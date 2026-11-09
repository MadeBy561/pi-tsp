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
  assert.ok(view.main[0].c.length >= 2);
});
