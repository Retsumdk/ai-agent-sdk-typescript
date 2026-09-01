/**
 * Demo CLI for the ai-agent-sdk.
 *
 * Builds an agent with plugins and tools, runs a queued task list, shows
 * stats, and shuts down cleanly. Run with: bun run src/cli.ts
 */

import { Agent } from "./agent";
import { createClockTool, createEchoTool, createMathTool } from "./tools";
import type { Plugin } from "./types";

const audit: Plugin = {
  name: "audit",
  onInit: () => console.log("[audit] init"),
  onBeforeTask: (_ctx, task) => {
    console.log(`[audit] -> ${task.tool}`, task.input ?? {});
    return task;
  },
  onAfterTask: (_ctx, _task, result) => {
    console.log(`[audit] <- ${result.tool} ${result.status} in ${result.durationMs}ms`);
  },
  onError: (_ctx, task, err) => {
    console.error(`[audit] !! ${task.tool}:`, err instanceof Error ? err.message : err);
  },
  onShutdown: () => console.log("[audit] shutdown"),
};

async function main(): Promise<void> {
  const agent = new Agent({ name: "demo", timeoutMs: 5_000, memory: { env: "demo" } });

  agent.on("state_change", (e) => {
    const { from, to } = e.payload as { from: string; to: string };
    console.log(`[lifecycle] ${from} -> ${to}`);
  });

  agent.use(audit);
  agent.registerTool(createEchoTool());
  agent.registerTool(createMathTool());
  agent.registerTool(createClockTool());

  await agent.init();

  const greet = await agent.executeTask({ tool: "echo", input: { message: "hello, world" } });
  console.log("[echo]", greet.output);

  const sum = await agent.executeTask({
    tool: "math",
    input: { a: 21, b: 21, op: "add" },
  });
  console.log("[math] 21 + 21 =", sum.output);

  const now = await agent.executeTask({ tool: "clock", input: { timeZone: "UTC" } });
  console.log("[clock]", now.output);

  console.log("[stats]", JSON.stringify(agent.stats()));
  await agent.stop();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
