/**
 * What every view shares: the node builder, the render context and the
 * formatters.
 */
import { node, span, type Node, type Span } from "@stencil-hq/tern";
import { homedir } from "node:os";
import type { Item } from "../model.js";

export { node as h, span as s };
export type { Node, Span };
export type { ActionEvent, ActivateEvent, ChangeEvent, EditEvent, FocusEvent, SelectEvent, SendEvent, ToggleEvent, UndoEvent } from "@stencil-hq/tern";

/** A span list or plain string, as TSP text props take it. */
export type Text = string | readonly Span[];

/** The callbacks views attach to nodes. */
export interface Actions {
  toggle(id: string, collapsed: boolean): void;
  copy(text: string, what: string): void;
  rewind(item: Item): void;
  editTurn(item: Item): void;
  retry(): void;
  pickModel(): void;
  openAgent(item: Item): void;
  open(path: string): void;
  /** A control of a command pane was used: `view:raw`, `view:pseudo`, `layer:color`. */
  shell(id: string, value: string): void;
}

/** What a view needs beyond the conversation. */
export interface ViewCtx {
  cwd: string;
  kinds: ReadonlySet<string>;
  hour12: boolean;
  expandAll: boolean;
  hideThinking: boolean;
  showImages: boolean;
  /** Draw tool calls as one-line rows, runs of them closed up. */
  compactTools: boolean;
  /** Follow a table of numbers in a reply with a bar chart of it. */
  showCharts: boolean;
  /** Draw a token usage line under each assistant message. */
  showUsage: boolean;
  /** An approval is open: the tool call that is running is waiting on it. */
  awaitingApproval: boolean;
  /** How each command pane is shown, by item id; absent is the default. */
  shell: ReadonlyMap<string, { view: "raw" | "pseudo"; color: boolean }>;
  /** Per-node fold state the user set, by item id. */
  fold: ReadonlyMap<string, boolean>;
  /** Bumped when `fold`, `expandAll`, `hideThinking` or `showImages` change. */
  foldRev: number;
  /** Sends an image and returns its blob id, or undefined when it has no data. */
  blob(image: { data?: string; mimeType?: string }): string | undefined;
  on: Actions;
}

/** Whether the node of `id` is collapsed: the user's toggle, else the default. */
export function collapsed(ctx: ViewCtx, id: string, fallback: boolean): boolean {
  return ctx.fold.get(id) ?? (ctx.expandAll ? false : fallback);
}

/** `8.6s`, `1m 5s`, `420ms`. */
export function duration(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}

/** `850`, `9.7K`, `120K`, `1M`, `1.2M`. */
export function tokens(value: number | undefined | null): string {
  if (value == null || !Number.isFinite(value)) return "";
  if (value < 1000) return String(Math.round(value));
  const scaled = value < 1_000_000 ? value / 1000 : value / 1_000_000;
  const unit = value < 1_000_000 ? "K" : "M";
  const text = scaled < 10 ? scaled.toFixed(1) : String(Math.round(scaled));
  return `${text.replace(/\.0$/, "")}${unit}`;
}

/** `$0.42`, `<$0.01`, or empty for zero. */
export function money(cost: number | undefined | null): string {
  if (!cost || cost <= 0) return "";
  return cost < 0.005 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

export function clock(at: number, hour12: boolean): string {
  try {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12 });
  } catch {
    return "";
  }
}

/** A path as shown: relative to the project, else with `~` for home. */
export function showPath(path: string, cwd: string): string {
  if (!path) return "";
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  if (path === cwd) return ".";
  const home = homedir();
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

/** The `file://` link of a path, resolved against the project. */
export function fileHref(path: string, cwd: string): string | undefined {
  if (!path || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return undefined;
  const expanded = path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
  const full = expanded.startsWith("/") ? expanded : `${cwd}/${expanded}`;
  return `file://${full.split("/").map(encodeURIComponent).join("/")}`;
}

export function firstLine(text: unknown, max = 120): string {
  const line = String(text ?? "").split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Keeps the last `chars` characters and `lines` lines of live output. */
export function tail(text: string, lines = 2000, chars = 200_000): string {
  let out = text.length > chars ? text.slice(-chars) : text;
  const rows = out.split("\n");
  if (rows.length > lines) out = rows.slice(-lines).join("\n");
  return out;
}

/** Keeps the first `chars` characters and `lines` lines of a file body. */
export function head(text: string, lines = 2000, chars = 200_000): string {
  let out = text.length > chars ? text.slice(0, chars) : text;
  const rows = out.split("\n");
  if (rows.length > lines) out = rows.slice(0, lines).join("\n");
  return out;
}
