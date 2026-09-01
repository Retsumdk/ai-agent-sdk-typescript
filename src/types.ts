/**
 * Core type definitions for the AI Agent SDK.
 *
 * Everything is deliberately small and composable: an Agent is a state
 * machine, Tools are typed functions, Plugins are lifecycle hooks.
 */

/** Lifecycle states an agent moves through. */
export type AgentState = "idle" | "init" | "ready" | "running" | "stopped";

/** Events emitted on the agent's internal bus. */
export type AgentEventType =
  | "init"
  | "run_start"
  | "run_end"
  | "task_start"
  | "task_end"
  | "state_change"
  | "shutdown";

/** A unit of work: call one tool with one input. */
export interface TaskInput {
  /** Optional client-supplied id; an id is generated when omitted. */
  id?: string;
  /** Name of the registered tool to invoke. */
  tool: string;
  /** Input passed to the tool. */
  input?: Record<string, unknown>;
  /** Per-task timeout override (ms). */
  timeoutMs?: number;
}

/** Outcome of one executed task. */
export interface TaskResult {
  taskId: string;
  status: "completed" | "failed";
  tool: string;
  /** Tool output when successful. */
  output?: unknown;
  /** Error message when failed. */
  error?: string;
  durationMs: number;
  startedAt: Date;
  endedAt: Date;
}

/** Outcome of a full `run()`. */
export interface RunResult {
  status: "completed" | "failed";
  goal: string;
  tasksRun: number;
  tasksSucceeded: number;
  tasksFailed: number;
  durationMs: number;
  startedAt: Date;
  endedAt: Date;
  /** First failure message, when the run stopped early. */
  error?: string;
}

/** A named, typed function the agent can invoke. */
export interface Tool<TInput = any, TOutput = unknown> {
  name: string;
  description: string;
  /** Input keys that must be present. */
  requiredInputs: string[];
  /** Optional semantic validation; return an error message to reject. */
  validate?: (input: Record<string, unknown>) => string | null;
  execute(input: TInput, ctx: AgentContext): TOutput | Promise<TOutput>;
}

/** A ToolResult as returned by the registry's call(). */
export interface ToolResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  durationMs: number;
}

/** Lifecycle hooks that observe or reshape agent behavior. */
export interface Plugin {
  /** Unique plugin name; duplicates are rejected. */
  name: string;
  onInit?(ctx: AgentContext): void | Promise<void>;
  /** Runs before each task; return a rewritten TaskInput to transform it. */
  onBeforeTask?(
    ctx: AgentContext,
    task: TaskInput,
  ): TaskInput | void | Promise<TaskInput | void>;
  onAfterTask?(
    ctx: AgentContext,
    task: TaskInput,
    result: TaskResult,
  ): void | Promise<void>;
  onError?(ctx: AgentContext, task: TaskInput, err: unknown): void | Promise<void>;
  onShutdown?(ctx: AgentContext): void | Promise<void>;
}

/** Key/value working memory shared by tools and plugins. */
export interface MemoryStore {
  /** Number of stored entries. */
  readonly size: number;
  get<T = unknown>(key: string, defaultValue?: T): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
  /** Removes every stored entry. */
  clear(): void;
  keys(prefix?: string): string[];
}

/** Read-only view handed to tools and plugins. */
export interface AgentContext {
  agentId: string;
  readonly state: AgentState;
  memory: MemoryStore;
  emit(type: AgentEventType | string, payload?: unknown): void;
}

/** Constructor options for an Agent. */
export interface AgentConfig {
  /** Human-readable name; used to derive the agent id. */
  name?: string;
  /** Default per-task timeout in ms (default 10_000). */
  timeoutMs?: number;
  /** Upper bound on tasks executed in a single run (default 100). */
  maxToolCalls?: number;
  /** Initial memory entries. */
  memory?: Record<string, unknown>;
}

/** Lifetime counters exposed by `agent.stats()`. */
export interface AgentStats {
  tasksTotal: number;
  tasksSucceeded: number;
  tasksFailed: number;
  uptimeMs: number;
}

/** An event flowing through the agent's bus. */
export interface AgentEvent {
  type: AgentEventType | string;
  agentId: string;
  timestamp: number;
  payload?: unknown;
}

/** Thrown when a tool is missing, misconfigured, or times out. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly toolName: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** Thrown when the agent is asked to run from an invalid state. */
export class AgentStateError extends Error {
  constructor(
    message: string,
    readonly state: AgentState,
  ) {
    super(message);
    this.name = "AgentStateError";
  }
}
