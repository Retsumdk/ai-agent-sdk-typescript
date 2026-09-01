/** The Agent: a small, observable state machine with tools and plugins. */

import { PluginManager, SimpleMemoryStore, ToolRegistry } from "./internals";
import type {
  AgentConfig,
  AgentContext,
  AgentEvent,
  AgentEventType,
  AgentState,
  AgentStats,
  RunResult,
  TaskInput,
  TaskResult,
  Tool,
  Plugin,
} from "./types";
import { AgentStateError, ToolError } from "./types";

type Listener = (event: AgentEvent) => void;

/**
 * A stateful agent that executes tool-backed tasks behind a guarded
 * lifecycle: `init()` -> `run()` -> `stop()`.
 *
 * Every transition, task, and tool call is emitted onto an internal event
 * bus, so host applications can observe (or record) everything the agent
 * does without patching its internals.
 */
export class Agent {
  readonly id: string;
  readonly tools: ToolRegistry;
  readonly plugins: PluginManager;

  private readonly label: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxToolCalls: number;
  private readonly memory: SimpleMemoryStore;
  private readonly listeners = new Map<AgentEventType | string, Set<Listener>>();
  private readonly anyListeners = new Set<Listener>();

  private stateValue: AgentState = "idle";
  private readonly createdAt = Date.now();
  private tasksTotal = 0;
  private tasksSucceeded = 0;
  private tasksFailed = 0;

  constructor(config: AgentConfig = {}) {
    this.label = config.name ?? "agent";
    this.id = `${this.label}-${Math.random().toString(36).slice(2, 10)}`;
    this.defaultTimeoutMs = config.timeoutMs ?? 10_000;
    this.maxToolCalls = config.maxToolCalls ?? 100;
    this.tools = new ToolRegistry();
    this.plugins = new PluginManager();
    this.memory = new SimpleMemoryStore();
    for (const [key, value] of Object.entries(config.memory ?? {})) {
      this.memory.set(key, value);
    }
  }

  /** Current lifecycle state. */
  get state(): AgentState {
    return this.stateValue;
  }

  /** Working memory — shared between tools and plugins for this agent. */
  get mem(): SimpleMemoryStore {
    return this.memory;
  }

  /** Registers a tool. Throws if a tool with the same name exists. */
  registerTool(tool: Tool): this {
    this.tools.register(tool);
    return this;
  }

  /** Registers a plugin. Throws on duplicate plugin names. */
  use(plugin: Plugin): this {
    this.plugins.use(plugin);
    return this;
  }

  /** Subscribes to a specific event type. */
  on(type: AgentEventType | string, listener: Listener): this {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
    return this;
  }

  /** Subscribes to every event regardless of type. */
  onAny(listener: Listener): this {
    this.anyListeners.add(listener);
    return this;
  }

  /** Moves the agent from `idle` to `ready`, initializing plugins. */
  async init(): Promise<this> {
    if (this.stateValue !== "idle") {
      throw new AgentStateError(
        `Agent "${this.label}" is already initialized (state: ${this.stateValue})`,
        this.stateValue,
      );
    }
    await this.plugins.init(this.context());
    this.setState("ready");
    this.emit("init", { agentId: this.id });
    return this;
  }

  /**
   * Executes a single task: plugin pre-processing, tool dispatch with
   * timeout, plugin post-processing, and full accounting. Resolves with a
   * TaskResult even when the task fails; only invalid lifecycle states throw.
   */
  async executeTask(task: TaskInput): Promise<TaskResult> {
    if (this.stateValue !== "ready" && this.stateValue !== "running") {
      throw new AgentStateError(
        `Agent "${this.label}" is not running (state: ${this.stateValue})`,
        this.stateValue,
      );
    }
    const ctx = this.context();
    const effective = await this.plugins.beforeTask(ctx, {
      ...task,
      id: task.id ?? `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    });

    if (!this.tools.get(effective.tool)) {
      throw new ToolError(`Unknown tool: ${effective.tool}`, effective.tool);
    }

    const startedAt = new Date();
    this.tasksTotal += 1;
    this.setState("running");
    this.emit("task_start", { taskId: effective.id, tool: effective.tool });

    let result: TaskResult;
    try {
      const toolResult = await this.tools.call(
        effective.tool,
        effective.input ?? {},
        ctx,
        effective.timeoutMs ?? this.defaultTimeoutMs,
      );
      const endedAt = new Date();
      if (toolResult.ok) {
        this.tasksSucceeded += 1;
        result = {
          taskId: effective.id!,
          status: "completed",
          tool: effective.tool,
          output: toolResult.value,
          durationMs: toolResult.durationMs,
          startedAt,
          endedAt,
        };
      } else {
        this.tasksFailed += 1;
        result = {
          taskId: effective.id!,
          status: "failed",
          tool: effective.tool,
          error: toolResult.error,
          durationMs: toolResult.durationMs,
          startedAt,
          endedAt,
        };
        await this.plugins.error(ctx, effective, new Error(toolResult.error));
      }
    } catch (err) {
      this.tasksFailed += 1;
      const message = err instanceof Error ? err.message : String(err);
      const endedAt = new Date();
      result = {
        taskId: effective.id!,
        status: "failed",
        tool: effective.tool,
        error: message,
        durationMs: endedAt.getTime() - startedAt.getTime(),
        startedAt,
        endedAt,
      };
      await this.plugins.error(ctx, effective, err);
      this.emit("task_end", { taskId: effective.id, status: "failed", error: message });
      this.setState("ready");
      return result;
    }

    await this.plugins.afterTask(ctx, effective, result);
    this.emit("task_end", {
      taskId: result.taskId,
      status: result.status,
      durationMs: result.durationMs,
    });
    this.setState("ready");
    return result;
  }

  /**
   * Drives a goal through a queued list of tasks. Stops early if any task
   * fails. This is the "one run" entry point host applications call.
   */
  async run(goals: TaskInput[] | string): Promise<RunResult> {
    if (this.stateValue === "idle") await this.init();
    const queue = typeof goals === "string" ? [] : goals;
    const goal = typeof goals === "string" ? goals : queue.map((t) => t.tool).join(" -> ") || "noop";

    const startedAt = new Date();
    this.emit("run_start", { goal, tasks: queue.length });
    let tasksRun = 0;
    let tasksSucceeded = 0;
    let tasksFailed = 0;
    let firstError: string | undefined;

    for (const task of queue.slice(0, this.maxToolCalls)) {
      const result = await this.executeTask(task);
      tasksRun += 1;
      if (result.status === "completed") {
        tasksSucceeded += 1;
      } else {
        tasksFailed += 1;
        firstError ??= result.error;
        break;
      }
    }

    const endedAt = new Date();
    const status = tasksFailed > 0 ? "failed" : "completed";
    const runResult: RunResult = {
      status,
      goal,
      tasksRun,
      tasksSucceeded,
      tasksFailed,
      durationMs: endedAt.getTime() - startedAt.getTime(),
      startedAt,
      endedAt,
      ...(firstError ? { error: firstError } : {}),
    };
    this.emit("run_end", { goal, status, tasksRun });
    return runResult;
  }

  /** Lifetime counters, useful for dashboards and health checks. */
  stats(): AgentStats {
    return {
      tasksTotal: this.tasksTotal,
      tasksSucceeded: this.tasksSucceeded,
      tasksFailed: this.tasksFailed,
      uptimeMs: Date.now() - this.createdAt,
    };
  }

  /**
   * Terminal shutdown: runs plugin teardown in reverse registration order
   * and locks the agent out of further runs.
   */
  async stop(): Promise<void> {
    if (this.stateValue === "stopped") return;
    await this.plugins.shutdown(this.context());
    this.setState("stopped");
    this.emit("shutdown", { agentId: this.id });
  }

  private setState(next: AgentState): void {
    const from = this.stateValue;
    if (from === next) return;
    this.stateValue = next;
    this.emit("state_change", { from, to: next });
  }

  private emit(type: AgentEventType | string, payload?: unknown): void {
    const event: AgentEvent = {
      type,
      agentId: this.id,
      timestamp: Date.now(),
      payload,
    };
    for (const l of this.listeners.get(type) ?? []) l(event);
    for (const l of this.anyListeners) l(event);
  }

  private context(): AgentContext {
    const self = this;
    return {
      agentId: self.id,
      get state(): AgentState {
        return self.stateValue;
      },
      memory: self.memory,
      emit: (type, payload) => self.emit(type, payload),
    };
  }
}
