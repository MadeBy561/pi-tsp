/**
 * The dock: the working row and todo HUD, queued messages, and the composer
 * with its context meter, chips and status facts.
 */
import type { TextEditor } from "../editor.js";
import type { Conversation } from "../model.js";
import { duration, firstLine, h, money, s, tokens, type EditEvent, type Node, type SendEvent, type Span } from "./h.js";

/** The wire id of the composer's editor: the caret anchor of the completion popup. */
export const EDITOR_ID = "dock.editor.line.input";

export interface Attachment {
  name: string;
  mimeType: string;
  data: string;
}

export interface DockState {
  editor: TextEditor;
  attachments: Attachment[];
  /** The Vim mode label (`NORMAL`, `VISUAL`), or empty in insert mode or with Vim keys off. */
  vimMode: string;
  /** The selection to draw instead of the editor's own (Vim's Visual modes). */
  drawn: { anchor: number; cursor: number } | null;
  modelName: string;
  /** The model maker's logo, as an icon name. */
  modelIcon: string | undefined;
  effort: string;
  /** Whether the model takes a thinking level at all. */
  reasoning: boolean;
  /** Extension `setStatus` texts by key. */
  statuses: ReadonlyMap<string, string>;
  /** Extension `setWidget` lines by key, above and below the editor. */
  widgets: ReadonlyMap<string, { lines: string[]; below: boolean }>;
  /** A dialog owns the keyboard: the composer is not ready for a `send`. */
  blocked: boolean;
  /** Startup is not finished: Tern keeps what is typed until this clears. */
  starting: boolean;
  /** What the model is doing now, for the working row. */
  activity: string;
  blob(image: { data?: string; mimeType?: string }): string | undefined;
}

export interface DockActions {
  submit(): void;
  interrupt(): void;
  pickModel(): void;
  cycleEffort(): void;
  showContext(): void;
  showSession(): void;
  showAgents(): void;
  dequeue(): void;
  detach(index: number): void;
  togglePlan(): void;
  edit(event: EditEvent): void;
  undo(): void;
  send(event: SendEvent): void;
}

/** The live "working" indicator above the composer. */
function workingRow(conv: Conversation, state: DockState, on: DockActions): Node {
  const retry = conv.retry;
  const label = retry
    ? `Retrying (attempt ${retry.attempt}/${retry.max}) in ${duration(Math.max(0, retry.delayMs - (Date.now() - retry.at)))}`
    : conv.compacting
      ? "Compacting the conversation"
      : state.activity || "Working";
  return h("row", { key: "working", role: "omp.working", align: "center", gap: "sm", ...(retry ? { title: retry.error } : {}) }, [
    h("spinner", { key: "spinner", style: "starburst", tone: retry ? "warning" : "accent" }),
    conv.runStartedAt ? h("elapsed", { key: "elapsed", age: Math.max(0, Date.now() - conv.runStartedAt), format: "short" }) : null,
    conv.runStartedAt ? h("text", { key: "sep", text: "·", role: "omp.working.sep" }) : null,
    h("shimmer", { key: "label", role: "omp.working.label", mode: "classic", palette: { low: "dim", mid: "muted", high: "accent" }, spans: [s(label, "muted")] }),
    h("row", { key: "fill", grow: 1 }),
    h("row", { key: "stop", role: "omp.working.stop", gap: "xs", align: "center", title: "Stop  esc", onClick: () => on.interrupt() }, [
      h("kbd", { key: "0", keys: ["escape"] }),
      h("text", { key: "1", text: "Stop" }),
    ]),
  ]);
}

function todoHud(conv: Conversation): Node | null {
  const phases = conv.todos;
  if (!phases?.length) return null;
  const open = phases.some(phase => phase.items.some(item => item.status === "pending" || item.status === "active" || item.status === "blocked"));
  if (!open && !conv.busy) return null;
  return h("checklist", {
    key: "todo",
    role: "omp.hud.todo",
    mode: "hud",
    phases: phases.map(phase => ({
      id: phase.id,
      title: phase.name,
      items: phase.items.map(item => ({ id: `${phase.id}.${item.id}`, text: item.text, status: item.status, ...(item.note ? { note: item.note } : {}) })),
    })),
  });
}

/** The work still running behind the conversation: background subagents, as a pill that opens their list. */
function runningPill(conv: Conversation, on: DockActions): Node | null {
  const running = conv.items.filter(item => item.kind === "agent" && item.background && (item.agentStatus === "running" || item.agentStatus === "pending"));
  if (!running.length) return null;
  const first = running[0]!;
  const started = Math.min(...running.map(item => item.startedAt ?? item.at));
  return h("row", { key: "hud", role: "omp.hud", justify: "end" }, [
    h("row", { key: "jobs", role: "omp.hud.jobs", gap: "xs", align: "center", title: "Background subagents: click to list them", onClick: () => on.showAgents() }, [
      h("spinner", { key: "spin", style: "dots" }),
      h("text", { key: "glance", role: "omp.hud.glance", wrap: "none", truncate: "end", spans: [s(running.length === 1 ? firstLine(first.args?.description ?? first.agentType ?? "subagent", 50) : `${running.length} subagents running`, "muted")] }),
      h("elapsed", { key: "age", age: Math.max(0, Date.now() - started), format: "short" }),
    ]),
  ]);
}

function queueRows(conv: Conversation, on: DockActions): Node | null {
  const groups: [string, string[]][] = [
    ["Steering", conv.queue.steering],
    ["After yield", conv.queue.followUp],
  ];
  const total = conv.queue.steering.length + conv.queue.followUp.length;
  if (!total) return null;
  let first = true;
  const rows: Node[] = [];
  for (const [label, messages] of groups) {
    messages.forEach((message, index) => {
      rows.push(
        h("row", { key: `${label === "Steering" ? "s" : "f"}${index}`, role: "omp.queue.item", align: "center", gap: "sm", title: label }, [
          h("icon", { key: "icon", name: "corner-down-right" }),
          h("text", { key: "text", wrap: "none", truncate: "end", grow: 1, text: String(message).replace(/\t/g, " ").replace(/\s*\r?\n\s*/g, " ↵ ") }),
          first && total > 1 ? h("badge", { key: "count", role: "omp.queue.count", text: `${total} queued`, title: `${total} messages queued` }) : null,
          h("row", { key: "edit", role: "omp.queue.edit", gap: "xs", align: "center", title: "Edit  Alt+↑", onClick: () => on.dequeue() }, [
            h("kbd", { key: "0", keys: ["alt", "up"] }),
            h("text", { key: "1", text: "Edit" }),
          ]),
        ]),
      );
      first = false;
    });
  }
  return h("col", { key: "queue", role: "omp.queue", gap: "xs" }, rows);
}

function widgetRows(state: DockState, below: boolean): Node[] {
  const out: Node[] = [];
  for (const [key, widget] of state.widgets) {
    if (widget.below !== below || !widget.lines.length) continue;
    out.push(h("ansi", { key: `w-${key.replace(/[^\w-]/g, "_")}`, role: "pi.widget", text: widget.lines.join("\n") }));
  }
  return out;
}

function contextMeter(conv: Conversation, on: DockActions): Node | null {
  const window = conv.contextWindow;
  if (!window) return null;
  const used = Math.max(0, conv.contextTokens);
  const value = Math.min(1, used / window);
  const percent = Math.round(value * 100);
  const lines = [`Context ${percent}% used`, `${tokens(used)} of ${tokens(window)} tokens`];
  if (conv.autoCompaction) lines.push("Auto-compact on");
  return h("meter", {
    key: "context",
    role: "omp.composer.context",
    style: "bar",
    thresholds: { warn: 0.7, bad: 0.9 },
    total: tokens(window),
    title: lines.join("\n"),
    value,
    label: `${percent}%`,
    onClick: () => on.showContext(),
  });
}

function chips(state: DockState, on: DockActions): Node {
  const nodes = state.attachments.map((attachment, index) => {
    const blob = state.blob(attachment);
    return h("row", { key: `a${index}`, role: "omp.composer.chip", gap: "xs", align: "center", title: `Remove ${attachment.name}`, onClick: () => on.detach(index) }, [
      blob ? h("image", { key: "thumb", blob, alt: attachment.name, max: { h: "2lines", w: "8ch" } }) : h("icon", { key: "thumb", name: "image" }),
      h("text", { key: "name", wrap: "none", truncate: "middle", spans: [s(attachment.name, "muted")] }),
      h("icon", { key: "x", name: "x" }),
    ]);
  });
  return h("row", { key: "chips", gap: "sm", wrap: true, role: "omp.composer.chips", ...(nodes.length ? {} : { hidden: true }) }, nodes);
}

/** The facts between the model chip and the send key: path, branch, session, modes. */
function extras(conv: Conversation, state: DockState, on: DockActions): Node {
  // Tern draws the pane's folder and branch in this strip itself; these are the facts only pi knows.
  const segs: Node[] = [];
  if (conv.sessionName) {
    segs.push(h("seg", { key: "session", role: "omp.status.session", side: "left", priority: 3, icon: "session", title: "Session details", spans: [s(firstLine(conv.sessionName, 40), "muted")], onClick: () => on.showSession() }));
  }
  if (conv.plan?.active) {
    segs.push(h("seg", { key: "plan", role: "omp.status.mode", side: "left", priority: 9, icon: "plan", tone: "info", title: "Plan mode: edits are blocked. Click to leave.", spans: [s("plan", "info")], onClick: () => on.togglePlan() }));
  }
  for (const [key, text] of state.statuses) {
    if (!text) continue;
    segs.push(h("seg", { key: `x-${key.replace(/[^\w-]/g, "_")}`, role: "pi.status.extension", side: "right", priority: 2, title: key, spans: [s(firstLine(text, 60), "muted")] }));
  }
  return h("status", { key: "extras", role: "omp.composer.extras", transparent: true, grow: 1 }, segs);
}

/** Style runs over the draft: the shell sigil hidden behind its chip, a command name, pasted-text chips. */
function decorations(editor: TextEditor): { from: number; to: number; s: string }[] {
  const out: { from: number; to: number; s: string }[] = [];
  if (editor.text.startsWith("!")) out.push({ from: 0, to: editor.text.startsWith("!!") ? 2 : 1, s: "hide" });
  else if (editor.text.startsWith("/")) {
    const end = editor.text.search(/\s/);
    out.push({ from: 0, to: end < 0 ? editor.text.length : end, s: "accent" });
  }
  for (const paste of editor.pastes) {
    let from = editor.text.indexOf(paste.token);
    while (from >= 0) {
      out.push({ from, to: from + paste.token.length, s: "mark" });
      from = editor.text.indexOf(paste.token, from + paste.token.length);
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

function placeholder(conv: Conversation): string | Span[] {
  if (conv.sessionName) return [s(`“${firstLine(conv.sessionName, 60)}”`, "em")];
  if (conv.busy) return "Steer pi, or queue a follow-up with Alt+Enter";
  if (conv.plan?.active) return "Describe what to plan";
  return "What are we cooking?";
}

function composer(conv: Conversation, state: DockState, on: DockActions): Node {
  const editor = state.editor;
  const decor = decorations(editor);
  const shell = editor.text.startsWith("!");
  const usage = [conv.cost > 0 ? money(conv.cost) : ""].filter(Boolean).join(" · ");
  const privately = editor.text.startsWith("!!");
  return h("col", { key: "editor", role: shell ? "omp.editor.bash" : "omp.editor", ...(conv.busy ? { tone: "pending" } : {}) }, [
    contextMeter(conv, on),
    chips(state, on),
    ...widgetRows(state, false),
    h("row", { key: "line", role: "omp.composer.line", align: "start", gap: "sm" }, [
      shell
        ? h("row", { key: "mode", role: "omp.composer.mode", gap: "xs", align: "center", title: privately ? "Runs in your shell · not sent to the model" : "Runs in your shell" }, [
            h("text", { key: "0", spans: [s("bash", "bashMode")] }),
            privately ? h("icon", { key: "1", name: "eye-off", title: "Not sent to the model" }) : null,
          ])
        : null,
      h("editor", {
        key: "input",
        text: editor.text,
        cursor: state.drawn?.cursor ?? editor.cursor,
        ...(state.drawn ? { anchor: state.drawn.anchor } : editor.anchor !== null ? { anchor: editor.anchor } : {}),
        ...(decor.length ? { decor } : {}),
        ...(shell ? { lang: "bash" } : {}),
        ...(state.vimMode ? { mode: state.vimMode } : {}),
        sendable: !state.blocked && !state.starting,
        ...(state.starting ? { typeahead: true } : {}),
        placeholder: placeholder(conv),
        maxLines: 18,
        aria: "Message pi",
        onEdit: (event: EditEvent) => on.edit(event),
        onUndo: () => on.undo(),
        onSend: (event: SendEvent) => on.send(event),
      }),
    ]),
    h("row", { key: "bar", role: "omp.composer.bar", gap: "sm", align: "center" }, [
      h("row", { key: "model", role: "omp.composer.model", gap: "xs", align: "center", title: "Switch model  Ctrl+L", onClick: () => on.pickModel() }, [
        state.modelIcon ? h("icon", { key: "logo", name: state.modelIcon, role: "pi.composer.model.logo" }) : null,
        state.reasoning
          ? h("effort", { key: "effort", role: "omp.composer.model.effort", level: state.effort || "off", title: `Thinking effort: ${state.effort || "off"}  ⇧⇥`, actions: { click: "effort" }, onAction: { effort: () => on.cycleEffort() } })
          : null,
        h("text", { key: "name", wrap: "none", spans: [s(state.modelName || "no model", "statusLineModel")] }),
        h("icon", { key: "chev", name: "chev" }),
      ]),
      conv.busy && conv.tokPerSec > 0 ? h("rate", { key: "rate", role: "omp.composer.rate", value: conv.tokPerSec, unit: "tok/s", title: "Generation rate" }) : null,
      extras(conv, state, on),
      h("text", { key: "usage", role: "omp.composer.usage", wrap: "none", text: usage, ...(usage ? { title: "Session cost" } : {}), onClick: () => on.showSession() }),
      conv.busy && editor.empty
        ? h("text", { key: "stop", role: "omp.composer.stop", text: "Stop", tone: "error", title: "Stop  esc", onClick: () => on.interrupt() })
        : h("kbd", { key: "send", role: "omp.composer.send", keys: ["enter"], title: conv.busy ? "Steer  ⏎" : "Send  ⏎", onClick: () => on.submit() }),
    ]),
    ...widgetRows(state, true),
  ]);
}

/**
 * The whole dock. `above` sits over the composer (the approval panel);
 * `instead` takes the composer's place (an extension's input dialog).
 */
export function dock(conv: Conversation, state: DockState, on: DockActions, above: Node | null | (Node | null)[] = null, instead: Node | null = null): Node {
  const hud = todoHud(conv);
  const busy = conv.busy || conv.compacting || Boolean(conv.retry);
  return h("col", { key: "dock" }, [
    runningPill(conv, on),
    busy || hud
      ? h("row", { key: "activity", role: "omp.hud.activity", align: "center", gap: "sm" }, [
          busy ? h("col", { key: "status", role: "omp.hud.status" }, [workingRow(conv, state, on)]) : h("row", { key: "status", grow: 1 }),
          hud,
        ])
      : null,
    queueRows(conv, on),
    ...(Array.isArray(above) ? above : [above]),
    instead ?? composer(conv, state, on),
  ]);
}

/** A failed turn's error, pinned above the composer until dismissed or the next turn. */
export function errorBanner(message: string, expanded: boolean, on: { details(): void; dismiss(): void }): Node {
  const clean = message.trim();
  const headline = clean.split("\n").find(line => line.trim())?.trim() || "Error";
  const long = clean !== headline || headline.length > 80;
  return h("row", { key: "error-banner", role: "omp.errorBanner", tone: "error", gap: "sm", align: expanded ? "start" : "center" }, [
    expanded
      ? h("text", { key: "text", wrap: "word", grow: 1, spans: [s(clean, "error")] })
      : h("text", { key: "text", truncate: "end", lines: 1, grow: 1, title: clean, spans: [s(headline, "error")] }),
    long ? h("button", { key: "details", role: "omp.btn", text: expanded ? "Less" : "Details", size: "sm", title: expanded ? "Less" : "Details", onClick: on.details }) : null,
    h("button", { key: "dismiss", role: "omp.btn", text: "Dismiss", size: "sm", title: "Dismiss", onClick: on.dismiss }),
  ]);
}

/** The panel shown in the composer's place while a rewind point is being chosen. */
export function rewindPanel(view: { text: string; dropped: number; index: number; total: number }, on: { confirm(): void; cancel(): void }): Node {
  // The approval panel's frame: Tern draws it as a card in the composer's column.
  return h("col", { key: "rewind", role: "omp.editor.ask.approval", gap: "md" }, [
    h("text", { key: "title", role: "omp.approval.title", tone: "accent", text: `Rewind to message ${view.index} of ${view.total}` }),
    h("text", { key: "text", lines: 2, truncate: "end", spans: [s(view.text, "muted")] }),
    h("text", {
      key: "note",
      wrap: "word",
      spans: [s(view.dropped ? `${view.dropped} later ${view.dropped === 1 ? "block is" : "blocks are"} left on the old branch. The message returns to the composer to edit and send.` : "The message returns to the composer to edit and send.", "dim")],
    }),
    h("row", { key: "actions", role: "omp.actions", gap: "sm", align: "center" }, [
      h("kbd", { key: "keys", keys: ["up"] }),
      h("kbd", { key: "keys2", keys: ["down"] }),
      h("text", { key: "hint", spans: [s("choose a message", "dim")] }),
      h("spacer", { key: "fill", grow: 1 }),
      h("button", { key: "cancel", role: "omp.btn", text: "Cancel", keys: ["escape"], size: "md", onClick: on.cancel }),
      h("button", { key: "confirm", role: "omp.btn", text: "Rewind here", keys: ["enter"], size: "md", variant: "primary", onClick: on.confirm }),
    ]),
  ]);
}
