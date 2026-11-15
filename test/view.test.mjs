import assert from "node:assert/strict";
import test from "node:test";
import { View } from "@stencil-hq/tern";
import { TextEditor } from "../dist/editor.js";
import { nativeEligible } from "../dist/launcher.js";
import { Conversation } from "../dist/model.js";
import { Picker } from "../dist/picker.js";
import { dock, EDITOR_ID } from "../dist/view/dock.js";
import { approvalPanel, completionPopup, fieldInputId, fieldDialog, pickerNode, sheet } from "../dist/view/overlays.js";
import { diffHunks } from "../dist/view/tools.js";
import { TranscriptView } from "../dist/view/transcript.js";
import { h } from "../dist/view/h.js";

const noop = () => undefined;
const ctx = (extra = {}) => ({
  cwd: "/proj", kinds: new Set(["json"]), hour12: false, expandAll: false, hideThinking: false, showImages: true, showUsage: false, showCharts: true, compactTools: false, awaitingApproval: false,
  fold: new Map(), shell: new Map(), foldRev: 0, blob: () => undefined,
  on: { toggle: noop, copy: noop, rewind: noop, editTurn: noop, retry: noop, pickModel: noop, openAgent: noop, open: noop, shell: noop },
  ...extra,
});
const dockOn = { submit: noop, interrupt: noop, pickModel: noop, cycleEffort: noop, showContext: noop, showSession: noop, showAgents: noop, dequeue: noop, detach: noop, togglePlan: noop, edit: noop, undo: noop, send: noop };
const dockState = (extra = {}) => ({ editor: new TextEditor(), attachments: [], vimMode: "", drawn: null, modelName: "m", modelIcon: undefined, effort: "high", reasoning: true, statuses: new Map(), widgets: new Map(), blocked: false, starting: false, activity: "", blob: () => undefined, ...extra });

const session = [
  { role: "user", content: "fix it", timestamp: 1 },
  { role: "assistant", content: [
    { type: "thinking", thinking: "look" }, { type: "text", text: "Reading." },
    { type: "toolCall", id: "r1", name: "read", arguments: { path: "/proj/a.txt" } },
    { type: "toolCall", id: "r2", name: "read", arguments: { path: "/proj/b.txt" } },
    { type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls -la" } },
    { type: "toolCall", id: "e1", name: "edit", arguments: { path: "calc.py", edits: [{ oldText: "a - b", newText: "a + b" }] } },
    { type: "toolCall", id: "x1", name: "mystery_tool", arguments: { query: "q" } },
  ] },
  { role: "toolResult", toolCallId: "r1", content: [{ type: "text", text: "alpha" }] },
  { role: "toolResult", toolCallId: "r2", content: [{ type: "text", text: "one" }] },
  { role: "toolResult", toolCallId: "b1", content: [{ type: "text", text: "total 0" }] },
  { role: "toolResult", toolCallId: "e1", content: [{ type: "text", text: "ok" }], details: { diff: " 1 def add(a, b):\n-2     return a - b\n+2     return a + b\n 3 ", firstChangedLine: 2 } },
  { role: "toolResult", toolCallId: "x1", content: [{ type: "text", text: '{"hits":3}' }] },
  { role: "assistant", content: [{ type: "text", text: "Done." }] },
];

/** Every node of a view by wire id; View.from throws on a duplicate sibling key. */
function index(view) {
  const out = new Map();
  const walk = tree => { assert.equal(out.has(tree.id), false, `duplicate id ${tree.id}`); out.set(tree.id, tree); tree.children.forEach(walk); };
  view.regions.forEach(region => region && walk(region));
  return out;
}

test("a session renders to the recorded node shapes with unique ids", () => {
  const conv = new Conversation();
  conv.loadMessages(session);
  const blocks = new TranscriptView().build(conv, ctx());
  const view = View.from({ main: h("col", { key: "main" }, blocks) });
  const nodes = [...index(view).values()];
  const top = view.regions[0].children.map(tree => [tree.kind, tree.props.role]);
  assert.deepEqual(top, [
    ["card", "omp.user"], ["col", "omp.assistant"], ["tool", "omp.tool.read"], ["tool", "omp.tool.bash"],
    ["tool", "omp.tool.edit"], ["tool", "omp.tool.mystery_tool"], ["col", "omp.assistant"],
  ]);
  const group = view.regions[0].children[2];
  assert.equal(group.props.target, "2 files");
  assert.deepEqual(group.children.map(child => child.props.role), ["omp.tool.file", "omp.tool.file"]);
  const edit = view.regions[0].children[4];
  assert.equal(edit.props.target, "calc.py:2");
  assert.deepEqual(edit.props.meta, ["+1 −1"]);
  assert.deepEqual(edit.children[0].props.hunks, [{ oldStart: 1, newStart: 1, lines: [" def add(a, b):", "-    return a - b", "+    return a + b"] }]);
  assert.equal(nodes.find(tree => tree.kind === "json").props.value.hits, 3);
  assert.equal(nodes.find(tree => tree.props.role === "omp.thinking").props.collapsed, true);
  // Every text prop that is a list holds span objects, never bare strings.
  for (const tree of nodes) for (const key of ["spans", "head", "title", "target", "label"]) {
    const value = tree.props[key];
    if (Array.isArray(value)) for (const part of value) assert.equal(typeof part?.t, "string", `${tree.id}.${key}`);
  }
});

test("an unchanged session diffs to no ops, and a streamed delta to one append", () => {
  const conv = new Conversation();
  conv.loadMessages(session);
  const transcript = new TranscriptView();
  const render = () => View.from({ main: h("col", { key: "main" }, transcript.build(conv, ctx())) });
  const first = render();
  assert.deepEqual(first.ops(render(), "pi"), []);
  conv.onEvent({ type: "message_start", message: { role: "assistant" } });
  conv.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } });
  const second = render();
  conv.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } });
  const ops = second.ops(render(), "pi");
  assert.deepEqual(ops, [["text", ops[0][1], "append", "lo"]]);
});

test("a failed edit shows the error, not a diff of the attempt", () => {
  const conv = new Conversation();
  conv.loadMessages([
    { role: "assistant", content: [{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "a.py", edits: [{ oldText: "x", newText: "y" }] } }] },
    { role: "toolResult", toolCallId: "e1", isError: true, content: [{ type: "text", text: "Error: text not found" }] },
  ]);
  const view = View.from({ main: h("col", { key: "main" }, new TranscriptView().build(conv, ctx())) });
  const edit = view.regions[0].children[0];
  assert.equal(edit.props.status, "error");
  assert.deepEqual(edit.children.map(child => child.kind), ["text"]);
  assert.equal(edit.children[0].props.spans[0].t, "text not found");
});

test("the composer's editor has the id the popup and focus name", () => {
  const conv = new Conversation();
  const view = View.from({ dock: dock(conv, dockState(), dockOn), layer: h("col", { key: "layer" }, [completionPopup([{ id: "model", label: "model", mark: 2 }], 0, noop)]) });
  const nodes = index(view);
  const editor = nodes.get(EDITOR_ID);
  assert.equal(editor.kind, "editor");
  assert.equal(editor.props.sendable, true);
  assert.deepEqual(nodes.get("layer.complete").props.anchor, { caret: EDITOR_ID });
  const list = nodes.get("layer.complete.select.list");
  assert.ok(nodes.has(list.props.selected));
  assert.deepEqual(nodes.get(list.props.selected).props.label, [{ t: "mo", s: "mark" }, { t: "del" }]);
});

test("the composer is not sendable while a dialog owns the keyboard or pi is starting", () => {
  const conv = new Conversation();
  for (const state of [{ blocked: true }, { starting: true }]) {
    const editor = index(View.from({ dock: dock(conv, dockState(state), dockOn) })).get(EDITOR_ID);
    assert.equal(editor.props.sendable, false);
  }
  assert.equal(index(View.from({ dock: dock(conv, dockState({ starting: true }), dockOn) })).get(EDITOR_ID).props.typeahead, true);
});

test("the approval panel lists the request's own choices and names the selected one", () => {
  const panel = approvalPanel(
    { title: "Allow bash?", details: ["rm -rf x"], choices: [{ id: "c0", label: "Allow once", deny: false }, { id: "c1", label: "Always this session", deny: false }, { id: "c2", label: "Deny", deny: true }], selected: "c1", expanded: false },
    { take: noop, approve: noop, deny: noop, expand: noop },
  );
  const nodes = index(View.from({ dock: dock(new Conversation(), dockState({ blocked: true }), dockOn, panel) }));
  const list = nodes.get("dock.approval.choices");
  assert.deepEqual(list.children.map(child => child.props.label), ["Allow once", "Always this session", "Deny"]);
  assert.equal(nodes.get(list.props.selected).props.label, "Always this session");
});

test("a field dialog takes the composer's place and its input has the focus id", () => {
  for (const multiline of [false, true]) {
    const field = fieldDialog({ title: "Name", detail: "", placeholder: "", multiline, editor: new TextEditor() }, { submit: noop, cancel: noop, edit: noop, undo: noop });
    const nodes = index(View.from({ dock: dock(new Conversation(), dockState({ blocked: true }), dockOn, null, field) }));
    assert.equal(nodes.has(EDITOR_ID), false);
    assert.equal(nodes.get(fieldInputId(multiline)).kind, multiline ? "editor" : "input");
  }
});

test("a picker filters by query, keeps the catalogue stable and reports hits", () => {
  const picker = new Picker({
    props: { title: "Models" },
    items: ["alpha/one", "alpha/two", "beta/three"].map(id => ({ id, label: id })),
    searchable: true,
    actions: [{ id: "use", label: "Use", keys: ["enter"], primary: true }, { id: "close", label: "Close", keys: ["esc"], end: true }],
    choose: noop,
  });
  const key = (name, text) => ({ name, text, ctrl: false, alt: false, shift: false, meta: false });
  const before = pickerNode(picker.view(), { select: noop, activate: noop, change: noop });
  for (const ch of "thr") picker.key(key(ch, ch));
  const view = picker.view();
  assert.deepEqual(view.order, ["beta/three"]);
  assert.equal(view.selected, "beta/three");
  assert.deepEqual(view.hits["beta/three"], [[5, 8]]);
  const after = pickerNode(view, { select: noop, activate: noop, change: noop });
  const ops = View.from({ layer: h("col", { key: "layer" }, [before]) }).ops(View.from({ layer: h("col", { key: "layer" }, [after]) }), "pi");
  assert.equal(ops.length, 1);
  assert.equal("items" in ops[0][2], false, "typing does not re-send the catalogue");
  assert.deepEqual(picker.key(key("escape")), { type: "handled" });
  assert.equal(picker.query.text, "");
  assert.deepEqual(picker.key(key("escape")), { type: "close" });
  assert.deepEqual(picker.key(key("enter")), { type: "choose" });
});

test("diffHunks reads pi's unified patch without a phantom last line", () => {
  const hunks = diffHunks({ patch: "--- calc.py\n+++ calc.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a - b\n+    return a + b\n", diff: "ignored" });
  assert.deepEqual(hunks, [{ oldStart: 1, newStart: 1, lines: [" def add(a, b):", "-    return a - b", "+    return a + b"] }]);
});

test("diffHunks splits pi's numbered diff at gaps", () => {
  const hunks = diffHunks({ diff: " 1 a\n-2 b\n+2 B\n   ...\n 40 x\n+41 y" });
  assert.deepEqual(hunks.map(hunk => [hunk.oldStart, hunk.lines.length]), [[1, 3], [40, 2]]);
});

test("only an interactive invocation on a tty gets a surface", () => {
  assert.equal(nativeEligible([], true), true);
  assert.equal(nativeEligible(["--model", "x"], true), true);
  assert.equal(nativeEligible([], false), false);
  for (const args of [["-p", "hi"], ["--version"], ["--mode", "rpc"], ["--mode=json"], ["install", "x"], ["auth"]]) assert.equal(nativeEligible(args, true), false, args.join(" "));
});

test("grep output is grouped per file with its matches marked", () => {
  const conv = new Conversation();
  conv.loadMessages([
    { role: "assistant", content: [{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "add" } }] },
    { role: "toolResult", toolCallId: "g1", content: [{ type: "text", text: "calc.py:2: def add(a, b):\ncalc.py-1- # math\ncalc.py-9- add(1, 2)\ncalc.py:9: add(1, 2)\nlib/x.py:4: add = 1" }] },
  ]);
  const view = View.from({ main: h("col", { key: "main" }, new TranscriptView().build(conv, ctx())) });
  const tool = view.regions[0].children[0];
  assert.deepEqual(tool.props.meta, ["3 matches · 2 files"]);
  const first = tool.children[0];
  assert.equal(first.props.role, "omp.tool.search.file");
  const code = first.children[1];
  assert.deepEqual(code.props.nums, [1, 2, 9]);
  assert.deepEqual(code.props.marks, [{ line: 2, tone: "accent" }, { line: 9, tone: "accent" }]);
  assert.equal(code.props.text, "# math\ndef add(a, b):\nadd(1, 2)");
});

test("a model shows its maker's logo, else its provider's", async () => {
  const { providerIcon } = await import("../dist/provider.js");
  assert.equal(providerIcon("my-gateway", "deepseek-chat"), "provider:deepseek");
  assert.equal(providerIcon("openrouter", "anthropic/claude-sonnet-4"), "provider:anthropic");
  assert.equal(providerIcon("openai", "gpt-5"), "provider:openai");
  assert.equal(providerIcon("groq", "some-model"), "provider:groq");
  assert.equal(providerIcon("", ""), undefined);
});

test("a usage row is drawn per message only when asked for", () => {
  const conv = new Conversation();
  conv.loadMessages([{ role: "assistant", timestamp: 0, content: [{ type: "text", text: "hi" }], usage: { input: 3800, output: 660, cacheRead: 12000, cacheWrite: 0 } }]);
  const roles = extra => View.from({ main: h("col", { key: "main" }, new TranscriptView().build(conv, ctx(extra))) }).regions[0].children.map(tree => tree.props.role);
  assert.deepEqual(roles({}), ["omp.assistant"]);
  assert.deepEqual(roles({ showUsage: true }), ["omp.assistant", "omp.usage.turn"]);
});

test("a shell draft hides its sigil behind a bash chip and highlights as bash", () => {
  const editor = new TextEditor();
  editor.set("!!ls -la");
  const nodes = index(View.from({ dock: dock(new Conversation(), dockState({ editor }), dockOn) }));
  assert.equal(nodes.get("dock.editor").props.role, "omp.editor.bash");
  const input = nodes.get(EDITOR_ID);
  assert.equal(input.props.lang, "bash");
  assert.deepEqual(input.props.decor, [{ from: 0, to: 2, s: "hide" }]);
  assert.deepEqual(nodes.get("dock.editor.line.mode").children.map(child => child.kind), ["text", "icon"]);
});

test("a failed turn pins its error above the composer, opened on demand", async () => {
  const { errorBanner } = await import("../dist/view/dock.js");
  const message = "429 rate limited\nretry after 30s";
  const shape = expanded => index(View.from({ dock: dock(new Conversation(), dockState(), dockOn, [errorBanner(message, expanded, { details: noop, dismiss: noop })]) }));
  const closed = shape(false);
  assert.equal(closed.get("dock.error-banner").props.role, "omp.errorBanner");
  assert.deepEqual(closed.get("dock.error-banner.text").props.spans, [{ t: "429 rate limited", s: "error" }]);
  assert.equal(closed.get("dock.error-banner.details").props.text, "Details");
  assert.equal(shape(true).get("dock.error-banner.text").props.spans[0].t, message);
  assert.ok(closed.has(EDITOR_ID), "the composer stays under the banner");
});

test("the running call with nothing to show is the one awaiting approval", () => {
  const conv = new Conversation();
  conv.onEvent({ type: "message_start", message: { role: "assistant" } });
  conv.onEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "b1", name: "bash", arguments: { command: "rm -rf x" } } } });
  conv.onEvent({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash" });
  const tool = extra => View.from({ main: h("col", { key: "main" }, new TranscriptView().build(conv, ctx(extra))) }).regions[0].children[0];
  assert.equal(tool({}).props.status, "running");
  assert.deepEqual([tool({ awaitingApproval: true }).props.status, tool({ awaitingApproval: true }).props.note], ["pending", "awaiting approval"]);
});

test("the rewind panel names the chosen message and what is left behind", async () => {
  const { rewindPanel } = await import("../dist/view/dock.js");
  const nodes = index(View.from({ dock: dock(new Conversation(), dockState({ blocked: true }), dockOn, null, rewindPanel({ text: "fix it", dropped: 3, index: 1, total: 2 }, { confirm: noop, cancel: noop })) }));
  assert.equal(nodes.get("dock.rewind.title").props.text, "Rewind to message 1 of 2");
  assert.match(nodes.get("dock.rewind.note").props.spans[0].t, /^3 later blocks are left/);
  assert.equal(nodes.has(EDITOR_ID), false);
});

test("a keystroke in the middle of a draft is one splice, not a re-send", async () => {
  const { installSplice, spliceOf } = await import("../dist/splice.js");
  assert.deepEqual(spliceOf("hello world", "hello brave world", false), { at: 6, del: 0, text: "brave " });
  assert.deepEqual(spliceOf("abc", "aXc", false), { at: 1, del: 1, text: "X" });
  assert.equal(spliceOf("abc", "xyz", false), null);
  assert.equal(spliceOf("abc", "Xbc", true), null, "markdown needs a shared prefix");
  assert.deepEqual(spliceOf("a😀b", "a😃b", false), { at: 1, del: 2, text: "😃" }, "never cuts a surrogate pair");
  installSplice();
  const editor = new TextEditor();
  editor.set("hello world");
  const conv = new Conversation();
  const first = View.from({ dock: dock(conv, dockState({ editor }), dockOn) });
  editor.moveTo(6);
  editor.insert("brave ");
  const ops = first.ops(View.from({ dock: dock(conv, dockState({ editor }), dockOn) }), "pi");
  assert.deepEqual(ops.find(op => op[0] === "splice"), ["splice", EDITOR_ID, 6, 0, "brave "]);
  assert.equal(ops.some(op => op[0] === "text"), false);
});

test("a shell command becomes rows of semantic segments for Tern's command pane", async () => {
  const { shellPresentation } = await import("../dist/shell.js");
  const styles = (script, view = "pseudo") => shellPresentation(script, { running: false, failed: false, took: "0.1s" }, { view, color: true }).rows.map(row => row.segments.filter(segment => segment.text.trim()).map(segment => [segment.text, segment.style ?? segment.language ?? ""]));
  assert.deepEqual(styles("ls -la ./src"), [[["ls", "cmd"], ["-la", "arg"], ["./src", "path"]]]);
  assert.deepEqual(styles('FOO=1 grep -n "$HOME" a.txt | wc -l && echo done # count'), [[["FOO=1", "var"], ["grep", "cmd"], ["-n", "arg"], ['"$HOME"', "str"], ["a.txt", "path"], ["|", "op"], ["wc", "cmd"], ["-l", "arg"], ["&&", "op"], ["echo", "cmd"], ["done", ""], ["# count", "comment"]]]);
  assert.deepEqual(styles(`python3 -c "print(1)"`), [[["python3", "cmd"], ["-c", "arg"], ["‹", "emb"], ["print(1)", "py"], ["›", "emb"]]]);
  assert.deepEqual(styles(`python3 -c "print(1)"`, "raw")[0].at(-1), ['"print(1)"', "str"]);
  const done = shellPresentation("rm -rf x\nsudo ls", { running: false, failed: true, took: "2s" }, { view: "pseudo", color: true });
  assert.deepEqual(done.rows.map(row => [row.state, row.meta, row.effects.map(effect => effect.kind)]), [["fail", undefined, ["destructive"]], ["fail", "2s", ["privilege"]]]);
  assert.deepEqual(done.rows[1].range, [9, 16]);
  const live = shellPresentation("sleep 5", { running: true, failed: false }, { view: "pseudo", color: true });
  assert.deepEqual([live.running, live.executing, live.rows[0].active, live.rows[0].state], [true, true, true, undefined]);
});

test("the bash tool uses the command pane when the terminal has one, code otherwise", () => {
  const conv = new Conversation();
  conv.loadMessages([
    { role: "assistant", content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls -la" } }] },
    { role: "toolResult", toolCallId: "b1", content: [{ type: "text", text: "total 0" }] },
  ]);
  const kinds = extra => index(View.from({ main: h("col", { key: "main" }, new TranscriptView().build(conv, ctx(extra))) }));
  const pane = [...kinds({ kinds: new Set(["shell"]) }).values()].find(tree => tree.props.role === "omp.tool.bash.command");
  assert.equal(pane.kind, "shell");
  assert.equal(pane.props.presentation.rows[0].segments[0].style, "cmd");
  assert.equal([...kinds({ kinds: new Set() }).values()].some(tree => tree.kind === "shell"), false);
});

test("a table of numbers in a reply is followed by a bar chart, once it has arrived", async () => {
  const { chartTables, withCharts } = await import("../dist/chart.js");
  const text = "Timings:\n\n| Step | Time |\n|---|---|\n| build | 120 ms |\n| test | 1,450 ms |\n| lint | 80 ms |\n\nDone.";
  const [table] = chartTables(text, false);
  assert.deepEqual([table.title, table.unit, table.rows], ["Time by Step", "ms", [{ label: "build", value: 120 }, { label: "test", value: 1450 }, { label: "lint", value: 80 }]]);
  const parts = withCharts(text, false);
  assert.deepEqual(parts.map(part => part.chart), [false, true, false]);
  assert.match(parts[1].text, /^```svg\n<svg[^>]*aria-label="bar chart of Time by Step"/);
  assert.ok(parts[1].text.includes('fill="var(--accent)"') && !/#[0-9a-f]{3,6}"/i.test(parts[1].text), "theme colours, never baked ones");
  assert.equal(parts[2].text, "Done.");
  assert.deepEqual(withCharts("| a | b |\n|---|---|\n| x | y |\n| z | w |", false).map(part => part.chart), [false], "no numbers, no chart");
  assert.equal(chartTables("| Step | Time |\n|---|---|\n| a | 1 |\n| b | 2 |", true).length, 0, "a table still arriving gets none");
  const conv = new Conversation();
  conv.loadMessages([{ role: "assistant", content: [{ type: "text", text }] }]);
  const kinds = extra => View.from({ main: h("col", { key: "main" }, new TranscriptView().build(conv, ctx(extra))) }).regions[0].children[0].children.map(tree => tree.props.role ?? "md");
  assert.deepEqual(kinds({}), ["md", "omp.figure", "md"]);
  assert.deepEqual(kinds({ showCharts: false }), ["md"]);
});

test("an invoked skill is a chip with its text folded away, not a wall of prompt", () => {
  const conv = new Conversation();
  conv.loadMessages([{ role: "user", content: '<skill name="review" location="/skills/review/SKILL.md">\nReferences are relative to /skills/review.\n\nRead the diff.\nList risks.\n</skill>\n\nfocus on auth' }]);
  const card = View.from({ main: h("col", { key: "main" }, new TranscriptView().build(conv, ctx())) }).regions[0].children[0];
  assert.equal(card.props.role, "omp.skill");
  assert.deepEqual(card.props.head.map(span => span.t), ["review", "  4 lines"]);
  assert.deepEqual(card.children.map(child => [child.kind, child.props.collapsed]), [["md", undefined], ["section", true]]);
  assert.equal(card.children[0].props.text, "focus on auth");
});

test("compact mode closes a run of calls into one gapless group of one-line rows", () => {
  const conv = new Conversation();
  conv.loadMessages(session);
  const top = extra => View.from({ main: h("col", { key: "main" }, new TranscriptView().build(conv, ctx(extra))) }).regions[0].children;
  const group = top({ compactTools: true }).find(tree => tree.props.role === "omp.compact");
  assert.equal(group.props.gap, "none");
  assert.deepEqual(group.children.map(child => [child.props.role, child.props.frame]), [["omp.tool.read", "inline"], ["omp.tool.bash", "inline"], ["omp.tool.edit", "inline"], ["omp.tool.mystery_tool", "inline"]]);
  assert.equal(top({}).some(tree => tree.props.role === "omp.compact"), false);
});

test("a run that ends with todos open leaves a reminder of them", () => {
  const conv = new Conversation();
  conv.onEvent({ type: "agent_start" });
  conv.onEvent({ type: "message_start", message: { role: "assistant" } });
  conv.onEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "t1", name: "todo", arguments: { action: "add" } } } });
  conv.onEvent({ type: "tool_execution_end", toolCallId: "t1", result: { content: [], details: { todos: [{ id: 1, text: "ship it", done: false }, { id: 2, text: "wrote it", done: true }] } } });
  conv.onEvent({ type: "agent_settled" });
  const reminder = View.from({ main: h("col", { key: "main" }, new TranscriptView().build(conv, ctx())) }).regions[0].children.at(-1);
  assert.deepEqual([reminder.kind, reminder.props.role, reminder.props.mode], ["checklist", "omp.notice.todo", "reminder"]);
  assert.deepEqual(reminder.props.phases[0].items.map(item => item.text), ["ship it"]);
});

test("background subagents still running show as a pill above the composer", () => {
  const conv = new Conversation();
  const nodes = () => index(View.from({ dock: dock(conv, dockState(), dockOn) }));
  assert.equal(nodes().has("dock.hud"), false);
  conv.onEvent({ type: "message_start", message: { role: "assistant" } });
  conv.onEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "a1", name: "Agent", arguments: { description: "long job", run_in_background: true } } } });
  conv.onEvent({ type: "tool_execution_end", toolCallId: "a1", result: { content: [], details: { status: "background", agentId: "a-1" } } });
  const pill = nodes().get("dock.hud.jobs");
  assert.equal(pill.props.role, "omp.hud.jobs");
  assert.deepEqual(pill.children.map(child => child.kind), ["spinner", "text", "elapsed"]);
  assert.equal(pill.children[1].props.spans[0].t, "long job");
  conv.onEvent({ type: "message_end", message: { role: "custom", customType: "subagent-notification", content: "done", details: { id: "a-1", status: "completed" } } });
  assert.equal(nodes().has("dock.hud"), false);
});

test("the trace extension keeps line numbers and times, never the expanded text", async () => {
  const { parseTrace } = await import("../ext/trace.ts");
  const raw = "+\t100.000000\t2\techo hi\n+\t100.010000\t3\texport TOKEN=sk-secret\n++\t100.020500\t4\tdate +%s\nnoise\n+\t100.030000\t4\tx=1";
  const { steps, trimmed } = parseTrace(raw);
  assert.deepEqual(steps, [{ line: 1, at: 0, depth: 1 }, { line: 2, at: 10, depth: 1 }, { line: 3, at: 20.5, depth: 2 }, { line: 3, at: 30, depth: 1 }]);
  assert.equal(trimmed, false);
  assert.equal(JSON.stringify(steps).includes("secret"), false);
  const { usesTracing } = await import("../ext/trace.ts");
  for (const command of ["set -x; make", "set -euxo pipefail\nls", "set -o xtrace", "PS4='> ' bash build.sh", "exec 5>log; BASH_XTRACEFD=5"]) assert.equal(usesTracing(command), true, command);
  for (const command of ["ls -la", "set -e; make", "tar -xzf a.tgz", "bash -x build.sh"]) assert.equal(usesTracing(command), false, command);
});

test("a traced run shows what happened on each line, and replays step by step", async () => {
  const { shellPresentation } = await import("../dist/shell.js");
  const script = "echo hi\nfor i in 1 2; do sleep 1; done\nfalse\necho never";
  const trace = { steps: [{ line: 1, at: 0, depth: 1 }, { line: 2, at: 5, depth: 1 }, { line: 2, at: 1005, depth: 1 }, { line: 3, at: 2005, depth: 1 }] };
  const at = cursor => shellPresentation(script, { running: false, failed: true, tookMs: 2010 }, { view: "pseudo", color: true, ...(cursor === undefined ? {} : { cursor }) }, trace);
  const done = at(undefined);
  assert.deepEqual(done.rows.map(row => [row.state, row.meta]), [["ok", "5ms"], ["ok", "2.0s ×2"], ["fail", "5ms"], ["skipped", undefined]]);
  assert.deepEqual(done.timeline, { length: 4, cursor: 4, elapsedNs: 2010e6, durationNs: 2010e6 });
  assert.equal(done.preferences.cursor, undefined);
  const mid = at(2);
  assert.deepEqual(mid.rows.map(row => [row.state, row.active]), [["ok", false], ["running", true], ["pending", false], ["pending", false]]);
  assert.deepEqual([mid.preferences.cursor, mid.running, mid.timeline.cursor], [2, true, 2]);
  assert.deepEqual(at(0).rows.map(row => row.state), ["running", "pending", "pending", "pending"]);
});

test("a sheet keeps its buttons in the overlay's footer, clear of a long body", () => {
  const body = Array.from({ length: 200 }, (_, i) => h("text", { key: `l${i}`, text: `line ${i}` }));
  const ops = View.from({ layer: h("col", { key: "layer" }) }).ops(View.from({ layer: h("col", { key: "layer" }, [sheet("agent", "Report", "lg", body, noop)]) }), "pi");
  const wire = JSON.stringify(ops);
  assert.match(wire, /"foot":"layer\.agent\.foot"/, "the overlay names its footer");
  assert.match(wire, /layer\.agent\.foot\.close/, "Close is a child of the footer");
  assert.doesNotMatch(wire, /layer\.agent\.actions/);
});
