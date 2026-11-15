/**
 * Vim keys for the composer: Normal, Insert, Visual and Visual-line modes
 * over a `TextEditor`, with counts, the common motions, the `d` `c` `y`
 * operators and the everyday commands.
 */
import type { TextEditor } from "./editor.js";

export type VimMode = "insert" | "normal" | "visual" | "visual-line";

type Operator = "d" | "c" | "y";

/** Where a motion lands, and whether an operator over it takes whole lines or the end character. */
interface Target {
  at: number;
  linewise?: boolean;
  inclusive?: boolean;
}

const isWord = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

export class Vim {
  mode: VimMode = "normal";
  #editor: TextEditor;
  #count = "";
  #operator: Operator | null = null;
  /** A key waiting for its second half: `g`, `f`/`t` and friends, `r`, or a text object's `i`/`a`. */
  #pending = "";
  #find: { key: string; ch: string } | null = null;
  #linewiseRegister = false;

  constructor(editor: TextEditor) {
    this.#editor = editor;
  }

  /** The label the editor shows, empty in Insert mode. */
  get label(): string {
    const pending = `${this.#count}${this.#operator ?? ""}${this.#pending}`;
    const name = { insert: "", normal: "NORMAL", visual: "VISUAL", "visual-line": "V-LINE" }[this.mode];
    return name && pending ? `${name} ${pending}` : name;
  }

  /** The selection anchor to draw, widened to whole lines in Visual-line mode. */
  get selecting(): boolean {
    return this.mode === "visual" || this.mode === "visual-line";
  }

  reset(): void {
    this.mode = "insert";
    this.#clear();
  }

  #clear(): void {
    this.#count = "";
    this.#operator = null;
    this.#pending = "";
  }

  #setMode(mode: VimMode): void {
    const editor = this.#editor;
    if (mode === "visual" || mode === "visual-line") editor.anchor ??= editor.cursor;
    else editor.anchor = null;
    if (mode === "normal" && this.mode === "insert" && editor.cursor > editor.lineStart()) editor.moveTo(editor.cursor - 1);
    this.mode = mode;
    this.#clear();
  }

  /**
   * Takes one key: `escape`, or what the key types. Returns false when Vim
   * leaves it to the application (Insert mode typing, Escape with nothing
   * pending in Normal mode).
   */
  key(key: string): boolean {
    if (this.mode === "insert") {
      if (key !== "escape") return false;
      this.#setMode("normal");
      return true;
    }
    if (key === "escape") {
      if (this.mode === "normal" && !this.#count && !this.#operator && !this.#pending) return false;
      this.#setMode("normal");
      return true;
    }
    if (key.length !== 1 && key !== "\n") return true;
    this.#normal(key);
    return true;
  }

  #lines(): [number, number] {
    const editor = this.#editor;
    return [editor.lineStart(), editor.lineEnd()];
  }

  /** The last offset the Normal-mode caret may rest on in its line. */
  #clamp(at: number): number {
    const editor = this.#editor;
    const start = editor.lineStart(at);
    const end = editor.lineEnd(at);
    return this.mode === "normal" ? Math.max(start, Math.min(at, end - 1)) : Math.min(at, end);
  }

  #motion(key: string, count: number): Target | null {
    const editor = this.#editor;
    const text = editor.text;
    let at = editor.cursor;
    const [start, end] = this.#lines();
    switch (key) {
      case "h":
        return { at: Math.max(start, at - count) };
      case "l":
      case " ":
        return { at: Math.min(end, at + count) };
      case "0":
        return { at: start };
      case "^": {
        let first = start;
        while (first < end && isSpace(text[first])) first += 1;
        return { at: first };
      }
      case "$":
        return { at: end, inclusive: true };
      case "j":
      case "k": {
        const column = at - start;
        let line = start;
        for (let step = 0; step < count; step += 1) {
          if (key === "j") {
            const next = editor.lineEnd(line);
            if (next >= text.length) break;
            line = next + 1;
          } else {
            if (line === 0) break;
            line = editor.lineStart(line - 1);
          }
        }
        return { at: Math.min(line + column, editor.lineEnd(line)), linewise: true };
      }
      case "w":
        for (let step = 0; step < count; step += 1) {
          const word = isWord(text[at]);
          while (at < text.length && !isSpace(text[at]) && isWord(text[at]) === word) at += 1;
          while (at < text.length && isSpace(text[at])) at += 1;
        }
        return { at };
      case "b":
        for (let step = 0; step < count; step += 1) {
          while (at > 0 && isSpace(text[at - 1])) at -= 1;
          const word = isWord(text[at - 1]);
          while (at > 0 && !isSpace(text[at - 1]) && isWord(text[at - 1]) === word) at -= 1;
        }
        return { at };
      case "e":
        for (let step = 0; step < count; step += 1) {
          at += 1;
          while (at < text.length && isSpace(text[at])) at += 1;
          const word = isWord(text[at]);
          while (at + 1 < text.length && !isSpace(text[at + 1]) && isWord(text[at + 1]) === word) at += 1;
        }
        return { at: Math.min(at, text.length), inclusive: true };
      case "G":
        return { at: editor.lineStart(text.length), linewise: true };
      default:
        return null;
    }
  }

  /** `fx`, `Fx`, `tx`, `Tx`: to (or just before) a character on this line. */
  #findChar(key: string, ch: string, count: number): Target | null {
    const editor = this.#editor;
    const [start, end] = this.#lines();
    let at = editor.cursor;
    const forward = key === "f" || key === "t";
    for (let step = 0; step < count; step += 1) {
      at = forward ? editor.text.indexOf(ch, at + 1) : editor.text.lastIndexOf(ch, at - 1);
      if (at < start || at >= end || at < 0) return null;
    }
    if (key === "t") at -= 1;
    if (key === "T") at += 1;
    return { at, inclusive: forward };
  }

  /** `iw` / `aw`: the word under the caret, with its trailing space for `a`. */
  #wordObject(around: boolean): [number, number] {
    const text = this.#editor.text;
    let from = this.#editor.cursor;
    let to = from;
    const word = isWord(text[from]);
    const same = (ch: string | undefined): boolean => !isSpace(ch) && isWord(ch) === word;
    while (from > 0 && same(text[from - 1])) from -= 1;
    while (to < text.length && same(text[to])) to += 1;
    if (around) while (to < text.length && text[to] === " ") to += 1;
    return [from, to];
  }

  #apply(operator: Operator, from: number, to: number, linewise: boolean): void {
    const editor = this.#editor;
    let a = Math.min(from, to);
    let b = Math.max(from, to);
    if (linewise) {
      a = editor.lineStart(a);
      b = editor.lineEnd(b);
    }
    const taken = editor.text.slice(a, b);
    editor.register = taken;
    this.#linewiseRegister = linewise;
    if (operator === "y") {
      editor.moveTo(this.#clamp(a));
      this.#setMode("normal");
      return;
    }
    if (linewise && operator === "d") {
      // Take the line's newline with it: the one after, or the one before on the last line.
      if (b < editor.text.length) b += 1;
      else if (a > 0) a -= 1;
    }
    editor.splice(a, b, "");
    if (operator === "c") {
      this.mode = "insert";
      this.#clear();
      editor.anchor = null;
    } else {
      this.#setMode("normal");
      editor.moveTo(this.#clamp(Math.min(a, editor.text.length)));
    }
  }

  #paste(before: boolean, count: number): void {
    const editor = this.#editor;
    const text = editor.register.repeat(count);
    if (!text) return;
    if (this.#linewiseRegister) {
      if (before) {
        const at = editor.lineStart();
        editor.splice(at, at, `${text}\n`);
        editor.moveTo(at);
      } else {
        const at = editor.lineEnd();
        editor.splice(at, at, `\n${text}`);
        editor.moveTo(at + 1);
      }
      return;
    }
    const at = before ? editor.cursor : Math.min(editor.cursor + 1, editor.lineEnd());
    editor.splice(at, at, text);
    editor.moveTo(at + text.length - 1);
  }

  #normal(key: string): void {
    const editor = this.#editor;
    const pending = this.#pending;
    if (pending) {
      this.#pending = "";
      const count = Number(this.#count) || 1;
      if (pending === "r") {
        if (editor.cursor < editor.lineEnd()) editor.splice(editor.cursor, editor.cursor + 1, key);
        editor.moveTo(editor.cursor - 1);
        this.#clear();
        return;
      }
      if (pending === "g") {
        if (key === "g") this.#go({ at: 0, linewise: true });
        else this.#clear();
        return;
      }
      if (pending === "i" || pending === "a") {
        if (key === "w" && (this.#operator || this.selecting)) {
          const [from, to] = this.#wordObject(pending === "a");
          if (this.#operator) this.#apply(this.#operator, from, to, false);
          else {
            editor.anchor = from;
            editor.cursor = Math.max(from, to - 1);
          }
        } else this.#clear();
        return;
      }
      this.#find = { key: pending, ch: key };
      const target = this.#findChar(pending, key, count);
      if (target) this.#go(target);
      else this.#clear();
      return;
    }
    if (/[1-9]/.test(key) || (key === "0" && this.#count)) {
      this.#count += key;
      return;
    }
    const count = Number(this.#count) || 1;
    if ("fFtTg".includes(key) || key === "r") {
      this.#pending = key;
      return;
    }
    if ((key === "i" || key === "a") && (this.#operator || this.selecting)) {
      this.#pending = key;
      return;
    }
    if (key === ";" && this.#find) {
      const target = this.#findChar(this.#find.key, this.#find.ch, count);
      if (target) this.#go(target);
      return;
    }
    const motion = this.#motion(key, count);
    if (motion) {
      this.#go(motion);
      return;
    }
    if (this.#operator) {
      // `dd`, `cc`, `yy`: the operator doubled takes `count` lines.
      if (key === this.#operator) {
        const from = editor.cursor;
        const down = count > 1 ? (this.#motion("j", count - 1)?.at ?? from) : from;
        this.#apply(this.#operator, from, down, true);
      } else this.#clear();
      return;
    }
    if (this.selecting) return this.#visual(key);
    switch (key) {
      case "d":
      case "c":
      case "y":
        this.#operator = key;
        return;
      case "i":
        this.#setMode("insert");
        return;
      case "a":
        editor.moveTo(Math.min(editor.cursor + 1, editor.lineEnd()));
        this.#setMode("insert");
        return;
      case "I":
        editor.moveTo(this.#motion("^", 1)!.at);
        this.#setMode("insert");
        return;
      case "A":
        editor.moveTo(editor.lineEnd());
        this.#setMode("insert");
        return;
      case "o": {
        const at = editor.lineEnd();
        editor.splice(at, at, "\n");
        this.#setMode("insert");
        return;
      }
      case "O": {
        const at = editor.lineStart();
        editor.splice(at, at, "\n");
        editor.moveTo(at);
        this.#setMode("insert");
        return;
      }
      case "v":
        this.#setMode("visual");
        return;
      case "V":
        this.#setMode("visual-line");
        return;
      case "x":
        this.#apply("d", editor.cursor, Math.min(editor.cursor + count, editor.lineEnd()), false);
        return;
      case "D":
        this.#apply("d", editor.cursor, editor.lineEnd(), false);
        return;
      case "C":
        this.#apply("c", editor.cursor, editor.lineEnd(), false);
        return;
      case "p":
        this.#paste(false, count);
        this.#clear();
        return;
      case "P":
        this.#paste(true, count);
        this.#clear();
        return;
      case "u":
        for (let step = 0; step < count; step += 1) editor.undo();
        editor.moveTo(this.#clamp(editor.cursor));
        this.#clear();
        return;
      case "J": {
        const end = editor.lineEnd();
        if (end < editor.text.length) {
          let next = end + 1;
          while (editor.text[next] === " ") next += 1;
          editor.splice(end, next, " ");
          editor.moveTo(end);
        }
        this.#clear();
        return;
      }
      default:
        // An unknown key in Normal mode does nothing; it must not type.
        this.#clear();
    }
  }

  /** Moves the caret, or runs the pending operator over the motion. */
  #go(target: Target): void {
    const editor = this.#editor;
    if (this.#operator) {
      const to = target.inclusive && target.at >= editor.cursor ? target.at + 1 : target.at;
      this.#apply(this.#operator, editor.cursor, to, Boolean(target.linewise));
      return;
    }
    if (this.selecting) {
      editor.cursor = Math.max(0, Math.min(target.at, editor.text.length));
    } else editor.moveTo(this.#clamp(target.at));
    this.#count = "";
  }

  #visual(key: string): void {
    const editor = this.#editor;
    const anchor = editor.anchor ?? editor.cursor;
    const from = Math.min(anchor, editor.cursor);
    // Visual mode covers the character under the caret.
    const to = Math.min(Math.max(anchor, editor.cursor) + 1, editor.text.length);
    const linewise = this.mode === "visual-line";
    switch (key) {
      case "v":
        this.#setMode(this.mode === "visual" ? "normal" : "visual");
        return;
      case "V":
        this.#setMode(linewise ? "normal" : "visual-line");
        return;
      case "o":
        editor.anchor = editor.cursor;
        editor.cursor = anchor;
        return;
      case "y":
        this.#apply("y", from, to, linewise);
        return;
      case "d":
      case "x":
        this.#apply("d", from, to, linewise);
        return;
      case "c":
      case "s":
        this.#apply("c", from, to, linewise);
        return;
      default:
        this.#clear();
    }
  }

  /** The selection as offsets for drawing: whole lines in Visual-line mode. */
  drawn(): { anchor: number; cursor: number } | null {
    const editor = this.#editor;
    if (!this.selecting || editor.anchor === null) return null;
    if (this.mode !== "visual-line") {
      const forward = editor.cursor >= editor.anchor;
      return { anchor: forward ? editor.anchor : Math.min(editor.anchor + 1, editor.text.length), cursor: forward ? Math.min(editor.cursor + 1, editor.text.length) : editor.cursor };
    }
    const from = editor.lineStart(Math.min(editor.anchor, editor.cursor));
    const to = editor.lineEnd(Math.max(editor.anchor, editor.cursor));
    return { anchor: from, cursor: to };
  }
}
