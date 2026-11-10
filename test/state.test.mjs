import test from "node:test";
import assert from "node:assert/strict";
import { Conversation } from "../src/state.mjs";
import { buildView, renderTodos } from "../src/view.mjs";

test("loadMessages keeps summary, custom, bash and python rows", () => {
  const conv = new Conversation();
  conv.loadMessages([
    { role: "user", content: "hello", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
    { role: "compactionSummary", summary: "older context", tokensBefore: 1000, tokensAfter: 200, timestamp: 3 },
    { role: "branchSummary", summary: "other branch", timestamp: 4 },
    { role: "custom", customType: "test", content: "injected", display: true, timestamp: 5 },
    { role: "bashExecution", command: "echo hi", output: "hi", exitCode: 0, timestamp: 6 },
    { role: "pythonExecution", code: "print(1)", output: "1", exitCode: 0, timestamp: 7 },
  ]);
  assert.deepEqual(
    conv.items.map((item) => item.kind),
    ["user", "assistant", "compaction", "branch", "custom", "bash", "python"],
  );
});

test("todo details become a checklist board", () => {
  const conv = new Conversation();
  conv.noteTodos({ todos: [
    { id: 1, text: "Read", done: true },
    { id: 2, text: "Write", done: false },
  ] });
  const board = renderTodos(conv, { kinds: new Set(["checklist"]) });
  assert.equal(board.k, "checklist");
  assert.equal(board.p.phases[0].items.length, 2);
  assert.equal(board.p.phases[0].items[0].status, "done");
});

test("queue updates are kept for the composer", () => {
  const conv = new Conversation();
  conv.onEvent({ type: "queue_update", steering: ["do this next"], followUp: ["then summarize"] });
  assert.deepEqual(conv.queue.steering, ["do this next"]);
  assert.deepEqual(conv.queue.followUp, ["then summarize"]);
});

test("buildView renders a user image attachment without throwing", () => {
  const conv = new Conversation();
  conv.addUser("image", [{ type: "image", data: "AAAA", mimeType: "image/png", name: "pixel.png" }]);
  const view = buildView(conv, {
    model: "reaper/deepseek-v4.1-flash-1017",
    modelLabel: "DeepSeek V4.1 Flash",
    effort: "max",
    compact: false,
    cwd: "/tmp",
    contextTokens: 10,
    contextWindow: 1000,
    composer: { text: "", cursor: 0 },
    kinds: new Set(["checklist"]),
    blobFor: () => "blob123",
  });
  assert.ok(view.main[0].c.length > 0);
});

test("buildView renders a todo board without throwing", () => {
  const conv = new Conversation();
  conv.addUser("hello");
  conv.add({ kind: "assistant", id: "m1", text: "hi", status: "done", at: Date.now() });
  conv.noteTodos({ todoPhases: [{ items: [{ id: "1", text: "one", status: "pending" }] }] });
  const view = buildView(conv, {
    model: "reaper/deepseek-v4.1-flash-1017",
    modelLabel: "DeepSeek V4.1 Flash",
    effort: "max",
    compact: false,
    cwd: "/tmp",
    contextTokens: 10,
    contextWindow: 1000,
    composer: { text: "", cursor: 0 },
    kinds: new Set(["checklist"]),
  });
  const root = view.main[0];
  const stream = root.c?.find((node) => node.p?.role === "pit.stream") || root.c?.[0] || root;
  assert.ok(stream.c.length >= 2);
});

/** Drive one assistant tool call through the RPC event sequence pi emits. */
function runToolCall(conv, { name, args, partials = [], result }) {
  conv.onEvent({ type: "message_start", message: { role: "assistant", content: [] } });
  conv.onEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", toolName: name, id: "call-1", contentIndex: 0 } });
  conv.onEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "call-1", name, arguments: args } } });
  conv.onEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: name, args });
  for (const partial of partials) {
    conv.onEvent({ type: "tool_execution_update", toolCallId: "call-1", toolName: name, partialResult: partial });
  }
  conv.onEvent({ type: "tool_execution_end", toolCallId: "call-1", toolName: name, result, isError: false, durationMs: 9000 });
  return conv.items.find((item) => item.toolCallId === "call-1");
}

test("@tintinweb/pi-subagents Agent calls become agent cards", () => {
  const conv = new Conversation();
  const item = runToolCall(conv, {
    name: "Agent",
    args: { description: "audit the auth flow", subagent_type: "Explore", prompt: "…" },
    partials: [{
      content: [{ type: "text", text: "3 tool uses..." }],
      details: { toolUses: 3, tokens: "1.2k token", durationMs: 1200, status: "running", subagentType: "Explore", modelName: "anthropic/claude-haiku-4", agentId: "a-7", activity: "grep auth" },
    }],
    result: {
      content: [{ type: "text", text: "Agent completed in 9s (5 tool uses, 2.4k tokens).\n\nReport." }],
      details: { toolUses: 5, tokens: "2.4k token", durationMs: 9000, status: "completed", subagentType: "Explore", modelName: "anthropic/claude-haiku-4", agentId: "a-7" },
    },
  });
  assert.equal(item.kind, "agent");
  assert.equal(item.name, "audit the auth flow");
  assert.equal(item.agentType, "Explore");
  assert.equal(item.model, "anthropic/claude-haiku-4");
  assert.equal(item.stats.tools, 5);
  assert.equal(item.stats.tokens, 2400);
  assert.equal(item.runId, "a-7");
  assert.equal(item.agentStatus, "done");
  assert.match(item.output, /Report\./);
});

test("a background Agent stays running after its tool result", () => {
  const conv = new Conversation();
  const item = runToolCall(conv, {
    name: "Agent",
    args: { description: "long job", subagent_type: "general-purpose", run_in_background: true },
    result: {
      content: [{ type: "text", text: "Agent started in the background. Use get_subagent_result…" }],
      details: { toolUses: 0, tokens: "", durationMs: 0, status: "background", agentId: "a-9" },
    },
  });
  assert.equal(item.kind, "agent");
  assert.equal(item.agentStatus, "running");
});

test("pi-subagents subagent calls still become agent cards", () => {
  const conv = new Conversation();
  const item = runToolCall(conv, {
    name: "subagent",
    args: { task: "map the parser", agent: "explore" },
    result: { content: [{ type: "text", text: "done" }], details: { results: [{ progress: { toolCount: 4, tokens: 900, durationMs: 3000 } }] } },
  });
  assert.equal(item.kind, "agent");
  assert.equal(item.agentType, "explore");
  assert.equal(item.stats.tools, 4);
  assert.equal(item.agentStatus, "done");
});
