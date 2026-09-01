# ai-agent-sdk-typescript

A TypeScript SDK for building AI agents with a guarded lifecycle, typed tools, a plugin system, and an event bus — zero framework lock-in, one dependency.

## The problem

Most "agent" code in the wild is an unstructured loop: an LLM call wrapped in a `while` loop, a pile of `if` statements for tools, and state smeared across module-level variables. That works for a demo and fails in production, for three specific reasons:

1. **No lifecycle.** Nothing defines when an agent may accept work, when it is warming up, and when it is retired — so callers race the agent's internal state and get undefined behavior instead of errors.
2. **No boundary between agent and tools.** Tool inputs are untyped `any` blobs, failures inside a tool take down the whole run, and there is no record of which tool call failed, how long it took, or why.
3. **No observation surface.** You cannot answer "what did the agent do, in order, with what inputs and outputs?" without reverse-engineering logs.

## How this SDK solves it

`ai-agent-sdk` makes the boring parts structural so you never hand-roll them again:

- **Guarded lifecycle state machine** — `idle → ready → running → stopped`. Calling `init()` twice, running a task before init, or using a stopped agent throws typed errors (`AgentStateError`) instead of misbehaving silently.
- **Typed tools with validation** — every tool declares its name, required inputs, an optional semantic validator, and an `execute()` function. The registry rejects duplicates and re-registered implementations; invalid inputs become **failed task results, not crashes**.
- **Plugin system** — hooks at every lifecycle point (`onInit`, `onBeforeTask`, `onAfterTask`, `onError`, `onShutdown`). `onBeforeTask` can rewrite the task, which is how you add auditing, redaction, or routing without touching agent code.
- **Event bus** — every transition, task start/end, and shutdown is emitted as an event (`state_change`, `task_start`, `task_end`, `run_start`, `run_end`, …). Subscribe per-type or observe everything with `onAny()` — a complete audit trail with zero extra effort.
- **Operational guardrails** — per-task timeouts with a sane default, a configurable cap on tool calls per run, and lifetime stats (`tasksTotal`, `tasksSucceeded`, `tasksFailed`, `uptimeMs`) for dashboards.

## How it works

```
┌────────────────────────── Agent ──────────────────────────┐
│                                                           │
│   run(tasks) ──► executeTask(task) ──► ToolRegistry       │
│        │                     │          │  call()        │
│   PluginManager              │          ▼                │
│   (hooks) ◄──────────────────┤     Tool.execute()        │
│        │                     │                           │
│        ▼                     ▼                           │
│   EventEmitter ◄──── SimpleMemoryStore (shared memory)   │
└───────────────────────────────────────────────────────────┘
```

- **`Agent`** owns a lifecycle state machine. `run()` accepts a goal string or a queue of tasks; it stops early on the first failure and returns a structured `RunResult`.
- **`ToolRegistry`** validates inputs against `requiredInputs` + the tool's own `validate()`, runs the tool under a timeout, and converts throws into `{ ok: false, error }` results.
- **`PluginManager`** fans lifecycle hooks out in registration order (shutdown in reverse order).
- **`SimpleMemoryStore`** is a dot-namespace key/value store (`"run.1.attempt"`) shared between tools and plugins; swap in your own by implementing the 5-method `MemoryStore` interface.

## Getting started

Requires [Bun](https://bun.sh) v1+.

```bash
git clone https://github.com/Retsumdk/ai-agent-sdk-typescript.git
cd ai-agent-sdk-typescript
bun install

# verify everything works
bun test          # 13 tests, 36 assertions
bun run demo      # full lifecycle walkthrough with event logging
```

> **Note:** This SDK is not published to npm yet. To use it in another project, clone this repo and run `bun link`, or copy `src/` into your project — the package has a single runtime dependency (`commander`).

## Example 1: hello, agent

```typescript
import { Agent, createEchoTool } from "ai-agent-sdk-typescript";

const agent = new Agent({ name: "greeter" }).registerTool(createEchoTool());

await agent.init();
const result = await agent.run("summarize today's notes");
console.log(result.status); // "completed"
await agent.stop();
```

## Example 2: a full run with a custom tool and a plugin

```typescript
import { Agent, createEchoTool, createMathTool } from "ai-agent-sdk-typescript";
import type { Plugin, Tool } from "ai-agent-sdk-typescript";

// A tool is a plain object — no base class, no boilerplate.
const lengthTool: Tool<{ text: string }, number> = {
  name: "length",
  description: "Returns the length of the input text.",
  requiredInputs: ["text"],
  execute: (input) => input.text.length,
};

// A plugin that audits every tool call.
const audit: Plugin = {
  name: "audit",
  onBeforeTask(ctx, task) {
    console.log(`[audit] calling ${task.tool} with`, task.input);
  },
};

const agent = new Agent({ name: "worker", timeoutMs: 5_000 })
  .registerTool(createEchoTool())
  .registerTool(createMathTool())
  .registerTool(lengthTool)
  .use(audit);

await agent.init();

const run = await agent.run([
  { tool: "math", input: { a: 21, b: 21, op: "add" } },
  { tool: "length", input: { text: "four" } },
]);

console.log(run.tasksRun);       // 2
console.log(run.tasksSucceeded); // 2

// Observability: subscribe to anything, any time.
agent.on("state_change", (e) => console.log(e.payload)); // { from: "ready", to: "running" }

await agent.stop();
```

## Example 3: failures are data, not crashes

```typescript
const result = await agent.executeTask({
  tool: "math",
  input: { a: 1, b: 0, op: "div" },
});

console.log(result.status); // "failed"
console.log(result.error);  // "Division by zero"
console.log(agent.stats()); // { tasksTotal: 1, tasksSucceeded: 0, tasksFailed: 1, ... }
```

Invalid inputs never reach your tool. Unknown tools throw `ToolError` immediately. The agent itself always stays usable.

## API surface

| Export | Purpose |
| --- | --- |
| `Agent` | Lifecycle state machine, task runner, event bus, stats |
| `createEchoTool` / `createMathTool` / `createClockTool` | Ready-made tools for testing and composition |
| `ToolRegistry` | Named tool storage with validation and timeouts |
| `PluginManager` | Lifecycle hook fan-out |
| `SimpleMemoryStore` | Namespaced key/value working memory |
| `AgentStateError`, `ToolError` | Typed, catchable failure modes |

## License

[MIT](./LICENSE)

---

Built by [Retsumdk](https://github.com/Retsumdk)
