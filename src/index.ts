/**
 * ai-agent-sdk — TypeScript SDK for building AI agents.
 *
 * Exports the Agent class, tool/plugin primitives, and built-in tools.
 */

export { Agent } from "./agent";
export { SimpleMemoryStore, ToolRegistry, PluginManager } from "./internals";
export {
  AgentStateError,
  ToolError,
} from "./types";
export type {
  AgentConfig,
  AgentContext,
  AgentEvent,
  AgentEventType,
  AgentState,
  MemoryStore,
  Plugin,
  RunResult,
  TaskResult,
  TaskInput,
  Tool,
  ToolResult,
} from "./types";
export { createClockTool, createEchoTool, createMathTool } from "./tools";
