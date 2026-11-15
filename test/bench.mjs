// How long one frame takes to build and diff as the transcript grows.
// Run with `node test/bench.mjs` after `npm run build`.
import { Conversation } from "../dist/model.js";
import { BlockRegion } from "../dist/region.js";
import { TranscriptView } from "../dist/view/transcript.js";

const noop = () => undefined;
const ctx = { cwd: "/proj", kinds: new Set(["json"]), hour12: false, expandAll: false, hideThinking: false, showImages: true, showUsage: false, showCharts: true, compactTools: false, awaitingApproval: false, fold: new Map(), shell: new Map(), foldRev: 0, blob: noop, on: { toggle: noop, copy: noop, rewind: noop, editTurn: noop, retry: noop, pickModel: noop, openAgent: noop, open: noop, shell: noop } };
const body = "A paragraph of answer text with `code` and **emphasis** in it. ".repeat(12);

for (const turns of [50, 500, 2000]) {
  const messages = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ role: "user", content: `question ${turn}` });
    messages.push({ role: "assistant", content: [{ type: "thinking", thinking: body }, { type: "text", text: body }, { type: "toolCall", id: `b${turn}`, name: "bash", arguments: { command: `echo ${turn}` } }, { type: "toolCall", id: `e${turn}`, name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] } }] });
    messages.push({ role: "toolResult", toolCallId: `b${turn}`, content: [{ type: "text", text: `${turn}\n`.repeat(40) }] });
    messages.push({ role: "toolResult", toolCallId: `e${turn}`, content: [{ type: "text", text: "ok" }], details: { diff: " 1 x\n-2 a\n+2 b" } });
  }
  const conv = new Conversation();
  conv.loadMessages(messages);
  const transcript = new TranscriptView();
  const region = new BlockRegion("main");
  const cold = performance.now();
  region.ops(transcript.build(conv, ctx), "pi");
  const coldMs = performance.now() - cold;
  conv.onEvent({ type: "message_start", message: { role: "assistant" } });
  const frames = 200;
  let ops = 0;
  const start = performance.now();
  for (let frame = 0; frame < frames; frame += 1) {
    conv.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "word " } });
    ops += region.ops(transcript.build(conv, ctx), "pi").length;
  }
  const perFrame = (performance.now() - start) / frames;
  console.log(`${String(conv.items.length).padStart(6)} items  first frame ${coldMs.toFixed(1).padStart(7)} ms  streamed frame ${perFrame.toFixed(2).padStart(6)} ms  ${(ops / frames).toFixed(1)} ops/frame`);
}

// The other paths a keystroke or an event takes.
const { View } = await import("@stencil-hq/tern");
const { TextEditor } = await import("../dist/editor.js");
const { rank } = await import("../dist/fuzzy.js");
const { Picker } = await import("../dist/picker.js");
const { dock } = await import("../dist/view/dock.js");
const { h } = await import("../dist/view/h.js");
const { pickerNode } = await import("../dist/view/overlays.js");
const time = (label, runs, fn) => {
  const start = performance.now();
  for (let run = 0; run < runs; run += 1) fn(run);
  console.log(`${label.padEnd(44)} ${((performance.now() - start) / runs).toFixed(3).padStart(8)} ms`);
};
const pressed = ch => ({ name: ch, text: ch, ctrl: false, alt: false, shift: false, meta: false });
for (const count of [200, 2000]) {
  const picker = new Picker({ props: { title: "Models" }, items: Array.from({ length: count }, (_, i) => ({ id: `p${i % 20}/model-${i}`, label: `p${i % 20}/model-${i}-turbo`, facts: { ctx: "200K" } })), searchable: true, actions: [], choose: noop });
  const render = () => View.from({ layer: h("col", { key: "layer" }, [pickerNode(picker.view(), { select: noop, activate: noop, change: noop })]) });
  let view = render();
  time(`picker keystroke, ${count} items`, 40, run => {
    picker.key(pressed("model1turbo"[run % 11]));
    const next = render();
    view.ops(next, "pi");
    view = next;
  });
}
const editor = new TextEditor();
const draft = new Conversation();
const dockOn = { submit: noop, interrupt: noop, pickModel: noop, cycleEffort: noop, showContext: noop, showSession: noop, showAgents: noop, dequeue: noop, detach: noop, togglePlan: noop, edit: noop, undo: noop, send: noop };
const dockState = () => ({ editor, attachments: [], vimMode: "", drawn: null, modelName: "m", modelIcon: undefined, effort: "high", reasoning: true, statuses: new Map(), widgets: new Map(), blocked: false, starting: false, activity: "", blob: noop });
let docked = View.from({ dock: dock(draft, dockState(), dockOn) });
time("composer keystroke (build and diff the dock)", 2000, () => {
  editor.insert("x");
  const next = View.from({ dock: dock(draft, dockState(), dockOn) });
  docked.ops(next, "pi");
  docked = next;
});
const files = Array.from({ length: 20000 }, (_, i) => `src/dir${i % 300}/module-${i}/file${i}.ts`);
time("@ completion over 20,000 files", 20, run => rank(`mod${run}fi`, files, file => file).slice(0, 50));
