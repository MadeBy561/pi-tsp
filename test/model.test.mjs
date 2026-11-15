import assert from "node:assert/strict";
import test from "node:test";
import { Conversation, partialJson, todoPhases } from "../dist/model.js";

const start = () => ({ type: "message_start", message: { role: "assistant" } });
const update = (type, fields) => ({ type: "message_update", assistantMessageEvent: { type, ...fields } });

test("streamed text and thinking become blocks of one message", () => {
  const conv = new Conversation();
  conv.onEvent({ type: "agent_start" });
  conv.onEvent(start());
  conv.onEvent(update("thinking_delta", { contentIndex: 0, delta: "hm" }));
  conv.onEvent(update("thinking_end", { contentIndex: 0, content: "hmm" }));
  conv.onEvent(update("text_delta", { contentIndex: 1, delta: "Hel" }));
  conv.onEvent(update("text_delta", { contentIndex: 1, delta: "lo" }));
  assert.deepEqual(conv.items.map(item => [item.kind, item.text, item.status]), [["thinking", "hmm", "done"], ["assistant", "Hello", "running"]]);
  assert.equal(conv.items[0].msg, conv.items[1].msg);
  conv.onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Hello" }], usage: { input: 10, output: 2, totalTokens: 12 } } });
  conv.onEvent({ type: "turn_end", message: { usage: { input: 10, output: 2, totalTokens: 12 } } });
  conv.onEvent({ type: "agent_settled" });
  assert.equal(conv.busy, false);
  assert.equal(conv.items[1].status, "done");
  assert.equal(conv.items[1].turn.total, 12);
  assert.deepEqual(conv.items.at(-1).usage, { input: 10, output: 2, cacheRead: 0, prompt: 10, ms: conv.items.at(-1).usage.ms, ttftMs: conv.items.at(-1).usage.ttftMs });
});

test("a tool call streams its arguments, runs and settles", () => {
  const conv = new Conversation();
  conv.onEvent(start());
  conv.onEvent(update("toolcall_start", { contentIndex: 0, id: "c1", toolName: "write" }));
  conv.onEvent(update("toolcall_delta", { contentIndex: 0, delta: '{"path":"a.txt","content":"li' }));
  const item = conv.items[0];
  assert.equal(item.kind, "tool");
  assert.deepEqual(item.args, { path: "a.txt", content: "li" });
  conv.onEvent(update("toolcall_end", { contentIndex: 0, toolCall: { id: "c1", name: "write", arguments: { path: "a.txt", content: "line" } } }));
  conv.onEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "write" });
  assert.equal(item.status, "running");
  conv.onEvent({ type: "tool_execution_end", toolCallId: "c1", isError: false, result: { content: [{ type: "text", text: "ok" }] } });
  assert.equal(item.status, "done");
  assert.equal(item.output, "ok");
});

test("a stored call with no result is cancelled, not running", () => {
  const conv = new Conversation();
  conv.loadMessages([
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] },
  ]);
  assert.equal(conv.items.at(-1).status, "cancelled");
});

test("a failed request becomes an error row; an abort a notice", () => {
  const conv = new Conversation();
  conv.onEvent(start());
  conv.onEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 slow down" } });
  assert.deepEqual([conv.items[0].kind, conv.items[0].text], ["error", "429 slow down"]);
  conv.onEvent({ type: "turn_end" });
  conv.onEvent(start());
  conv.onEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
  assert.equal(conv.items.at(-1).kind, "notice");
});

test("every item id is unique across reloads", () => {
  const conv = new Conversation();
  const messages = [
    { role: "user", content: "a" },
    { role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a" } }, { type: "toolCall", id: "r2", name: "read", arguments: { path: "b" } }] },
    { role: "toolResult", toolCallId: "r1", content: [{ type: "text", text: "A" }] },
    { role: "toolResult", toolCallId: "r2", content: [{ type: "text", text: "B" }] },
  ];
  conv.loadMessages(messages);
  const first = conv.items.map(item => item.id);
  conv.loadMessages(messages);
  const ids = [...first, ...conv.items.map(item => item.id)];
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(conv.items.filter(item => item.kind === "tool").map(item => [item.status, item.output]), [["done", "A"], ["done", "B"]]);
});

test("a shell command shows at once and fills as output arrives", () => {
  const conv = new Conversation();
  const item = conv.startShell("echo hi", false);
  conv.onEvent({ type: "bash_execution_update", delta: "hi\n" });
  assert.equal(item.output, "hi\n");
  conv.finishShell(item, { output: "hi\n", exitCode: 0 });
  assert.equal(item.status, "done");
  conv.onEvent({ type: "message_end", message: { role: "bashExecution", command: "echo hi", output: "hi\n", exitCode: 0 } });
  assert.equal(conv.items.length, 1);
});

test("partialJson closes what a streamed prefix leaves open", () => {
  assert.deepEqual(partialJson('{"a":1,"b":"x'), { a: 1, b: "x" });
  assert.deepEqual(partialJson('{"a":[1,2'), { a: [1, 2] });
  assert.deepEqual(partialJson('{"a":1,"b"'), { a: 1 });
  assert.deepEqual(partialJson('{"a":"q\\"'), { a: 'q"' });
  assert.equal(partialJson("nope"), null);
});

test("todoPhases reads a flat list and a phased one", () => {
  assert.deepEqual(todoPhases({ todos: [{ id: 1, text: "a", done: true }, { id: 2, text: "b" }] })[0].items.map(item => item.status), ["done", "pending"]);
  assert.equal(todoPhases({ phases: [{ name: "P", tasks: [{ content: "x", status: "in_progress" }] }] })[0].items[0].status, "active");
  assert.equal(todoPhases({ nothing: true }), null);
});

test("a failure that is retried leaves one error, the last", () => {
  const conv = new Conversation();
  conv.addUser("hi");
  const fail = () => {
    conv.onEvent({ type: "message_start", message: { role: "assistant" } });
    conv.onEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." } });
    conv.onEvent({ type: "turn_end" });
  };
  fail();
  conv.onEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "Connection error." });
  assert.equal(conv.items.filter(item => item.kind === "error").length, 0);
  assert.equal(conv.retry.attempt, 1);
  fail();
  conv.onEvent({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: "Connection error." });
  fail();
  conv.onEvent({ type: "auto_retry_end", success: false });
  assert.equal(conv.items.filter(item => item.kind === "error").length, 1);
  assert.equal(conv.retry, null);
});

/** One tool call through pi's event sequence: call, start, partial results, end. */
function runToolCall(conv, { name, args, partials = [], result, isError = false }) {
  conv.onEvent({ type: "message_start", message: { role: "assistant" } });
  conv.onEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: name } });
  conv.onEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "call-1", name, arguments: args } } });
  conv.onEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: name, args });
  for (const partialResult of partials) conv.onEvent({ type: "tool_execution_update", toolCallId: "call-1", partialResult });
  conv.onEvent({ type: "tool_execution_end", toolCallId: "call-1", result, isError });
  return conv.findTool("call-1");
}

test("@tintinweb/pi-subagents Agent calls become agent rows", () => {
  const item = runToolCall(new Conversation(), {
    name: "Agent",
    args: { description: "audit the auth flow", subagent_type: "Explore", prompt: "…" },
    partials: [{ content: [{ type: "text", text: "3 tool uses..." }], details: { toolUses: 3, tokens: "1.2k token", durationMs: 1200, status: "running", subagentType: "Explore", modelName: "anthropic/claude-haiku-4", agentId: "a-7", activity: "grep auth" } }],
    result: { content: [{ type: "text", text: "Agent completed in 9s (5 tool uses, 2.4k tokens).\n\nReport." }], details: { toolUses: 5, tokens: "2.4k token", durationMs: 9000, status: "completed", subagentType: "Explore", modelName: "anthropic/claude-haiku-4", agentId: "a-7" } },
  });
  assert.deepEqual([item.kind, item.agentType, item.model, item.runId, item.agentStatus], ["agent", "Explore", "claude-haiku-4", "a-7", "done"]);
  assert.deepEqual([item.stats.tools, item.stats.tokens], [5, 2400]);
  assert.match(item.output, /Report\./);
});

test("a background Agent stays running until its completion notification settles it", () => {
  const conv = new Conversation();
  const item = runToolCall(conv, {
    name: "Agent",
    args: { description: "long job", subagent_type: "general-purpose", run_in_background: true },
    result: { content: [{ type: "text", text: "Agent started in the background." }], details: { toolUses: 0, tokens: "", durationMs: 0, status: "background", agentId: "a-9" } },
  });
  assert.deepEqual([item.agentStatus, item.background], ["running", true]);
  conv.onEvent({
    type: "message_end",
    message: { role: "custom", customType: "subagent-notification", content: [{ type: "text", text: 'Agent "long job" completed' }], details: { id: "a-9", status: "completed", toolUses: 2, totalTokens: 1200, durationMs: 5000, outputFile: "/tmp/a-9.output", resultPreview: "the finished report" } },
  });
  assert.equal(item.agentStatus, "done");
  assert.deepEqual([item.stats.tools, item.stats.tokens, item.stats.took], [2, 1200, 5000]);
  assert.equal(item.transcriptPath, "/tmp/a-9.output");
  assert.match(item.output, /the finished report/);
  assert.equal(conv.items.some(entry => entry.kind === "custom"), false, "the notification settles the row instead of adding one");
});

test("pi-subagents subagent calls become agent rows", () => {
  const item = runToolCall(new Conversation(), {
    name: "subagent",
    args: { task: "map the parser", agent: "explore" },
    result: { content: [{ type: "text", text: "done" }], details: { results: [{ progress: { toolCount: 4, tokens: 900, durationMs: 3000 } }] } },
  });
  assert.deepEqual([item.kind, item.agentType, item.stats.tools, item.agentStatus], ["agent", "explore", 4, "done"]);
});

test("a reply from a different model is marked once, and an image block is kept", () => {
  const conv = new Conversation();
  conv.loadMessages([
    { role: "user", content: "a" },
    { role: "assistant", model: "one", content: [{ type: "text", text: "x" }] },
    { role: "assistant", model: "one", content: [{ type: "text", text: "y" }] },
    { role: "assistant", model: "prov/two", content: [{ type: "text", text: "z" }, { type: "image", data: "AAAA", mimeType: "image/png" }] },
  ]);
  assert.deepEqual(conv.items.map(item => [item.kind, item.text]), [["user", "a"], ["assistant", "x"], ["assistant", "y"], ["notice", "Model: two"], ["assistant", "z"], ["assistant", ""]]);
  assert.equal(conv.items.at(-1).images.length, 1);
});

test("the context breakdown is exact from the second request on", async () => {
  const { contextBreakdown } = await import("../dist/context.js");
  const conv = new Conversation();
  conv.loadMessages([
    { role: "user", content: "x".repeat(400) },
    // Request 1 sent 3,100 tokens (system, tools and the first message) and the model wrote 50.
    { role: "assistant", content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } }], usage: { input: 100, cacheRead: 3000, cacheWrite: 0, output: 50, totalTokens: 3150 } },
    { role: "toolResult", toolCallId: "b1", content: [{ type: "text", text: "y".repeat(2000) }] },
    // Request 2 sent 3,650: the 3,100, the 50 written, and so exactly 500 of tool result.
    { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 550, cacheRead: 3100, cacheWrite: 0, output: 20, totalTokens: 3670 } },
    { role: "user", content: "and now?" },
    // Request 3 sent 3,690: the 3,650, the 20 written, and exactly 20 of new message.
    { role: "assistant", content: [{ type: "text", text: "now" }], usage: { input: 40, cacheRead: 3650, cacheWrite: 0, output: 5, totalTokens: 3695 } },
  ]);
  const rows = Object.fromEntries(contextBreakdown(conv.items, 3695).map(row => [row.label, [row.value, row.exact]]));
  assert.deepEqual(rows["Written by the model"], [75, true]);
  assert.deepEqual(rows["Tool results"], [500, true]);
  // 100 estimated for the first message (400 characters), 20 counted for the second.
  assert.deepEqual(rows["Your messages"], [120, false]);
  assert.deepEqual(rows["System prompt, tools and summaries"], [3000, false]);
  assert.equal(Object.values(rows).reduce((sum, [value]) => sum + value, 0), 3695, "the rows add up to pi's total");
});
