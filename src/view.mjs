/**
 * The Tern view: transcript, composer, layer (pickers, approvals), status.
 * Every function is pure: it takes the conversation + UI state and returns
 * plain TSP nodes. The UI loop diffs them.
 */
import { fmtModel } from "./state.mjs";

export const BUILD = "pit-1.0.14+2026.11.09";

export const THEME = {
  dark: {
    accent: "#A78BFA",
    info: "#67E8F9",
    success: "#34D399",
    warning: "#FBBF24",
    error: "#FB7185",
    muted: "#9CA3AF",
  },
  light: {
    accent: "#6D28D9",
    info: "#0891B2",
    success: "#059669",
    warning: "#D97706",
    error: "#E11D48",
    muted: "#6B7280",
  },
};

const n = (k, p = {}, c = null) => {
  const node = { k, p };
  if (c && c.length) node.c = c.filter(Boolean);
  return node;
};

/** Give a node an id from its parent item: stable across renders. */
function id(node, value) {
  node.id = value;
  return node;
}

export function spans(text, style) {
  return style ? [{ t: text, s: style }] : [text];
}

export function clock(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function humanMs(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function humanTokens(value) {
  if (!value && value !== 0) return "";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function clip(text, lines = 400, chars = 24000) {
  if (typeof text !== "string") return "";
  let out = text;
  let note = "";
  const rows = out.split("\n");
  if (rows.length > lines) {
    note = `\n… ${rows.length - lines} more lines`;
    out = rows.slice(0, lines).join("\n");
  }
  if (out.length > chars) {
    note += `\n… ${out.length - chars} more characters`;
    out = out.slice(0, chars);
  }
  return out + note;
}

export function firstLine(text, max = 120) {
  const line = String(text || "").split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function parseUnified(patch) {
  const hunks = [];
  let current = null;
  for (const line of String(patch || "").split("\n")) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("\\")) continue;
    current.lines.push(line);
  }
  return hunks;
}

/** pi's edit detail is " 12 old\n-13 gone\n+13 new": strip the line numbers. */
export function diffHunks(details = {}, args = {}) {
  if (typeof details.patch === "string" && details.patch.includes("@@")) {
    const hunks = parseUnified(details.patch);
    if (hunks.length) return hunks;
  }
  if (typeof details.diff === "string" && details.diff.trim()) {
    const lines = [];
    for (const raw of details.diff.split("\n")) {
      const match = raw.match(/^([ +-])(\d+)?\s?(.*)$/);
      if (match) lines.push(`${match[1]}${match[3]}`);
      else lines.push(raw);
    }
    return [{ oldStart: 1, newStart: 1, lines }];
  }
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length) {
    const lines = [];
    for (const edit of edits) {
      for (const line of String(edit.oldText || "").split("\n")) if (line !== "") lines.push(`-${line}`);
      for (const line of String(edit.newText || "").split("\n")) if (line !== "") lines.push(`+${line}`);
    }
    if (lines.length) return [{ oldStart: 1, newStart: 1, lines }];
  }
  if (typeof args.oldText === "string" || typeof args.newText === "string") {
    const lines = [];
    for (const line of String(args.oldText || "").split("\n")) if (line !== "") lines.push(`-${line}`);
    for (const line of String(args.newText || "").split("\n")) if (line !== "") lines.push(`+${line}`);
    if (lines.length) return [{ oldStart: 1, newStart: 1, lines }];
  }
  return [];
}

function diffStat(hunks) {
  let plus = 0;
  let minus = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) plus += 1;
      else if (line.startsWith("-")) minus += 1;
    }
  }
  return { plus, minus };
}

const TOOL_ICONS = {
  bash: "terminal",
  python: "code",
  eval: "code",
  read: "read",
  edit: "edit",
  write: "write",
  grep: "search",
  find: "search",
  ls: "files",
  subagent: "agents",
  web: "globe",
  webfetch: "globe",
  websearch: "search",
};

const TOOL_TITLES = {
  bash: "Ran",
  python: "Ran",
  eval: "Ran",
  read: "Read",
  edit: "Edited",
  write: "Wrote",
  grep: "Searched",
  find: "Found",
  ls: "Listed",
  subagent: "Delegated",
  web: "Opened",
  webfetch: "Fetched",
  websearch: "Searched",
};

function toolTarget(item) {
  const args = item.args || {};
  if (item.name === "bash") return [args.command || "", "command"];
  if (item.name === "read" || item.name === "write") return [args.path || args.file_path || "", "path"];
  if (item.name === "edit") return [args.path || args.file_path || "", "path"];
  if (item.name === "grep") return [args.pattern || "", "pattern"];
  if (item.name === "find") return [args.pattern || args.glob || "", "pattern"];
  if (item.name === "subagent") return [args.agent || "", "text"];
  for (const key of ["command", "path", "file_path", "pattern", "query", "url", "description"]) {
    if (typeof args[key] === "string" && args[key]) return [args[key], key === "command" ? "command" : "text"];
  }
  return ["", "text"];
}

export function toolMeta(item, hunks) {
  const meta = [];
  if (hunks?.length) {
    const { plus, minus } = diffStat(hunks);
    if (plus || minus) meta.push({ t: `+${plus} −${minus}`, s: minus ? "success" : "success" });
  }
  const args = item.args || {};
  if (item.name === "read" && item.output) {
    const lines = item.output.split("\n").length;
    meta.push({ t: `${lines} lines`, s: "muted" });
  }
  if (item.name === "bash") {
    const exit = item.result?.structuredContent?.exit_code ?? item.details?.exit_code;
    if (exit != null && exit !== 0) meta.push({ t: `exit ${exit}`, s: "error" });
  }
  return meta;
}

/** One tool row. Reads are inline and collapsed; mutations and bash are cards. */
function renderReadGroup(items, ctx) {
  const sections = items.map((item, index) => {
    const path = item.args?.path || item.args?.file_path || `file ${index + 1}`;
    const output = item.output || "";
    return id(n("section", {
      role: "pit.tool.readfile",
      head: [{ t: path, s: "muted mono" }],
      collapsible: true,
      collapsed: true,
    }, output ? [
      id(n("code", { text: clip(output, 160, 12000), path, lang: languageOf(path), wrap: true, actions: { menu: ["copy"] } }), `rg${index}.out`),
    ] : []), `rg${index}`);
  });
  return id(n("tool", {
    role: "pit.tool.readgroup",
    name: "read",
    title: spans("Read"),
    target: spans(`${items.length} files`),
    targetKind: "text",
    status: items.some((item) => item.status === "error") ? "error" : "done",
    frame: "card",
    icon: "files",
    collapsible: true,
    collapsed: true,
    preview: { lines: 8 },
    meta: [{ t: `${items.length} files`, s: "muted" }],
  }, sections), items[0].id);
}

export function renderTool(item, ctx) {
  if (item.kind === "agent") return renderAgent(item, ctx);
  const args = item.args || {};
  const name = String(item.name || "tool").toLowerCase();
  if (name === "todo") return null; // the checklist board below the transcript owns this state
  const [target, targetKind] = toolTarget(item);
  const hunks = name === "edit" ? diffHunks(item.details || {}, args) : [];
  const inline = name === "read" || name === "grep" || name === "find" || name === "ls";
  const status = item.status === "queued" ? "running" : item.status === "error" ? "error" : item.status === "done" ? "done" : "running";
  const props = {
    role: `pit.tool.${name}`,
    name,
    title: spans(TOOL_TITLES[name] || item.name || "Tool"),
    target: target ? spans(target) : undefined,
    targetKind,
    status,
    frame: inline ? "inline" : "card",
    collapsible: true,
    collapsed: inline ? !ctx.expandAll : false,
    preview: inline ? { lines: 12 } : { lines: 24 },
    icon: TOOL_ICONS[name] || "tool",
    meta: toolMeta(item, hunks),
  };
  if (item.durationMs != null) props.took = item.durationMs;
  else if (status === "running" && item.startedAt) props.age = Date.now() - item.startedAt;
  const exit = item.result?.structuredContent?.exit_code ?? item.details?.exit_code;
  if (exit != null && exit !== 0) props.exit = exit;
  props.badges = [];
  if (name === "subagent") props.badges.push({ text: args.agent || "agent", tone: "accent" });
  if (args.async === false && name === "subagent") props.badges.push({ text: "foreground", tone: "muted" });

  const body = [];
  const base = `${item.id}`;
  if (hunks.length) {
    body.push(n("diff", { path: args.path || args.file_path || "", mode: "unified", hunks }, null));
    body[body.length - 1].id = `${base}.diff`;
  }
  if (name === "write" && typeof args.content === "string") {
    body.push(id(n("code", { text: clip(args.content, 200, 12000), path: args.path || args.file_path || "", numbers: true, lang: languageOf(args.path) }), `${base}.code`));
  }
  const output = item.output || "";
  if (output && name !== "edit") {
    const out = clip(output, inline ? 200 : 400, 20000);
    const coded = id(n("code", { text: out, lang: name === "bash" ? "shell" : languageOf(target), wrap: name !== "bash", actions: { menu: ["copy"] } }), `${base}.out`);
    body.push(coded);
  }
  if (!body.length && status === "running") {
    body.push(id(n("row", { gap: "xs", align: "center" }, [
      id(n("spinner", { style: "dots" }), `${base}.spin`),
      id(n("text", { spans: [{ t: item.name === "bash" ? "running…" : `${item.name}…`, s: "muted" }] }), `${base}.run`),
    ]), `${base}.runrow`));
  }
  return id(n("tool", props, body), item.id);
}

function languageOf(path = "") {
  const ext = String(path).split(".").pop()?.toLowerCase();
  const map = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", json: "json", md: "md", py: "python",
    rs: "rust", go: "go", sh: "shell", zsh: "shell", bash: "shell", css: "css", html: "html",
    yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql", diff: "diff", c: "c", h: "c",
    cpp: "cpp", hpp: "cpp", java: "java", rb: "ruby", swift: "swift", kt: "kotlin",
  };
  return map[ext] || "";
}

export function renderAgent(item, ctx) {
  const running = item.agentStatus === "running" || item.status === "running";
  const failed = item.agentStatus === "failed" || item.status === "error" || item.isError;
  const status = failed ? "failed" : running ? "running" : "done";
  const stats = item.stats || {};
  const current = item.recentTools?.[item.recentTools.length - 1];
  const children = [];
  const base = item.id;
  if (item.recentTools?.length) {
    const recent = item.recentTools.slice(-4).map((tool) => tool.tool || tool.name).filter(Boolean).join(" → ");
    if (recent) {
      children.push(id(n("text", { spans: [{ t: recent, s: "dim mono" }], truncate: "end" }), `${base}.recent.tools`));
    }
  }
  if (item.recentOutput?.length) {
    children.push(id(n("text", {
      spans: [{ t: item.recentOutput.slice(-1)[0].slice(0, 180), s: "muted mono" }],
      lines: 2,
    }), `${base}.recent`));
  }
  children.push(id(n("row", { gap: "xs", align: "center", actions: { click: "agent-view" } }, [
    id(n("icon", { name: "expand" }), `${base}.view.ic`),
    id(n("text", { spans: [{ t: "View transcript", s: "muted" }] }), `${base}.view.t`),
  ]), `${base}.view`));
  if (item.output && !running && ctx.expandAgents) {
    children.push(id(n("rule", { variant: "pin", label: [{ t: "Report", s: "muted" }] }), `${base}.rule`));
    children.push(id(n("md", { text: clip(item.output, 80, 8000), actions: { menu: ["copy"] } }), `${base}.report`));
  }
  return id(n("agent", {
    role: "pit.agent",
    name: "Task",
    agent: item.agentType || "agent",
    badges: item.args?.async ? [{ text: "background", tone: "muted" }] : [],
    task: item.args?.task ? [{ t: firstLine(item.args.task, 120), s: "muted" }] : undefined,
    status,
    model: item.model || "",
    thinking: item.thinking || "",
    tool: current ? { name: current.tool || current.name || "tool", age: current.age } : undefined,
    stats: { tools: stats.tools || 0, tokens: stats.tokens || 0, ...(running ? {} : { took: stats.took }) },
    depth: item.depth || 1,
    collapsible: true,
    collapsed: false,
    actions: { click: "agent-view" },
    title: "Open the subagent transcript",
  }, children), item.id);
}

export function renderThinking(item, ctx) {
  if (ctx.hideThinking) return null;
  const streaming = item.status === "running" || item.status === "streaming";
  const head = id(n("row", { gap: "xs", align: "center" }, [
    id(n("text", { spans: [{ t: streaming ? "Thinking" : `Thought${item.tookMs ? ` for ${humanMs(item.tookMs)}` : ""}`, s: "muted" }] }), `${item.id}.lbl`),
    streaming ? id(n("spinner", { style: "dots" }), `${item.id}.spin`) : null,
  ]), `${item.id}.head`);
  return id(n("section", {
    role: "pit.thinking",
    collapsible: true,
    collapsed: !ctx.expandAll,
    head: `${item.id}.head`,
  }, [head, id(n("md", { text: item.text || "", stream: streaming }), `${item.id}.body`)]), item.id);
}

export function renderSummary(item, ctx) {
  const isBranch = item.kind === "branch";
  const label = isBranch
    ? "Branch summarized"
    : `Compacted${item.tokensBefore ? ` · ${humanTokens(item.tokensBefore)}` : ""}${item.tokensAfter ? ` → ${humanTokens(item.tokensAfter)} tokens` : ""}`;
  const head = id(n("row", { gap: "xs", align: "center" }, [
    id(n("icon", { name: isBranch ? "branch" : "layers", tone: "muted" }), `${item.id}.ic`),
    id(n("text", { spans: [{ t: label, s: "muted" }] }), `${item.id}.label`),
    item.warning ? id(n("icon", { name: "warn", tone: "warning" }), `${item.id}.warn`) : null,
  ]), `${item.id}.head`);
  return id(n("section", {
    role: isBranch ? "pit.branch" : "pit.compaction",
    collapsible: true,
    collapsed: !ctx.expandAll,
    head: `${item.id}.head`,
  }, [
    head,
    id(n("md", { text: item.text || "", actions: { menu: ["copy"] } }), `${item.id}.body`),
  ]), item.id);
}

export function renderCustom(item, ctx) {
  const hook = item.kind === "hook";
  const head = id(n("row", { gap: "xs", align: "center" }, [
    id(n("icon", { name: hook ? "link" : "package", tone: "muted" }), `${item.id}.ic`),
    id(n("text", { spans: [{ t: item.customType || (hook ? "hook" : "extension"), s: "muted" }] }), `${item.id}.type`),
  ]), `${item.id}.head`);
  return id(n("card", {
    role: hook ? "pit.hook" : "pit.custom",
    inset: true,
    collapsible: true,
    collapsed: false,
    head: `${item.id}.head`,
  }, [
    head,
    id(n("md", { text: item.text || "", actions: { menu: ["copy"] } }), `${item.id}.body`),
  ]), item.id);
}

export function renderExecution(item, ctx) {
  const python = item.kind === "python";
  const failed = item.status === "error" || (item.exitCode != null && item.exitCode !== 0);
  return id(n("tool", {
    role: python ? "pit.tool.python" : "pit.tool.bash",
    name: python ? "python" : "bash",
    title: spans(python ? "Python" : "Bash"),
    target: spans(item.text || ""),
    targetKind: "command",
    status: failed ? "error" : item.status === "running" ? "running" : "done",
    icon: python ? "code" : "terminal",
    frame: "card",
    collapsible: true,
    collapsed: false,
    preview: { lines: 24 },
    ...(item.exitCode != null ? { exit: item.exitCode } : {}),
    meta: item.truncated ? [{ t: "truncated", s: "warning" }] : [],
  }, item.output ? [
    id(n("code", { text: clip(item.output, 400, 24000), lang: python ? "python" : "shell", wrap: false, actions: { menu: ["copy"] } }), `${item.id}.out`),
  ] : []), item.id);
}

export function renderTodos(conv, ctx) {
  const todos = conv.todos?.items || [];
  if (!todos.length) return null;
  const done = todos.filter((todo) => todo.status === "done").length;
  const active = todos.find((todo) => todo.status === "active");
  const phases = conv.todos.phases?.length
    ? conv.todos.phases.map((phase, phaseIndex) => ({
      id: phase.id || `phase${phaseIndex}`,
      title: [{ t: phase.name || `Phase ${phaseIndex + 1}`, s: "strong" }],
      items: phase.items.map((todo, index) => ({
        id: `todo${phaseIndex}.${index}`,
        text: todo.text,
        status: todo.status === "done" ? "done"
          : todo.status === "active" ? "active"
          : todo.status === "dropped" ? "dropped"
          : todo.status === "blocked" ? "blocked"
          : "pending",
        ...(todo.note ? { note: [{ t: todo.note, s: "muted" }] } : {}),
      })),
    }))
    : [{ id: "todos", title: [{ t: `Todo · ${done}/${todos.length}`, s: "strong" }], items: todos.map((todo, index) => ({
      id: `todo${index}`,
      text: todo.text,
      status: todo.status === "done" ? "done" : todo.status === "active" ? "active" : "pending",
      ...(todo.status === "blocked" ? { note: [{ t: "blocked", s: "muted" }] } : {}),
    })) }];
  const title = `Todo · ${done}/${todos.length}`;
  if (ctx.kinds && !ctx.kinds.has("checklist")) {
    return id(n("card", { role: "pit.todos", inset: true }, [
      id(n("text", { spans: [{ t: `${title}${active ? ` · ${active.text}` : ""}`, s: "muted" }] }), "todos.title"),
    ]), "todos");
  }
  return id(n("checklist", {
    phases,
    mode: "full",
    note: done === todos.length ? [{ t: "All done", s: "success" }] : undefined,
  }), "todos");
}

export function renderUser(item, ctx) {
  const body = [];
  if (item.images?.length) {
    const imgs = item.images.map((img, index) => {
      const blob = ctx.blobFor?.(img.data, img.mimeType || "image/png");
      return id(n("image", blob ? { blob, alt: `attachment ${index + 1}`, w: 220 } : { alt: "attachment pending" }), `${item.id}.img${index}`);
    });
    body.push(id(n("row", { gap: "sm", align: "start" }, imgs), `${item.id}.imgs`));
  }
  body.push(id(n("md", { text: item.text || "" }), `${item.id}.md`));
  // omp's transcript is deliberately quiet: no timestamp or completion
  // telemetry beside a turn. Keep the bubble content-fit and metadata-free.
  return id(n("row", { gap: "none", align: "end" }, [
    id(n("spacer", { grow: 1 }), `${item.id}.sp`),
    id(n("card", { role: "pit.user", tone: "user", basis: "content", grow: 0, max: { w: "82ch" }, inset: true }, body), `${item.id}.card`),
  ]), item.id);
}

export function renderAssistant(item, ctx) {
  const streaming = item.status === "streaming" || item.status === "pending";
  return id(n("col", { gap: "none", role: "pit.answer" }, [
    id(n("md", { text: item.text || "", stream: streaming, actions: { menu: ["copy"] } }), `${item.id}.md`),
  ]), item.id);
}

function footerForTurn(items, ctx) {
  const tools = items.filter((item) => item.kind === "tool" || item.kind === "agent").length;
  const took = ctx.turnMs || 0;
  const bits = [];
  if (took) bits.push(`Worked for ${humanMs(took)}`);
  if (tools) bits.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  if (ctx.turnTokens) bits.push(`${humanTokens(ctx.turnTokens)} tok`);
  if (ctx.tokPerSec) bits.push(`${ctx.tokPerSec} tok/s`);
  if (!bits.length) return null;
  return id(n("rule", {
    variant: "line",
    label: [{ t: bits.join(" · "), s: "muted" }],
    time: clock(Date.now()),
  }), `turn.footer.${items[0]?.id || "x"}`);
}

/** A turn is everything between two user messages. */
export function renderTranscript(conv, ctx) {
  const out = [];
  let turn = [];
  const flush = () => {
    turn = [];
  };
  for (let index = 0; index < conv.items.length; index += 1) {
    const item = conv.items[index];
    if (item.kind === "user") {
      flush();
      out.push(renderUser(item, ctx));
      continue;
    }
    if (item.kind === "tool" && String(item.name).toLowerCase() === "read") {
      const group = [item];
      let cursor = index + 1;
      while (cursor < conv.items.length) {
        const next = conv.items[cursor];
        if (next.kind !== "tool" || String(next.name).toLowerCase() !== "read") break;
        group.push(next);
        cursor += 1;
      }
      if (group.length > 1) {
        out.push(renderReadGroup(group, ctx));
        index = cursor - 1;
        continue;
      }
    }
    turn.push(item);
    if (item.kind === "assistant") out.push(renderAssistant(item, ctx));
    else if (item.kind === "thinking") out.push(renderThinking(item, ctx));
    else if (item.kind === "tool" || item.kind === "agent") {
      const node = renderTool(item, ctx);
      if (node) out.push(node);
    }
    else if (item.kind === "compaction" || item.kind === "branch") out.push(renderSummary(item, ctx));
    else if (item.kind === "custom" || item.kind === "hook") out.push(renderCustom(item, ctx));
    else if (item.kind === "bash" || item.kind === "python") out.push(renderExecution(item, ctx));
    else if (item.kind === "info") {
      out.push(id(n("text", { spans: [{ t: item.text, s: item.tone || "muted" }], lines: 2 }), item.id));
    } else if (item.kind === "error") {
      out.push(id(n("tool", {
        name: "error", title: spans("Error"), status: "error", frame: "card",
        meta: [{ t: item.text, s: "error" }],
      }), item.id));
    }
  }
  flush();
  return out;
}

export function brandBar(conv, ctx) {
  const model = ctx.modelLabel || fmtModel(ctx.model || conv.model || "");
  return id(n("row", { gap: "sm", align: "center", role: "pit.brandbar" }, [
    id(n("text", { role: "pit.badge", spans: [{ t: "π" }] }), "brand.badge"),
    id(n("text", { role: "pit.wordmark", spans: [{ t: "pi", s: "strong" }] }), "brand.name"),
    conv.sessionName ? id(n("text", { spans: [{ t: `· ${conv.sessionName}`, s: "muted" }], truncate: "end" }), "brand.session") : null,
    id(n("spacer", { grow: 1 }), "brand.sp"),
    ctx.compact ? null : id(n("badge", { text: "TSP" }), "brand.tsp"),
    id(n("text", { spans: [{ t: model, s: "muted" }], truncate: "end" }), "brand.model"),
  ]), "brand");
}

export function splash(conv, ctx) {
  const model = ctx.modelLabel || fmtModel(ctx.model || conv.model || "");
  const suggestions = ctx.compact
    ? ["Explain this repo", "Fix a failing test"]
    : ["Explain this repo", "Fix a failing test", "Review my diff", "Write a test"];
  const chips = suggestions.map((text, index) =>
    id(n("row", {
      role: "pit.suggestion",
      gap: "xs",
      align: "center",
      actions: { click: `suggest:${index}` },
      title: text,
    }, [
      id(n("text", { spans: [{ t: text, s: "muted" }], truncate: "end" }), `splash.s${index}t`),
    ]), `splash.s${index}`),
  );
  const hints = id(n("row", { gap: "sm", align: "center", role: "pit.hints" }, [
    id(n("kbd", { keys: ["enter"] }), "splash.k1"),
    id(n("text", { spans: [{ t: "send", s: "dim" }] }), "splash.h1"),
    id(n("kbd", { keys: ["/"] }), "splash.k2"),
    id(n("text", { spans: [{ t: "commands", s: "dim" }] }), "splash.h2"),
    id(n("kbd", { keys: ["@"] }), "splash.k3"),
    id(n("text", { spans: [{ t: "files", s: "dim" }] }), "splash.h3"),
    id(n("kbd", { keys: ["esc"] }), "splash.k4"),
    id(n("text", { spans: [{ t: "clear", s: "dim" }] }), "splash.h4"),
  ]), "splash.hints");
  return id(n("col", { role: "pit.splash", gap: "lg", align: "center" }, [
    id(n("spacer", { size: "lg" }), "splash.top"),
    id(n("row", { gap: "md", align: "center", role: "pit.hero" }, [
      id(n("text", { role: "pit.badge-lg", spans: [{ t: "π" }] }), "splash.badge"),
      id(n("col", { gap: "none", role: "pit.herotext" }, [
        id(n("text", { role: "pit.wordmark-xl", spans: [{ t: "pi", s: "strong" }] }), "splash.word"),
        id(n("shimmer", { text: "a Tern-native coding agent", mode: "kitt" }), "splash.tag"),
      ]), "splash.herocol"),
    ]), "splash.hero"),
    ctx.compact ? null : id(n("text", {
      role: "pit.splashmeta",
      spans: [{ t: `${model} · 1M context · effort ${(ctx.effort || conv.thinkingLevel || "max").toLowerCase()}`, s: "dim" }],
      lines: 2,
    }), "splash.meta"),
    id(n("row", { gap: "sm", align: "center", role: "pit.suggestions", wrap: true }, chips), "splash.chips"),
    id(n("card", { role: "pit.welcome", inset: true }, [
      id(n("row", { gap: "xs", align: "center" }, [
        id(n("icon", { name: "sparkles", tone: "accent" }), "welcome.ic"),
        id(n("text", { role: "pit.welcome.title", spans: [{ t: "Tern-native, powered by your pi", s: "strong" }] }), "welcome.title"),
      ]), "welcome.head"),
      id(n("text", {
        role: "pit.welcome.body",
        spans: [{ t: "Semantic transcript, tool cards, subagents, checklists, model pickers and approvals. Your pi config, extensions and skills are used as-is.", s: "muted" }],
        lines: 2,
      }), "welcome.body"),
    ]), "splash.welcome"),
    id(n("spacer", { grow: 1 }), "splash.grow"),
    hints,
  ]), "splash");
}

export function renderPlan(conv, ctx) {
  if (!conv.plan?.steps?.length) return null;
  const done = conv.plan.steps.filter((step) => step.done).length;
  const items = conv.plan.steps.map((step, index) =>
    id(n("text", { spans: [{ t: `${step.done ? "✓" : "○"} ${step.text}`, s: step.done ? "success" : "muted" }] }), `plan.step${index}`),
  );
  const head = id(n("row", { gap: "xs", align: "center" }, [
    id(n("icon", { name: "plan", tone: "info" }), "plan.ic"),
    id(n("text", { spans: [{ t: conv.plan.title || "Plan", s: "strong" }] }), "plan.title"),
    id(n("text", { spans: [{ t: ` · ${done}/${conv.plan.steps.length}`, s: "muted" }] }), "plan.count"),
    id(n("spacer", { grow: 1 }), "plan.sp"),
    id(n("row", { role: "chip", gap: "xs", align: "center", actions: { click: "plan-implement" } }, [
      id(n("icon", { name: "play", tone: "accent" }), "plan.run.ic"),
      id(n("text", { spans: [{ t: "Implement", s: "accent" }] }), "plan.run.t"),
    ]), "plan.run"),
  ]), "plan.head");
  return id(n("card", { role: "pit.plan", inset: true }, [head, ...items]), "plan");
}

export function renderApproval(conv, ctx) {
  const approval = ctx.approval;
  if (!approval) return null;
  const buttons = [
    id(n("row", { role: "chip", tone: "success", gap: "xs", align: "center", actions: { click: "approve:once" } }, [
      id(n("icon", { name: "check", tone: "success" }), "appr.once.ic"),
      id(n("text", { spans: [{ t: "Allow once", s: "success" }] }), "appr.once.t"),
    ]), "appr.once"),
    id(n("row", { role: "chip", gap: "xs", align: "center", actions: { click: "approve:session" } }, [
      id(n("text", { spans: [{ t: "Always this session", s: "muted" }] }), "appr.session.t"),
    ]), "appr.session"),
    id(n("row", { role: "chip", tone: "error", gap: "xs", align: "center", actions: { click: "approve:deny" } }, [
      id(n("icon", { name: "x", tone: "error" }), "appr.deny.ic"),
      id(n("text", { spans: [{ t: "Deny", s: "error" }] }), "appr.deny.t"),
    ]), "appr.deny"),
  ];
  return id(n("overlay", {
    anchor: "center",
    modal: true,
    size: "md",
    head: spans("Permission"),
    icon: "shield-alert",
    meta: spans(approval.tool || "tool"),
  }, [
    id(n("col", { gap: "md", role: "pit.approval" }, [
      id(n("text", { spans: [{ t: approval.title || "Allow this tool call?", s: "strong" }] }), "appr.title"),
      approval.detail ? id(n("code", { text: clip(approval.detail, 18, 4000), wrap: true }), "appr.detail") : null,
      approval.message ? id(n("md", { text: approval.message }), "appr.message") : null,
      id(n("row", { gap: "sm", align: "center", wrap: true }, buttons), "appr.buttons"),
    ]), "appr.body"),
  ]), "approval");
}

function pickerPreview(picker) {
  if (picker.kind === "fork" || picker.kind === "tree") {
    const entry = picker.entries?.find((item) => item.id === picker.selected);
    if (!entry) return [];
    return [
      id(n("text", { spans: [{ t: `${entry.role === "user" ? "You" : "pi"}${entry.label ? ` · ${entry.label}` : ""} · branch point`, s: "muted" }] }), "picker.preview.meta"),
      id(n("md", { text: clip(entry.text, 80, 12000) }), "picker.preview.md"),
    ];
  }
  if (picker.kind === "copy") {
    const item = picker.texts?.find((entry) => entry.id === picker.selected);
    if (!item?.text) return [];
    return [id(n("md", { text: clip(item.text, 80, 12000) }), "picker.preview.md")];
  }
  if (picker.kind === "resume") {
    const session = picker.sessions?.find((entry) => entry.id === picker.selected);
    if (!session) return [];
    const recent = session.previewMessages || [];
    const transcript = recent.length
      ? recent.map((message) => `**${message.role === "user" ? "You" : "pi"}**: ${message.text}`).join("\n\n")
      : (session.preview || "(No assistant message yet.)");
    return [
      id(n("text", { spans: [{ t: `${session.messages} messages · ${session.size} · ${session.when}`, s: "muted" }], lines: 1 }), "picker.preview.meta"),
      id(n("md", { text: clip(transcript, 80, 12000) }), "picker.preview.md"),
    ];
  }
  return [];
}

export function renderPicker(ctx) {
  const picker = ctx.picker;
  if (!picker) return null;
  const preview = pickerPreview(picker);
  const actions = picker.kind === "help"
    ? [{ id: "close", label: "Close", primary: true }]
    : [{ id: "choose", label: picker.kind === "tree" ? "Use prompt" : "Choose", primary: true }];
  if (picker.kind === "tree") {
    actions.push({ id: "tree-label", label: "Label", keys: ["shift", "l"] });
  }
  if (picker.kind === "resume") {
    const pinned = picker.pinned?.has?.(picker.selected);
    actions.push({ id: "pin", label: pinned ? "Unpin" : "Pin", keys: ["ctrl", "k"] });
    actions.push({ id: "rename-picked", label: "Rename", keys: ["ctrl", "r"] });
    actions.push({ id: "delete", label: "Delete", keys: ["ctrl", "d"], danger: true });
  }
  return id(n("picker", {
    size: picker.size === "full" ? "screen" : picker.size || "lg",
    preview: preview.length ? "side" : "none",
    title: picker.title ? spans(picker.title) : undefined,
    subtitle: picker.subtitle ? spans(picker.subtitle) : undefined,
    icon: picker.icon || "sparkles",
    layout: picker.layout || "rows",
    items: picker.items,
    selected: picker.selected,
    current: picker.current || [],
    query: picker.query || "",
    placeholder: picker.placeholder || "Filter…",
    confirm: picker.confirm || null,
    actions,
  }, preview), "picker.node");
}

export function renderLayer(conv, ctx) {
  const children = [];
  const picker = renderPicker(ctx);
  const approval = renderApproval(conv, ctx);
  const transcript = renderAgentModal(ctx);
  const field = renderFieldDialog(ctx);
  if (picker) children.push(picker);
  if (approval) children.push(approval);
  if (transcript) children.push(transcript);
  if (field) children.push(field);
  for (const toast of ctx.toasts || []) {
    children.push(id(n("toast", { text: toast.text, ttl: 3600, tone: toast.tone === "error" ? "error" : toast.tone === "warning" ? "warning" : "info" }), toast.id));
  }
  const hidden = children.length === 0;
  return id(n("col", { gap: "none", hidden }, children), "layer");
}

export function renderFieldDialog(ctx) {
  const dialog = ctx.fieldDialog;
  if (!dialog) return null;
  const placeholder = [dialog.placeholder || "Type a value…"];
  const field = dialog.method === "editor"
    ? id(n("editor", { text: dialog.text || "", placeholder, readonly: true, maxLines: 14 }), "field.input")
    : id(n("input", { text: dialog.text || "", placeholder, readonly: true, clear: true }), "field.input");
  const body = [
    id(n("text", { spans: [{ t: dialog.message || "pi needs a value to continue.", s: "muted" }] }), "field.message"),
    field,
    id(n("row", { gap: "xs", justify: "end" }, [
      id(n("row", { role: "pit.chip", gap: "xs", align: "center", actions: { click: "field-cancel" } }, [
        id(n("icon", { name: "x" }), "field.cancel.ic"),
        id(n("text", { spans: [{ t: "Cancel", s: "muted" }] }), "field.cancel.t"),
      ]), "field.cancel"),
      id(n("row", { role: "pit.chip", gap: "xs", align: "center", actions: { click: "field-submit" } }, [
        id(n("icon", { name: "check" }), "field.ok.ic"),
        id(n("text", { spans: [{ t: "Continue", s: "accent" }] }), "field.ok.t"),
      ]), "field.ok"),
    ]), "field.actions"),
  ];
  return id(n("overlay", {
    anchor: "center", modal: true, size: "md",
    head: spans(dialog.title || "Input"), icon: "edit",
  }, [id(n("col", { role: "pit.fielddialog", gap: "sm" }, body), "field.body")]), "fielddialog");
}

export function renderAgentModal(ctx) {
  const modal = ctx.agentModal;
  if (!modal) return null;
  const body = [];
  body.push(id(n("row", { gap: "xs", align: "center" }, [
    id(n("icon", { name: "agents", tone: "accent" }), "am.ic"),
    id(n("text", { spans: [{ t: modal.agent || "agent", s: "strong" }] }), "am.agent"),
    id(n("text", { spans: [{ t: ` · ${modal.name || ""}`, s: "muted" }], truncate: "end" }), "am.name"),
    id(n("spacer", { grow: 1 }), "am.sp"),
    id(n("row", { role: "chip", gap: "xs", align: "center", actions: { click: "agent-close" } }, [
      id(n("icon", { name: "x" }), "am.close.ic"),
      id(n("text", { spans: [{ t: "Close", s: "muted" }] }), "am.close.t"),
    ]), "am.close"),
  ]), "am.head"));
  if (modal.meta) body.push(id(n("text", { spans: [{ t: modal.meta, s: "dim" }], lines: 2 }), "am.meta"));
  for (const node of modal.nodes || []) body.push(node);
  return id(n("overlay", {
    anchor: "center", modal: true, size: "lg",
    head: spans("Subagent transcript"), icon: "agents",
  }, [id(n("col", { gap: "sm", role: "pit.agentmodal" }, body), "am.body")]), "agentmodal");
}

function queueRows(ctx) {
  const queue = ctx.queue || {};
  const groups = [
    ["Steering", queue.steering || []],
    ["After yield", queue.followUp || []],
  ].filter(([, messages]) => messages.length);
  if (!groups.length) return null;
  const total = groups.reduce((sum, [, messages]) => sum + messages.length, 0);
  const rows = [];
  for (const [label, messages] of groups) {
    messages.forEach((message, index) => {
      rows.push(id(n("row", {
        role: "pit.queue",
        gap: "xs",
        align: "center",
        actions: { click: "queue-edit" },
        title: `${label}: ${message}`,
      }, [
        id(n("icon", { name: "corner-down-right", tone: "info" }), `queue.${label}.${index}.ic`),
        id(n("text", { spans: [{ t: String(message).replace(/\s+/g, " ").slice(0, 120), s: "muted" }], truncate: "end", grow: 1 }), `queue.${label}.${index}.t`),
        index === 0 && total > 1
          ? id(n("badge", { text: `${total} queued` }), `queue.${label}.${index}.count`)
          : null,
      ]), `queue.${label}.${index}`));
    });
  }
  return id(n("col", { gap: "xs", role: "pit.queuerows" }, rows), "queue.rows");
}

export function composer(conv, ctx) {
  const state = ctx.composer;
  const text = state.text || "";
  const cursor = Math.min(state.cursor ?? text.length, text.length);
  const placeholder = ctx.approval
    ? "Answer above…"
    : conv.busy
      ? "Steer pi…"
      : conv.plan?.active
        ? "Describe the plan, or /implement…"
        : "Message pi…";
  const editor = id(n("editor", {
    text,
    cursor,
    placeholder: [placeholder],
    prompt: [{ t: "› ", s: "accent" }],
    maxLines: 8,
    sendable: true,
    variant: "well",
    aria: "Message pi",
  }), "composer.editor");

  const menu = renderSlashMenu(ctx);

  const modelName = ctx.modelLabel || fmtModel(ctx.model || conv.model || "");
  const chips = [];
  chips.push(id(n("row", { role: "pit.chip", tone: "accent", gap: "xs", align: "center", title: `Model: ${modelName}`, actions: { click: "model" } }, [
    id(n("icon", { name: providerIcon(ctx.provider, ctx.model), tone: "accent" }), "chip.model.ic"),
    id(n("text", { spans: [{ t: ctx.compact ? shortModel(modelName) : modelName, s: "accent" }], truncate: "end" }), "chip.model.t"),
    ctx.compact ? null : id(n("icon", { name: "chev" }), "chip.model.ch"),
  ]), "chip.model"));
  const effort = (ctx.effort || conv.thinkingLevel || "max").toLowerCase();
  chips.push(id(n("row", { role: "pit.chip", gap: "xs", align: "center", title: `Thinking effort: ${effort}`, actions: { click: "effort" } }, [
    id(n("icon", { name: "gauge", tone: "info" }), "chip.effort.ic"),
    id(n("text", { spans: [{ t: ctx.compact ? effort.slice(0, 3) : effort, s: "info" }] }), "chip.effort.t"),
  ]), "chip.effort"));
  if (conv.plan?.active) {
    chips.push(id(n("row", { role: "pit.chip", tone: "info", gap: "xs", align: "center", title: "Plan mode", actions: { click: "plan-off" } }, [
      id(n("icon", { name: "plan", tone: "info" }), "chip.plan.ic"),
      id(n("text", { spans: [{ t: "Plan", s: "info" }] }), "chip.plan.t"),
    ]), "chip.plan"));
  }
  if (ctx.attachments?.length) {
    for (let index = 0; index < ctx.attachments.length; index += 1) {
      const attachment = ctx.attachments[index];
      chips.push(id(n("row", {
        role: "pit.chip",
        tone: "info",
        gap: "xs",
        align: "center",
        title: `Detach ${attachment.name || "image"}`,
        actions: { click: `detach:${index}` },
      }, [
        id(n("icon", { name: "image", tone: "info" }), `chip.attach${index}.ic`),
        id(n("text", { spans: [{ t: `#${index + 1}`, s: "info" }] }), `chip.attach${index}.t`),
      ]), `chip.attach${index}`));
    }
  }
  const agents = conv.items.filter((item) => item.kind === "agent");
  if (agents.length) {
    chips.push(id(n("row", { role: "pit.chip", gap: "xs", align: "center", title: `${agents.length} subagents`, actions: { click: "agents" } }, [
      id(n("icon", { name: "users", tone: "accent" }), "chip.agents.ic"),
      id(n("text", { spans: [{ t: ctx.compact ? String(agents.length) : `Agents ${agents.length}`, s: "muted" }] }), "chip.agents.t"),
    ]), "chip.agents"));
  }
  if (conv.todos?.items?.length) {
    const done = conv.todos.items.filter((todo) => todo.status === "done").length;
    chips.push(id(n("row", { role: "pit.chip", gap: "xs", align: "center", title: "Todo list", actions: { click: "todos" } }, [
      id(n("icon", { name: done === conv.todos.items.length ? "check" : "clock", tone: "info" }), "chip.todos.ic"),
      id(n("text", { spans: [{ t: ctx.compact ? `${done}/${conv.todos.items.length}` : `Todos ${done}/${conv.todos.items.length}`, s: "info" }] }), "chip.todos.t"),
    ]), "chip.todos"));
  }
  chips.push(id(n("spacer", { grow: 1 }), "chip.sp"));
  if (!ctx.compact) {
    chips.push(id(n("row", { role: "pit.place", gap: "xs", align: "center", title: ctx.cwd }, [
      id(n("icon", { name: "folder", tone: "muted" }), "chip.cwd.ic"),
      id(n("text", { spans: [{ t: shortPath(ctx.cwd), s: "muted" }], truncate: "end" }), "chip.cwd.t"),
    ]), "chip.cwd"));
  }
  chips.push(id(n("icon", {
    name: "send",
    title: conv.busy ? "Steer" : "Send",
    role: text.trim() ? "pit.send-ready" : "pit.send",
    tone: text.trim() ? "accent" : "muted",
    actions: { click: "send" },
  }), "composer.send"));

  const meter = ctx.contextWindow
    ? id(n("meter", {
      value: Math.max(0, Math.min(1, (ctx.contextTokens || 0) / ctx.contextWindow)),
      label: `${(100 * (ctx.contextTokens || 0) / ctx.contextWindow) < 10 ? (100 * (ctx.contextTokens || 0) / ctx.contextWindow).toFixed(1) : Math.round(100 * (ctx.contextTokens || 0) / ctx.contextWindow)}%`,
      style: "bar",
      size: "sm",
      role: "pit.context",
      title: `${(ctx.contextTokens || 0).toLocaleString()} of ${ctx.contextWindow.toLocaleString()} tokens`,
    }), "composer.meter")
    : null;
  const meterRow = id(n("row", { gap: "sm", align: "center", role: "pit.meterrow" }, [
    id(n("text", { spans: [{ t: "context", s: "dim" }] }), "composer.ctx.l"),
    id(n("spacer", { grow: 1 }), "composer.ctx.sp"),
    id(n("text", { spans: [{ t: `${humanTokens(ctx.contextTokens || 0)} / ${humanTokens(ctx.contextWindow || 0)}`, s: "dim" }] }), "composer.ctx.r"),
  ]), "composer.meterrow");

  const statusBits = [];
  if (conv.busy) statusBits.push({ t: conv.compacting ? "compacting" : "working", s: "accent" });
  else if (ctx.approval) statusBits.push({ t: "needs your answer", s: "warning" });
  else statusBits.push({ t: "ready", s: "success" });
  if (ctx.tokPerSec) statusBits.push({ t: ` · ${ctx.tokPerSec} tok/s`, s: "muted" });
  if (ctx.turnMs) statusBits.push({ t: ` · ${humanMs(ctx.turnMs)}`, s: "muted" });
  if (ctx.cost) statusBits.push({ t: ` · $${ctx.cost.toFixed(2)}`, s: "muted" });
  const status = id(n("row", { gap: "sm", align: "center", role: "pit.status" }, [
    id(n("spinner", { style: "dots" }), "status.spin"),
    id(n("text", { spans: statusBits }), "status.text"),
    id(n("spacer", { grow: 1 }), "status.sp"),
    ctx.compact ? null : id(n("text", { spans: [{ t: BUILD, s: "dim" }] }), "status.build"),
  ]), "status");

  return id(n("col", { gap: "sm", role: "pit.composerwrap" }, [
    id(n("row", { gap: "none", align: "center" }, [
      id(n("spacer", { size: "none", grow: 1 }), "composer.sp1"),
      id(n("card", { role: "pit.composer", inset: true, basis: 0.92, max: { w: "96ch" } }, [
        id(n("col", { gap: "sm", role: "pit.composerbody" }, [
          ctx.compact ? null : meter,
          ctx.compact ? null : meterRow,
          queueRows(ctx),
          menu,
          editor,
          id(n("row", { gap: "xs", align: "center", role: "pit.chiprow", wrap: false }, chips), "composer.chiprow"),
        ]), "composer.body"),
      ]), "composer.card"),
      id(n("spacer", { size: "none", grow: 1 }), "composer.sp2"),
    ]), "composer.center"),
    status,
  ]), "composer.wrap");
}

export function renderSlashMenu(ctx) {
  const menu = ctx.menu;
  if (!menu || !menu.items?.length) return null;
  const rows = menu.items.slice(0, menu.limit || 6).map((item, index) => {
    const selected = index === menu.selected;
    const value = item.value ?? menu.values?.[item.name];
    return id(n("row", {
      role: selected ? "pit.menuitem active" : "pit.menuitem",
      gap: "sm",
      align: "center",
      actions: { click: `menu:${index}` },
    }, [
      id(n("text", { spans: [{ t: `/${item.name}`, s: selected ? "accent" : "strong" }], wrap: "none" }), `menu.i${index}.name`),
      id(n("text", { spans: [{ t: item.description || "", s: "muted" }], truncate: "end" }), `menu.i${index}.desc`),
      item.source ? id(n("text", { spans: [{ t: item.source, s: "dim" }] }), `menu.i${index}.src`) : null,
      value ? id(n("text", { spans: [{ t: String(value), s: "dim mono" }], truncate: "end" }), `menu.i${index}.value`) : null,
    ]), `menu.i${index}`);
  });
  return id(n("col", { gap: "none", role: "pit.menu" }, rows), "menu");
}

/** Provider icons that Tern ships for the model picker and composer. */
export function providerKey(provider = "", model = "") {
  const p = String(provider || "").toLowerCase();
  const id = String(model || "").toLowerCase();
  if (p.includes("deepseek") || id.includes("deepseek")) return "deepseek";
  if (p === "zai" || p.includes("z.ai") || p.includes("z-ai")) return "zai";
  if (p.includes("zhipu") || p.includes("glm") || id.includes("glm")) return "zhipu-coding-plan";
  if (p.includes("anthropic")) return "anthropic";
  if (p.includes("openai") || p.includes("codex")) return "openai";
  if (p.includes("google") || p.includes("gemini") || p.includes("vertex")) return "google";
  if (p.includes("xai") || p.includes("x.ai")) return "xai";
  if (p.includes("moonshot") || p.includes("kimi")) return "moonshot";
  if (p.includes("qwen") || p.includes("alibaba")) return "qwen-portal";
  if (p.includes("openrouter")) return "openrouter";
  if (p.includes("groq")) return "groq";
  if (p.includes("ollama")) return "ollama";
  if (p.includes("mistral")) return "mistral";
  return "";
}

export function providerIcon(provider = "", model = "") {
  const key = providerKey(provider, model);
  return key ? `provider:${key}` : "sparkles";
}

export function shortModel(model = "") {
  return String(model).replace(/^deepseek-/i, "").replace(/-1017$/, "").slice(0, 22);
}

export function shortPath(path = "") {
  const home = process.env.HOME || "";
  let out = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  if (out.length > 34) out = `…${out.slice(-33)}`;
  return out;
}

/** Build the three regions. */
export function buildView(conv, ctx) {
  const empty = conv.items.length === 0;
  const transcript = empty ? [splash(conv, ctx)] : [...renderTranscript(conv, ctx)];
  const plan = renderPlan(conv, ctx);
  if (plan) transcript.push(plan);
  const todos = renderTodos(conv, ctx);
  if (todos) transcript.push(todos);
  if (conv.error) {
    transcript.push(id(n("card", { role: "pit.error", inset: true }, [
      id(n("row", { gap: "xs", align: "center" }, [
        id(n("icon", { name: "warn", tone: "error" }), "err.ic"),
        id(n("text", { spans: [{ t: "Something went wrong", s: "error" }] }), "err.t"),
      ]), "err.head"),
      id(n("md", { text: conv.error }), "err.msg"),
      id(n("row", { role: "pit.chip", gap: "xs", align: "center", actions: { click: "retry" } }, [
        id(n("icon", { name: "repeat" }), "err.retry.ic"),
        id(n("text", { spans: [{ t: "Retry", s: "muted" }] }), "err.retry.t"),
      ]), "err.retry"),
    ]), "error"));
  }
  const tail = id(n("spacer", { size: "none" }), "tail");
  transcript.push(tail);
  return {
    main: [id(n("col", { gap: "lg", role: "pit.stream" }, transcript), "main")],
    dock: [id(n("col", { gap: "sm" }, [composer(conv, ctx)]), "dock")],
    layer: [renderLayer(conv, ctx)],
  };
}

export const STYLESHEET = `
.sf-region.sf-main [data-role="pit.stream"]{max-width:860px;margin:0 auto;padding:4px 2px 12px}
[data-role="pit.brandbar"]{padding:2px 2px 0;opacity:.95}
[data-role="pit.badge"]{display:inline-flex;align-items:center;justify-content:center;
  width:24px;height:24px;border-radius:8px;background:linear-gradient(145deg,#7C5CFF,#22D3EE);
  color:#fff;font-weight:700;font-size:15px;box-shadow:0 2px 10px rgba(124,92,255,.35)}
[data-role="pit.badge-lg"]{display:inline-flex;align-items:center;justify-content:center;
  width:76px;height:76px;border-radius:22px;background:linear-gradient(145deg,#7C5CFF,#22D3EE);
  color:#fff;font-size:46px;font-weight:700;box-shadow:0 12px 40px rgba(124,92,255,.38);
  animation:pit-float 5s ease-in-out infinite}
[data-role="pit.wordmark"]{font-weight:700;letter-spacing:-.01em}
[data-role="pit.wordmark-xl"]{font-size:2.4em;line-height:1;letter-spacing:-.04em}
[data-role="pit.herotext"]{justify-content:center}
[data-role="pit.splash"]{padding-top:4vh;animation:pit-rise .6s cubic-bezier(.2,.8,.2,1) both}
[data-role="pit.suggestions"]{max-width:640px;margin-top:6px}
[data-role="pit.suggestion"]{padding:8px 13px;border-radius:999px;cursor:pointer;
  background:rgba(124,92,255,.10);border:1px solid rgba(124,92,255,.28);
  transition:background .15s ease, transform .15s ease}
[data-role="pit.suggestion"] .sf-text{color:var(--sf-accent)!important}
[data-role="pit.suggestion"]:hover{background:rgba(124,92,255,.18);border-color:rgba(124,92,255,.55);transform:translateY(-1px)}
[data-role="pit.suggestion"]:active{transform:scale(.98)}
[data-role="pit.hints"]{opacity:1;padding-bottom:4px}
[data-role="pit.hints"] .sf-text{color:var(--sf-t2)!important}
[data-role="pit.build"]{opacity:1}
[data-role="pit.welcome"]{max-width:640px;margin-top:8px;padding:12px 16px;background:rgba(124,92,255,.06)!important;border-color:rgba(124,92,255,.20)!important}
[data-role="pit.welcome"] .sf-text{color:var(--sf-t2)!important}
[data-role="pit.welcome.title"]{color:var(--sf-t1)!important;font-weight:600!important}
[data-role="pit.welcome.body"]{color:var(--sf-t2)!important}
[data-role="pit.splashmeta"] .sf-text{color:var(--sf-t2)!important}
[data-role="pit.meterrow"] .sf-text{color:var(--sf-t2)!important}
[data-role="pit.user"]{background:rgba(127,127,127,.13)!important;border-color:transparent!important;
  box-shadow:none!important;padding:10px 14px}
[data-role="pit.user"] [data-role="pit.user.head"], [data-role="pit.user"] .sf-row{justify-content:flex-end}
[data-role="pit.answer"]{padding:2px 0}
[data-role="pit.answer"] .sf-md, [data-role="pit.answer"] .md,
[data-role="pit.user"] .sf-md, [data-role="pit.user"] .md,
[data-role="pit.custom"] .sf-md, [data-role="pit.hook"] .sf-md{
  font-family:Geist,system-ui,"SF Pro Text",system-ui,sans-serif!important;
  font-size:14px!important;line-height:1.5!important;letter-spacing:0!important}
[data-role="pit.answer"] .md code, [data-role="pit.answer"] .md pre,
[data-role="pit.user"] .md code, [data-role="pit.user"] .md pre{
  font-family:"SF Mono","Berkeley Mono",monospace!important;font-size:13px!important}
[data-role="pit.user"]{padding:0!important}
[data-role="pit.user"] .sf-card-body{padding:10px 16px!important}
[data-role="pit.usermeta"]{padding:2px 2px 0 0}
[data-role="pit.usermeta"] .sf-text{font-size:11px!important}
[data-role="pit.thinking"]{opacity:.82;padding-left:0}
[data-role="pit.compaction"], [data-role="pit.branch"]{opacity:.92;padding:2px 0}
[data-role="pit.custom"], [data-role="pit.hook"]{border-left:3px solid rgba(34,211,238,.4)!important}
[data-role="pit.todos"]{margin-top:4px}
[data-role="pit.copy"]{opacity:.65;cursor:pointer}
[data-role="pit.copy"]:hover{opacity:1}
[data-role="pit.thinking"] .sf-md{color:var(--sf-t2);font-size:.96em}
[data-role="pit.tool.read"]{opacity:.92}
[data-role="pit.composer"]{padding:11px 13px;border-radius:18px!important;
  box-shadow:0 12px 40px rgba(0,0,0,.10),0 1px 0 rgba(255,255,255,.5) inset!important;
  backdrop-filter:blur(14px)}
[data-role="pit.composer"] .sf-editor{font-size:1.03em;line-height:1.5}
[data-role="pit.composer"] .sf-editor.focused{box-shadow:none!important;outline:none!important}
[data-role="pit.chip"]{padding:5px 9px;border-radius:999px;cursor:pointer;
  background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.16)}
[data-role="pit.chip"]:hover{background:rgba(124,92,255,.12);border-color:rgba(124,92,255,.3)}
[data-role="pit.place"]{padding:4px 6px;opacity:.8}
[data-role="pit.send"]{display:inline-flex;align-items:center;justify-content:center;
  width:30px;height:30px;border-radius:50%;background:rgba(127,127,127,.12);color:var(--sf-t3)}
[data-role="pit.send-ready"]{display:inline-flex;align-items:center;justify-content:center;
  width:30px;height:30px;border-radius:50%;background:linear-gradient(145deg,#7C5CFF,#22D3EE);
  color:#fff;cursor:pointer;box-shadow:0 4px 14px rgba(124,92,255,.4);
  transition:transform .12s ease}
[data-role="pit.send-ready"]:hover{transform:scale(1.06)}
[data-role="pit.send-ready"]:active{transform:scale(.95)}
[data-role="pit.menu"]{background:rgba(127,127,127,.06);border:1px solid rgba(127,127,127,.14);
  border-radius:12px;padding:4px;max-height:260px;overflow:auto}
[data-role="pit.menuitem"]{padding:6px 9px;border-radius:8px;cursor:pointer}
[data-role="pit.menuitem"]:hover{background:rgba(124,92,255,.10)}
[data-role="pit.menuitem.active"]{background:rgba(124,92,255,.16)}
[data-role="pit.status"]{padding:0 6px 2px;font-size:.92em;opacity:1}
[data-role="pit.chip"]{padding:5px 9px;border-radius:999px;cursor:pointer;
  background:rgba(124,92,255,.10);border:1px solid rgba(124,92,255,.24)}
[data-role="pit.plan"]{border-left:3px solid #22D3EE!important}
[data-role="pit.approval"]{min-width:340px}
[data-role="pit.agentmodal"]{max-height:60vh;overflow:auto;min-width:420px}
[data-role="pit.fielddialog"]{min-width:440px;max-width:560px}
[data-role="pit.error"]{border-color:rgba(225,29,72,.35)!important}
.sf-row[data-role="pit.menuitem"]{flex-wrap:nowrap}
@media (prefers-reduced-motion: reduce){
  [data-role="pit.splash"],[data-role="pit.badge-lg"]{animation:none!important}
}
@keyframes pit-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes pit-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
`;

/** Theme-specific corrections layered over Tern's native tokens. */
export const TEXT_CSS = {
  light: `
[data-role="pit.hints"] .sf-text, [data-role="pit.meterrow"] .sf-text,
[data-role="pit.status"] .sf-text, [data-role="pit.splashmeta"],
[data-role="pit.welcome.body"]{color:#374151!important}
[data-role="pit.welcome.title"], [data-role="pit.answer"] .sf-md,
[data-role="pit.wordmark-xl"]{color:#111827!important}
[data-role="pit.suggestion"] .sf-text{color:#4C1D95!important}
[data-role="pit.chip"] .sf-text{color:#4C1D95!important}
[data-role="pit.user"]{background:rgba(55,65,81,.10)!important}
`,
  dark: `
[data-role="pit.hints"] .sf-text, [data-role="pit.meterrow"] .sf-text,
[data-role="pit.status"] .sf-text, [data-role="pit.splashmeta"],
[data-role="pit.welcome.body"]{color:#D1D5DB!important}
[data-role="pit.welcome.title"], [data-role="pit.answer"] .sf-md,
[data-role="pit.wordmark-xl"]{color:#F9FAFB!important}
[data-role="pit.suggestion"] .sf-text{color:#C4B5FD!important}
[data-role="pit.chip"] .sf-text{color:#C4B5FD!important}
[data-role="pit.user"]{background:rgba(209,213,219,.12)!important}
`,
};

