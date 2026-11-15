import assert from "node:assert/strict";
import test from "node:test";
import { TextEditor } from "../dist/editor.js";
import { Vim } from "../dist/vim.js";

function setup(text, cursor = 0) {
  const editor = new TextEditor();
  editor.set(text, cursor);
  const vim = new Vim(editor);
  const type = keys => { for (const key of keys) vim.key(key === "⎋" ? "escape" : key); };
  return { editor, vim, type };
}

test("motions move without editing and stop at the line's last character", () => {
  const { editor, type } = setup("one two three\nfour");
  type("w");
  assert.equal(editor.cursor, 4);
  type("2w");
  assert.equal(editor.cursor, 14);
  type("gg$");
  assert.equal(editor.cursor, 12);
  type("0e");
  assert.equal(editor.cursor, 2);
  type("j");
  assert.equal(editor.cursor, 16);
  assert.equal(editor.text, "one two three\nfour");
});

test("operators take a motion, a count, a doubled key and a text object", () => {
  let t = setup("one two three");
  t.type("dw");
  assert.equal(t.editor.text, "two three");
  t.type("u");
  assert.equal(t.editor.text, "one two three");
  t = setup("a\nb\nc\nd", 2);
  t.type("2dd");
  assert.equal(t.editor.text, "a\nd");
  t.type("p");
  assert.equal(t.editor.text, "a\nd\nb\nc");
  t = setup("say hello world", 6);
  t.type("ciw");
  assert.equal(t.vim.mode, "insert");
  assert.equal(t.editor.text, "say  world");
  t = setup("f(a, b)", 0);
  t.type("dt,");
  assert.equal(t.editor.text, ", b)");
  t = setup("abc", 0);
  t.type("d$");
  assert.equal(t.editor.text, "");
});

test("insert commands, replace and join", () => {
  let t = setup("abc", 1);
  t.type("A");
  assert.deepEqual([t.vim.mode, t.editor.cursor], ["insert", 3]);
  assert.equal(t.vim.key("x"), false, "Insert mode leaves typing to the application");
  t.type("⎋");
  assert.deepEqual([t.vim.mode, t.editor.cursor], ["normal", 2]);
  t.type("rZ");
  assert.equal(t.editor.text, "abZ");
  t = setup("a\n  b");
  t.type("J");
  assert.equal(t.editor.text, "a b");
  t = setup("x");
  t.type("oy");
  assert.equal(t.editor.text, "x\n");
  assert.equal(t.vim.mode, "insert");
});

test("visual modes select, then act", () => {
  let t = setup("one two three");
  t.type("vee");
  assert.deepEqual(t.vim.drawn(), { anchor: 0, cursor: 7 });
  assert.equal(t.vim.label, "VISUAL");
  t.type("d");
  assert.equal(t.editor.text, " three");
  assert.equal(t.vim.mode, "normal");
  t = setup("a\nb\nc", 2);
  t.type("Vy");
  assert.equal(t.editor.register, "b");
  t.type("P");
  assert.equal(t.editor.text, "a\nb\nb\nc");
});

test("escape is the application's only when nothing is pending in Normal mode", () => {
  const { vim, type } = setup("abc");
  assert.equal(vim.key("escape"), false);
  type("2d");
  assert.equal(vim.label, "NORMAL 2d");
  assert.equal(vim.key("escape"), true);
  assert.equal(vim.label, "NORMAL");
  type("z");
  assert.equal(vim.label, "NORMAL");
});
