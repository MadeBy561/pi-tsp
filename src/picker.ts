/**
 * A picker's controller: the catalogue, the search field, filtering by tab
 * and scope, selection, and what its actions do. The view is redrawn from it.
 */
import type { Key } from "@stencil-hq/tern";
import { TextEditor } from "./editor.js";
import { rank } from "./fuzzy.js";
import type { Node } from "./view/h.js";
import type { PickerAction, PickerItem, PickerView } from "./view/overlays.js";

export interface PickerOptions {
  /** Static picker props: title, icon, noun, size, layout, placeholder, columns, preview. */
  props: Record<string, unknown>;
  items: PickerItem[];
  /** The id selected when it opens; the first row by default. */
  selected?: string | null;
  current?: string[];
  /** Whether typing filters. Default: more than 8 items. */
  searchable?: boolean;
  tabs?: { id: string; label: string; test(item: PickerItem): boolean }[];
  tab?: string;
  scopes?: { id: string; label: string; icon?: string; group?: string; test(item: PickerItem): boolean }[];
  scope?: string;
  /** Group rows under headers by `item.group` while there is no query. */
  grouped?: boolean;
  actions: PickerAction[];
  empty?: string;
  /** Enter or a double click on a row. */
  choose(id: string, picker: Picker): void | Promise<void>;
  /** Any other action of the sheet, with the selected id. */
  act?(act: string, id: string | null, picker: Picker): void | Promise<void>;
  /** The preview pane of the selected item. */
  preview?(id: string | null): Node[];
  /** Called once when the sheet closes without a choice. */
  cancel?(): void;
}

const keyNames = (key: Key): string[] => [...(key.ctrl ? ["ctrl"] : []), ...(key.alt ? ["alt"] : []), ...(key.shift ? ["shift"] : []), ...(key.meta ? ["meta"] : []), key.name];

const KEY_ALIAS: Record<string, string> = { esc: "escape", return: "enter", del: "delete" };

function sameKeys(key: Key, keys: readonly string[] | undefined): boolean {
  if (!keys?.length) return false;
  const want = keys.map(name => KEY_ALIAS[name.toLowerCase()] ?? name.toLowerCase()).sort();
  const have = keyNames(key).sort();
  return want.length === have.length && want.every((name, index) => name === have[index]);
}

export class Picker {
  readonly options: PickerOptions;
  readonly query = new TextEditor();
  items: PickerItem[];
  itemsRev = 0;
  selected: string | null;
  tab: string | undefined;
  scope: string | undefined;
  confirm: { text: string; act: string; label?: string } | null = null;
  state: "ready" | "loading" | "error" = "ready";
  message = "";
  #order: string[] = [];
  #wire: (string | { group: string; label: string; count?: number })[] | undefined;
  #hits: Record<string, [number, number][]> = {};

  constructor(options: PickerOptions) {
    this.options = options;
    this.items = options.items;
    this.tab = options.tab ?? options.tabs?.[0]?.id;
    this.scope = options.scope ?? options.scopes?.[0]?.id;
    this.selected = options.selected ?? null;
    this.refilter(false);
  }

  get searchable(): boolean {
    return this.options.searchable ?? this.items.length > 8;
  }

  /** Replaces the catalogue (a delete, a rename, a loaded list). */
  setItems(items: PickerItem[]): void {
    this.items = items;
    this.itemsRev += 1;
    this.refilter(false);
  }

  #visible(): PickerItem[] {
    const tab = this.options.tabs?.find(entry => entry.id === this.tab);
    const scope = this.options.scopes?.find(entry => entry.id === this.scope);
    return this.items.filter(item => (!tab || tab.test(item)) && (!scope || scope.test(item)));
  }

  /** Recomputes what is shown; `reset` puts the selection on the best match. */
  refilter(reset: boolean): void {
    const query = this.query.text.trim();
    const visible = this.#visible();
    const ranked = rank(query, visible, item => `${item.label} ${item.detail ?? ""} ${item.search ?? ""}`);
    this.#order = ranked.map(entry => entry.item.id);
    this.#hits = {};
    if (query) {
      for (const { item } of ranked) {
        // Hits are drawn in the label only, so they are matched against it alone.
        const inLabel = rank(query, [item], entry => entry.label)[0];
        if (inLabel?.match.hits.length) this.#hits[item.id] = inLabel.match.hits;
      }
    }
    if (this.options.grouped && !query) {
      const wire: (string | { group: string; label: string; count?: number })[] = [];
      const counts = new Map<string, number>();
      for (const item of visible) counts.set(item.group ?? "", (counts.get(item.group ?? "") ?? 0) + 1);
      let group: string | undefined;
      for (const item of visible) {
        if ((item.group ?? "") !== group) {
          group = item.group ?? "";
          if (group) wire.push({ group, label: group, count: counts.get(group) });
        }
        wire.push(item.id);
      }
      this.#wire = wire;
    } else {
      this.#wire = query || this.options.tabs || this.options.scopes ? this.#order : undefined;
    }
    if (reset || !this.selected || !this.#order.includes(this.selected)) this.selected = this.#order[0] ?? null;
  }

  move(delta: number): void {
    if (!this.#order.length) return;
    const at = this.selected ? this.#order.indexOf(this.selected) : -1;
    const next = Math.max(0, Math.min(this.#order.length - 1, at < 0 ? 0 : at + delta));
    this.selected = this.#order[next] ?? null;
    this.confirm = null;
  }

  edge(end: boolean): void {
    this.selected = (end ? this.#order.at(-1) : this.#order[0]) ?? null;
  }

  cycleTab(delta: number): void {
    const tabs = this.options.tabs;
    if (!tabs?.length) return;
    const at = tabs.findIndex(tab => tab.id === this.tab);
    this.tab = tabs[(at + delta + tabs.length) % tabs.length]?.id;
    this.refilter(true);
  }

  /**
   * A key while the sheet has the keyboard. Returns `close` for Escape with
   * nothing left to dismiss, `handled`, or `choose`/an action id to run.
   */
  key(key: Key): { type: "handled" } | { type: "close" } | { type: "choose" } | { type: "act"; act: string } {
    for (const action of this.options.actions) {
      // Escape first clears a confirmation or the query; the switch below decides.
      if (action.disabled || action.id === "close" || !sameKeys(key, action.keys)) continue;
      // Enter on the primary action is the choice itself.
      return action.primary ? { type: "choose" } : { type: "act", act: action.id };
    }
    const plain = !key.ctrl && !key.alt && !key.meta;
    switch (key.name) {
      case "escape":
        if (this.confirm) this.confirm = null;
        else if (this.query.text) {
          this.query.clear();
          this.refilter(true);
        } else return { type: "close" };
        return { type: "handled" };
      case "enter":
        return { type: "choose" };
      case "up":
        this.move(-1);
        return { type: "handled" };
      case "down":
        this.move(1);
        return { type: "handled" };
      case "page_up":
        this.move(-10);
        return { type: "handled" };
      case "page_down":
        this.move(10);
        return { type: "handled" };
      case "home":
        if (!this.query.text) this.edge(false);
        else this.query.home();
        return { type: "handled" };
      case "end":
        if (!this.query.text) this.edge(true);
        else this.query.end();
        return { type: "handled" };
      case "tab":
        this.cycleTab(key.shift ? -1 : 1);
        return { type: "handled" };
      default:
        break;
    }
    if (key.ctrl && key.name === "n") this.move(1);
    else if (key.ctrl && key.name === "p") this.move(-1);
    else if (this.searchable && editKey(this.query, key)) this.refilter(true);
    else if (this.searchable && plain && key.text && key.name !== "paste") {
      this.query.insert(key.text);
      this.refilter(true);
    } else if (this.searchable && key.name === "paste" && key.text) {
      this.query.insert(key.text.replace(/\s+/g, " "));
      this.refilter(true);
    }
    return { type: "handled" };
  }

  view(): PickerView {
    const tabs = this.options.tabs?.map(tab => ({ id: tab.id, label: tab.label, count: this.items.filter(tab.test).length }));
    const scopes = this.options.scopes?.map(scope => ({ id: scope.id, label: scope.label, ...(scope.icon ? { icon: scope.icon } : {}), ...(scope.group ? { group: scope.group } : {}), count: this.items.filter(scope.test).length }));
    return {
      props: this.options.props,
      items: this.items,
      itemsRev: this.itemsRev,
      ...(this.#wire ? { order: this.#wire } : {}),
      hits: this.#hits,
      query: this.searchable ? this.query.text : null,
      cursor: this.query.cursor,
      selected: this.selected,
      ...(this.options.current ? { current: this.options.current } : {}),
      ...(tabs ? { tabs, tab: this.tab } : {}),
      ...(scopes ? { scopes, scope: this.scope } : {}),
      actions: this.options.actions,
      confirm: this.confirm,
      state: this.state,
      message: this.message,
      ...(this.options.empty ? { empty: this.options.empty } : {}),
      ...(this.options.preview ? { preview: this.options.preview(this.selected) } : {}),
    };
  }
}

/** The line-editing keys of a one-line field; true when the key edited it. */
export function editKey(editor: TextEditor, key: Key): boolean {
  const word = key.ctrl || key.alt;
  switch (key.name) {
    case "backspace":
      editor.backspace(word);
      return true;
    case "delete":
      editor.deleteForward(word);
      return true;
    case "left":
      editor.left(key.shift, word);
      return false;
    case "right":
      editor.right(key.shift, word);
      return false;
    default:
      break;
  }
  if (key.ctrl && !key.alt) {
    switch (key.name) {
      case "a":
        editor.home();
        return false;
      case "e":
        editor.end();
        return false;
      case "u":
        editor.killToStart();
        return true;
      case "k":
        editor.killToEnd();
        return true;
      case "w":
        editor.backspace(true);
        return true;
      default:
        return false;
    }
  }
  return false;
}
