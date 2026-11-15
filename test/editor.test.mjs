import assert from "node:assert/strict";
import test from "node:test";
import { TextEditor } from "../dist/editor.js";
import { fuzzy, rank } from "../dist/fuzzy.js";

test("typing, undo and redo", () => {
  const editor = new TextEditor();
  editor.insert("hello");
  editor.insert(" ");
  editor.insert("world");
  assert.equal(editor.text, "hello world");
  editor.undo();
  assert.equal(editor.text, "hello ");
  editor.redo();
  assert.equal(editor.text, "hello world");
});

test("an edit event is applied once and rejected when stale", () => {
  const editor = new TextEditor();
  editor.set("abcdef");
  assert.equal(editor.applyEdit({ from: 1, to: 3, text: "X", cursor: 2, len: 6 }), true);
  assert.equal(editor.text, "aXdef");
  assert.equal(editor.cursor, 2);
  assert.equal(editor.applyEdit({ from: 0, to: 1, text: "Z", cursor: 1, len: 6 }), false);
  assert.equal(editor.text, "aXdef");
  editor.undo();
  assert.equal(editor.text, "abcdef");
});

test("a large paste is one chip that expands on submit and deletes whole", () => {
  const editor = new TextEditor();
  const big = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  editor.insert("see ");
  editor.paste(big);
  assert.match(editor.text, /^see \[Pasted text #1 \+30 lines\]$/);
  assert.equal(editor.expanded(), `see ${big}`);
  editor.backspace();
  assert.equal(editor.text, "see ");
  assert.equal(editor.pastes.length, 0);
});

test("vertical motion keeps the column and reports the edges", () => {
  const editor = new TextEditor();
  editor.set("abcd\nxy\nlonger line");
  editor.moveTo(3);
  assert.equal(editor.vertical(-1), false);
  assert.equal(editor.vertical(1), true);
  assert.equal(editor.cursor, 7);
  assert.equal(editor.vertical(1), true);
  assert.equal(editor.cursor, 11);
  assert.equal(editor.vertical(1), false);
});

test("selection, word motion and kill and yank", () => {
  const editor = new TextEditor();
  editor.set("one two three");
  editor.left(true, true);
  assert.deepEqual(editor.selection(), [8, 13]);
  editor.insert("3");
  assert.equal(editor.text, "one two 3");
  editor.home();
  editor.killToEnd();
  assert.equal(editor.text, "");
  editor.yank();
  assert.equal(editor.text, "one two 3");
});

test("an emoji is one step, never half a surrogate pair", () => {
  const editor = new TextEditor();
  editor.set("a👩‍👩‍👧b");
  editor.left();
  editor.left();
  assert.equal(editor.cursor, 1);
  editor.deleteForward();
  assert.equal(editor.text, "ab");
});

test("history recall walks back and returns to the draft", () => {
  const editor = new TextEditor();
  editor.remember("first");
  editor.remember("second");
  editor.insert("draft");
  editor.recall(-1);
  assert.equal(editor.text, "second");
  editor.recall(-1);
  assert.equal(editor.text, "first");
  editor.recall(1);
  editor.recall(1);
  assert.equal(editor.text, "draft");
});

test("fuzzy ranks a prefix over a scattered match and reports hits", () => {
  assert.deepEqual(fuzzy("mod", "model").hits, [[0, 3]]);
  assert.equal(fuzzy("xyz", "model"), null);
  const order = rank("set", ["reset", "settings", "s-e-t"], text => text).map(entry => entry.item);
  assert.equal(order[0], "settings");
  assert.equal(order.length, 3);
});

test("the keymap applies pi's keybindings.json overrides", async () => {
  const { Keymap } = await import("../dist/keymap.js");
  const key = (name, mods = {}) => ({ name, ctrl: false, alt: false, shift: false, meta: false, ...mods });
  const defaults = new Keymap();
  assert.equal(defaults.action(key("l", { ctrl: true })), "app.model.select");
  assert.equal(defaults.action(key("tab", { shift: true })), "app.thinking.cycle");
  assert.equal(defaults.label("app.message.dequeue"), "Alt+↑");
  const custom = new Keymap({ "app.model.select": "Ctrl+Shift+M", "app.tools.expand": [], "app.session.new": ["alt+n"] });
  assert.equal(custom.action(key("l", { ctrl: true })), undefined);
  assert.equal(custom.action(key("m", { ctrl: true, shift: true })), "app.model.select");
  assert.equal(custom.action(key("o", { ctrl: true })), undefined);
  assert.equal(custom.action(key("n", { alt: true })), "app.session.new");
  assert.equal(custom.label("app.tools.expand"), "");
});
