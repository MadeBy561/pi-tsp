import assert from "node:assert/strict";
import test from "node:test";
import { View } from "@stencil-hq/tern";
import { BlockRegion } from "../dist/region.js";
import { h } from "../dist/view/h.js";

/** A document that applies frame ops, as the terminal does; it throws on an op a terminal would reject. */
class Doc {
  nodes = new Map();
  add(node, parent, before) {
    assert.equal(this.nodes.has(node.id), false, `add of existing ${node.id}`);
    const entry = { id: node.id, k: node.k, p: { ...(node.p ?? {}) }, c: [], parent };
    this.nodes.set(node.id, entry);
    const siblings = this.nodes.get(parent)?.c;
    if (siblings) {
      if (before === null) siblings.push(node.id);
      else {
        assert.ok(siblings.includes(before), `before ${before} is not a child of ${parent}`);
        siblings.splice(siblings.indexOf(before), 0, node.id);
      }
    }
    for (const child of node.c ?? []) this.add(child, node.id, null);
  }
  del(id) {
    const entry = this.nodes.get(id);
    assert.ok(entry, `del of missing ${id}`);
    for (const child of [...entry.c]) this.del(child);
    const siblings = this.nodes.get(entry.parent)?.c;
    if (siblings) siblings.splice(siblings.indexOf(id), 1);
    this.nodes.delete(id);
  }
  apply(ops) {
    for (const op of ops) {
      if (op[0] === "add") this.add(op[4], op[2], op[3]);
      else if (op[0] === "del") this.del(op[1]);
      else if (op[0] === "set") {
        const entry = this.nodes.get(op[1]);
        assert.ok(entry, `set of missing ${op[1]}`);
        for (const [key, value] of Object.entries(op[2])) value === null ? delete entry.p[key] : (entry.p[key] = value);
      } else if (op[0] === "text") {
        const entry = this.nodes.get(op[1]);
        assert.ok(entry, `text of missing ${op[1]}`);
        entry.p.text = op[2] === "append" ? (entry.p.text ?? "") + op[3] : op[3];
      } else if (op[0] === "move") {
        const entry = this.nodes.get(op[1]);
        const siblings = this.nodes.get(op[2]).c;
        siblings.splice(siblings.indexOf(op[1]), 1);
        if (op[3] === null) siblings.push(op[1]);
        else siblings.splice(siblings.indexOf(op[3]), 0, op[1]);
        entry.parent = op[2];
      } else assert.fail(`unexpected op ${op[0]}`);
    }
  }
  tree(id) {
    const entry = this.nodes.get(id);
    return { id, k: entry.k, ...(Object.keys(entry.p).length ? { p: entry.p } : {}), ...(entry.c.length ? { c: entry.c.map(child => this.tree(child)) } : {}) };
  }
}

const user = (key, text) => h("card", { key, role: "omp.user" }, [h("md", { key: "text", text })]);
const tool = (key, status, body) => h("tool", { key, name: "bash", status }, body ? [h("ansi", { key: "out", text: body })] : []);
const expected = nodes => View.from({ main: h("col", {}, nodes) }).regions[0].wire().c ?? [];

test("block-by-block ops leave the same document as a whole-view diff would", () => {
  const region = new BlockRegion("main");
  const doc = new Doc();
  doc.nodes.set("pi", { id: "pi", k: "surface", p: {}, c: [] });
  const check = (nodes, label) => {
    doc.apply(region.ops(nodes, "pi"));
    assert.deepEqual(doc.tree("main").c ?? [], expected(nodes), label);
  };
  const a = user("a", "first");
  const b = tool("b", "running", "");
  check([a, b], "first frame");
  const b2 = tool("b", "running", "out");
  check([a, b2], "a child appears in one block");
  const c = user("c", "second");
  check([a, b2, c], "a block is appended");
  const b3 = tool("b", "done", "output");
  check([a, b3, c], "a block in the middle changes");
  check([c, a, b3], "blocks move");
  check([c, b3], "a block is removed");
  const b4 = h("agent", { key: "b", name: "x", status: "running" });
  check([c, b4], "a block changes kind in place");
  check([a, c, b4, user("d", "third")], "blocks added at both ends");
  region.reset();
  const before = region.ops([a], "pi");
  assert.deepEqual(before[0], ["del", "main"], "after a reset the region is dropped and sent whole");
  doc.apply(before);
  assert.deepEqual(doc.tree("main").c, expected([a]));
});

test("an unchanged block costs nothing and a streamed delta is one append", () => {
  const region = new BlockRegion("main");
  const blocks = Array.from({ length: 500 }, (_, index) => user(`u${index}`, `message ${index}`));
  region.ops([...blocks, h("md", { key: "live", text: "Hel" })], "pi");
  assert.deepEqual(region.ops([...blocks, h("md", { key: "live", text: "Hel" })], "pi"), [], "an equal node rebuilt is no op");
  assert.deepEqual(region.ops([...blocks, h("md", { key: "live", text: "Hello" })], "pi"), [["text", "main.live", "append", "lo"]]);
});

test("the region finds its nodes by wire id and runs their handlers", () => {
  const region = new BlockRegion("main");
  const seen = [];
  const section = h("section", { key: "k1", collapsible: true, onToggle: event => seen.push(["toggle", event.collapsed]) }, [h("icon", { key: "copy", name: "copy", onClick: () => seen.push(["click"]) })]);
  region.ops([section], "pi");
  assert.equal(region.find("main.k1.copy").kind, "icon");
  assert.equal(region.dispatch({ ev: "toggle", sf: "pi", id: "main.k1", collapsed: true }), true);
  assert.equal(region.dispatch({ ev: "action", sf: "pi", id: "main.k1.copy", act: "click" }), true);
  assert.equal(region.dispatch({ ev: "action", sf: "pi", id: "main.k1.copy", act: "other" }), false);
  assert.equal(region.dispatch({ ev: "toggle", sf: "pi", id: "dock.editor", collapsed: true }), false);
  assert.deepEqual(seen, [["toggle", true], ["click"]]);
  assert.throws(() => region.ops([section, h("md", { key: "k1", text: "" })], "pi"), /key/);
});
