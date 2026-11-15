/**
 * The composer's text model: caret and selection, undo and redo, a kill
 * buffer, word and line motions, prompt history and pasted-text chips.
 * Offsets are UTF-16, as TSP's `editor` node counts them.
 */

interface Snapshot {
  text: string;
  cursor: number;
}

/** A large paste kept out of the draft and shown as one chip token. */
export interface Paste {
  token: string;
  text: string;
}

const PASTE_LINES = 10;
const PASTE_CHARS = 1000;
const UNDO_LIMIT = 200;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The offset one grapheme before `at`. */
function prevGrapheme(text: string, at: number): number {
  if (at <= 0) return 0;
  let last = 0;
  for (const part of segmenter.segment(text.slice(Math.max(0, at - 32), at))) last = part.index;
  return Math.max(0, at - 32) + last;
}

/** The offset one grapheme after `at`. */
function nextGrapheme(text: string, at: number): number {
  if (at >= text.length) return text.length;
  const first = segmenter.segment(text.slice(at, at + 32))[Symbol.iterator]().next();
  return at + (first.done ? 1 : first.value.segment.length);
}

const isWord = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

export class TextEditor {
  text = "";
  cursor = 0;
  /** The other end of the selection, or null for none. */
  anchor: number | null = null;
  pastes: Paste[] = [];
  history: string[] = [];
  #historyAt = -1;
  #draft = "";
  #undo: Snapshot[] = [];
  #redo: Snapshot[] = [];
  #typing = false;
  #kill = "";
  #goal: number | null = null;
  #pasteCount = 0;

  get empty(): boolean {
    return this.text.length === 0;
  }

  /** The selected range, or null. */
  selection(): [number, number] | null {
    if (this.anchor === null || this.anchor === this.cursor) return null;
    return [Math.min(this.anchor, this.cursor), Math.max(this.anchor, this.cursor)];
  }

  #save(typing = false): void {
    if (typing && this.#typing) return;
    this.#undo.push({ text: this.text, cursor: this.cursor });
    if (this.#undo.length > UNDO_LIMIT) this.#undo.shift();
    this.#redo = [];
    this.#typing = typing;
  }

  #moved(): void {
    this.#typing = false;
    this.#goal = null;
  }

  /** Replaces the whole text (history recall, `set_editor_text`), as one undo unit. */
  set(text: string, cursor = text.length): void {
    if (text === this.text && cursor === this.cursor) return;
    this.#save();
    this.text = text;
    this.cursor = Math.max(0, Math.min(cursor, text.length));
    this.anchor = null;
    this.#moved();
    this.pastes = this.pastes.filter(paste => text.includes(paste.token));
  }

  /** Empties the editor after a submit: nothing left to undo into. */
  clear(): void {
    this.text = "";
    this.cursor = 0;
    this.anchor = null;
    this.pastes = [];
    this.#undo = [];
    this.#redo = [];
    this.#historyAt = -1;
    this.#moved();
  }

  /** Replaces `[from, to)` with `text`, caret after it. */
  splice(from: number, to: number, text: string, typing = false): void {
    this.#save(typing);
    this.text = this.text.slice(0, from) + text + this.text.slice(to);
    this.cursor = from + text.length;
    this.anchor = null;
    this.#goal = null;
    this.#historyAt = -1;
    if (!typing) this.#typing = false;
  }

  /** Types `text` over the selection. */
  insert(text: string): void {
    if (!text) return;
    const range = this.selection();
    if (range) this.splice(range[0], range[1], text);
    else this.splice(this.cursor, this.cursor, text, !/\s/.test(text));
  }

  /** A paste: large text becomes a chip token expanded on submit. */
  paste(text: string): void {
    const clean = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
    if (!clean) return;
    const lines = clean.split("\n").length;
    if (lines <= PASTE_LINES && clean.length <= PASTE_CHARS) {
      const range = this.selection();
      this.splice(range ? range[0] : this.cursor, range ? range[1] : this.cursor, clean);
      return;
    }
    this.#pasteCount += 1;
    const token = lines > 1 ? `[Pasted text #${this.#pasteCount} +${lines} lines]` : `[Pasted text #${this.#pasteCount} ${clean.length} chars]`;
    this.pastes.push({ token, text: clean });
    const range = this.selection();
    this.splice(range ? range[0] : this.cursor, range ? range[1] : this.cursor, token);
  }

  /** The draft with every paste chip replaced by its text. */
  expanded(): string {
    let out = this.text;
    for (const paste of this.pastes) out = out.split(paste.token).join(paste.text);
    return out;
  }

  /** A chip token is one unit: a caret or range end inside one snaps to its edge. */
  #tokenAt(at: number): [number, number] | null {
    for (const paste of this.pastes) {
      let from = this.text.indexOf(paste.token);
      while (from >= 0) {
        const to = from + paste.token.length;
        if (at > from && at < to) return [from, to];
        from = this.text.indexOf(paste.token, to);
      }
    }
    return null;
  }

  /**
   * An `edit` event from Tern: replace `[from, to)` with `text`, caret to
   * `cursor`. `len` is the length Tern saw; a mismatch makes the edit stale.
   */
  applyEdit(edit: { from: number; to: number; text: string; cursor: number; len: number }): boolean {
    if (edit.len !== this.text.length) return false;
    let from = Math.max(0, Math.min(edit.from, this.text.length));
    let to = Math.max(from, Math.min(edit.to, this.text.length));
    from = this.#tokenAt(from)?.[0] ?? from;
    to = this.#tokenAt(to)?.[1] ?? to;
    const text = edit.text.replace(/\r\n?/g, "\n");
    this.splice(from, to, text);
    if (from === edit.from && to === edit.to) this.cursor = Math.max(0, Math.min(edit.cursor, this.text.length));
    this.pastes = this.pastes.filter(paste => this.text.includes(paste.token));
    return true;
  }

  undo(): boolean {
    const snapshot = this.#undo.pop();
    if (!snapshot) return false;
    this.#redo.push({ text: this.text, cursor: this.cursor });
    this.text = snapshot.text;
    this.cursor = snapshot.cursor;
    this.anchor = null;
    this.#moved();
    return true;
  }

  redo(): boolean {
    const snapshot = this.#redo.pop();
    if (!snapshot) return false;
    this.#undo.push({ text: this.text, cursor: this.cursor });
    this.text = snapshot.text;
    this.cursor = snapshot.cursor;
    this.anchor = null;
    this.#moved();
    return true;
  }

  /** Moves the caret; `select` keeps (or starts) the selection. */
  moveTo(at: number, select = false): void {
    const next = Math.max(0, Math.min(at, this.text.length));
    if (select) this.anchor ??= this.cursor;
    else this.anchor = null;
    this.cursor = next;
    if (this.anchor === this.cursor) this.anchor = null;
    this.#typing = false;
  }

  /** The offset where the line holding `at` starts. */
  lineStart(at = this.cursor): number {
    return this.text.lastIndexOf("\n", at - 1) + 1;
  }

  /** The offset of the newline ending the line holding `at`, or the text's end. */
  lineEnd(at = this.cursor): number {
    const end = this.text.indexOf("\n", at);
    return end < 0 ? this.text.length : end;
  }

  /** The text last killed or yanked. */
  get register(): string {
    return this.#kill;
  }

  set register(text: string) {
    this.#kill = text;
  }

  wordLeft(at = this.cursor): number {
    let i = at;
    while (i > 0 && !isWord(this.text[i - 1])) i -= 1;
    while (i > 0 && isWord(this.text[i - 1])) i -= 1;
    return i;
  }

  wordRight(at = this.cursor): number {
    let i = at;
    while (i < this.text.length && !isWord(this.text[i])) i += 1;
    while (i < this.text.length && isWord(this.text[i])) i += 1;
    return i;
  }

  left(select = false, word = false): void {
    const range = this.selection();
    if (range && !select) this.moveTo(range[0]);
    else {
      const at = word ? this.wordLeft() : prevGrapheme(this.text, this.cursor);
      this.moveTo(this.#tokenAt(at)?.[0] ?? at, select);
    }
    this.#goal = null;
  }

  right(select = false, word = false): void {
    const range = this.selection();
    if (range && !select) this.moveTo(range[1]);
    else {
      const at = word ? this.wordRight() : nextGrapheme(this.text, this.cursor);
      this.moveTo(this.#tokenAt(at)?.[1] ?? at, select);
    }
    this.#goal = null;
  }

  home(select = false): void {
    this.moveTo(this.lineStart(), select);
    this.#goal = null;
  }

  end(select = false): void {
    this.moveTo(this.lineEnd(), select);
    this.#goal = null;
  }

  /** Moves one line up or down; false when the caret is on the first or last line. */
  vertical(direction: -1 | 1, select = false): boolean {
    const start = this.lineStart();
    const column = this.#goal ?? this.cursor - start;
    if (direction < 0) {
      if (start === 0) return false;
      const prevStart = this.lineStart(start - 1);
      this.moveTo(Math.min(prevStart + column, start - 1), select);
    } else {
      const end = this.lineEnd();
      if (end >= this.text.length) return false;
      const nextEnd = this.lineEnd(end + 1);
      this.moveTo(Math.min(end + 1 + column, nextEnd), select);
    }
    this.#goal = column;
    return true;
  }

  selectAll(): void {
    this.anchor = 0;
    this.cursor = this.text.length;
    this.#moved();
  }

  #delete(from: number, to: number, kill = false): void {
    if (from === to) return;
    if (kill) this.#kill = this.text.slice(from, to);
    this.splice(from, to, "");
    this.pastes = this.pastes.filter(paste => this.text.includes(paste.token));
  }

  backspace(word = false): void {
    const range = this.selection();
    if (range) return this.#delete(range[0], range[1]);
    if (this.cursor === 0) return;
    const token = this.#tokenAt(this.cursor - 1) ?? this.#tokenEndingAt(this.cursor);
    if (token) return this.#delete(token[0], token[1]);
    this.#delete(word ? this.wordLeft() : prevGrapheme(this.text, this.cursor), this.cursor, word);
  }

  #tokenEndingAt(at: number): [number, number] | null {
    for (const paste of this.pastes) {
      if (this.text.slice(0, at).endsWith(paste.token)) return [at - paste.token.length, at];
    }
    return null;
  }

  deleteForward(word = false): void {
    const range = this.selection();
    if (range) return this.#delete(range[0], range[1]);
    this.#delete(this.cursor, word ? this.wordRight() : nextGrapheme(this.text, this.cursor), word);
  }

  killToEnd(): void {
    const end = this.lineEnd();
    this.#delete(this.cursor, end === this.cursor ? Math.min(end + 1, this.text.length) : end, true);
  }

  killToStart(): void {
    this.#delete(this.lineStart(), this.cursor, true);
  }

  yank(): void {
    if (this.#kill) this.insert(this.#kill);
  }

  /** The selected text, or the whole draft. */
  copyText(): string {
    const range = this.selection();
    return range ? this.text.slice(range[0], range[1]) : this.text;
  }

  /** Remembers a submitted prompt (or a displaced draft) for recall. */
  remember(text: string): void {
    const value = text.trim();
    if (!value || this.history.at(-1) === value) return;
    this.history.push(value);
    if (this.history.length > 500) this.history.shift();
    this.#historyAt = -1;
  }

  /** Recalls an older (`-1`) or newer (`1`) prompt; false at the end. */
  recall(direction: -1 | 1): boolean {
    if (!this.history.length) return false;
    if (this.#historyAt < 0) {
      if (direction > 0) return false;
      this.#draft = this.text;
      this.#historyAt = this.history.length - 1;
    } else {
      const next = this.#historyAt + direction;
      if (next < 0) return false;
      if (next >= this.history.length) {
        this.#historyAt = -1;
        this.set(this.#draft);
        return true;
      }
      this.#historyAt = next;
    }
    this.set(this.history[this.#historyAt] ?? "");
    // `set` clears the position for an ordinary edit; a recall keeps walking.
    return true;
  }
}
