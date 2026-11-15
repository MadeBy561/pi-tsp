import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Session } from "@stencil-hq/tern";

// The surface end to end, with a fake terminal on one side and a fake pi on the other.
process.env.PI_TSP_PI = new URL("./fixtures/fake-pi.mjs", import.meta.url).pathname;
process.env.PI_TSP_HOME = mkdtempSync(join(tmpdir(), "pi-tsp-test-"));
const { App } = await import("../dist/app.js");

const apc = (verb, body) => `\x1b_tsp;${verb};${JSON.stringify(body)}\x1b\\`;
const wait = ms => new Promise(done => setTimeout(done, ms));

/** A terminal that answers `hello`, collects frames and acknowledges them unless told not to. */
async function open({ ack = true } = {}) {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 120 });
  const term = { frames: [], ack, send: (verb, body) => input.write(apc(verb, body)), type: text => input.write(text) };
  let pending = "";
  output.on("data", chunk => {
    pending += chunk.toString("utf8");
    for (;;) {
      const start = pending.indexOf("\x1b_tsp;");
      const end = pending.indexOf("\x1b\\", start);
      if (start < 0 || end < 0) break;
      const inner = pending.slice(start + 6, end);
      pending = pending.slice(end + 2);
      const verb = inner[0];
      const brace = inner.indexOf("{");
      if (brace < 0) continue;
      const body = JSON.parse(inner.slice(brace));
      if (verb === "q" && body.q === "hello") setImmediate(() => term.send("r", { r: "hello", v: 1, term: "tern", ver: "test", kinds: [], features: ["scroll", "settle"], apc: 65536, credits: 2, cols: 120, cell: { w: 8, h: 16 }, dark: false, reduceMotion: false, hour12: false }));
      if (verb === "f") {
        term.frames.push(body);
        // A terminal answers later, never from inside the program's own write.
        if (term.ack) setImmediate(() => term.send("e", { ev: "ack", sf: body.sf, s: body.s }));
      }
    }
  });
  const session = new Session(input, output, { app: "pi-tsp", exitHooks: false, bracketedPaste: false, kittyKeyboard: false });
  assert.equal(await session.handshake(), true);
  const app = new App({ session, args: [], cwd: process.cwd() });
  const running = app.run();
  const ops = () => term.frames.flatMap(frame => frame.ops);
  return { app, term, ops, close: async () => (await app.quit(), await running) };
}

test("a prompt typed into the fake terminal comes back as a streamed reply", async t => {
  const { term, ops, close } = await open();
  t.after(close);
  await wait(400);
  assert.ok(ops().some(op => op[0] === "add" && op[1] === "dock"), "the dock is drawn");
  term.type("hi there\r");
  await wait(600);
  const text = JSON.stringify(ops());
  assert.ok(text.includes("omp.user"), "the prompt is in the transcript");
  assert.ok(text.includes("echo: hi there"), "and the reply after it");
  assert.deepEqual(term.frames.map(frame => frame.s), term.frames.map((_, index) => index + 1), "frames are numbered once each, in order");
  assert.ok(ops().some(op => op[0] === "settle"), "finished blocks are settled");
});

test("a frame Tern rejects is followed by the whole view again", async t => {
  const { term, ops, close } = await open();
  t.after(close);
  await wait(400);
  const before = term.frames.length;
  term.send("e", { ev: "error", sf: "pi", s: 1, op: 0, msg: "unknown node" });
  await wait(300);
  const after = term.frames.slice(before).flatMap(frame => frame.ops);
  assert.ok(after.some(op => op[0] === "del" && op[1] === "main"), "the stale document is dropped");
  assert.ok(after.some(op => op[0] === "add" && op[1] === "main"), "and sent again whole");
  assert.ok(after.some(op => op[0] === "focus"), "the caret is put back");
});

test("a lost acknowledgement stalls drawing for five seconds, not forever", async t => {
  const { app, term, close } = await open({ ack: false });
  t.after(close);
  await wait(400);
  // Two frames are out with no ack: the surface is out of credit.
  const stalled = term.frames.length;
  app.toast("one");
  await wait(100);
  assert.equal(term.frames.length, stalled, "nothing more is sent while blocked");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  app.schedule();
  t.mock.timers.tick(5001);
  app.schedule();
  t.mock.timers.reset();
  await wait(200);
  assert.ok(term.frames.length > stalled, "drawing resumed without the ack");
});
