/**
 * pi-tsp: a native Tern surface in front of a pi RPC session.
 *
 * The flow: launcher probed Tern and handed us the hello; we open a screen
 * surface, spawn `pi --mode rpc`, and from then on every render is a diff of
 * the conversation model. Keys come back on the same pty, TSP events are
 * peeled off first.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { SurfaceDoc, TspInbound, TspLink, TEXT_KINDS } from "./tsp.mjs";
import { PiRpc } from "./rpc.mjs";
import { Composer } from "./keys.mjs";
import { Conversation, fmtModel, textOf } from "./state.mjs";
import { BUILD, THEME, TEXT_CSS, buildView, STYLESHEET, clock, firstLine, humanMs, humanTokens, spans, providerIcon } from "./view.mjs";
import { listSessions, sessionPath } from "./sessions.mjs";
import { configDir, sessionDir } from "./setup.mjs";

const SURFACE = "pit";
const STOCK = process.env.PI_TSP_PI || "/usr/local/bin/pi";

function log(...args) {
  if (process.env.PI_TSP_TRACE) {
    try {
      const { appendFileSync } = require("node:fs");
    } catch {
      /* ESM: no require */
    }
  }
}

export class PiTsp {
  constructor({ hello, leftover, args, cwd }) {
    this.hello = hello;
    this.leftover = leftover;
    this.args = args;
    this.cwd = cwd || process.cwd();
    this.kinds = new Set(hello.kinds || []);
    this.features = new Set(hello.features || []);
    this.forceCompact = process.env.PI_TSP_COMPACT === "1";
    this.compact = this.forceCompact || Number(hello.cols || 120) < 74;
    this.link = new TspLink(process.stdout, Number(hello.apc) || 65536);
    this.doc = new SurfaceDoc(this.link, SURFACE, Number(hello.credits) || 2);
    this.conv = new Conversation();
    this.composer = new Composer();
    this.fieldInput = new Composer();
    this.inbound = new TspInbound();
    this.dirty = false;
    this.renderTimer = null;
    this.closed = false;
    this.cwd = this.cwd;
    this.configDir = sessionDir();
    this.picker = null;
    this.approval = null;
    this.agentModal = null;
    this.fieldDialog = null;
    this.pinned = new Set();
    this.toasts = [];
    this.menuSelected = 0;
    this.attachments = [];
    this.blobCache = new Map();
    this.imageCache = new Map();
    this.statusExtras = new Map();
    this.models = [];
    this.levels = ["off", "low", "medium", "high", "max"];
    this.expandAll = false;
    this.hideThinking = false;
    this.commands = [];
    this.effort = "";
    this.lastUserText = "";
    this.lastPrompt = "";
    this.sessionFile = "";
    this.sessionId = "";
    this.sessionsCache = null;
    this.agentPoll = null;
    this.stopping = false;
    this.startedAt = Date.now();
    this.frames = 0;
    this.renderCount = 0;
    this.renderMs = 0;
    this.toastSeq = 0;
    this.notifySeq = 0;
    this.notifyPending = false;
    this.lastSigintTime = 0;
    this.lastPromptAt = 0;
    this.ttftLogged = false;
    this.firstTokenPainted = false;
    this.lastItemCount = 0;
  }

  async start() {
    const theme = this.hello.dark ? THEME.dark : THEME.light;
    this.link.open({
      id: SURFACE,
      mode: "screen",
      title: "pi",
      role: "pi.session",
      listen: true,
      closable: true,
      font: "sans",
    });
    this.link.palette({
      sf: SURFACE,
      name: { dark: "pi-tsp", light: "pi-tsp" },
      dark: { accent: theme.accent, info: theme.info, success: theme.success, warning: theme.warning, error: theme.error, muted: theme.muted },
      light: { accent: theme.accent, info: theme.info, success: theme.success, warning: theme.warning, error: theme.error, muted: theme.muted },
    });
    this.link.stylesheet({ sf: SURFACE, name: "pi-tsp", css: `${STYLESHEET}${this.hello.dark ? TEXT_CSS.dark : TEXT_CSS.light}` });

    // Three stable region roots. `layer` is hidden until a modal exists.
    this.doc.setRegions({
      main: [{ id: "main", k: "col", p: { gap: "lg" }, c: [] }],
      dock: [{ id: "dock", k: "col", p: { gap: "sm" }, c: [] }],
      layer: [{ id: "layer", k: "col", p: { hidden: true }, c: [] }],
    });
    this.renderNow();
    this.doc.sendOps([["focus", "composer.editor"]]);

    process.stdin.setEncoding("utf8");
    try {
      process.stdin.setRawMode(true);
    } catch {
      /* not a tty: tests call render directly */
    }
    process.stdin.resume();
    process.stdin.on("data", (chunk) => this.onInput(chunk));

    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) {
      process.on(signal, () => this.shutdown(signal));
    }
    process.on("exit", () => {
      try {
        this.link.close(SURFACE, true);
      } catch {
        /* the pty may already be gone */
      }
    });

    if (this.leftover?.length) this.onInput(this.leftover);
    await this.startRpc();
    this.schedule();
  }

  resolvePi() {
    return process.env.PI_TSP_PI || STOCK;
  }

  extensionPaths() {
    const here = dirname(new URL(import.meta.url).pathname);
    return [
      join(here, "..", "ext", "permissions.ts"),
      join(here, "..", "ext", "plan.ts"),
      join(here, "..", "ext", "todo.ts"),
      join(here, "..", "ext", "tree.ts"),
    ].filter((path) => existsSync(path));
  }

  async startRpc() {
    const args = ["--mode", "rpc", "--session-dir", this.configDir];
    for (const path of this.extensionPaths()) args.push("--extension", path);
    // Interactive-only flags pi's RPC mode understands.
    const pass = new Set([
      "--provider", "--model", "--thinking", "--session", "--name", "--models",
      "--no-session", "--continue", "--resume", "--api-key", "--fork", "--session-id",
      "--extension", "--skill", "--prompt-template", "--theme", "--use-theme",
      "--tools", "--exclude-tools", "--no-tools", "--no-builtin-tools", "--no-mcp",
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
      "--no-context-files", "--system-prompt", "--append-system-prompt",
      "--approve", "--no-approve", "--offline", "--verbose", "--tui-mode",
    ]);
    for (let index = 0; index < this.args.length; index += 1) {
      const arg = this.args[index];
      const [flag, inline] = arg.split("=");
      if (!pass.has(flag)) continue;
      args.push(arg);
      if (!inline && index + 1 < this.args.length && !this.args[index + 1].startsWith("-")) {
        args.push(this.args[++index]);
      }
    }
    if (process.env.PI_TSP_EXTRA_ARGS) args.push(...process.env.PI_TSP_EXTRA_ARGS.split(" ").filter(Boolean));
    this.rpc = new PiRpc({ bin: this.resolvePi(), args, cwd: this.cwd, env: { PI_CODING_AGENT_DIR: configDir() } });
    this.rpc.on("event", (event) => this.onEvent(event));
    this.rpc.on("stderr", (chunk) => {
      if (process.env.PI_TSP_TRACE) {
        try {
          const { appendFileSync } = process.getBuiltinModule("node:fs");
          appendFileSync(process.env.PI_TSP_TRACE, `STDERR ${chunk}`);
        } catch {
          /* best effort */
        }
      }
    });
    this.rpc.on("exit", ({ code, signal }) => {
      if (this.stopping) return;
      this.conv.busy = false;
      this.conv.error = `pi exited (${signal || code})${this.rpc.stderr ? `\n\n${this.rpc.stderr.slice(-1200)}` : ""}`;
      this.schedule();
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    try {
      const state = await this.rpc.command("get_state", {}, 15000);
      this.applyState(state);
      // Paint the shell before the slower discovery calls. This keeps startup
      // responsive while models, commands, stats and history arrive in parallel.
      this.schedule();
      const [models, levels, commands, stats, messages] = await Promise.all([
        this.rpc.command("get_available_models", {}, 10000).catch(() => ({ models: [] })),
        this.rpc.command("get_available_thinking_levels", {}, 10000).catch(() => ({ levels: [] })),
        this.rpc.command("get_commands", {}, 10000).catch(() => ({ commands: [] })),
        this.rpc.command("get_session_stats", {}, 10000).catch(() => null),
        this.rpc.command("get_messages", {}, 15000).catch(() => ({ messages: [] })),
      ]);
      this.models = models.models || [];
      if (levels.levels?.length) this.levels = levels.levels;
      this.commands = commands.commands || [];
      this.applyStats(stats);
      if (messages.messages?.length) {
        this.conv.loadMessages(messages.messages);
      }
    } catch (error) {
      this.conv.error = `could not start pi: ${error.message}`;
    }
    this.schedule();
  }

  applyState(state) {
    if (!state) return;
    if (state.model) {
      this.conv.model = state.model.id;
      this.conv.provider = state.model.provider;
      this.conv.contextWindow = state.model.contextWindow || this.conv.contextWindow;
    }
    this.conv.thinkingLevel = state.thinkingLevel || this.conv.thinkingLevel;
    this.effort = this.conv.thinkingLevel;
    if (typeof state.autoCompactionEnabled === "boolean") this.conv.autoCompaction = state.autoCompactionEnabled;
    if (state.steeringMode) this.conv.steeringMode = state.steeringMode;
    if (state.followUpMode) this.conv.followUpMode = state.followUpMode;
    this.conv.busy = Boolean(state.isStreaming);
    this.sessionFile = state.sessionFile || "";
    this.sessionId = state.sessionId || "";
    this.conv.sessionName = state.sessionName || "";
  }

  applyStats(stats) {
    if (!stats) return;
    this.conv.cost = stats.cost || this.conv.cost;
    this.conv.contextTokens = stats.contextUsage?.tokens ?? this.conv.contextTokens;
    this.conv.contextWindow = stats.contextUsage?.contextWindow ?? this.conv.contextWindow;
    if (stats.tokens?.total) this.conv.usage.total = stats.tokens.total;
  }

  onEvent(event) {
    if (event.type === "extension_ui_request") {
      this.onExtensionUi(event);
      return;
    }
    if (event.type === "extension_error") {
      if (process.env.PI_TSP_TRACE) this.trace(`EXT ${JSON.stringify(event)}`);
      return;
    }
    if (event.type === "response") return;
    this.conv.onEvent(event);
    if (this.lastPromptAt && this.conv.turnFirstTokenAt && !this.ttftLogged) {
      this.ttftLogged = true;
      this.trace(`TTFT ${Date.now() - this.lastPromptAt}ms`);
    }
    if (event.type === "agent_settled" && this.notifyPending) {
      const last = [...this.conv.items].reverse().find((item) => item.kind === "assistant");
      if (last && last.stopReason !== "aborted" && last.stopReason !== "error" && !this.conv.error) {
        this.sendCompletionNotification();
      }
      this.notifyPending = false;
    }
    if (event.type === "agent_settled" || event.type === "turn_end") {
      this.rpc.command("get_session_stats", {}, 8000).then((stats) => {
        this.applyStats(stats);
        this.schedule();
      }).catch(() => {});
    }
    this.schedule();
  }

  onExtensionUi(request) {
    const method = request.method;
    if (method === "notify") {
      this.toast(request.message || "", request.notifyType);
      return;
    }
    if (method === "setStatus") {
      this.statusExtras.set(request.statusKey, request.statusText);
      this.schedule();
      return;
    }
    if (method === "setTitle" || method === "setWidget") {
      return;
    }
    if (method === "setEditorText" || method === "set_editor_text") {
      if (typeof request.text === "string") {
        this.composer.set(request.text, request.text.length);
        this.schedule();
      }
      return;
    }
    if (method === "confirm" || method === "select") {
      this.approval = {
        id: request.id,
        method,
        title: request.title || "Confirm",
        message: request.message || "",
        options: request.options || [],
        tool: request.title || "tool",
      };
      this.schedule();
      return;
    }
    if (method === "input" || method === "editor") {
      this.fieldDialog = {
        id: request.id,
        method,
        title: request.title || (method === "editor" ? "Edit text" : "Input"),
        message: request.message || "",
        text: method === "editor" ? (request.prefill || "") : "",
        placeholder: request.placeholder || (method === "editor" ? "Edit text…" : "Type a value…"),
      };
      this.fieldInput.set(this.fieldDialog.text || "");
      this.schedule();
      return;
    }
    // Unknown dialog method: cancel so the agent never hangs.
    if (request.id) this.rpc.respondExtensionUi(request.id, { cancelled: true });
  }

  sendCompletionNotification() {
    if (["off", "0", "false"].includes(String(process.env.PI_NOTIFICATIONS || "").toLowerCase())) return;
    const title = String(this.conv.sessionName || "pi").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 120) || "pi";
    const body = "Complete";
    const id = `pi-${this.sessionId || "session"}-${++this.notifySeq}`.replace(/[^a-zA-Z0-9_+.-]/g, "");
    const b64 = (value) => Buffer.from(value, "utf8").toString("base64");
    const meta = `i=${id}:f=${b64("pi")}:a=focus:t=${b64("completion")}`;
    const chunk = (m, value, hold) => `\x1b]99;${m}${hold ? ":d=0" : ""};${value}\x1b\\`;
    try {
      process.stdout.write(chunk(meta, title, true) + chunk(`i=${id}:p=body`, body, false));
    } catch { /* notifications are best-effort */ }
  }

  toast(text, tone = "info") {
    if (!text) return;
    const item = { id: `toast${++this.toastSeq || (this.toastSeq = 1)}`, text: String(text).slice(0, 300), tone };
    this.toasts.push(item);
    setTimeout(() => {
      this.toasts = this.toasts.filter((toast) => toast !== item);
      this.schedule();
    }, 3800);
    this.schedule();
  }

  onInput(chunk) {
    // Tern can deliver Ctrl+C as a raw byte before the TSP key decoder sees it.
    // Handle it once here so the double-tap works identically in both paths.
    if (String(chunk).includes("\x03")) {
      this.handleCtrlC();
      return;
    }
    const { events, keys } = this.inbound.feed(String(chunk));
    for (const { verb, body } of events) {
      if (verb === "e") this.onTspEvent(body);
    }
    if (keys.length) this.onKeys(keys);
  }

  onTspEvent(event) {
    switch (event.ev) {
      case "ack":
        this.doc.ack(Number(event.s || 0));
        return;
      case "resize":
        if (event.cols) {
          this.compact = this.forceCompact || Number(event.cols) < 74;
          this.schedule();
        }
        return;
      case "theme":
        this.dark = Boolean(event.dark);
        return;
      case "motion":
        return;
      case "visible":
        return;
      case "error":
        this.trace(`TSP ${JSON.stringify(event)}`);
        return;
      case "action":
        this.onAction(event.act || "", event.id || "", event.value, event);
        return;
      case "select":
        this.onSelect(event);
        return;
      case "activate":
        this.onActivate(event);
        return;
      case "change":
        this.onChange(event);
        return;
      case "toggle":
        return;
      case "edit":
        if (this.fieldDialog && String(event.id || "").startsWith("field.")) {
          this.fieldDialog.text = String(this.fieldDialog.text || "").slice(0, event.from) + (event.text || "") + String(this.fieldDialog.text || "").slice(event.to);
          this.schedule();
          return;
        }
        this.composer.set(
          this.composer.text.slice(0, event.from) + event.text + this.composer.text.slice(event.to),
          event.cursor,
        );
        this.schedule();
        return;
      case "send":
        if (this.fieldDialog) {
          this.submitField(event.text ?? this.fieldDialog.text);
          return;
        }
        this.submit(event.text || this.composer.text);
        return;
      case "undo":
        return;
      default:
        return;
    }
  }

  handleCtrlC() {
    if (this.killed || this.stopping) return;
    if (this.picker) {
      this.picker = null;
      this.schedule();
      return;
    }
    if (this.approval) {
      this.answerApproval(this.approval.options?.[this.approval.options.length - 1] || "Deny");
      return;
    }
    const now = Date.now();
    if (now - this.lastSigintTime < 1500) {
      this.shutdown("Ctrl+C");
      return;
    }
    this.lastSigintTime = now;
    if (this.conv.busy) this.abort();
    else if (this.composer.text) this.composer.clear();
    this.toast("Ctrl+C again to exit");
    this.schedule();
  }

  onKeys(data) {
    if (this.killed) return;
    if (String(data) === "\x1b\r") {
      const text = this.composer.text.trim();
      if (!text) return;
      this.rpc.command("follow_up", { message: text }, 15000).then(() => {
        this.lastUserText = text;
        this.composer.clear();
        this.toast("Queued after the current turn");
        this.schedule();
      }).catch((error) => this.toast(`queue failed: ${error.message}`, "error"));
      return;
    }
    if (String(data) === "\x1b[1;3A") {
      if (this.conv.queue?.steering?.length || this.conv.queue?.followUp?.length) this.editQueue();
      else this.composer.recall(-1);
      return;
    }
    if (this.fieldDialog) {
      const field = this.fieldInput.feed(data);
      this.fieldDialog.text = this.fieldInput.text;
      if (field.submit != null) {
        this.submitField(field.submit);
        return;
      }
      if (field.escape) {
        this.cancelField();
        return;
      }
      if (field.changed) this.schedule();
      return;
    }
    if (String(data) === "\x0f") {
      this.expandAll = !this.expandAll;
      this.schedule();
      return;
    }
    if (String(data) === "\x14") {
      this.hideThinking = !this.hideThinking;
      this.schedule();
      return;
    }
    if (String(data) === "\x10") {
      this.cycleModel();
      return;
    }
    if (String(data) === "\x1b[70;6u" || String(data) === "\x1b[70;6~") {
      this.openSearchPrompt();
      return;
    }
    if (String(data) === "\x0c") {
      this.openModelPicker();
      return;
    }
    if (String(data) === "\x12") {
      if (this.picker?.kind === "resume") {
        const target = this.picker.sessions?.find((entry) => entry.id === this.picker.selected);
        this.openRenameDialog(target || null);
      } else {
        this.openRenameDialog();
      }
      return;
    }
    if (String(data) === "\x18") {
      this.copyLastAnswer();
      return;
    }
    if (String(data) === "\x1b[Z") {
      const levels = this.levels;
      const index = Math.max(0, levels.indexOf(this.conv.thinkingLevel || this.effort));
      this.setEffort(levels[(index + 1) % levels.length]);
      return;
    }
    if (this.picker?.kind === "resume" && String(data) === "\x04") {
      this.armDeleteSession();
      return;
    }
    if (String(data) === "\x04" && !this.composer.text && !this.conv.busy && !this.picker && !this.approval && !this.fieldDialog) {
      this.shutdown("Ctrl+D");
      return;
    }
    const result = this.composer.feed(data);
    if (this.picker) {
      if (result.submit != null) {
        this.choosePicker();
        return;
      }
      if (result.menuUp || result.menuDown) {
        const items = this.picker.items || [];
        if (items.length) {
          const current = items.findIndex((item) => item.id === this.picker.selected);
          const delta = result.menuDown ? 1 : -1;
          const next = (Math.max(0, current) + delta + items.length) % items.length;
          this.picker.selected = items[next].id;
          this.schedule();
        }
        return;
      }
      if (result.escape) {
        if (this.picker.confirm) {
          this.picker.confirm = null;
          this.picker.deleteTarget = null;
        } else {
          this.picker = null;
        }
        this.schedule();
        return;
      }
    }
    if (result.menuUp || result.menuDown) {
      const menu = this.currentMenu();
      if (menu?.items?.length) {
        const delta = result.menuDown ? 1 : -1;
        const count = Math.min(menu.items.length, 6);
        this.menuSelected = (this.menuSelected + delta + count) % count;
        this.schedule();
        return;
      }
      if (result.menuUp) this.composer.recall(-1);
      if (result.menuDown) this.composer.recall(1);
      this.schedule();
      return;
    }
    if (result.tab) {
      this.complete();
      return;
    }
    if (result.escape) {
      if (this.picker) this.picker = null;
      else if (this.agentModal) this.agentModal = null;
      else if (this.approval) {
        // Esc dismisses without answering; the agent is explicitly denied.
        this.answerApproval(this.approval.options?.[this.approval.options.length - 1] || "Deny");
        return;
      } else if (this.currentMenu()) this.composer.clear();
      else if (this.conv.busy) this.abort();
      else this.composer.clear();
      this.schedule();
      return;
    }
    if (result.ctrlC) {
      this.handleCtrlC();
      return;
    }
    if (result.interrupt) {
      if (this.conv.busy) this.abort();
      return;
    }
    if (result.submit != null) {
      this.submit(result.submit);
      return;
    }
    if (result.changed) {
      this.menuSelected = 0;
      this.schedule();
    }
  }

  onAction(act, nodeId, value, event) {
    if (act === "field-submit") {
      this.submitField(this.fieldDialog?.text || "");
      return;
    }
    if (act === "field-cancel") {
      this.cancelField();
      return;
    }
    if (act === "send") {
      this.submit(this.composer.text);
      return;
    }
    if (act === "queue-edit") {
      this.editQueue();
      return;
    }
    if (act === "pin") {
      this.togglePin();
      return;
    }
    if (act === "rename-picked") {
      const target = this.picker?.sessions?.find((entry) => entry.id === this.picker.selected);
      this.openRenameDialog(target || null);
      return;
    }
    if (act === "fork") {
      this.openForkPicker();
      return;
    }
    if (act === "delete") {
      this.armDeleteSession();
      return;
    }
    if (act === "delete-confirm") {
      this.deleteSelectedSession();
      return;
    }
    if (act === "cancel-delete") {
      if (this.picker) this.picker.confirm = null;
      this.schedule();
      return;
    }
    if (act.startsWith("detach:")) {
      const index = Number(act.slice(7));
      this.attachments.splice(index, 1);
      this.schedule();
      return;
    }
    if (act === "copy-answer" || act === "copy-message") {
      const id = String(nodeId || "").split(".")[0];
      const item = this.conv.items.find((entry) => entry.id === id);
      if (item) this.copyText(item.text || "");
      return;
    }
    if (act === "copy-picker") {
      this.openCopyPicker();
      return;
    }
    if (act === "model") {
      this.openModelPicker();
      return;
    }
    if (act === "effort") {
      this.openEffortPicker();
      return;
    }
    if (act === "plan-off") {
      this.prompt("/plan");
      return;
    }
    if (act === "plan-implement") {
      this.prompt("/implement");
      return;
    }
    if (act === "agents") {
      this.openAgentsPicker();
      return;
    }
    if (act === "todos") {
      this.showTodos();
      return;
    }
    if (act.startsWith("agent-view")) {
      const id = act.includes(":") ? act.split(":")[1] : nodeId.split(".")[0];
      this.openAgentModal(id);
      return;
    }
    if (act === "agent-close") {
      this.agentModal = null;
      this.schedule();
      return;
    }
    if (act.startsWith("menu:")) {
      const index = Number(act.slice(5));
      const menu = this.currentMenu();
      const item = menu?.items?.[index];
      if (item) this.runCommand(item.name);
      return;
    }
    if (act.startsWith("suggest:")) {
      const index = Number(act.slice(8));
      const suggestions = this.suggestions();
      if (suggestions[index]) {
        this.composer.set(suggestions[index]);
        this.schedule();
      }
      return;
    }
    if (act.startsWith("approve:")) {
      this.answerApproval(act.slice(8));
      return;
    }
    if (act === "retry") {
      if (this.lastUserText) this.prompt(this.lastUserText);
      return;
    }
    if (act === "tree-label") {
      const entry = this.picker?.entries?.find((item) => item.id === this.picker.selected);
      this.openTreeLabelDialog(entry);
      return;
    }
    if (act === "picker-choose" || act === "choose") {
      this.choosePicker();
      return;
    }
    if (act === "plan-toggle") {
      this.prompt("/plan");
      return;
    }
    this.trace(`unknown action ${act} on ${nodeId}`);
  }

  onSelect(event) {
    if (this.picker && event.id === "picker.node") {
      this.picker.selected = event.item;
      if (this.picker.kind === "resume") {
        const session = this.picker.sessions?.find((entry) => entry.id === event.item);
        if (session?.preview) this.picker.subtitle = session.preview.slice(0, 180);
      }
      this.schedule();
    }
  }

  onActivate(event) {
    if (this.picker && event.id === "picker.node") {
      this.picker.selected = event.item;
      this.choosePicker();
    }
  }

  onChange(event) {
    if (this.fieldDialog && String(event.id || "").startsWith("field.")) {
      const value = event.text ?? event.value;
      if (typeof value === "string") this.fieldDialog.text = value;
      this.schedule();
      return;
    }
    if (this.picker && event.id === "picker.node" && event.value) {
      this.picker.selected = String(event.value);
      this.schedule();
    }
  }

  currentMenu() {
    const text = this.composer.text;
    if (!text.startsWith("/") || /\s/.test(text)) return null;
    const query = text.slice(1).toLowerCase();
    const commands = this.allCommands().filter((command) => command.name.toLowerCase().startsWith(query));
    if (!commands.length) return null;
    const model = fmtModel(this.conv.model || "");
    const used = this.conv.contextWindow ? Math.round((100 * (this.conv.contextTokens || 0)) / this.conv.contextWindow) : 0;
    const values = {
      model,
      effort: this.effort || this.conv.thinkingLevel,
      plan: this.conv.plan?.active ? "on" : "off",
      compact: `${used}%`,
      permissions: "on",
    };
    return { items: commands, selected: Math.min(this.menuSelected, commands.length - 1), limit: 6, values };
  }

  allCommands() {
    const local = [
      { name: "clear", description: "Start a fresh session", source: "pi-tsp" },
      { name: "resume", description: "Open a previous session", source: "pi-tsp" },
      { name: "model", description: "Switch model", source: "pi-tsp" },
      { name: "effort", description: "Set thinking effort", source: "pi-tsp" },
      { name: "plan", description: "Toggle plan mode (read-only)", source: "pi-tsp" },
      { name: "implement", description: "Execute the current plan", source: "pi-tsp" },
      { name: "agents", description: "List subagents and transcripts", source: "pi-tsp" },
      { name: "todos", description: "Show the current todo board", source: "pi-tsp" },
      { name: "rename", description: "Name this session: /rename <name>", source: "pi-tsp" },
      { name: "name", description: "Alias for /rename", source: "pi-tsp" },
      { name: "new", description: "Start a fresh session", source: "pi-tsp" },
      { name: "clone", description: "Duplicate this session at its current position", source: "pi-tsp" },
      { name: "session", description: "Show session statistics", source: "pi-tsp" },
      { name: "thinking", description: "Set thinking level", source: "pi-tsp" },
      { name: "export", description: "Export this session as HTML", source: "pi-tsp" },
      { name: "import", description: "Import a JSONL session: /import <path>", source: "pi-tsp" },
      { name: "hotkeys", description: "Show keyboard shortcuts", source: "pi-tsp" },
      { name: "search", description: "Search the transcript: /search <text>", source: "pi-tsp" },
      { name: "settings", description: "Show available pi settings commands", source: "pi-tsp" },
      { name: "trust", description: "Save project trust for the next launch", source: "pi-tsp" },
      { name: "scoped-models", description: "Choose the model for Ctrl+P cycling", source: "pi-tsp" },
      { name: "reload", description: "Reload instructions, extensions and themes", source: "pi-tsp" },
      { name: "changelog", description: "Show the pi-tsp build version", source: "pi-tsp" },
      { name: "tree", description: "Browse the session tree and fork", source: "pi-tsp" },
      { name: "fork", description: "Fork from an earlier message", source: "pi-tsp" },
      { name: "copy", description: "Copy a message or answer", source: "pi-tsp" },
      { name: "attach", description: "Attach an image: /attach <path>", source: "pi-tsp" },
      { name: "compact", description: "Compact the conversation", source: "pi-tsp" },
      { name: "help", description: "Keys and commands", source: "pi-tsp" },
      { name: "quit", description: "Close pi-tsp", source: "pi-tsp" },
    ];
    const seen = new Set(local.map((command) => command.name));
    const remote = this.commands
      .filter((command) => !seen.has(command.name))
      .map((command) => ({ name: command.name, description: command.description || "", source: command.source || "pi" }));
    return [...local, ...remote];
  }

  suggestions() {
    return ["Explain this repository and its main entry points.",
      "Find a failing test and fix it.",
      "Review the uncommitted diff and point out risks.",
      "Write a focused test for the last change."];
  }

  runCommand(name) {
    if (!name) return;
    this.composer.set("");
    this.menuSelected = 0;
    const command = this.allCommands().find((entry) => entry.name === name);
    if (!command) return;
    if (["clear", "new", "clone", "session", "resume", "model", "effort", "thinking", "plan", "implement", "agents", "todos", "rename", "name", "tree", "fork", "copy", "search", "attach", "export", "import", "hotkeys", "settings", "trust", "scoped-models", "reload", "changelog", "compact", "help", "quit"].includes(name)) {
      this.localCommand(name, "");
    } else {
      this.prompt(`/${name}`);
    }
  }

  localCommand(name, rest) {
    const arg = rest.trim();
    switch (name) {
      case "clear":
        this.clearSession();
        return;
      case "resume":
        this.openResumePicker();
        return;
      case "model":
        if (arg) this.setModelByQuery(arg);
        else this.openModelPicker();
        return;
      case "effort":
        if (arg) this.setEffort(arg);
        else this.openEffortPicker();
        return;
      case "plan":
        this.prompt("/plan");
        return;
      case "implement":
        this.prompt("/implement");
        return;
      case "agents":
        this.openAgentsPicker();
        return;
      case "todos":
        this.showTodos();
        return;
      case "rename":
      case "name":
        this.renameSession(arg);
        return;
      case "new":
        this.clearSession();
        return;
      case "clone":
        this.cloneSession();
        return;
      case "session":
        this.showSession();
        return;
      case "thinking":
        if (arg) this.setEffort(arg);
        else this.openEffortPicker();
        return;
      case "export":
        this.exportSession(arg);
        return;
      case "import":
        this.importSession(arg);
        return;
      case "hotkeys":
        this.openHotkeysPicker();
        return;
      case "settings":
        this.openSettingsPicker();
        return;
      case "trust":
        this.openTrustPicker();
        return;
      case "scoped-models":
        this.openModelPicker();
        return;
      case "reload":
        this.toast("Restarting pi-tsp reloads extensions, skills, themes and instructions.");
        return;
      case "changelog":
        this.toast(`pi-tsp ${BUILD} · https://github.com/MadeBy561/pi-tsp/releases`);
        return;
      case "tree":
        this.openForkPicker("tree");
        return;
      case "fork":
        this.openForkPicker("fork");
        return;
      case "copy":
        this.openCopyPicker();
        return;
      case "search":
        this.openSearchPrompt(arg);
        return;
      case "attach":
        this.attach(arg);
        return;
      case "compact":
        this.compactNow();
        return;
      case "help":
        this.showHelp();
        return;
      case "quit":
        this.shutdown("quit");
        return;
      default:
        return;
    }
  }

  submit(raw) {
    const text = (raw ?? this.composer.text).trim();
    if (!text) return;
    this.composer.push(text);
    this.composer.clear();
    this.menuSelected = 0;
    if (text.startsWith("!")) {
      this.runShell(text);
      return;
    }
    if (text.startsWith("/")) {
      const [word, ...rest] = text.slice(1).split(/\s+/);
      const local = ["clear", "new", "clone", "session", "resume", "model", "effort", "thinking", "plan", "implement", "agents", "todos", "rename", "name", "tree", "fork", "copy", "search", "attach", "export", "import", "hotkeys", "settings", "trust", "scoped-models", "reload", "changelog", "compact", "help", "quit"];
      if (local.includes(word)) {
        this.localCommand(word, rest.join(" "));
        return;
      }
    }
    this.lastUserText = text;
    this.sendPrompt(text);
  }

  async runShell(raw) {
    const excludeFromContext = raw.startsWith("!!");
    const command = raw.slice(excludeFromContext ? 2 : 1).trim();
    if (!command) {
      this.toast("usage: !command or !!command");
      return;
    }
    const item = {
      kind: "bash",
      id: `shlocal${Date.now()}`,
      text: command,
      output: "",
      status: "running",
      at: Date.now(),
      excludeFromContext,
    };
    this.conv.shellLocal = item;
    this.conv.add(item);
    this.lastPrompt = raw;
    this.schedule();
    try {
      const result = await this.rpc.command("bash", { command, excludeFromContext }, 600000);
      item.output = result?.output || "";
      item.exitCode = result?.exitCode;
      item.cancelled = Boolean(result?.cancelled);
      item.truncated = Boolean(result?.truncated);
      item.status = item.cancelled || (item.exitCode != null && item.exitCode !== 0) ? "error" : "done";
    } catch (error) {
      item.status = "error";
      item.output = error.message;
    }
    this.schedule();
  }

  sendPrompt(text, extraImages = null) {
    const images = extraImages || this.attachments;
    const wasBusy = this.conv.busy;
    const isCommand = text.startsWith("/");
    this.attachments = [];
    if (!isCommand) {
      this.conv.addUser(text, images);
      this.conv.busy = true;
      this.notifyPending = true;
      this.lastPromptAt = Date.now();
      this.ttftLogged = false;
      this.firstTokenPainted = false;
    }
    this.conv.error = null;
    this.conv.turnStartedAt = Date.now();
    this.lastPrompt = text;
    this.schedule();
    const payload = { type: "prompt", message: text };
    if (images.length) payload.images = images;
    if (wasBusy) payload.streamingBehavior = "steer";
    this.rpc.command("prompt", payload, 20000).then((data) => {
      if (isCommand && data?.disposition === "handled") {
        this.conv.busy = false;
      }
      this.schedule();
    }).catch((error) => {
      this.conv.busy = false;
      this.conv.error = error.message;
      this.schedule();
    });
  }

  prompt(text) {
    if (!text) return;
    this.lastUserText = text;
    this.sendPrompt(text);
  }

  abort() {
    this.rpc.command("abort", {}, 15000).catch(() => {});
    this.notifyPending = false;
    this.conv.busy = false;
    this.schedule();
  }

  async clearSession() {
    try {
      await this.rpc.command("new_session", {}, 15000);
      this.conv.loadMessages([]);
      this.conv.error = null;
      this.notifyPending = false;
      this.agentModal = null;
      this.picker = null;
      this.approval = null;
      const state = await this.rpc.command("get_state", {}, 10000);
      this.applyState(state);
      this.toast("New session");
    } catch (error) {
      this.toast(`clear failed: ${error.message}`, "error");
    }
    this.schedule();
  }

  submitField(value) {
    const dialog = this.fieldDialog;
    if (!dialog) return;
    this.fieldDialog = null;
    if (dialog.id) {
      try { this.rpc.respondExtensionUi(dialog.id, { value: String(value ?? "") }); } catch { /* gone */ }
    }
    if (dialog.local === "rename") {
      const name = String(value ?? "").trim();
      if (name && dialog.renamePath && dialog.renamePath !== this.sessionFile) this.renamePickedSession(dialog.renamePath, name);
      else this.renameSession(name);
    }
    if (dialog.local === "tree-label" && dialog.labelEntry) {
      this.labelTreeEntry(dialog.labelEntry.id, String(value ?? ""));
    }
    if (dialog.local === "search") this.openSearchPicker(String(value ?? ""));
    this.schedule();
  }

  cancelField() {
    const dialog = this.fieldDialog;
    if (!dialog) return;
    this.fieldDialog = null;
    if (dialog.id) {
      try { this.rpc.respondExtensionUi(dialog.id, { cancelled: true }); } catch { /* gone */ }
    }
    this.schedule();
  }

  openRenameDialog(target = null) {
    this.fieldDialog = {
      id: null,
      method: "input",
      local: "rename",
      renamePath: target?.path || null,
      title: "Rename session",
      message: target ? "Name the selected session." : "Give this session a recognizable name.",
      text: target?.title || this.conv.sessionName || "",
      placeholder: "Session name",
    };
    this.fieldInput.set(this.fieldDialog.text || "");
    this.schedule();
  }

  copyLastAnswer() {
    const item = [...this.conv.items].reverse().find((entry) => entry.kind === "assistant" && String(entry.text || "").trim());
    if (item) this.copyText(item.text);
    else this.toast("No assistant answer to copy", "warning");
  }

  copyText(text) {
    const value = String(text || "");
    if (!value.trim()) {
      this.toast("Nothing to copy", "warning");
      return;
    }
    try {
      const b64 = Buffer.from(value, "utf8").toString("base64");
      process.stdout.write(`\x1b]52;c;${b64}\x07`);
      this.toast("Copied to clipboard");
    } catch (error) {
      this.toast(`copy failed: ${error.message}`, "error");
    }
  }

  openSearchPrompt(query = "") {
    const value = String(query || "").trim();
    if (value) {
      this.openSearchPicker(value);
      return;
    }
    this.fieldDialog = {
      id: null,
      method: "input",
      local: "search",
      title: "Search transcript",
      message: "Find text in this session.",
      text: "",
      placeholder: "Search text…",
    };
    this.fieldInput.set("");
    this.schedule();
  }

  openSearchPicker(query) {
    const needle = String(query || "").toLowerCase();
    const entries = this.conv.items
      .filter((item) => ["user", "assistant", "tool", "agent", "custom", "hook", "bash", "python", "thinking", "compaction", "branch"].includes(item.kind) && String(item.text || item.output || "").trim())
      .map((item) => ({
        id: item.id,
        text: String(item.text || item.output || ""),
        kind: item.kind,
      }))
      .filter((item) => !needle || item.text.toLowerCase().includes(needle));
    if (!entries.length) {
      this.toast(`No matches for “${query}”`, "warning");
      return;
    }
    this.picker = {
      kind: "search",
      title: "Search transcript",
      subtitle: `${entries.length} match${entries.length === 1 ? "" : "es"} · ${query}`,
      icon: "search",
      selected: entries[0].id,
      items: entries.map((entry) => ({
        id: entry.id,
        label: entry.text.replace(/\s+/g, " ").slice(0, 110),
        detail: entry.kind,
        icon: entry.kind === "user" ? "user" : entry.kind === "assistant" ? "message" : "search",
        mono: true,
      })),
      texts: entries,
      query,
    };
    this.schedule();
  }

  openCopyPicker() {
    const entries = this.conv.items.filter((item) =>
      (item.kind === "user" || item.kind === "assistant" || item.kind === "compaction" || item.kind === "branch") &&
      String(item.text || "").trim(),
    );
    if (!entries.length) {
      this.toast("No copyable messages yet");
      return;
    }
    this.picker = {
      kind: "copy",
      title: "Copy from this session",
      subtitle: `${entries.length} messages`,
      icon: "copy",
      selected: entries[entries.length - 1].id,
      items: entries.map((item) => ({
        id: item.id,
        label: firstLine(item.text, 96),
        detail: `${item.kind === "user" ? "You" : item.kind === "assistant" ? "pi" : item.kind} · ${clock(item.at)}`,
        icon: item.kind === "user" ? "user" : "message",
        dot: item.kind === "assistant" ? "success" : "muted",
      })),
      texts: entries,
    };
    this.schedule();
  }

  async openForkPicker(mode = "fork") {
    try {
      const data = await this.rpc.command("get_tree", {}, 15000);
      this.trace(`TREE data ${JSON.stringify(data).slice(0, 120)}`);
      const entries = [];
      const walk = (nodes, depth = 0) => {
        for (const node of nodes || []) {
          const entry = node?.entry;
          if (entry?.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant")) {
            const text = textOf(entry.message.content).replace(/\s+/g, " ").trim();
            if (text) entries.push({
              id: entry.id,
              text,
              role: entry.message.role,
              depth,
              label: node.label || "",
              labelTimestamp: node.labelTimestamp || "",
              at: entry.message.timestamp || Date.now(),
            });
          }
          walk(node?.children, depth + 1);
        }
      };
      walk(data.tree);
      this.trace(`TREE entries ${entries.length}`);
      if (!entries.length) {
        this.toast("No messages to fork from yet");
        return;
      }
      this.picker = {
        kind: mode,
        title: mode === "tree" ? "Session tree" : "Fork from a message",
        subtitle: mode === "tree" ? `${entries.length} messages · select a prompt to restore` : `${entries.length} messages · choose a branch point`,
        icon: "branch",
        layout: "tree",
        selected: data.leafId || entries[entries.length - 1].id,
        items: entries.map((entry) => ({
          id: entry.id,
          label: entry.label ? `${entry.label} · ${entry.text.slice(0, 88)}` : entry.text.slice(0, 100),
          detail: `${entry.role === "user" ? "You" : "pi"} · ${mode === "tree" ? "tree entry" : "new branch"}${entry.label ? " · labeled" : ""}`,
          icon: entry.role === "user" ? "user" : "message",
          dot: entry.role === "assistant" ? "success" : "muted",
          depth: entry.depth || 0,
        })),
        entries,
      };
      this.schedule();
    } catch (error) {
      this.trace(`TREE error ${error.message}`);
      this.toast(`could not read the session tree: ${error.message}`, "error");
    }
  }

  openTreeLabelDialog(entry) {
    if (!entry) return;
    this.fieldDialog = {
      id: null,
      method: "input",
      local: "tree-label",
      labelEntry: entry,
      title: entry.label ? "Edit tree label" : "Label tree entry",
      message: entry.label ? "Change or clear the label for this tree entry." : "Give this tree entry a short label.",
      text: entry.label || "",
      placeholder: "Label (empty clears it)",
    };
    this.fieldInput.set(this.fieldDialog.text || "");
    this.schedule();
  }

  async labelTreeEntry(entryId, label) {
    const value = String(label || "").trim().replace(/\s+/g, " ");
    try {
      await this.rpc.command("prompt", { message: `/tsp-label ${entryId}${value ? ` ${value}` : ""}` }, 20000);
      this.picker = null;
      this.toast(value ? `Labeled: ${value}` : "Tree label cleared");
      this.openForkPicker("tree");
    } catch (error) {
      this.toast(`tree label failed: ${error.message}`, "error");
    }
  }

  useTreeEntry(entryId, entries = null) {
    const entry = (entries || this.picker?.entries || []).find((item) => item.id === entryId);
    this.picker = null;
    if (!entry) return;
    this.treeSession(entry);
  }

  async treeSession(entry) {
    try {
      await this.rpc.command("prompt", { message: `/tsp-tree ${entry.id}` }, 30000);
      await this.refreshCurrent();
      if (entry.role === "user") {
        this.composer.set(entry.text);
        this.toast("Moved to that branch; prompt restored");
      } else {
        this.composer.clear();
        this.toast("Moved to that branch");
      }
    } catch (error) {
      this.toast(`tree navigation failed: ${error.message}`, "error");
    }
    this.schedule();
  }

  async forkSession(entryId) {
    try {
      const result = await this.rpc.command("fork", { entryId }, 30000);
      if (result?.cancelled) {
        this.toast("Fork cancelled");
        return;
      }
      const messages = await this.rpc.command("get_messages", {}, 20000);
      this.conv.loadMessages(messages.messages || []);
      const state = await this.rpc.command("get_state", {}, 10000);
      this.applyState(state);
      this.toast("Forked a new branch");
    } catch (error) {
      this.toast(`fork failed: ${error.message}`, "error");
    }
    this.schedule();
  }

  showTodos() {
    const todos = this.conv.todos?.items || [];
    if (!todos.length) {
      this.toast("No todo list yet");
      return;
    }
    this.picker = {
      kind: "todos",
      title: "Todos",
      subtitle: `${todos.filter((todo) => todo.status === "done").length}/${todos.length} complete`,
      icon: "check",
      selected: todos.find((todo) => todo.status !== "done")?.id || todos[0].id,
      items: todos.map((todo) => ({
        id: todo.id,
        label: todo.text,
        detail: todo.status,
        icon: todo.status === "done" ? "check" : "clock",
        dot: todo.status === "done" ? "success" : todo.status === "active" ? "pending" : "muted",
      })),
    };
    this.schedule();
  }

  async refreshCurrent() {
    const messages = await this.rpc.command("get_messages", {}, 20000);
    this.conv.loadMessages(messages.messages || []);
    const state = await this.rpc.command("get_state", {}, 10000);
    this.applyState(state);
    this.schedule();
  }

  async cloneSession() {
    try {
      const result = await this.rpc.command("clone", {}, 30000);
      if (result?.cancelled) {
        this.toast("Clone cancelled", "warning");
        return;
      }
      await this.refreshCurrent();
      this.toast("Session cloned");
    } catch (error) {
      this.toast(`clone failed: ${error.message}`, "error");
    }
  }

  async showSession() {
    try {
      const stats = await this.rpc.command("get_session_stats", {}, 10000);
      const name = this.conv.sessionName || "(unnamed)";
      const messages = stats.totalMessages ?? this.conv.items.length;
      const tokens = stats.tokens?.total ?? this.conv.usage.total ?? 0;
      const cost = Number(stats.cost || 0).toFixed(2);
      this.toast(`${name} · ${messages} messages · ${humanTokens(tokens)} tok · $${cost}`);
    } catch (error) {
      this.toast(`session stats failed: ${error.message}`, "error");
    }
  }

  async exportSession(path) {
    try {
      const result = await this.rpc.command("export_html", path ? { outputPath: path } : {}, 120000);
      this.toast(`Exported: ${result?.path || path || "session.html"}`);
    } catch (error) {
      this.toast(`export failed: ${error.message}`, "error");
    }
  }

  async importSession(path) {
    if (!path) {
      this.toast("usage: /import <session.jsonl>");
      return;
    }
    try {
      await this.rpc.command("switch_session", { sessionPath: path }, 25000);
      await this.refreshCurrent();
      this.toast("Session imported");
    } catch (error) {
      this.toast(`import failed: ${error.message}`, "error");
    }
  }

  openHotkeysPicker() {
    this.picker = {
      kind: "info",
      title: "Keyboard shortcuts",
      subtitle: "Vanilla pi controls supported by pi-tsp",
      items: [
        { id: "ctrl-o", label: "Ctrl+O", detail: "expand/collapse tools and summaries" },
        { id: "ctrl-t", label: "Ctrl+T", detail: "show/hide thinking" },
        { id: "ctrl-p", label: "Ctrl+P", detail: "cycle model" },
        { id: "ctrl-l", label: "Ctrl+L", detail: "open model picker" },
        { id: "ctrl-r", label: "Ctrl+R", detail: "rename current session" },
        { id: "ctrl-x", label: "Ctrl+X", detail: "copy last assistant answer" },
        { id: "shift-tab", label: "Shift+Tab", detail: "cycle thinking level" },
        { id: "ctrl-d", label: "Ctrl+D", detail: "delete selected session in /resume" },
        { id: "enter", label: "Enter", detail: "send or confirm" },
        { id: "escape", label: "Escape", detail: "cancel or abort" },
      ],
    };
    this.schedule();
  }

  async renamePickedSession(path, name) {
    const current = this.sessionFile;
    try {
      await this.rpc.command("switch_session", { sessionPath: path }, 25000);
      await this.rpc.command("set_session_name", { name }, 10000);
      if (current && current !== path) await this.rpc.command("switch_session", { sessionPath: current }, 25000);
      await this.refreshCurrent();
      this.picker = null;
      this.toast(`Session renamed: ${name}`);
    } catch (error) {
      this.toast(`rename failed: ${error.message}`, "error");
    }
  }

  async renameSession(name) {
    if (!name) {
      this.toast("usage: /rename <session name>");
      return;
    }
    try {
      await this.rpc.command("set_session_name", { name }, 10000);
      this.conv.sessionName = name;
      this.toast(`Session renamed: ${name}`);
      this.schedule();
    } catch (error) {
      this.toast(`rename failed: ${error.message}`, "error");
    }
  }

  async editQueue() {
    try {
      const data = await this.rpc.command("clear_queue", {}, 10000);
      const messages = [...(data.steering || []), ...(data.followUp || [])];
      if (messages.length) this.composer.set(messages.join("\n"));
      this.conv.queue = { steering: [], followUp: [] };
      this.schedule();
    } catch (error) {
      this.toast(`could not edit queue: ${error.message}`, "error");
    }
  }

  pinnedPath() {
    return join(homedir(), ".pi-tsp", "pinned.json");
  }

  loadPinned() {
    try {
      const values = JSON.parse(readFileSync(this.pinnedPath(), "utf8"));
      this.pinned = new Set(Array.isArray(values) ? values.filter((value) => typeof value === "string") : []);
    } catch {
      this.pinned = new Set();
    }
  }

  savePinned() {
    try {
      writeFileSync(this.pinnedPath(), JSON.stringify([...this.pinned], null, 2), { mode: 0o600 });
    } catch {
      /* a pin is best-effort; the session still works */
    }
  }

  togglePin() {
    const picker = this.picker;
    if (!picker || picker.kind !== "resume") return;
    const session = picker.sessions?.find((entry) => entry.id === picker.selected);
    if (!session) return;
    if (this.pinned.has(session.id)) {
      this.pinned.delete(session.id);
      this.toast("Session unpinned");
    } else {
      this.pinned.add(session.id);
      this.toast("Session pinned");
    }
    this.savePinned();
    picker.pinned = this.pinned;
    for (const item of picker.items || []) {
      item.badges = this.pinned.has(item.id) ? [{ text: "pinned", tone: "accent" }] : [];
    }
    this.schedule();
  }

  armDeleteSession() {
    const picker = this.picker;
    if (!picker || picker.kind !== "resume") return;
    const session = picker.sessions?.find((entry) => entry.id === picker.selected);
    if (!session) return;
    if (
      session.current ||
      session.path === this.sessionFile ||
      (this.sessionId && session.id === this.sessionId)
    ) {
      this.toast("Cannot delete the session that is currently open", "warning");
      return;
    }
    picker.deleteTarget = session;
    picker.confirm = {
      text: `Delete “${session.title || "this session"}”? This removes the session file.`,
      act: "delete-confirm",
      label: "Delete",
    };
    this.schedule();
  }

  deleteSelectedSession() {
    const picker = this.picker;
    const session = picker?.deleteTarget || picker?.sessions?.find((entry) => entry.id === picker.selected);
    if (!picker || !session) return;
    try {
      if (existsSync(session.path)) unlinkSync(session.path);
      picker.sessions = picker.sessions.filter((entry) => entry.id !== session.id);
      picker.items = picker.items.filter((item) => item.id !== session.id);
      picker.confirm = null;
      picker.deleteTarget = null;
      const next = picker.sessions.find((entry) => entry.path !== this.sessionFile) || picker.sessions[0];
      picker.selected = next?.id || "";
      if (!picker.items.length) {
        this.picker = null;
        this.toast("Session deleted");
      } else {
        this.toast(`Deleted ${session.title || "session"}`);
      }
      this.schedule();
    } catch (error) {
      this.toast(`delete failed: ${error.message}`, "error");
    }
  }

  async openResumePicker() {
    try {
      const sessions = await listSessions(this.configDir, this.cwd);
      if (!sessions.length) {
        this.toast("No earlier sessions in this project");
        return;
      }
      this.loadPinned();
      for (const session of sessions) {
        session.current = session.path === this.sessionFile || (this.sessionId && session.id === this.sessionId);
      }
      sessions.sort((a, b) => Number(this.pinned.has(b.id)) - Number(this.pinned.has(a.id)));
      this.picker = {
        kind: "resume",
        title: "Resume a session",
        subtitle: `${sessions.length} in ${this.cwd}`,
        icon: "history",
        selected: sessions[0].id,
        items: sessions.slice(0, 40).map((session) => ({
          id: session.id,
          label: session.title || "(empty session)",
          badges: this.pinned.has(session.id) ? [{ text: "pinned", tone: "accent" }] : [],
          detail: session.preview
            ? `${session.preview.slice(0, 110)}${session.preview.length > 110 ? "…" : ""}`
            : `${session.when} · ${session.messages} messages · ${session.size}`,
          icon: "session",
          dot: session.current ? "success" : "muted",
        })),
        sessions,
        pinned: this.pinned,
      };
      this.schedule();
    } catch (error) {
      this.toast(`could not list sessions: ${error.message}`, "error");
    }
  }

  trustPath() {
    return join(configDir(), "trust.json");
  }

  trustDecision() {
    try {
      const data = JSON.parse(readFileSync(this.trustPath(), "utf8"));
      let current = resolve(this.cwd);
      while (true) {
        if (data[current] === true) return true;
        if (data[current] === false) return false;
        const parent = dirname(current);
        if (parent === current) return null;
        current = parent;
      }
    } catch {
      return null;
    }
  }

  openTrustPicker() {
    const decision = this.trustDecision();
    this.picker = {
      kind: "trust",
      title: "Project trust",
      subtitle: `${this.cwd} · ${decision === true ? "trusted" : decision === false ? "blocked" : "not set"}`,
      icon: "shield",
      selected: decision === false ? "off" : "on",
      items: [
        { id: "on", label: "Trust this project", detail: "allow project settings, extensions and packages", icon: "shield", dot: decision === true ? "success" : "muted" },
        { id: "off", label: "Do not trust", detail: "block project-local resources", icon: "shield-alert", dot: decision === false ? "error" : "muted" },
      ],
    };
    this.schedule();
  }

  applyTrust(decision) {
    try {
      let data = {};
      try { data = JSON.parse(readFileSync(this.trustPath(), "utf8")); } catch { data = {}; }
      data[resolve(this.cwd)] = decision === "on";
      mkdirSync(dirname(this.trustPath()), { recursive: true });
      writeFileSync(this.trustPath(), JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
      this.picker = null;
      this.toast(`Project trust ${decision === "on" ? "enabled" : "disabled"} · applies on next launch`);
      this.schedule();
    } catch (error) {
      this.toast(`trust update failed: ${error.message}`, "error");
    }
  }

  openSettingsPicker() {
    const onOff = (value) => (value ? "On" : "Off");
    this.picker = {
      kind: "settings",
      title: "Settings",
      subtitle: "pi session behavior",
      icon: "gear",
      selected: "auto-compaction",
      items: [
        { id: "auto-compaction", label: `Auto-compaction: ${onOff(this.conv.autoCompaction)}`, detail: "summarize when context is nearly full", icon: "compaction", dot: this.conv.autoCompaction ? "success" : "muted" },
        { id: "auto-retry", label: `Auto-retry: ${onOff(this.conv.autoRetry)}`, detail: "retry transient provider errors", icon: "repeat", dot: this.conv.autoRetry ? "success" : "muted" },
        { id: "steering-mode", label: `Steering: ${this.conv.steeringMode}`, detail: "delivery mode for steering messages", icon: "corner-down-right", dot: this.conv.steeringMode === "all" ? "success" : "muted" },
        { id: "follow-up-mode", label: `Follow-up: ${this.conv.followUpMode}`, detail: "delivery mode for follow-up messages", icon: "corner-down-right", dot: this.conv.followUpMode === "all" ? "success" : "muted" },
        { id: "model", label: "Model and thinking", detail: "use /model or /thinking", icon: "sparkles", dot: "muted" },
      ],
    };
    this.schedule();
  }

  async openSettingsChoice(id) {
    if (id === "model") {
      this.openModelPicker();
      return;
    }
    try {
      if (id === "auto-compaction") {
        const enabled = !this.conv.autoCompaction;
        await this.rpc.command("set_auto_compaction", { enabled }, 15000);
        this.conv.autoCompaction = enabled;
        this.toast(`Auto-compaction: ${enabled ? "On" : "Off"}`);
      } else if (id === "auto-retry") {
        const enabled = !this.conv.autoRetry;
        await this.rpc.command("set_auto_retry", { enabled }, 15000);
        this.conv.autoRetry = enabled;
        this.toast(`Auto-retry: ${enabled ? "On" : "Off"}`);
      } else if (id === "steering-mode") {
        const mode = this.conv.steeringMode === "all" ? "one-at-a-time" : "all";
        await this.rpc.command("set_steering_mode", { mode }, 15000);
        this.conv.steeringMode = mode;
        this.toast(`Steering: ${mode}`);
      } else if (id === "follow-up-mode") {
        const mode = this.conv.followUpMode === "all" ? "one-at-a-time" : "all";
        await this.rpc.command("set_follow_up_mode", { mode }, 15000);
        this.conv.followUpMode = mode;
        this.toast(`Follow-up: ${mode}`);
      }
      this.openSettingsPicker();
    } catch (error) {
      this.toast(`settings failed: ${error.message}`, "error");
    }
  }

  openModelPicker() {
    const models = this.models.map((model) => ({
      id: `${model.provider}/${model.id}`,
      label: model.name || model.id,
      detail: `${model.provider} · ${(model.contextWindow / 1000).toFixed(0)}k ctx${model.reasoning ? " · reasoning" : ""}`,
      icon: providerIcon(model.provider, model.id),
      dot: model.id === this.conv.model ? "success" : "muted",
      mono: true,
    }));
    if (!models.length) {
      this.toast("No models configured for pi");
      return;
    }
    this.picker = {
      kind: "model",
      title: "Switch model",
      subtitle: "applies to the running session",
      icon: providerIcon(this.conv.provider, this.conv.model),
      selected: this.models.find((model) => model.id === this.conv.model)
        ? `${this.models.find((model) => model.id === this.conv.model).provider}/${this.conv.model}`
        : models[0].id,
      items: models,
      models: this.models,
    };
    this.schedule();
  }

  openEffortPicker() {
    const levels = this.levels.length ? this.levels : ["off", "low", "medium", "high", "max"];
    this.picker = {
      kind: "effort",
      title: "Thinking effort",
      subtitle: "how long the model may think",
      icon: "gauge",
      selected: this.effort || this.conv.thinkingLevel,
      items: levels.map((level) => ({
        id: level,
        label: level === "max" ? "Max — deepest reasoning" : level === "high" ? "High — thorough" : level === "low" ? "Low — fast" : level,
        detail: level,
        dot: level === (this.effort || this.conv.thinkingLevel) ? "success" : "muted",
        mono: true,
      })),
      levels,
    };
    this.schedule();
  }

  openAgentsPicker() {
    const agents = this.conv.items.filter((item) => item.kind === "agent");
    if (!agents.length) {
      this.toast("No subagents yet in this session");
      return;
    }
    this.picker = {
      kind: "agents",
      title: "Subagents",
      subtitle: `${agents.length} in this session`,
      icon: "users",
      selected: agents[agents.length - 1].id,
      items: agents.map((item) => ({
        id: item.id,
        label: item.name || "Subagent",
        detail: `${item.agentType || "agent"} · ${item.agentStatus || item.status}${item.stats?.tools ? ` · ${item.stats.tools} tools` : ""}`,
        icon: "agent",
        dot: item.agentStatus === "running" ? "pending" : item.agentStatus === "failed" ? "error" : "success",
      })),
      agents,
    };
    this.schedule();
  }

  choosePicker() {
    const picker = this.picker;
    if (!picker) return;
    const selected = picker.selected || picker.items?.[0]?.id;
    this.picker = null;
    if (picker.kind === "model") {
      const model = picker.models?.find((entry) => `${entry.provider}/${entry.id}` === selected || entry.id === selected);
      if (model) this.applyModel(model);
    } else if (picker.kind === "effort") {
      this.setEffort(selected);
    } else if (picker.kind === "resume") {
      const session = picker.sessions?.find((entry) => entry.id === selected);
      if (session) this.resumeSession(session.path);
    } else if (picker.kind === "agents") {
      this.openAgentModal(selected);
    } else if (picker.kind === "copy" || picker.kind === "search") {
      const item = picker.texts?.find((entry) => entry.id === selected);
      if (item) this.copyText(item.text);
    } else if (picker.kind === "fork") {
      this.forkSession(selected);
    } else if (picker.kind === "tree") {
      this.useTreeEntry(selected, picker.entries);
    } else if (picker.kind === "settings") {
      this.openSettingsChoice(selected);
    } else if (picker.kind === "trust") {
      this.applyTrust(selected);
    }
    this.schedule();
  }

  async applyModel(model) {
    try {
      const data = await this.rpc.command("set_model", { provider: model.provider, modelId: model.id }, 20000);
      if (data?.id) {
        this.conv.model = data.id;
        this.conv.provider = data.provider || model.provider;
        this.conv.contextWindow = data.contextWindow || this.conv.contextWindow;
        this.toast(`Model: ${data.name || data.id}`);
      } else {
        const state = await this.rpc.command("get_state", {}, 10000);
        this.applyState(state);
        this.toast(`Model: ${this.conv.model}`);
      }
    } catch (error) {
      this.toast(`model switch failed: ${error.message}`, "error");
    }
    this.schedule();
  }

  cycleModel() {
    if (!this.models.length) return;
    const index = this.models.findIndex((model) => model.id === this.conv.model && (!model.provider || model.provider === this.conv.provider));
    const next = this.models[(Math.max(0, index) + 1) % this.models.length];
    if (next) this.applyModel(next);
  }

  setModelByQuery(query) {
    const needle = query.toLowerCase();
    const model = this.models.find((entry) => entry.id.toLowerCase().includes(needle) || (entry.name || "").toLowerCase().includes(needle));
    if (!model) {
      this.toast(`No model matching "${query}"`, "warning");
      return;
    }
    this.applyModel(model);
  }

  async setEffort(level) {
    try {
      await this.rpc.command("set_thinking_level", { level }, 15000);
      this.effort = level;
      this.conv.thinkingLevel = level;
      this.toast(`Thinking effort: ${level}`);
      const state = await this.rpc.command("get_state", {}, 10000);
      this.applyState(state);
    } catch (error) {
      this.toast(`effort switch failed: ${error.message}`, "error");
    }
    this.schedule();
  }

  async resumeSession(path) {
    try {
      await this.rpc.command("switch_session", { sessionPath: path }, 25000);
      const messages = await this.rpc.command("get_messages", {}, 20000);
      this.conv.loadMessages(messages.messages || []);
      const state = await this.rpc.command("get_state", {}, 10000);
      this.applyState(state);
      this.toast("Session resumed");
    } catch (error) {
      this.toast(`resume failed: ${error.message}`, "error");
    }
    this.schedule();
  }

  async compactNow() {
    this.toast("Compacting…");
    try {
      const result = await this.rpc.command("compact", {}, 120000);
      const after = await this.rpc.command("get_messages", {}, 15000);
      this.conv.loadMessages(after.messages || []);
      if (result?.summary && !this.conv.items.some((item) => item.kind === "compaction")) {
        this.conv.addSummary("compaction", {
          summary: result.summary,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.estimatedTokensAfter,
          timestamp: Date.now(),
        });
      }
      this.toast(`Compacted to ${humanTokens(result.estimatedTokensAfter || 0)} tokens`);
    } catch (error) {
      this.toast(`compact failed: ${error.message}`, "error");
    }
    this.schedule();
  }

  attach(path) {
    if (!path) {
      this.toast("usage: /attach <path to image>");
      return;
    }
    const full = isAbsolute(path) ? path : resolve(this.cwd, path);
    if (!existsSync(full)) {
      this.toast(`not found: ${path}`, "warning");
      return;
    }
    const ext = extname(full).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) {
      this.toast("only png/jpg/gif/webp can be attached", "warning");
      return;
    }
    const data = readFileSync(full).toString("base64");
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/png";
    this.attachments.push({ type: "image", data, mimeType: mime, name: basename(full) });
    this.toast(`Attached ${basename(full)} (${this.attachments.length} queued)`);
    this.schedule();
  }

  showHelp() {
    this.picker = {
      kind: "help",
      title: "pi-tsp keys",
      subtitle: `build ${BUILD}`,
      icon: "keyboard",
      selected: "enter",
      items: [
        { id: "enter", label: "Enter", detail: "send the message; when the slash menu is open, run the highlighted command" },
        { id: "shiftenter", label: "Shift+Enter", detail: "insert a newline" },
        { id: "slash", label: "/", detail: "command menu: local commands plus pi's extensions, skills and prompts" },
        { id: "at", label: "@", detail: "file completion in the composer" },
        { id: "tab", label: "Tab", detail: "complete the highlighted command or @file" },
        { id: "esc", label: "Esc", detail: "close a modal, dismiss the menu, or interrupt a run" },
        { id: "ctrld", label: "Ctrl+D", detail: "delete the selected session from /resume (confirmation required)" },
        { id: "ctrl-c", label: "Ctrl+C", detail: "interrupt a run, or clear the draft" },
        { id: "up", label: "↑ / ↓", detail: "history when the menu is closed" },
      ],
      help: true,
    };
    this.schedule();
  }

  openAgentModal(idOrPrefix) {
    const agent = this.conv.items.find((item) => item.kind === "agent" && (item.id === idOrPrefix || item.id.startsWith(idOrPrefix)));
    if (!agent) return;
    this.agentModal = { item: agent, nodes: [], loading: true };
    this.loadAgentTranscript(agent);
    this.schedule();
  }

  async loadAgentTranscript(agent) {
    const path = agent.transcriptPath;
    if (!path || !existsSync(path)) {
      this.agentModal.nodes = [spans("No transcript file for this subagent.", "muted")];
      this.agentModal.loading = false;
      this.schedule();
      return;
    }
    try {
      const records = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);
      this.agentModal.nodes = this.transcriptNodes(records, agent);
      this.agentModal.loading = false;
    } catch (error) {
      this.agentModal.nodes = [spans(`could not read transcript: ${error.message}`, "error")];
      this.agentModal.loading = false;
    }
    this.schedule();
  }

  transcriptNodes(records, agent) {
    const nodes = [];
    let index = 0;
    let lastUser = "";
    const toolNames = new Map();
    const cleanUserText = (text) => String(text || "")
      .split("\n")
      .filter((line) => !/^\s*(Output:|This path is authoritative|Ignore any other output|\[prompt redacted\]|live Prompt Audit only)/i.test(line))
      .join("\n")
      .trim();
    for (const record of records) {
      if (record.recordType === "tool_start") {
        toolNames.set(record.toolCallId, record);
        continue;
      }
      if (record.recordType === "tool_end") {
        const start = toolNames.get(record.toolCallId);
        const id = `am.t${index++}`;
        nodes.push({
          id,
          k: "tool",
          p: {
            name: start?.toolName || "tool",
            title: spans(start?.toolName ? `${start.toolName}` : "Tool"),
            target: start?.argsPreview ? spans(String(start.argsPreview).slice(0, 160)) : undefined,
            status: record.isError ? "error" : "done",
            frame: "inline",
            collapsible: false,
          },
        });
        continue;
      }
      const message = record.message;
      if (!message) continue;
      if (message.role === "user") {
        const text = cleanUserText(typeof message.content === "string"
          ? message.content
          : (message.content || []).filter((block) => block.type === "text").map((block) => block.text).join("\n"));
        if (!text || text === lastUser) continue;
        lastUser = text;
        nodes.push({ id: `am.u${index++}`, k: "md", p: { text } });
        continue;
      }
      if (message.role === "assistant") {
        for (const block of message.content || []) {
          if (block.type === "thinking") {
            nodes.push({
              id: `am.th${index++}`,
              k: "section",
              p: { head: [{ t: "Thought", s: "muted" }], collapsible: true, collapsed: true },
              c: [{ id: `am.th${index}b`, k: "md", p: { text: block.thinking || "" } }],
            });
          } else if (block.type === "text") {
            if (block.text?.trim()) nodes.push({ id: `am.a${index++}`, k: "md", p: { text: block.text } });
          }
          // Tool calls are rendered from tool_start/tool_end records; rendering the
          // assistant's toolCall blocks too would duplicate every command.
        }
      }
      if (message.role === "toolResult") {
        const text = (message.content || []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
        if (text) nodes.push({ id: `am.r${index++}`, k: "code", p: { text: text.slice(0, 4000), wrap: true } });
      }
    }
    if (agent?.model) nodes.unshift({ id: "am.meta", k: "text", p: { spans: [{ t: `${agent.agentType || "agent"} · ${agent.model}${agent.thinking ? ` · ${agent.thinking}` : ""}`, s: "muted" }] } });
    return nodes;
  }

  answerApproval(choice) {
    const approval = this.approval;
    if (!approval) return;
    this.approval = null;
    const normalized = String(choice || "").toLowerCase();
    if (approval.method === "confirm") {
      const confirmed = ["once", "allow", "allow once", "yes", "true"].includes(normalized);
      this.rpc.respondExtensionUi(approval.id, { confirmed });
    } else {
      const options = approval.options || [];
      const value = options.find((option) => option.toLowerCase() === normalized) || options[0];
      this.rpc.respondExtensionUi(approval.id, { value });
    }
    this.schedule();
  }

  complete() {
    const menu = this.currentMenu();
    if (menu?.items?.length) {
      const item = menu.items[Math.min(this.menuSelected, menu.items.length - 1)];
      this.composer.set(`/${item.name} `);
      this.schedule();
      return;
    }
    const text = this.composer.text;
    const match = text.match(/@([\w./-]*)$/);
    if (match) {
      const query = match[1];
      const base = query.includes("/") ? join(this.cwd, dirname(query)) : this.cwd;
      try {
        const entries = readdirSync(base, { withFileTypes: true })
          .filter((entry) => entry.name.startsWith(basename(query)) && entry.name !== ".git")
          .slice(0, 8);
        if (entries.length) {
          const chosen = entries[0];
          const replacement = `${dirname(query) === "." ? "" : `${dirname(query)}/`}${chosen.name}${chosen.isDirectory() ? "/" : ""}`;
          this.composer.set(text.slice(0, match.index) + "@" + replacement);
          this.schedule();
        }
      } catch {
        /* no completion */
      }
    }
  }

  schedule() {
    if (this.closed) return;
    this.dirty = true;
    // Paint the first token immediately instead of waiting for the 16 ms
    // frame slot; that is the latency the user perceives as TTFT.
    if (this.conv.busy && this.conv.turnFirstTokenAt && !this.firstTokenPainted) {
      this.firstTokenPainted = true;
      this.renderNow();
      return;
    }
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      if (this.dirty) this.renderNow();
    }, 16);
  }

  context() {
    const menu = this.currentMenu();
    const current = this.models.find((model) =>
      model.id === this.conv.model &&
      (!this.conv.provider || !model.provider || model.provider === this.conv.provider),
    ) || this.models.find((model) => model.id === this.conv.model);
    return {
      model: this.conv.model,
      provider: this.conv.provider,
      modelLabel: fmtModel(current?.name || this.conv.model || "") || fmtModel(this.conv.model || ""),
      effort: this.effort,
      compact: this.compact,
      kinds: this.kinds,
      cwd: this.cwd,
      contextTokens: this.conv.contextTokens,
      contextWindow: this.conv.contextWindow,
      cost: this.conv.cost,
      tokPerSec: this.conv.busy ? this.conv.lastTokPerSec : this.conv.lastTokPerSec,
      turnMs: this.conv.lastTurnMs,
      turnTokens: this.conv.lastTurnTokens,
      expandAll: this.expandAll,
      hideThinking: this.hideThinking,
      toasts: this.toasts,
      statusExtra: [...this.statusExtras.values()].at(-1) || "",
      composer: this.composer,
      attachments: this.attachments,
      queue: this.conv.queue,
      menu,
      picker: this.picker,
      approval: this.approval,
      agentModal: this.agentModal,
      fieldDialog: this.fieldDialog,
      toast: this.toasts.at(-1),
      blobFor: (data, mime) => this.blobFor(data, mime),
    };
  }

  blobFor(data, mime) {
    if (!data) return null;
    const key = `${mime}:${data.length}:${data.slice(0, 40)}`;
    if (this.blobCache.has(key)) return this.blobCache.get(key);
    const id = this.link.blob(Buffer.from(data, "base64"), mime || "image/png");
    this.blobCache.set(key, id);
    return id;
  }

  imageFor(path) {
    if (!path || !existsSync(path)) return null;
    try {
      const stat = statSync(path);
      const key = `${path}:${stat.mtimeMs}`;
      const cached = this.imageCache.get(key);
      if (cached) return cached;
      const bytes = readFileSync(path);
      const ext = extname(path).toLowerCase();
      const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/png";
      const id = this.link.blob(bytes, mime);
      this.imageCache.set(key, id);
      return id;
    } catch {
      return null;
    }
  }

  renderNow() {
    const started = performance.now();
    const view = buildView(this.conv, this.context());
    this.doc.setRegions(view);
    if (this.conv.busy || this.conv.items.length !== this.lastItemCount) {
      this.lastItemCount = this.conv.items.length;
      this.doc.reveal("tail", "end");
    }
    this.dirty = false;
    this.renderCount += 1;
    const elapsed = performance.now() - started;
    this.renderMs += elapsed;
    if (elapsed > 8 && process.env.PI_TSP_TRACE) this.trace(`render ${elapsed.toFixed(1)}ms`);
  }

  trace(line) {
    if (!process.env.PI_TSP_TRACE) return;
    try {
      const { appendFileSync } = process.getBuiltinModule("node:fs");
      appendFileSync(process.env.PI_TSP_TRACE, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* best effort */
    }
  }

  async shutdown(reason) {
    if (this.stopping) return;
    this.stopping = true;
    this.closed = true;
    clearTimeout(this.renderTimer);
    try {
      this.rpc?.stop();
    } catch {
      /* gone */
    }
    try {
      this.link.close(SURFACE, true);
    } catch {
      /* gone */
    }
    setTimeout(() => process.exit(0), 120);
  }
}
