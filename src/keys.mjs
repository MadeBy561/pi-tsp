/**
 * The composer owns its text: Tern forwards keys to the program, so this is
 * a small terminal line editor with bracketed paste, history and completion.
 */
export class Composer {
  constructor() {
    this.text = "";
    this.cursor = 0;
    this.history = [];
    this.histAt = -1;
    this.pasting = false;
    this.pasteBuffer = "";
  }

  set(text, cursor = text.length) {
    this.text = text;
    this.cursor = Math.max(0, Math.min(cursor, text.length));
  }

  insert(value) {
    const at = Math.min(this.cursor, this.text.length);
    this.text = this.text.slice(0, at) + value + this.text.slice(at);
    this.cursor = at + value.length;
  }

  clear() {
    this.text = "";
    this.cursor = 0;
    this.histAt = -1;
  }

  recall(direction, draft) {
    if (!this.history.length) return;
    if (direction < 0) {
      if (this.histAt === -1) this.draft = draft ?? this.text;
      this.histAt = Math.min(this.history.length - 1, this.histAt + 1);
      this.text = this.history[this.history.length - 1 - this.histAt];
    } else if (this.histAt > 0) {
      this.histAt -= 1;
      this.text = this.history[this.history.length - 1 - this.histAt];
    } else if (this.histAt === 0) {
      this.histAt = -1;
      this.text = this.draft ?? "";
    }
    this.cursor = this.text.length;
  }

  push(text) {
    if (!text.trim()) return;
    if (this.history[this.history.length - 1] !== text) this.history.push(text);
    if (this.history.length > 100) this.history.shift();
    this.histAt = -1;
  }

  /**
   * Feed raw pty bytes. Returns { submit, interrupt, escape, tab, ctrlC,
   * menuUp, menuDown, changed } so the UI can decide what they mean.
   */
  feed(data) {
    const out = { submit: null, interrupt: false, escape: false, tab: false, ctrlC: false, menuUp: false, menuDown: false, changed: false };
    const text = data.toString("utf8");
    let index = 0;
    while (index < text.length) {
      if (this.pasting) {
        const end = text.indexOf("\x1b[201~", index);
        if (end < 0) {
          this.pasteBuffer += text.slice(index);
          index = text.length;
          continue;
        }
        this.pasteBuffer += text.slice(index, end);
        this.insert(this.pasteBuffer);
        this.pasteBuffer = "";
        this.pasting = false;
        out.changed = true;
        index = end + 6;
        continue;
      }
      const ch = text[index];
      if (ch === "\x1b") {
        const rest = text.slice(index);
        const paste = rest.match(/^\x1b\[200~/);
        if (paste) {
          this.pasting = true;
          index += paste[0].length;
          continue;
        }
        const csi = rest.match(/^\x1b\[([0-9;?]*)([A-Za-z~])/);
        if (csi) {
          const [, body, final] = csi;
          index += csi[0].length;
          if (final === "A") { out.menuUp = true; continue; }
          if (final === "B") { out.menuDown = true; continue; }
          if (final === "C") { this.cursor = Math.min(this.text.length, this.cursor + 1); continue; }
          if (final === "D") { this.cursor = Math.max(0, this.cursor - 1); continue; }
          if (final === "H" || (final === "~" && (body === "1" || body === "7"))) { this.cursor = 0; continue; }
          if (final === "F" || (final === "~" && (body === "4" || body === "8"))) { this.cursor = this.text.length; continue; }
          if (final === "~" && body === "3") {
            this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
            out.changed = true;
            continue;
          }
          if (final === "u" && body === "13;2") { this.insert("\n"); out.changed = true; continue; }
          continue;
        }
        const sso = rest.match(/^\x1bO([A-Za-z])/);
        if (sso) {
          const final = sso[1];
          index += 3;
          if (final === "A") out.menuUp = true;
          else if (final === "B") out.menuDown = true;
          else if (final === "C") this.cursor = Math.min(this.text.length, this.cursor + 1);
          else if (final === "D") this.cursor = Math.max(0, this.cursor - 1);
          continue;
        }
        index += 1;
        out.escape = true;
        continue;
      }
      const code = ch.codePointAt(0);
      if (ch === "\r" || ch === "\n") { out.submit = this.text; index += 1; continue; }
      if (code === 0x7f || code === 0x08) {
        if (this.cursor > 0) {
          this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
          this.cursor -= 1;
          out.changed = true;
        }
        index += 1;
        continue;
      }
      if (code < 0x20) {
        if (code === 0x03) out.ctrlC = true;
        else if (code === 0x04) out.interrupt = true;
        else if (code === 0x01) this.cursor = 0;
        else if (code === 0x05) this.cursor = this.text.length;
        else if (code === 0x0b) { this.text = this.text.slice(0, this.cursor); out.changed = true; }
        else if (code === 0x15) { this.text = this.text.slice(this.cursor); this.cursor = 0; out.changed = true; }
        else if (code === 0x17) {
          const left = this.text.slice(0, this.cursor).replace(/\s+$/, "");
          const cut = left.lastIndexOf(" ") + 1;
          this.text = this.text.slice(0, cut) + this.text.slice(this.cursor);
          this.cursor = cut;
          out.changed = true;
        } else if (code === 0x09) out.tab = true;
        index += 1;
        continue;
      }
      // A run of printable text (including multi-byte characters).
      let end = index;
      while (end < text.length) {
        const next = text.codePointAt(end);
        if (next < 0x20 || next === 0x7f || next === 0x1b) break;
        end += next > 0xffff ? 2 : 1;
      }
      this.insert(text.slice(index, end));
      out.changed = true;
      index = end;
    }
    return out;
  }
}
