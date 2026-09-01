/** Built-in tools: echo, math, clock. Each is a plain `Tool` object. */

import type { Tool } from "./types";

/** Echo tool: returns its input unchanged. Useful as a smoke test in any agent. */
export function createEchoTool(): Tool<
  { message: string },
  { echoed: string }
> {
  return {
    name: "echo",
    description: "Returns the input message unchanged.",
    requiredInputs: ["message"],
    validate: (input) =>
      typeof input.message === "string" ? null : "message must be a string",
    execute: (input) => ({ echoed: input.message }),
  };
}

/** Math tool: two-operand arithmetic, including divide and modulo by zero guards. */
export function createMathTool(): Tool<
  { a: number; b: number; op: "add" | "sub" | "mul" | "div" | "mod" },
  number
> {
  const compute = (a: number, b: number, op: string): number => {
    switch (op) {
      case "add":
        return a + b;
      case "sub":
        return a - b;
      case "mul":
        return a * b;
      case "div":
        if (b === 0) throw new Error("Division by zero");
        return a / b;
      case "mod":
        if (b === 0) throw new Error("Modulo by zero");
        return a % b;
      default:
        throw new Error(`Unknown op: ${op}`);
    }
  };

  return {
    name: "math",
    description: "Arithmetic on two numbers: add, sub, mul, div, mod.",
    requiredInputs: ["a", "b", "op"],
    validate: (input) => {
      if (typeof input.a !== "number" || typeof input.b !== "number") {
        return "a and b must be numbers";
      }
      if (!["add", "sub", "mul", "div", "mod"].includes(String(input.op))) {
        return "op must be one of add, sub, mul, div, mod";
      }
      return null;
    },
    execute: (input) => compute(input.a, input.b, String(input.op)),
  };
}

/** Clock tool: returns the current ISO timestamp for a (validated) timezone. */
export function createClockTool(): Tool<
  { timeZone?: string },
  { iso: string; timeZone: string }
> {
  return {
    name: "clock",
    description: "Returns the current time as an ISO string, in a given timezone.",
    requiredInputs: [],
    async execute(input) {
      const timeZone = String(input.timeZone ?? "UTC");
      try {
        new Intl.DateTimeFormat("en-US", { timeZone });
      } catch {
        throw new Error(`Unknown timezone: ${timeZone}`);
      }
      return { iso: new Date().toISOString(), timeZone };
    },
  };
}
