/**
 * Tool calls as `tool` nodes: a data head (title, target, facts, status)
 * over a body built from the call's arguments and result.
 */
import type { Item } from "../model.js";
import { collapsed, duration, fileHref, firstLine, h, head, plural, s, showPath, tail, tokens, type Node, type Text, type ToggleEvent, type ViewCtx } from "./h.js";

interface Hunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

function parseUnified(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of patch.split("\n")) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      hunks.push(current);
    } else if (current && line !== "" && !line.startsWith("---") && !line.startsWith("+++") && !line.startsWith("\\")) {
      // Every line of a hunk starts with its marker; an empty string is the patch's final newline.
      current.lines.push(line);
    }
  }
  return hunks;
}

/**
 * pi's edit result carries `details.diff` as numbered lines (` 12 kept`,
 * `-13 gone`, `+13 new`, `   ...` between distant changes). Each run between
 * gaps becomes a hunk starting at its first line number.
 */
function parseNumbered(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const raw of diff.split("\n")) {
    const match = raw.match(/^([ +-])\s*(\d+) ?(.*)$/);
    if (!match) {
      current = null;
      continue;
    }
    const number = Number(match[2]);
    current ??= hunks[hunks.push({ oldStart: number, newStart: number, lines: [] }) - 1]!;
    current.lines.push(`${match[1]}${match[3]}`);
  }
  // The file's final newline shows up as an empty context line: not a change.
  for (const hunk of hunks) while (hunk.lines.at(-1) === " ") hunk.lines.pop();
  return hunks.filter(hunk => hunk.lines.length);
}

function editHunks(text: (edit: any) => [string, string], edits: any[]): Hunk[] {
  const lines: string[] = [];
  for (const edit of edits) {
    const [before, after] = text(edit);
    for (const line of before.split("\n")) lines.push(`-${line}`);
    for (const line of after.split("\n")) lines.push(`+${line}`);
  }
  return lines.length ? [{ oldStart: 1, newStart: 1, lines }] : [];
}

/** The hunks of an edit: from the result when there is one, else from the arguments as they stream. */
export function diffHunks(details: Record<string, any> = {}, args: Record<string, any> = {}): Hunk[] {
  if (typeof details.patch === "string" && details.patch.includes("@@")) {
    const hunks = parseUnified(details.patch);
    if (hunks.length) return hunks;
  }
  if (typeof details.diff === "string" && details.diff.trim()) {
    const hunks = details.diff.includes("@@") ? parseUnified(details.diff) : parseNumbered(details.diff);
    if (hunks.length) return hunks;
  }
  const pair = (edit: any): [string, string] => [String(edit?.oldText ?? edit?.old_string ?? ""), String(edit?.newText ?? edit?.new_string ?? "")];
  if (Array.isArray(args.edits) && args.edits.length) return editHunks(pair, args.edits);
  if (typeof (args.oldText ?? args.old_string) === "string" || typeof (args.newText ?? args.new_string) === "string") {
    return editHunks(pair, [args]);
  }
  return [];
}

function diffStat(hunks: Hunk[]): string | undefined {
  let plus = 0;
  let minus = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) plus += 1;
      else if (line.startsWith("-")) minus += 1;
    }
  }
  return plus || minus ? `+${plus} −${minus}` : undefined;
}

type Status = "pending" | "running" | "done" | "error" | "cancelled";

function statusOf(item: Item): Status {
  switch (item.status) {
    case "running":
    case "done":
    case "error":
    case "cancelled":
      return item.status;
    default:
      return "pending";
  }
}

/** Running: ms elapsed so far (Tern counts on). Settled: the duration. */
function timing(item: Item): { age?: number; took?: number } {
  if (item.status === "running" && item.startedAt) return { age: Math.max(0, Date.now() - item.startedAt) };
  if (item.durationMs != null && (item.status === "done" || item.status === "error")) return { took: Math.round(item.durationMs) };
  return {};
}

interface ToolView {
  props: Record<string, unknown>;
  body?: (Node | null | undefined | false)[];
}

function pathOf(args: Record<string, any>): string {
  return String(args.path ?? args.file_path ?? args.file ?? "");
}

function errorText(item: Item): Node {
  const text = (item.output || "").replace(/^Error:\s*/, "").trim() || "Failed";
  return h("text", { key: "error", role: "omp.tool.error", wrap: "word", spans: [s(text, "error")] });
}

/** The foot of a run box: the state word and how long it took. */
function runFoot(item: Item, running: boolean): Node {
  const failed = item.status === "error";
  const cancelled = item.status === "cancelled" || item.cancelled;
  const exit = item.kind === "tool" ? (item.details?.exitCode ?? item.details?.exit_code) : item.exitCode;
  const word = running ? "Running" : cancelled ? "Cancelled" : failed ? (typeof exit === "number" && exit !== 0 ? `exit ${exit}` : "Failed") : "Done";
  const tone = running ? "pending" : cancelled ? "muted" : failed ? "error" : "success";
  const age = running ? Math.max(0, Date.now() - (item.startedAt || item.at)) : Math.round(item.durationMs ?? 0);
  return h("row", { key: "foot", role: "omp.run.foot", gap: "sm", align: "center" }, [
    h("text", { key: "state", role: "omp.run.state", tone, spans: [s(word)] }),
    h("elapsed", { key: "time", role: "omp.run.time", age, format: "short", ...(running ? {} : { stopped: age }) }),
    item.truncated ? h("text", { key: "facts", role: "omp.run.facts", wrap: "word", spans: [s("output truncated", "warning")] }) : null,
  ]);
}

/** The run box of a shell command: the command, its output, the foot. */
export function runBox(item: Item, command: string, lang: string, role: string, showInput: boolean): Node {
  const running = item.status === "running" || item.status === "pending";
  const output = item.output ? tail(item.output.replace(/\s+$/, "")) : "";
  return h("col", { key: "run", role: "omp.run", gap: "none", ...(item.status === "error" ? { tone: "error" } : {}) }, [
    showInput ? h("code", { key: "input", role: `${role}.command`, lang, wrap: true, preview: { lines: 6 }, text: command.trimEnd() }) : null,
    output ? h("ansi", { key: "output", role: `${role}.output`, follow: true, preview: { lines: 10 }, text: output }) : null,
    runFoot(item, running),
  ]);
}

function bashView(item: Item, ctx: ViewCtx): ToolView {
  const args = item.args || {};
  const command = String(args.command ?? "");
  const described = typeof args.description === "string" && args.description.trim();
  const oneLine = !command.includes("\n") && command.length <= 100;
  const exit = item.details?.exitCode ?? item.details?.exit_code;
  return {
    props: {
      title: "Bash",
      target: described ? firstLine(args.description, 100) : firstLine(command, 100),
      targetKind: described ? "text" : "command",
      ...(described ? {} : { lang: "bash" }),
      command,
      frame: "inline",
      collapsible: true,
      collapsed: collapsed(ctx, item.id, item.status === "done"),
      preview: "children",
      ...(item.status === "error" && typeof exit === "number" && exit !== 0 ? { exit } : {}),
    },
    body: command ? [runBox(item, command, "bash", "omp.tool.bash", Boolean(described) || !oneLine)] : [],
  };
}

function readTarget(item: Item, ctx: ViewCtx): string {
  const args = item.args || {};
  const path = showPath(pathOf(args), ctx.cwd) || "…";
  const offset = Number(args.offset);
  const limit = Number(args.limit);
  if (Number.isFinite(offset) && offset > 0) return Number.isFinite(limit) && limit > 0 ? `${path}:${offset}-${offset + limit - 1}` : `${path}:${offset}`;
  return path;
}

function readBody(item: Item, ctx: ViewCtx): (Node | null)[] {
  const path = pathOf(item.args || {});
  const images = (item.resultImages || []).map((image, index) => {
    const blob = ctx.showImages ? ctx.blob(image) : undefined;
    return blob
      ? h("image", { key: `img${index}`, role: "omp.tool.read.image", blob, alt: showPath(path, ctx.cwd) || "image", max: { h: "16lines" } })
      : h("text", { key: `img${index}`, spans: [s(`[image ${image.mimeType || ""}]`, "muted")] });
  });
  // Without pi's truncation notice, and without the file's final newline, which would draw as an empty numbered line.
  const text = item.output ? head(item.output.replace(/\n\[[^\]\n]*(?:more lines|truncated)[^\]\n]*\]\s*$/i, "").replace(/\n$/, "")) : "";
  const start = Number(item.args?.offset);
  return [
    ...images,
    text && !images.length
      ? h("code", { key: "c", path: path || undefined, numbers: true, wrap: true, text, ...(Number.isFinite(start) && start > 1 ? { start } : {}) })
      : null,
  ];
}

function readView(item: Item, ctx: ViewCtx): ToolView {
  const path = pathOf(item.args || {});
  if (item.status === "error") {
    return { props: { title: "Read", target: readTarget(item, ctx), targetKind: "path", frame: "inline", tone: "error", meta: [firstLine((item.output || "").replace(/^Error:\s*/, ""), 80)] } };
  }
  const body = item.status === "done" ? readBody(item, ctx).filter(Boolean) : [];
  return {
    props: {
      title: "Read",
      target: readTarget(item, ctx),
      targetKind: "path",
      href: fileHref(path, ctx.cwd),
      frame: "inline",
      collapsible: body.length > 0,
      ...(body.length ? { collapsed: collapsed(ctx, item.id, !item.resultImages?.length), preview: "none" } : {}),
    },
    body,
  };
}

function editView(item: Item, ctx: ViewCtx): ToolView {
  const args = item.args || {};
  const path = pathOf(args);
  const failed = item.status === "error";
  const hunks = failed ? [] : diffHunks(item.details, args);
  const line = Number(item.details?.firstChangedLine);
  const stat = diffStat(hunks);
  const live = item.status === "pending" || item.status === "running";
  return {
    props: {
      title: "Edit",
      target: `${showPath(path, ctx.cwd) || "…"}${Number.isFinite(line) && line > 0 ? `:${line}` : ""}`,
      targetKind: "path",
      href: fileHref(path, ctx.cwd),
      ...(stat ? { meta: [stat] } : {}),
      frame: "card",
      collapsible: true,
      // Forced open while the edit streams, as its preview is the point.
      collapsed: live ? false : collapsed(ctx, item.id, true),
      preview: { lines: 10 },
      ...(failed ? { tone: "error" } : {}),
    },
    body: failed ? [errorText(item)] : hunks.length ? [h("diff", { key: "0", path: path || undefined, hunks })] : [],
  };
}

function writeView(item: Item, ctx: ViewCtx): ToolView {
  const args = item.args || {};
  const path = pathOf(args);
  const content = typeof args.content === "string" ? args.content.replace(/\r/g, "") : "";
  const failed = item.status === "error";
  const live = item.status === "pending" || item.status === "running";
  const lines = content ? content.replace(/\n$/, "").split("\n").length : 0;
  return {
    props: {
      title: "Write",
      target: showPath(path, ctx.cwd) || "…",
      targetKind: "path",
      href: fileHref(path, ctx.cwd),
      ...(lines ? { meta: [plural(lines, "line")] } : {}),
      frame: "card",
      collapsible: true,
      collapsed: live ? false : collapsed(ctx, item.id, true),
      preview: { lines: 8 },
      ...(failed ? { tone: "error" } : {}),
    },
    body: failed ? [errorText(item)] : content ? [h("code", { key: "source", path: path || undefined, numbers: true, wrap: true, text: head(content) })] : [],
  };
}

/**
 * grep output (`path:12: text` for a match, `path-13- text` for context) as
 * one block per file: its lines numbered as in the file, the matches marked.
 * Null when the output is not in that form.
 */
function grepFiles(output: string, cwd: string, limit: number): { nodes: Node[]; files: number; matches: number } | null {
  // Context blocks of nearby matches overlap, so a line can arrive twice and
  // out of order: keep one entry per line, a match winning over context.
  const byFile = new Map<string, Map<number, { text: string; match: boolean }>>();
  for (const raw of output.split("\n")) {
    if (!raw.trim() || raw === "--") continue;
    const match = raw.match(/^(.+?)([:-])(\d+)\2 ?(.*)$/);
    if (!match) {
      if (/^\[.*\]$/.test(raw.trim())) continue;
      return null;
    }
    const [, path = "", sep, number, text = ""] = match;
    let lines = byFile.get(path);
    if (!lines) byFile.set(path, (lines = new Map()));
    const line = Number(number);
    const known = lines.get(line);
    if (!known || (sep === ":" && !known.match)) lines.set(line, { text, match: sep === ":" });
  }
  const files = new Map<string, { nums: number[]; lines: string[]; marks: number[] }>();
  let matches = 0;
  for (const [path, lines] of byFile) {
    const nums = [...lines.keys()].sort((x, y) => x - y);
    const marks = nums.filter(line => lines.get(line)!.match);
    matches += marks.length;
    files.set(path, { nums, lines: nums.map(line => lines.get(line)!.text), marks });
  }
  if (!files.size) return null;
  const nodes: Node[] = [];
  let index = 0;
  for (const [path, file] of files) {
    if (index >= limit) break;
    const shown = showPath(path, cwd);
    const slash = shown.lastIndexOf("/");
    nodes.push(
      h("col", { key: `f${index}`, gap: "xs", role: "omp.tool.search.file" }, [
        h("row", { key: "file", role: "omp.tool.file" }, [
          h("icon", { key: "0", name: "file" }),
          h("text", { key: "1", lines: 1, truncate: "middle", shrink: 1, title: shown, spans: [...(slash >= 0 ? [s(shown.slice(0, slash + 1), "dim")] : []), s(shown.slice(slash + 1), "strong", { href: fileHref(path, cwd) })] }),
          h("badge", { key: "2", text: String(file.marks.length), title: plural(file.marks.length, "match", "matches") }),
        ]),
        h("code", { key: "c", path, numbers: true, nums: file.nums, text: file.lines.join("\n"), marks: file.marks.map(line => ({ line, tone: "accent" })) }),
      ]),
    );
    index += 1;
  }
  if (files.size > limit) nodes.push(h("text", { key: "more", spans: [s(plural(files.size - limit, "more file"), "muted")] }));
  return { nodes, files: files.size, matches };
}

/** A search-like tool: an inline head with a count, the result folded under it. */
function searchView(item: Item, ctx: ViewCtx, title: string, target: string, kind: string, noun: string): ToolView {
  const args = item.args || {};
  const failed = item.status === "error";
  const output = (item.output || "").replace(/\s+$/, "");
  const empty = !output || /^no (matches|files|results)/i.test(output);
  const rows = empty ? 0 : output.split("\n").filter(line => line.trim() && !/^\[.*\]$/.test(line.trim())).length;
  const scope = args.path && args.path !== "." ? `in ${showPath(String(args.path), ctx.cwd)}` : undefined;
  const meta: Text[] = [];
  if (scope) meta.push(scope);
  if (args.glob) meta.push(String(args.glob));
  const open = !collapsed(ctx, item.id, !failed);
  // Collapsed sends the first two files; open sends them all.
  const grouped = noun === "match" && !failed && !empty ? grepFiles(output, ctx.cwd, open ? 200 : 2) : null;
  if (item.status === "done") {
    meta.push(grouped ? `${plural(grouped.matches, "match", "matches")} · ${plural(grouped.files, "file")}` : plural(rows, noun, noun === "match" ? "matches" : noun === "entry" ? "entries" : `${noun}s`));
  }
  const body = failed ? [errorText(item)] : grouped ? grouped.nodes : !empty ? [h("ansi", { key: "output", text: head(output) })] : [];
  return {
    props: {
      title,
      target: target || "…",
      targetKind: kind,
      ...(meta.length ? { meta } : {}),
      frame: "inline",
      collapsible: body.length > 0,
      ...(body.length ? { collapsed: collapsed(ctx, item.id, !failed), preview: { lines: 12 } } : {}),
      ...(failed ? { tone: "error" } : item.status === "done" && empty ? { tone: "warning" } : {}),
    },
    body,
  };
}

function todoView(item: Item, ctx: ViewCtx): ToolView {
  const todos = Array.isArray(item.details?.todos) ? (item.details!.todos as any[]) : null;
  const done = todos ? todos.filter(todo => todo?.done || todo?.status === "done" || todo?.status === "completed").length : 0;
  const action = String(item.args?.action ?? "");
  return {
    props: {
      title: "Todo",
      target: todos ? `${done}/${todos.length}` : action,
      targetKind: "text",
      frame: "card",
      collapsible: true,
      collapsed: collapsed(ctx, item.id, false),
      preview: "none",
      ...(item.status === "error" ? { tone: "error" } : {}),
    },
    body:
      item.status === "error"
        ? [errorText(item)]
        : todos?.length
          ? [
              h("checklist", {
                key: "checklist",
                mode: "full",
                phases: [
                  {
                    id: "p0",
                    title: "Todos",
                    items: todos.map((todo, index) => ({
                      id: `p0.${index}`,
                      text: String(todo?.text ?? todo?.content ?? ""),
                      status: todo?.done || todo?.status === "done" || todo?.status === "completed" ? "done" : todo?.status === "in_progress" || todo?.status === "active" ? "active" : "pending",
                    })),
                  },
                ],
              }),
            ]
          : [],
  };
}

/** `key=value, key=value`, each value a short scalar, within `budget` characters. */
function argsSummary(args: Record<string, any>, budget = 160): string {
  const parts: string[] = [];
  let used = 0;
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    let text = typeof value === "string" ? value : JSON.stringify(value);
    text = text.replace(/\s+/g, " ");
    if (text.length > 24) text = `${text.slice(0, 23)}…`;
    const part = `${key}=${text}`;
    if (used + part.length > budget) {
      parts.push("…");
      break;
    }
    parts.push(part);
    used += part.length + 2;
  }
  return parts.join(", ");
}

/** The first argument that names what a tool acts on. */
function primaryArg(args: Record<string, any>): [string, string] | null {
  for (const [key, kind] of [
    ["command", "command"],
    ["path", "path"],
    ["file_path", "path"],
    ["url", "text"],
    ["query", "query"],
    ["pattern", "pattern"],
    ["description", "text"],
    ["prompt", "text"],
    ["name", "text"],
  ] as const) {
    if (typeof args[key] === "string" && args[key]) return [args[key], kind];
  }
  return null;
}

function titleCase(name: string): string {
  const words = name.replace(/^mcp__/, "").split(/[_\-.]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean);
  return words.map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(" ") || "Tool";
}

function defaultView(item: Item, ctx: ViewCtx): ToolView {
  const args = item.args || {};
  const primary = primaryArg(args);
  const output = (item.output || "").replace(/\s+$/, "");
  const settled = item.status === "done" || item.status === "error";
  let body: Node[] = [];
  if (settled) {
    const images = (item.resultImages || []).flatMap((image, index) => {
      const blob = ctx.showImages ? ctx.blob(image) : undefined;
      return blob ? [h("image", { key: `img${index}`, blob, alt: image.mimeType || "image", max: { h: "16lines" } })] : [];
    });
    let json: unknown;
    if (output && /^[[{]/.test(output) && output.length <= 64 * 1024 && ctx.kinds.has("json")) {
      try {
        json = JSON.parse(output);
      } catch {
        json = undefined;
      }
    }
    body =
      json !== undefined
        ? [h("json", { key: "json", value: json as never })]
        : output
          ? [h("ansi", { key: "output", text: head(output) })]
          : images.length
            ? []
            : [h("text", { key: "empty", spans: [s("(no output)", "muted")] })];
    body.push(...images);
  }
  return {
    props: {
      title: titleCase(item.name || "tool"),
      target: primary ? (primary[1] === "path" ? showPath(primary[0], ctx.cwd) : firstLine(primary[0], 100)) : argsSummary(args) || undefined,
      targetKind: primary?.[1] ?? "text",
      frame: "card",
      collapsible: body.length > 0,
      ...(body.length ? { collapsed: collapsed(ctx, item.id, true), preview: { lines: 10 } } : {}),
      ...(item.status === "error" ? { tone: "error" } : {}),
    },
    body,
  };
}

function viewOf(item: Item, ctx: ViewCtx): ToolView {
  const args = item.args || {};
  switch (String(item.name || "").toLowerCase()) {
    case "bash":
      return bashView(item, ctx);
    case "read":
      return readView(item, ctx);
    case "edit":
    case "multiedit":
      return editView(item, ctx);
    case "write":
      return writeView(item, ctx);
    case "grep":
      return searchView(item, ctx, "Grep", String(args.pattern ?? ""), "pattern", "match");
    case "find":
    case "glob":
      return searchView(item, ctx, "Find", String(args.pattern ?? args.glob ?? ""), "pattern", "file");
    case "ls":
      return searchView(item, ctx, "List", showPath(String(args.path ?? "."), ctx.cwd), "path", "entry");
    case "todo":
      return todoView(item, ctx);
    default:
      return defaultView(item, ctx);
  }
}

/** One tool call. */
export function toolNode(item: Item, ctx: ViewCtx): Node {
  const view = viewOf(item, ctx);
  const name = String(item.name || "tool").toLowerCase();
  const body = (view.body ?? []).filter((child): child is Node => Boolean(child));
  return h(
    "tool",
    {
      key: item.id,
      role: `omp.tool.${name}`,
      name,
      status: statusOf(item),
      ...timing(item),
      ...(item.status === "cancelled" ? { note: "cancelled" } : {}),
      ...view.props,
      // pi does not say which call an approval is for; the one running with nothing to show yet is it.
      ...(ctx.awaitingApproval && item.status === "running" && !item.output ? { status: "pending", note: "awaiting approval", age: undefined } : {}),
      onToggle: (event: ToggleEvent) => ctx.on.toggle(item.id, event.collapsed === true),
    },
    body,
  );
}

/** A run of consecutive reads as one inline tool with a row per file. */
export function readGroupNode(items: Item[], ctx: ViewCtx): Node {
  const first = items[0]!;
  const running = items.some(item => item.status === "running" || item.status === "pending");
  const failed = items.every(item => item.status === "error");
  const open = !collapsed(ctx, first.id, true);
  return h(
    "tool",
    {
      key: first.id,
      role: "omp.tool.read",
      name: "read",
      title: "Read",
      target: plural(items.length, "file"),
      targetKind: "text",
      status: running ? "running" : failed ? "error" : "done",
      frame: "inline",
      collapsible: true,
      collapsed: !open,
      preview: "children",
      onToggle: (event: ToggleEvent) => ctx.on.toggle(first.id, event.collapsed === true),
    },
    items.flatMap(item => {
      const path = pathOf(item.args || {});
      const shown = readTarget(item, ctx);
      const slash = shown.lastIndexOf("/");
      const label = [slash >= 0 ? s(shown.slice(0, slash + 1), "dim") : null, s(shown.slice(slash + 1), item.status === "error" ? "error" : "strong", { href: fileHref(path, ctx.cwd) })].filter(
        (part): part is NonNullable<typeof part> => part !== null,
      );
      const row = h("row", { key: item.id, role: "omp.tool.file" }, [
        h("icon", { key: "0", name: "file" }),
        h("text", { key: "1", lines: 1, truncate: "middle", shrink: 1, title: shown, spans: label }),
        item.status === "error" ? h("text", { key: "2", lines: 1, truncate: "end", spans: [s(firstLine((item.output || "").replace(/^Error:\s*/, ""), 80), "error")] }) : null,
      ]);
      // The bodies travel only while the group is open: a closed group is its rows.
      const body = open && item.status === "done" ? readBody(item, ctx).filter(Boolean) : [];
      return body.length ? [row, h("col", { key: `${item.id}.body`, gap: "none" }, body)] : [row];
    }),
  );
}

const THINKING_TOKEN: Record<string, string> = {
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingXhigh",
};

/** A subagent run as an `agent` node; a click opens its transcript. */
export function agentNode(item: Item, ctx: ViewCtx): Node {
  const args = item.args || {};
  const assignment = String(args.task ?? args.prompt ?? args.description ?? "").trim();
  const summary = firstLine(args.description ?? args.task ?? args.prompt ?? "", 120);
  const status = item.agentStatus ?? "pending";
  const running = status === "running" || status === "pending";
  const stats: Record<string, number> = {};
  if (item.stats?.tools) stats.tools = item.stats.tools;
  if (item.stats?.tokens) stats.tokens = item.stats.tokens;
  if (running && item.startedAt) stats.age = Math.max(0, Date.now() - item.startedAt);
  else if (item.stats?.took != null) stats.took = Math.round(item.stats.took);
  const lastTool = running ? item.recentTools?.at(-1) : undefined;
  const activity = running ? item.activity || (typeof lastTool === "string" ? lastTool : (lastTool as any)?.tool) : undefined;
  const badges = [
    ...(item.background ? [{ text: "background" }] : []),
    ...(item.status === "cancelled" ? [{ text: "cancelled", tone: "muted" }] : []),
  ];
  const output = (item.output || "").trim();
  return h(
    "agent",
    {
      key: item.id,
      role: "omp.task.agent",
      name: String(args.name ?? item.agentType ?? "agent"),
      agent: item.agentType && args.name && item.agentType !== args.name ? item.agentType : undefined,
      task: summary || undefined,
      status,
      model: item.model || undefined,
      thinking: item.thinking ? THINKING_TOKEN[item.thinking] : undefined,
      tool: activity ? { name: firstLine(activity, 60) } : null,
      ...(Object.keys(stats).length ? { stats } : {}),
      ...(badges.length ? { badges } : {}),
      collapsible: true,
      collapsed: collapsed(ctx, item.id, true),
      title: "Open the subagent transcript",
      actions: { dblclick: "open" },
      onDblClick: () => ctx.on.openAgent(item),
      onMenu: { "open-transcript": () => ctx.on.openAgent(item), "copy-output": () => ctx.on.copy(output, "Subagent output") },
      onToggle: (event: ToggleEvent) => ctx.on.toggle(item.id, event.collapsed === true),
    },
    [
      assignment ? h("md", { key: "assignment", role: "omp.task.assignment", text: assignment }) : null,
      item.error ? h("text", { key: "error", role: "omp.tool.error", wrap: "word", spans: [s(item.error, "error")] }) : null,
      !running && output ? h("md", { key: "output", role: "omp.task.output", text: head(output, 400, 40_000) }) : null,
      running && item.recentOutput ? h("text", { key: "recent", lines: 2, spans: [s(firstLine(item.recentOutput, 240), "muted")] }) : null,
      h("row", { key: "open", gap: "xs", align: "center", role: "omp.task.open", title: "Open the subagent transcript", onClick: () => ctx.on.openAgent(item) }, [
        h("icon", { key: "0", name: "expand" }),
        h("text", { key: "1", spans: [s("View transcript", "muted")] }),
        item.stats?.tokens ? h("text", { key: "2", spans: [s(`· ${tokens(item.stats.tokens)} tok`, "dim")] }) : null,
        !running && item.stats?.took != null ? h("text", { key: "3", spans: [s(`· ${duration(item.stats.took)}`, "dim")] }) : null,
      ]),
    ],
  );
}

/** A `!command` (or a stored bash/python execution) the user ran. */
export function executionNode(item: Item, ctx: ViewCtx): Node {
  const python = item.kind === "python";
  const running = item.status === "running";
  const status = running ? "running" : item.status === "cancelled" ? "cancelled" : item.status === "error" ? "error" : "done";
  const elapsed = running ? { age: Math.max(0, Date.now() - (item.startedAt || item.at)) } : item.durationMs != null ? { took: Math.round(item.durationMs) } : {};
  return h(
    "tool",
    {
      key: item.id,
      role: python ? "omp.eval" : "omp.bash",
      name: python ? "eval" : "bash",
      title: python ? "Python" : "Bash",
      command: item.text,
      badges: [{ text: "you", tone: "user" }, ...(item.excluded ? [{ text: "not sent", title: "Not sent to the model", tone: "muted" }] : [])],
      status,
      ...elapsed,
      ...(status === "error" && typeof item.exitCode === "number" ? { exit: item.exitCode } : {}),
      ...(status === "cancelled" ? { note: "cancelled" } : {}),
      frame: "card",
      collapsible: true,
      collapsed: collapsed(ctx, item.id, false),
      preview: "children",
      onToggle: (event: ToggleEvent) => ctx.on.toggle(item.id, event.collapsed === true),
    },
    [runBox(item, item.text, python ? "python" : "bash", python ? "omp.tool.eval" : "omp.tool.bash", true)],
  );
}
