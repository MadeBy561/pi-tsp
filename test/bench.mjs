// How long one frame takes to build and diff as the transcript grows.
// Run with `node test/bench.mjs` after `npm run build`.
import { Conversation } from "../dist/model.js";
import { BlockRegion } from "../dist/region.js";
import { TranscriptView } from "../dist/view/transcript.js";

const noop = () => undefined;
const ctx = { cwd: "/proj", kinds: new Set(["json"]), hour12: false, expandAll: false, hideThinking: false, showImages: true, showUsage: false, awaitingApproval: false, fold: new Map(), shell: new Map(), foldRev: 0, blob: noop, on: { toggle: noop, copy: noop, rewind: noop, editTurn: noop, retry: noop, pickModel: noop, openAgent: noop, open: noop, shell: noop } };
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
