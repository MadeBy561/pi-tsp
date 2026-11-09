/**
 * TSP wire protocol: framing, blobs, and the credit-aware surface differ.
 *
 * The surface tree is rebuilt from a plain snapshot on every render; this
 * module diffs it against what Tern has and emits the smallest ops it can.
 * Streaming text becomes `text append`, which is what keeps long answers
 * smooth: no node is re-sent, only the new characters.
 */
import { createHash } from "node:crypto";

const ST = "\x1b\\";
const APC_OPEN = "\x1b_tsp;";

export const TEXT_KINDS = new Set([
  "text", "md", "code", "ansi", "math", "editor", "input", "shimmer", "el",
]);

function stable(value) {
  return JSON.stringify(value);
}

export class TspLink {
  constructor(out = process.stdout, apc = 65536) {
    this.out = out;
    this.apc = Math.max(1024, apc);
    this.chunk = 0;
    this.written = 0;
    this.frames = 0;
  }

  encode(verb, body, params = null) {
    const json = JSON.stringify(body);
    const head = params
      ? `${APC_OPEN}${verb};${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(";")};`
      : `${APC_OPEN}${verb};`;
    if (json.length + 128 <= this.apc) return head + json + ST;
    // Chunked: Tern reads the pieces back whole when `c` matches and `m=1`
    // marks every piece but the last.
    this.chunk += 1;
    const token = this.chunk.toString(16);
    const limit = Math.max(1024, this.apc - 128);
    let out = "";
    let pos = 0;
    let first = true;
    while (pos < json.length) {
      const piece = json.slice(pos, pos + limit);
      pos += piece.length;
      const last = pos >= json.length;
      const extra = [];
      if (!params) extra.push(`c=${token}`);
      if (first && body && body.__mime) extra.push(`mime=${body.__mime}`);
      if (!last) extra.push("m=1");
      const p = params ? `${params};${extra.join(";")}` : extra.join(";");
      out += `${APC_OPEN}${verb};${p};${piece}${ST}`;
      first = false;
    }
    return out;
  }

  write(text) {
    this.written += text.length;
    this.out.write(text);
  }

  query(body) {
    this.write(this.encode("q", body));
  }

  da1() {
    this.write("\x1b[c");
  }

  open(body) {
    this.write(this.encode("o", body));
  }

  frame(body) {
    this.frames += 1;
    if (process.env.PI_TSP_FRAME_OPS) {
      try {
        const { appendFileSync } = process.getBuiltinModule("node:fs");
        appendFileSync(process.env.PI_TSP_FRAME_OPS, `${JSON.stringify({ t: Date.now(), s: body.s, ops: body.ops })}\n`);
      } catch {
        /* best effort */
      }
    }
    if (process.env.PI_TSP_FRAME_LOG) {
      try {
        const { appendFileSync } = process.getBuiltinModule("node:fs");
        appendFileSync(process.env.PI_TSP_FRAME_LOG, `${JSON.stringify({ t: Date.now(), s: body.s, ops: body.ops.length, bytes: JSON.stringify(body).length })}\n`);
      } catch {
        /* best effort */
      }
    }
    this.write(this.encode("f", body));
  }

  palette(body) {
    this.write(this.encode("t", body));
  }

  stylesheet(body) {
    this.write(this.encode("s", body));
  }

  close(id, keep = true) {
    this.write(this.encode("x", { id, keep }));
  }

  blob(bytes, mime = "application/octet-stream") {
    const id = createHash("sha256").update(bytes).digest("hex");
    const data = Buffer.isBuffer(bytes) ? bytes.toString("base64") : Buffer.from(bytes).toString("base64");
    const limit = Math.max(1024, this.apc - 160);
    const token = (++this.chunk).toString(16);
    let pos = 0;
    let first = true;
    while (pos < data.length) {
      const piece = data.slice(pos, pos + limit);
      pos += piece.length;
      const last = pos >= data.length;
      const params = `${first ? `mime=${mime};` : ""}c=${token};${last ? "" : "m=1;"}`;
      this.write(`${APC_OPEN}b;${params}${piece}${ST}`);
      first = false;
    }
    return id;
  }
}

function flatten(node, out, order) {
  if (!node) return;
  out.set(node.id, node);
  order.set(node.id, (node.c || []).map((child) => child.id));
  for (const child of node.c || []) flatten(child, out, order);
}

/**
 * A live document: the last tree Tern acknowledged plus the newest desired
 * tree. Tern allows only `credits` unacknowledged frames, so a fast producer
 * coalesces into one pending snapshot instead of building a backlog.
 */
export class SurfaceDoc {
  constructor(link, sf, credits = 2) {
    this.link = link;
    this.sf = sf;
    this.credits = Math.max(1, credits);
    this.seq = 0;
    this.unacked = new Set();
    this.sent = new Map();
    this.order = new Map();
    this.regions = { main: [], dock: [], layer: [] };
    this.desired = null;
    this.dirty = false;
    this.extra = [];
    this.opCount = 0;
    this.lastOps = 0;
    this.onFlush = null;
  }

  setRegions(regions, extra = null) {
    this.regions = { main: [], dock: [], layer: [], ...regions };
    if (extra) this.extra.push(...extra);
    this.dirty = true;
    this.flush();
  }

  sendOps(ops) {
    if (!ops.length) return;
    if (this.unacked.size >= this.credits) {
      this.extra.push(...ops);
      this.dirty = true;
      return;
    }
    this.seq += 1;
    this.unacked.add(this.seq);
    this.link.frame({ sf: this.sf, s: this.seq, ops });
    this.opCount += ops.length;
    this.lastOps = ops.length;
  }

  ack(seq) {
    for (const value of [...this.unacked]) if (value <= seq) this.unacked.delete(value);
    if (this.dirty) this.flush();
  }

  flush() {
    if (!this.dirty || this.unacked.size >= this.credits) return;
    const desired = new Map();
    const order = new Map();
    const roots = [];
    for (const [, list] of Object.entries(this.regions)) {
      for (const root of list || []) {
        roots.push(root);
        flatten(root, desired, order);
      }
    }
    const ops = [];
    if (this.sent.size === 0) {
      for (const root of roots) {
        ops.push(["add", root.id, this.sf, null, root]);
      }
    } else {
      for (const root of roots) ops.push(...this.diffNode(root, desired));
      // A region dropped from the view has its root removed.
      const wanted = new Set(roots.map((root) => root.id));
      for (const id of [...this.order.keys()]) {
        if (!this.sent.has(id) && !wanted.has(id)) continue;
      }
    }
    if (this.extra.length) {
      ops.push(...this.extra);
      this.extra = [];
    }
    if (!ops.length) {
      this.dirty = false;
      return;
    }
    this.seq += 1;
    this.unacked.add(this.seq);
    this.sent = desired;
    this.order = order;
    this.dirty = false;
    this.link.frame({ sf: this.sf, s: this.seq, ops });
    this.opCount += ops.length;
    this.lastOps = ops.length;
    this.onFlush?.(ops);
  }

  diffNode(node, desired) {
    const old = this.sent.get(node.id);
    const ops = [];
    if (!old) return ops;
    if (old.k !== node.k) {
      // The parent's child loop replaces the node; nothing to diff here.
      return ops;
    }
    const oldProps = old.p || {};
    const newProps = node.p || {};
    if (TEXT_KINDS.has(node.k)) {
      const before = oldProps.text || "";
      const after = newProps.text || "";
      if (before !== after) {
        if (after.startsWith(before)) ops.push(["text", node.id, "append", after.slice(before.length)]);
        else ops.push(["text", node.id, "replace", after]);
      }
    }
    const setProps = {};
    for (const [key, value] of Object.entries(newProps)) {
      if (key === "text" && TEXT_KINDS.has(node.k)) continue;
      if (stable(oldProps[key]) !== stable(value)) setProps[key] = value;
    }
    for (const key of Object.keys(oldProps)) {
      if (!(key in newProps) && !(key === "text" && TEXT_KINDS.has(node.k))) setProps[key] = null;
    }
    if (Object.keys(setProps).length) ops.push(["set", node.id, setProps]);

    const oldChildren = this.order.get(node.id) || [];
    const newChildren = node.c || [];
    const newIds = newChildren.map((child) => child.id);
    for (const id of oldChildren) {
      if (!newIds.includes(id) && this.sent.has(id)) ops.push(["del", id]);
    }
    // Siblings must be inserted last-to-first: `before` may only name a
    // child that already exists when the op lands.
    for (let at = newChildren.length - 1; at >= 0; at -= 1) {
      const child = newChildren[at];
      const before = at + 1 < newIds.length ? newIds[at + 1] : null;
      const oldChild = this.sent.get(child.id);
      if (!oldChild) {
        ops.push(["add", child.id, node.id, before, child]);
        this.register(child, desired);
      } else if (oldChild.k !== child.k) {
        // A tool promoted to an agent row: replace it in place.
        ops.push(["del", child.id]);
        ops.push(["add", child.id, node.id, before, child]);
        this.register(child, desired);
      } else {
        ops.push(...this.diffNode(child, desired));
      }
    }
    return ops;
  }

  register(node, desired) {
    this.sent.set(node.id, node);
    desired.set(node.id, node);
    this.order.set(node.id, (node.c || []).map((child) => child.id));
    for (const child of node.c || []) this.register(child, desired);
  }

  reveal(id, at = "end") {
    this.sendOps([["reveal", id, at]]);
  }

  settle(id) {
    this.sendOps([["settle", id]]);
  }
}

/**
 * Split TSP messages from ordinary keystrokes arriving on the same pty.
 * Returns { events, keys } where keys is a Buffer of everything else.
 */
export class TspInbound {
  constructor() {
    this.buffer = "";
  }

  feed(chunk) {
    this.buffer += chunk;
    const events = [];
    let keys = "";
    for (;;) {
      const start = this.buffer.indexOf(APC_OPEN);
      if (start < 0) break;
      const end = this.buffer.indexOf(ST, start + APC_OPEN.length);
      if (end < 0) break;
      keys += this.buffer.slice(0, start);
      const inner = this.buffer.slice(start + 6, end);
      this.buffer = this.buffer.slice(end + 2);
      const semi = inner.indexOf(";");
      const verb = semi < 0 ? inner : inner.slice(0, semi);
      const brace = inner.indexOf("{", semi + 1);
      if (brace < 0) continue;
      try {
        const body = JSON.parse(inner.slice(brace));
        events.push({ verb, body });
      } catch {
        /* a torn or non-JSON APC: ignore it rather than feeding it to the editor */
      }
    }
    // Keep an incomplete APC prefix for the next chunk.
    const open = this.buffer.indexOf(APC_OPEN);
    if (open < 0) {
      keys += this.buffer;
      this.buffer = "";
    } else {
      keys += this.buffer.slice(0, open);
      this.buffer = this.buffer.slice(open);
    }
    return { events, keys: Buffer.from(keys, "utf8") };
  }
}
