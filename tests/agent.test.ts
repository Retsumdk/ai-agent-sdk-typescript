import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agent";
import { SimpleMemoryStore, ToolRegistry } from "../src/internals";
import { createClockTool, createEchoTool, createMathTool } from "../src/tools";
import type { Plugin } from "../src/types";

async function makeAgent(): Promise<Agent> {
  const agent = new Agent({ name: "test-agent" });
  agent.registerTool(createEchoTool());
  agent.registerTool(createMathTool());
  agent.registerTool(createClockTool());
  await agent.init();
  return agent;
}

describe("Agent lifecycle", () => {
  test("init moves idle -> ready", async () => {
    const agent = new Agent({ name: "lifecycle" });
    expect(agent.state).toBe("idle");
    await agent.init();
    expect(agent.state).toBe("ready");
    await agent.stop();
    expect(agent.state).toBe("stopped");
  });

  test("double init and execute before init are rejected", async () => {
    const agent = new Agent({ name: "guards" });
    await agent.init();
    await expect(agent.init()).rejects.toThrow(/already initialized/);
    await agent.stop();
    await expect(
      agent.executeTask({ tool: "echo", input: { message: "x" } }),
    ).rejects.toThrow(/not running/);
  });

  test("emits state_change events", async () => {
    const agent = new Agent({ name: "events" });
    const events: Array<{ from: string; to: string }> = [];
    agent.on("state_change", (e) => {
      const p = e.payload as { from: string; to: string };
      events.push(p);
    });
    await agent.init();
    await agent.stop();
    expect(events).toEqual([
      { from: "idle", to: "ready" },
      { from: "ready", to: "stopped" },
    ]);
  });
});

describe("run and task execution", () => {
  test("run() completes and returns a RunResult", async () => {
    const agent = await makeAgent();
    const run = await agent.run("smoke");
    expect(run.status).toBe("completed");
    expect(run.tasksRun).toBe(0);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.startedAt).toBeInstanceOf(Date);
    expect(run.endedAt).toBeInstanceOf(Date);
    await agent.stop();
  });

  test("executeTask dispatches to the right tool", async () => {
    const agent = await makeAgent();
    const result = await agent.executeTask({
      tool: "math",
      input: { a: 6, b: 7, op: "mul" },
    });
    expect(result.status).toBe("completed");
    expect(result.output).toBe(42);
    expect(result.taskId).toMatch(/^task-/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    await agent.stop();
  });

  test("unknown tool is rejected", async () => {
    const agent = await makeAgent();
    await expect(
      agent.executeTask({ tool: "nope", input: {} }),
    ).rejects.toThrow(/Unknown tool/);
    await agent.stop();
  });

  test("tool errors become failed tasks, not crashes", async () => {
    const agent = await makeAgent();
    const result = await agent.executeTask({
      tool: "math",
      input: { a: 1, b: 0, op: "div" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/Division by zero/);
    await agent.stop();
  });
});

describe("ToolRegistry validation", () => {
  test("rejects duplicate names and missing required inputs", () => {
    const registry = new ToolRegistry();
    registry.register(createEchoTool());
    expect(() => registry.register(createEchoTool())).toThrow(/already registered/);
    expect(() => registry.register({ ...createEchoTool(), name: "echo2" } as never)).toThrow();

    const missing = registry.validateInputs("echo", {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.missing).toEqual(["message"]);

    const valid = registry.validateInputs("echo", { message: "hi" });
    expect(valid.ok).toBe(true);
  });
});

describe("PluginManager hooks", () => {
  test("onBeforeTask can transform input", async () => {
    const upper: Plugin = {
      name: "upper",
      version: "1.0.0",
      onBeforeTask: async (_ctx, task) => ({
        ...task,
        input: { message: String(task.input.message).toUpperCase() },
      }),
    };
    const agent = await makeAgent();
    agent.use(upper);
    const result = await agent.executeTask({ tool: "echo", input: { message: "hello" } });
    expect(result.output).toEqual({ echoed: "HELLO" });
    await agent.stop();
  });

  test("onError fires for failing tasks", async () => {
    let seen: unknown;
    const probe: Plugin = {
      name: "probe",
      version: "1.0.0",
      onError: async (_ctx, _task, error) => {
        seen = error;
      },
    };
    const agent = await makeAgent();
    agent.use(probe);
    await agent.executeTask({ tool: "math", input: { a: 1, b: 0, op: "div" } });
    expect(String(seen)).toMatch(/Division by zero/);
    await agent.stop();
  });
});

describe("SimpleMemoryStore", () => {
  test("set/get/delete/clear with scoped keys", () => {
    const store = new SimpleMemoryStore();
    store.set("k", "v");
    store.set("run:1.k2", 42);
    expect(store.get("k")).toBe("v");
    expect(store.get("run:1.k2")).toBe(42);
    expect(store.delete("k")).toBe(true);
    expect(store.get("k")).toBeUndefined();
    expect(store.size).toBe(1);
    store.clear();
    expect(store.size).toBe(0);
  });

  test("agent memory is shared across tasks", async () => {
    const agent = await makeAgent();
    agent.memory.set("note", "remembered");
    expect(agent.memory.get("note")).toBe("remembered");
    await agent.stop();
  });
});

describe("stats", () => {
  test("counts tasks and failures", async () => {
    const agent = await makeAgent();
    await agent.executeTask({ tool: "echo", input: { message: "a" } });
    await agent.executeTask({ tool: "math", input: { a: 1, b: 0, op: "div" } });
    const stats = agent.stats();
    expect(stats.tasksTotal).toBe(2);
    expect(stats.tasksSucceeded).toBe(1);
    expect(stats.tasksFailed).toBe(1);
    expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
    await agent.stop();
  });
});
