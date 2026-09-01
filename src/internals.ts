/** Internal building blocks: memory, tool registry, plugin manager. */

import type {
  AgentContext,
  MemoryStore,
  Plugin,
  TaskInput,
  TaskResult,
  Tool,
  ToolResult,
} from "./types";
import { ToolError } from "./types";

/** In-memory working memory with dot-separated namespace support. */
export class SimpleMemoryStore implements MemoryStore {
  private data = new Map<string, unknown>();

  get size(): number {
    return this.data.size;
  }

  get<T = unknown>(key: string, defaultValue?: T): T | undefined {
    return (this.data.get(key) as T | undefined) ?? defaultValue;
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value);
  }

  delete(key: string): boolean {
    return this.data.delete(key);
  }

  /** Removes every stored entry. */
  clear(): void {
    this.data.clear();
  }

  /** Lists stored keys, optionally filtered by a `prefix.` namespace. */
  keys(prefix?: string): string[] {
    const all = [...this.data.keys()];
    return prefix ? all.filter((k) => k === prefix || k.startsWith(`${prefix}.`)) : all;
  }
}

/** Registry of named tools with input validation and timeout handling. */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  /** Registers a tool; duplicate names throw. */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new ToolError(`Tool "${tool.name}" is already registered`, tool.name);
    }
    for (const existing of this.tools.values()) {
      if (
        existing.execute === tool.execute ||
        existing.execute.toString() === tool.execute.toString()
      ) {
        throw new ToolError(
          `Tool "${tool.name}" re-implements the logic already registered as "${existing.name}" — reuse the existing name or implement different behavior`,
          tool.name,
        );
      }
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Validates presence of required inputs and runs the tool's own checks. */
  validateInputs(
    name: string,
    input: Record<string, unknown>,
  ): { ok: boolean; missing?: string[] } {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, missing: [] };
    const missing = tool.requiredInputs.filter((k) => !(k in input));
    return { ok: missing.length === 0, missing };
  }

  /**
   * Invokes a tool and resolves with a ToolResult. Unknown tools, failed
   * validation, and timeouts surface as `{ ok: false }` — only unexpected
   * throws inside the tool propagate to the caller as rejections.
   */
  async call(
    name: string,
    input: Record<string, unknown>,
    ctx: AgentContext,
    timeoutMs = 10_000,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolError(`Unknown tool: ${name}`, name);
    }
    const check = this.validateInputs(name, input);
    if (!check.ok) {
      throw new ToolError(
        `Tool ${name} missing required inputs: ${check.missing?.join(", ")}`,
        name,
      );
    }
    if (tool.validate) {
      const problem = tool.validate(input);
      if (problem) {
        throw new ToolError(`Tool ${name} input invalid: ${problem}`, name);
      }
    }
    const started = Date.now();
    try {
      const value = await Promise.race([
        Promise.resolve(tool.execute(input, ctx)),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new ToolError(`Tool ${name} timed out`, name)),
            timeoutMs,
          ),
        ),
      ]);
      return { ok: true, value, durationMs: Date.now() - started };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message, durationMs: Date.now() - started };
    }
  }
}

/** Orders and invokes plugin lifecycle hooks. */
export class PluginManager {
  private plugins: Plugin[] = [];
  private names = new Set<string>();

  /** Registers a plugin; duplicate names throw. */
  use(plugin: Plugin): void {
    if (this.names.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }
    this.names.add(plugin.name);
    this.plugins.push(plugin);
  }

  list(): string[] {
    return this.plugins.map((p) => p.name);
  }

  async init(ctx: AgentContext): Promise<void> {
    for (const p of this.plugins) {
      if (p.onInit) await p.onInit(ctx);
    }
  }

  /** Runs every `onBeforeTask`; the last returned rewrite wins. */
  async beforeTask(ctx: AgentContext, task: TaskInput): Promise<TaskInput> {
    let effective = task;
    for (const p of this.plugins) {
      if (p.onBeforeTask) {
        const rewritten = await p.onBeforeTask(ctx, effective);
        if (rewritten) effective = rewritten;
      }
    }
    return effective;
  }

  async afterTask(
    ctx: AgentContext,
    task: TaskInput,
    result: TaskResult,
  ): Promise<void> {
    for (const p of this.plugins) {
      if (p.onAfterTask) await p.onAfterTask(ctx, task, result);
    }
  }

  async error(ctx: AgentContext, task: TaskInput, err: unknown): Promise<void> {
    for (const p of this.plugins) {
      if (p.onError) await p.onError(ctx, task, err);
    }
  }

  /** Shutdown hooks run in reverse registration order (LIFO teardown). */
  async shutdown(ctx: AgentContext): Promise<void> {
    for (const p of [...this.plugins].reverse()) {
      if (p.onShutdown) await p.onShutdown(ctx);
    }
  }
}
