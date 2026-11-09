/**
 * pi-tsp todo tool.
 *
 * A small, state-in-session todo list so pi-tsp can render the same checklist
 * board as omp even when the user has not installed a todo extension. The
 * state lives in tool-result details, so branching and resume reconstruct it
 * from the active branch. If the user's pi setup already registers `todo`, this
 * extension stays out of the way.
 */

type Pi = any;
type Ctx = any;

import { Type } from "typebox";

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

interface TodoDetails {
  action: "list" | "add" | "toggle" | "clear";
  todos: Todo[];
  nextId: number;
  error?: string;
}

export default function todoExtension(pi: Pi) {
  let todos: Todo[] = [];
  let nextId = 1;

  const restore = (ctx: Ctx) => {
    todos = [];
    nextId = 1;
    for (const entry of ctx.sessionManager?.getBranch?.() || []) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message?.role !== "toolResult" || message.toolName !== "todo") continue;
      const details = message.details as TodoDetails | undefined;
      if (details) {
        todos = Array.isArray(details.todos) ? details.todos : [];
        nextId = details.nextId || nextId;
      }
    }
  };

  const result = (action: TodoDetails["action"], error?: string) => ({
    content: [{
      type: "text" as const,
      text: error
        ? `Error: ${error}`
        : todos.length
          ? todos.map((todo) => `[${todo.done ? "x" : " "}] #${todo.id}: ${todo.text}`).join("\n")
          : "No todos",
    }],
    details: { action, todos: [...todos], nextId, ...(error ? { error } : {}) } as TodoDetails,
  });

  pi.on("session_start", async (_event: any, ctx: Ctx) => restore(ctx));
  pi.on("session_tree", async (_event: any, ctx: Ctx) => restore(ctx));

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Manage a todo list. Actions: list, add (text), toggle (id), clear",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("add"),
        Type.Literal("toggle"),
        Type.Literal("clear"),
      ]),
      text: Type.Optional(Type.String({ description: "Todo text for add" })),
      id: Type.Optional(Type.Number({ description: "Todo id for toggle" })),
    }),
    async execute(_toolCallId: string, params: any) {
      if (params.action === "list") return result("list");
      if (params.action === "clear") {
        const count = todos.length;
        todos = [];
        nextId = 1;
        return result("clear", count ? undefined : "no todos to clear");
      }
      if (params.action === "add") {
        if (!params.text) return result("add", "text required for add");
        const text = String(params.text).trim().slice(0, 500);
        if (!text) return result("add", "text required for add");
        todos.push({ id: nextId++, text, done: false });
        return result("add");
      }
      if (params.action === "toggle") {
        if (params.id === undefined) return result("toggle", "id required for toggle");
        const todo = todos.find((entry) => entry.id === params.id);
        if (!todo) return result("toggle", `#${params.id} not found`);
        todo.done = !todo.done;
        return result("toggle");
      }
      return result("list", `unknown action: ${params.action}`);
    },
  });

  pi.registerCommand("todos", {
    description: "Show the current todo list",
    handler: async (_args: string, ctx: Ctx) => {
      if (!todos.length) {
        ctx.ui.notify("No todos. Ask the agent to add some.", "info");
        return;
      }
      const done = todos.filter((todo) => todo.done).length;
      ctx.ui.notify(
        `Todos ${done}/${todos.length}\n` +
          todos.map((todo) => `${todo.done ? "✓" : "○"} #${todo.id} ${todo.text}`).join("\n"),
        "info",
      );
    },
  });
}
