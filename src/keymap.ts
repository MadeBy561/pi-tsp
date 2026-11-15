/**
 * Application shortcuts by pi's action names, so a `keybindings.json` written
 * for pi's own terminal UI applies here too.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Key } from "@stencil-hq/tern";

/** The actions pi-tsp binds, with pi's defaults. Names without a pi counterpart are pi-tsp's own. */
export const DEFAULT_KEYS = {
  "app.interrupt": ["escape"],
  "app.clear": ["ctrl+c"],
  "app.exit": ["ctrl+d"],
  "app.editor.external": ["ctrl+g"],
  "app.clipboard.pasteImage": ["ctrl+v"],
  "app.session.new": [],
  "app.session.tree": [],
  "app.session.fork": [],
  "app.session.resume": [],
  "app.model.select": ["ctrl+l"],
  "app.model.cycleForward": ["ctrl+p"],
  "app.thinking.cycle": ["shift+tab"],
  "app.thinking.toggle": ["ctrl+t"],
  "app.tools.expand": ["ctrl+o"],
  "app.message.copy": ["ctrl+x"],
  "app.message.followUp": ["alt+enter"],
  "app.message.dequeue": ["alt+up"],
  "app.history.search": ["ctrl+r"],
  "app.retry": ["f5", "alt+r"],
  "app.settings": ["ctrl+,"],
  "tui.editor.cursorLeft": ["left", "ctrl+b"],
  "tui.editor.cursorRight": ["right", "ctrl+f"],
  "tui.editor.cursorWordLeft": ["alt+left", "ctrl+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "ctrl+right", "alt+f"],
  "tui.editor.cursorLineStart": ["home", "ctrl+a"],
  "tui.editor.cursorLineEnd": ["end", "ctrl+e"],
  "tui.editor.deleteCharBackward": ["backspace"],
  "tui.editor.deleteCharForward": ["delete"],
  "tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace", "ctrl+backspace"],
  "tui.editor.deleteWordForward": ["alt+d", "alt+delete", "ctrl+delete"],
  "tui.editor.deleteToLineStart": ["ctrl+u"],
  "tui.editor.deleteToLineEnd": ["ctrl+k"],
  "tui.editor.yank": ["ctrl+y"],
  "tui.editor.undo": ["ctrl+z", "ctrl+-"],
  "tui.editor.redo": ["ctrl+shift+z"],
  "tui.input.newLine": ["shift+enter", "ctrl+j", "ctrl+enter"],
  "tui.input.submit": ["enter"],
} as const satisfies Record<string, readonly string[]>;

export type Action = keyof typeof DEFAULT_KEYS;

const NAMES: Record<string, string> = { esc: "escape", return: "enter", pageup: "page_up", pagedown: "page_down", del: "delete", " ": "space" };
const MODIFIERS = ["ctrl", "alt", "shift", "meta"] as const;

/** `Ctrl+Shift+N` as the canonical `ctrl+shift+n`: modifiers in a fixed order, then the key. */
function canonical(combo: string): string {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map(part => part.trim())
    .filter(Boolean);
  const key = parts.filter(part => !(MODIFIERS as readonly string[]).includes(part) && part !== "cmd" && part !== "super").pop() ?? "";
  const mods = MODIFIERS.filter(mod => parts.includes(mod) || (mod === "meta" && (parts.includes("cmd") || parts.includes("super"))));
  return [...mods, NAMES[key] ?? key].join("+");
}

function comboOf(key: Key): string {
  return [...MODIFIERS.filter(mod => key[mod]), key.name].join("+");
}

export class Keymap {
  #byCombo = new Map<string, Action>();
  #byAction = new Map<Action, string[]>();

  /** `overrides` maps an action to a key, a list of keys, or `[]` to unbind it. */
  constructor(overrides: Record<string, unknown> = {}) {
    for (const action of Object.keys(DEFAULT_KEYS) as Action[]) {
      const given = overrides[action];
      const combos = (given === undefined ? DEFAULT_KEYS[action] : Array.isArray(given) ? given : [given]).filter((combo): combo is string => typeof combo === "string").map(canonical);
      this.#byAction.set(action, combos);
      for (const combo of combos) if (!this.#byCombo.has(combo)) this.#byCombo.set(combo, action);
    }
  }

  /** The user's bindings: pi-tsp's own agent dir first, then pi's. */
  static load(configDir: string): Keymap {
    for (const path of [join(configDir, "keybindings.json"), join(homedir(), ".pi", "agent", "keybindings.json")]) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return new Keymap(parsed as Record<string, unknown>);
      } catch {
        /* no file, or not JSON: try the next */
      }
    }
    return new Keymap();
  }

  /** The action a key press runs, if any. */
  action(key: Key): Action | undefined {
    return this.#byCombo.get(comboOf(key));
  }

  /** An action's first binding as shown to people (`Ctrl+L`), or empty when unbound. */
  label(action: Action): string {
    const combo = this.#byAction.get(action)?.[0];
    if (!combo) return "";
    return combo
      .split("+")
      .map(part => ({ up: "↑", down: "↓", left: "←", right: "→", escape: "Esc", enter: "Enter", tab: "Tab", page_up: "PgUp", page_down: "PgDn" })[part] ?? (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
      .join("+");
  }
}
