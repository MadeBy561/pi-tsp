/**
 * The controller: pi's RPC session on one side, a Tern surface on the other.
 * It owns input focus (composer, picker, dialog, sheet), runs commands and
 * redraws the view from state.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Node as TernNode, type Key, type Session, type Surface, type TspEvent } from "@stencil-hq/tern";
import { transcriptNodes, transcriptPath } from "./agents.js";
import { isImagePath, readClipboardFilePaths, readClipboardImage, readClipboardText, readImageFile } from "./clipboard.js";
import { TextEditor } from "./editor.js";
import { FileIndex } from "./files.js";
import { rank } from "./fuzzy.js";
import { Keymap, type Action } from "./keymap.js";
import { Conversation, modelLabel, type Item } from "./model.js";
import { stockPath, toolNamesInSource, toolNamesRegisteredUnder } from "./paths.js";
import { Picker, type PickerOptions } from "./picker.js";
import { providerIcon } from "./provider.js";
import { BlockRegion } from "./region.js";
import { PiRpc } from "./rpc.js";
import { installSplice } from "./splice.js";
import { Vim } from "./vim.js";
import { listSessions, type SessionRow } from "./sessions.js";
import { configDir, piTspHome, sessionDir } from "./setup.js";
import { dock, EDITOR_ID, errorBanner, rewindPanel, type Attachment, type DockActions, type DockState } from "./view/dock.js";
import { clock, duration, firstLine, h, money, s, showPath, tokens, type EditEvent, type Node, type ViewCtx } from "./view/h.js";
import { approvalPanel, completionPopup, fieldDialog, fieldInputId, pickerNode, prefsNode, sheet, toastNodes, type Completion, type PickerItem, type PrefsRow, type Toast } from "./view/overlays.js";
import { planNode, TIPS, TranscriptView, welcome } from "./view/transcript.js";

export const VERSION: string = (() => {
  try {
    return String((JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

/** pi's mark: a rounded tile with the letter drawn as shapes, so no font is needed. */
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#1f6f6b"/><g fill="#fff"><rect x="28" y="38" width="72" height="12" rx="6"/><rect x="42" y="38" width="12" height="54" rx="6"/><path d="M74 38h12v40c0 4 2 6 6 6h2a6 6 0 0 1 0 12h-4c-10 0-16-6-16-16z"/></g></svg>`;

/** The surface's own styles: only what Tern's built-in roles do not cover. */
const STYLESHEET = `
[data-role="pi.widget"] { opacity: 0.85; }
`;

const META_AS_CTRL = process.env.PI_TSP_META_AS_CTRL === "1";

interface ModelInfo {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  cost?: { input?: number; output?: number };
}

interface Command {
  name: string;
  description: string;
  icon: string;
  /** Shown at the row's end: the current value. */
  value?: () => string;
  /** A local command; absent for the ones pi runs itself. */
  run?: (args: string) => void | Promise<void>;
}

interface Approval {
  id: string;
  method: "select" | "confirm";
  title: string;
  details: string[];
  choices: { id: string; label: string; deny: boolean }[];
  selected: string;
  expanded: boolean;
  deadline?: number;
  timer?: NodeJS.Timeout;
}

interface Field {
  id: string | null;
  title: string;
  detail: string;
  placeholder: string;
  multiline: boolean;
  editor: TextEditor;
  deadline?: number;
  timer?: NodeJS.Timeout;
  done(value: string | null): void;
}

interface Sheet {
  id: string;
  head: string;
  size: "sm" | "md" | "lg" | "full";
  body(): (Node | null)[];
  extra?: () => (Node | null)[];
}

interface Prefs {
  page: string;
  focus: string | null;
}

/** The user messages that can be forked from, and which one is chosen. */
interface RewindState {
  entries: { entryId: string; item: Item }[];
  at: number;
}

interface CompletionState {
  kind: "command" | "file";
  /** Where the completed token starts in the draft. */
  from: number;
  items: Completion[];
  selected: number;
}

const EFFORT_DETAIL: Record<string, string> = {
  off: "No extended thinking",
  minimal: "The least thinking the model allows",
  low: "Fast, for simple edits",
  medium: "Balanced",
  high: "Thorough",
  xhigh: "Very thorough, slower",
  max: "The deepest reasoning, slowest",
};

export interface AppOptions {
  session: Session;
  args: string[];
  cwd: string;
}

export class App {
  readonly conv = new Conversation();
  readonly editor = new TextEditor();
  #session: Session;
  #surface: Surface;
  #rpc!: PiRpc;
  #args: string[];
  #cwd: string;
  #transcript = new TranscriptView();
  /** The transcript region, reconciled block by block instead of through the SDK's whole-view diff. */
  #main = new BlockRegion("main");
  #files: FileIndex;
  #models: ModelInfo[] = [];
  #model: ModelInfo | null = null;
  #levels: string[] = [];
  #remote: Command[] = [];
  #sessionId = "";
  #sessionFile = "";
  #piVersion = "";
  #tip = TIPS[Math.floor(Math.random() * TIPS.length)] ?? "";
  #starting = true;
  #stopping = false;
  #visible = true;
  // Display state.
  #fold = new Map<string, boolean>();
  #foldRev = 0;
  #expandAll = false;
  #hideThinking = false;
  #showImages = true;
  #showUsage = false;
  #vimKeys = false;
  #vim = new Vim(this.editor);
  /** A rewind point is being chosen: the user messages that can be forked from, and which one. */
  #rewind: RewindState | null = null;
  /** The pinned error: which error row it shows, and whether it is opened or dismissed. */
  #banner = { id: "", expanded: false, dismissed: false };
  // Focus owners, innermost first: sheet, prefs, picker, field, approval, composer.
  #picker: Picker | null = null;
  #approvals: Approval[] = [];
  #field: Field | null = null;
  #sheet: Sheet | null = null;
  #prefs: Prefs | null = null;
  #completion: CompletionState | null = null;
  #completionDismissed = "";
  #attachments: Attachment[] = [];
  #statuses = new Map<string, string>();
  #widgets = new Map<string, { lines: string[]; below: boolean }>();
  #toasts: Toast[] = [];
  #toastSeq = 0;
  #blobs = new WeakMap<object, string>();
  #renderTimer: NodeJS.Timeout | null = null;
  #tick: NodeJS.Timeout | null = null;
  #focus: string | null | undefined;
  #lastCtrlC = 0;
  #resyncAt = 0;
  #blockedSince = 0;
  #keymap = Keymap.load(configDir());
  #lastError = "";
  /** A run ended: after the next frame, tell Tern its blocks are final. */
  #settlePending = false;
  #settled = new Set<string>();

  constructor(options: AppOptions) {
    this.#session = options.session;
    this.#args = options.args;
    this.#cwd = options.cwd;
    this.#files = new FileIndex(options.cwd);
    installSplice();
    this.#surface = this.#session.open({ id: "pi", mode: "inline", title: "pi", role: "omp.session", font: "sans" });
    if (this.#session.caps.features.includes("styles")) this.#surface.stylesheet("pi-tsp", STYLESHEET);
    this.#loadHistory();
    this.#loadDisplay();
    this.#vim.reset();
  }

  // ───────────────────────────────────────────────────────────── lifecycle

  /** Runs until the user quits or pi cannot be started. */
  async run(): Promise<number> {
    this.render();
    this.#startRpc();
    for await (const input of this.#session) {
      try {
        if (input.type === "key") await this.#onKey(input.key);
        else this.#onEvent(input.event);
      } catch (error) {
        this.toast(`pi-tsp: ${(error as Error).message}`, "error");
      }
      this.schedule();
      if (this.#stopping) break;
    }
    return 0;
  }

  #extensionPaths(): string[] {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "ext");
    const ours = ["permissions.ts", "plan.ts", "todo.ts", "tree.ts"].map(name => join(root, name)).filter(path => existsSync(path));
    // pi treats a duplicate tool name as an extension load error that ends the
    // session, so an extension of ours steps aside when the user's config
    // already registers one of its tools.
    const roots = [join(this.#cwd, ".pi", "extensions"), join(configDir(), "extensions")];
    const args = [...this.#args, ...(process.env.PI_TSP_EXTRA_ARGS?.split(" ").filter(Boolean) ?? [])];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === "--extension" && args[index + 1]) roots.push(resolve(this.#cwd, args[++index]!));
      else if (arg.startsWith("--extension=")) roots.push(resolve(this.#cwd, arg.slice("--extension=".length)));
    }
    const taken = toolNamesRegisteredUnder(roots);
    if (!taken.size) return ours;
    return ours.filter(path => {
      try {
        return ![...toolNamesInSource(readFileSync(path, "utf8"))].some(name => taken.has(name));
      } catch {
        return true;
      }
    });
  }

  #startRpc(): void {
    const bin = stockPath();
    const args = ["--mode", "rpc", "--session-dir", sessionDir(), ...this.#extensionPaths().flatMap(path => ["--extension", path]), ...this.#args, ...(process.env.PI_TSP_EXTRA_ARGS?.split(" ").filter(Boolean) ?? [])];
    this.#rpc = new PiRpc({ bin, args, cwd: this.#cwd, env: { PI_CODING_AGENT_DIR: configDir() } });
    this.#rpc.on("event", (record: Record<string, any>) => this.#onRpc(record));
    this.#rpc.on("error", (error: NodeJS.ErrnoException) => {
      this.#fatal(error.code === "ENOENT" ? `Could not run pi at ${bin}. Install pi on PATH or set PI_TSP_PI.` : `pi failed to start: ${error.message}`);
    });
    this.#rpc.on("exit", ({ code, signal }: { code: number | null; signal: string | null }) => {
      if (this.#stopping) return;
      const tail = this.#rpc.stderr.trim().slice(-1200);
      this.#fatal(`pi exited (${signal ?? code})${tail ? `\n\n${tail}` : ""}`);
    });
    execFile(bin, ["--version"], { timeout: 4000 }, (error, stdout, stderr) => {
      if (!error) this.#piVersion = (stdout || stderr).trim().split(/\s+/).at(-1) ?? "";
      this.schedule();
    });
    void this.#load();
  }

  #fatal(message: string): void {
    this.conv.busy = false;
    this.conv.retry = null;
    if (this.#lastError !== message) {
      this.#lastError = message;
      this.conv.add({ kind: "notice", text: message, tone: "error" }, "n");
    }
    this.#starting = false;
    this.schedule();
  }

  async #load(): Promise<void> {
    try {
      await this.#refreshState(15_000);
    } catch (error) {
      if (!this.#rpc.exited) this.#fatal(`pi did not answer: ${(error as Error).message}`);
      return;
    }
    const [models, levels, commands, messages] = await Promise.all([
      this.#rpc.command("get_available_models").catch(() => ({ models: [] })),
      this.#rpc.command("get_available_thinking_levels").catch(() => ({ levels: [] })),
      this.#rpc.command("get_commands").catch(() => ({ commands: [] })),
      this.#rpc.command("get_messages").catch(() => ({ messages: [] })),
    ]);
    this.#models = models.models ?? [];
    this.#levels = levels.levels ?? [];
    this.#remote = ((commands.commands ?? []) as any[]).map(command => ({
      name: String(command.name),
      description: String(command.description ?? ""),
      icon: command.source === "skill" ? "sparkles" : command.source === "prompt" ? "message" : "package",
    }));
    this.conv.loadMessages(messages.messages ?? []);
    await this.#refreshStats();
    // Startup is over: Tern now sends what it kept while the composer was not ready.
    this.#starting = false;
    this.schedule();
  }

  async #refreshState(timeout = 30_000): Promise<void> {
    const state = await this.#rpc.command("get_state", {}, timeout);
    this.#model = state.model ?? null;
    this.conv.model = state.model?.id ?? "";
    this.conv.provider = state.model?.provider ?? "";
    this.conv.contextWindow = state.model?.contextWindow ?? this.conv.contextWindow;
    this.conv.thinkingLevel = state.thinkingLevel ?? "";
    this.conv.sessionName = state.sessionName ?? "";
    this.conv.autoCompaction = state.autoCompactionEnabled !== false;
    this.conv.steeringMode = state.steeringMode ?? this.conv.steeringMode;
    this.conv.followUpMode = state.followUpMode ?? this.conv.followUpMode;
    this.conv.busy = Boolean(state.isStreaming);
    this.conv.compacting = Boolean(state.isCompacting);
    this.#sessionId = state.sessionId ?? "";
    this.#sessionFile = state.sessionFile ?? "";
    this.conv.touch();
  }

  async #refreshStats(): Promise<void> {
    try {
      const stats = await this.#rpc.command("get_session_stats");
      this.conv.cost = stats.cost ?? this.conv.cost;
      const usage = stats.contextUsage;
      if (usage?.contextWindow) this.conv.contextWindow = usage.contextWindow;
      if (typeof usage?.tokens === "number") this.conv.contextTokens = usage.tokens;
      this.conv.touch();
      this.schedule();
    } catch {
      /* stats are a nicety */
    }
  }

  async #reload(): Promise<void> {
    await this.#refreshState();
    const messages = await this.#rpc.command("get_messages");
    this.conv.loadMessages(messages.messages ?? []);
    this.#fold.clear();
    this.#foldRev += 1;
    await this.#refreshStats();
  }

  async quit(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    if (this.#tick) clearInterval(this.#tick);
    if (this.#renderTimer) clearTimeout(this.#renderTimer);
    this.#saveHistory();
    for (const approval of this.#approvals) clearTimeout(approval.timer);
    await Promise.race([this.#rpc.stop(), new Promise(done => setTimeout(done, 2500))]);
    await this.#session.close();
  }

  // ───────────────────────────────────────────────────────────── pi events

  #onRpc(record: Record<string, any>): void {
    if (record.type === "extension_ui_request") {
      this.#onExtensionUi(record);
      this.schedule();
      return;
    }
    if (record.type === "extension_error") {
      this.toast(`Extension error in ${firstLine(record.extensionPath, 60)}: ${firstLine(record.error, 160)}`, "error");
      return;
    }
    const wasBusy = this.conv.busy;
    this.conv.onEvent(record);
    if (record.type === "agent_settled" || record.type === "turn_end" || record.type === "compaction_end") void this.#refreshStats();
    if (record.type === "agent_settled") this.#settlePending = true;
    if (record.type === "agent_settled" && wasBusy && !this.#visible) this.#notify("pi is done", firstLine(this.conv.lastAnswer(), 120));
    if (record.type === "compaction_end" && !record.errorMessage) void this.#reload().then(() => this.schedule());
    this.schedule();
  }

  #onExtensionUi(request: Record<string, any>): void {
    switch (request.method) {
      case "notify":
        this.toast(String(request.message ?? ""), request.notifyType === "error" ? "error" : request.notifyType === "warning" ? "warning" : "info");
        return;
      case "setStatus":
        if (request.statusText) this.#statuses.set(String(request.statusKey), String(request.statusText));
        else this.#statuses.delete(String(request.statusKey));
        return;
      case "setWidget": {
        const key = String(request.widgetKey);
        const lines: string[] = Array.isArray(request.widgetLines) ? request.widgetLines.map(String) : [];
        // pi-subagents reports its background runs through a widget made of one JSON line.
        const snapshot = lines.find(line => line.startsWith("PI_SUBAGENT_ASYNC_JSON:"));
        if (snapshot) {
          try {
            this.conv.applySubagentSnapshot(JSON.parse(snapshot.slice("PI_SUBAGENT_ASYNC_JSON:".length)));
          } catch {
            /* a malformed snapshot is skipped */
          }
          return;
        }
        if (lines.some(line => line.startsWith("PI_SUBAGENT_INSPECT_JSON:"))) return;
        if (lines.length) this.#widgets.set(key, { lines, below: request.widgetPlacement === "belowEditor" });
        else this.#widgets.delete(key);
        return;
      }
      case "setTitle":
        return;
      case "set_editor_text":
      case "setEditorText":
        if (typeof request.text === "string") this.editor.set(request.text);
        return;
      case "select":
      case "confirm":
        this.#ask(request);
        return;
      case "input":
      case "editor":
        this.#openField({
          id: String(request.id),
          title: String(request.title || (request.method === "editor" ? "Edit text" : "Input")),
          placeholder: String(request.placeholder ?? ""),
          multiline: request.method === "editor",
          text: String(request.prefill ?? ""),
          timeout: request.timeout,
          done: value => this.#rpc.respondExtensionUi(String(request.id), value === null ? { cancelled: true } : { value }),
        });
        return;
      default:
        // An unknown dialog is cancelled so the agent never waits on it.
        if (request.id) this.#rpc.respondExtensionUi(String(request.id), { cancelled: true });
    }
  }

  /**
   * An extension's `select` or `confirm`. One whose options are an allow/deny
   * set is a tool approval and gets the approval panel above the composer;
   * any other is a picker of its options.
   */
  #ask(request: Record<string, any>): void {
    const id = String(request.id);
    const lines = String(request.title ?? "").split("\n");
    const title = lines[0]?.trim() || (request.method === "confirm" ? "Confirm" : "Select");
    const details = [...lines.slice(1), ...(request.message ? String(request.message).split("\n") : [])].map(line => line.replace(/\s+$/, ""));
    while (details.length && !details.at(-1)) details.pop();
    const options: string[] = request.method === "confirm" ? ["Yes", "No"] : (Array.isArray(request.options) ? request.options.map(String) : []);
    const isDeny = (label: string): boolean => /^(deny|no|reject|cancel|block)\b/i.test(label);
    const approval = options.length >= 2 && options.length <= 5 && options.some(isDeny) && options.some(label => /^(allow|approve|yes|always)\b/i.test(label));
    if (approval) {
      const entry: Approval = {
        id,
        method: request.method,
        title,
        details,
        choices: options.map((label, index) => ({ id: `c${index}`, label, deny: isDeny(label) })),
        selected: "c0",
        expanded: false,
      };
      if (Number(request.timeout) > 0) {
        entry.deadline = Date.now() + Number(request.timeout);
        entry.timer = setTimeout(() => this.#answerApproval(entry, null), Number(request.timeout));
      }
      this.#approvals.push(entry);
      if (!this.#visible) this.#notify("pi needs your approval", title);
      return;
    }
    this.#openPicker({
      props: { title, ...(details.length ? { subtitle: details.join("\n") } : {}), noun: "options", size: "md", layout: "rows", preview: "none" },
      items: options.map((label, index) => ({ id: String(index), label })),
      actions: [
        { id: "confirm", label: "Select", keys: ["enter"], primary: true },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      empty: "No matching options",
      choose: (choice, picker) => {
        picker.options.cancel = undefined;
        this.#picker = null;
        this.#rpc.respondExtensionUi(id, { value: options[Number(choice)] ?? "" });
      },
      cancel: () => this.#rpc.respondExtensionUi(id, { cancelled: true }),
    });
  }

  /** Answers an approval with one of its choices, or cancels it with `null`. */
  #answerApproval(approval: Approval, choiceId: string | null): void {
    const at = this.#approvals.indexOf(approval);
    if (at < 0) return;
    this.#approvals.splice(at, 1);
    clearTimeout(approval.timer);
    const choice = approval.choices.find(entry => entry.id === choiceId);
    if (!choice) this.#rpc.respondExtensionUi(approval.id, { cancelled: true });
    else if (approval.method === "confirm") this.#rpc.respondExtensionUi(approval.id, { confirmed: !choice.deny });
    else this.#rpc.respondExtensionUi(approval.id, { value: choice.label });
    this.schedule();
  }

  // ───────────────────────────────────────────────────────────── rendering

  /**
   * Tern paces frames by acknowledging them. If an acknowledgement is lost
   * the surface would wait for it forever, so after five seconds of waiting
   * the outstanding frames are taken as received and drawing goes on.
   */
  #unstall(): void {
    if (!this.#surface.blocked) {
      this.#blockedSince = 0;
      return;
    }
    this.#blockedSince ||= Date.now();
    if (Date.now() - this.#blockedSince < 5000) return;
    this.#blockedSince = 0;
    this.#surface.acknowledge(this.#surface.seq);
  }

  /** Redraws soon; many changes in one tick make one frame. */
  schedule(): void {
    this.#unstall();
    if (this.#renderTimer || this.#stopping) return;
    this.#renderTimer = setTimeout(() => {
      this.#renderTimer = null;
      this.render();
    }, 16);
  }

  #blob = (image: { data?: string; mimeType?: string }): string | undefined => {
    if (!image?.data || !this.#session.caps.features.includes("blobs")) return undefined;
    const known = this.#blobs.get(image);
    if (known) return known;
    try {
      const id = this.#session.blob(Buffer.from(image.data, "base64"), image.mimeType || "image/png");
      this.#blobs.set(image, id);
      return id;
    } catch {
      return undefined;
    }
  };

  #logoBlob: string | undefined;
  /** The two spacers around the welcome block: the same nodes every frame. */
  #mainHead = { top: h("spacer", { key: "top", size: "sm" }), gap: h("spacer", { key: "gap", size: "sm" }) };
  #welcomeNode: { sig: string; node: Node } | null = null;

  #logo(): string | undefined {
    if (!this.#session.caps.features.includes("blobs")) return undefined;
    try {
      this.#logoBlob ??= this.#session.blob(Buffer.from(LOGO_SVG, "utf8"), "image/svg+xml");
    } catch {
      return undefined;
    }
    return this.#logoBlob;
  }

  #welcome(): Node {
    const logo = this.#logo();
    const sig = `${this.#piVersion}|${logo}`;
    if (this.#welcomeNode?.sig !== sig) this.#welcomeNode = { sig, node: welcome({ version: VERSION, piVersion: this.#piVersion, tip: this.#tip, logo }) };
    return this.#welcomeNode.node;
  }

  #viewCtx(): ViewCtx {
    return {
      cwd: this.#cwd,
      kinds: new Set(this.#session.caps.kinds),
      hour12: this.#session.caps.hour12,
      expandAll: this.#expandAll,
      hideThinking: this.#hideThinking,
      showImages: this.#showImages,
      showUsage: this.#showUsage,
      awaitingApproval: this.#approvals.length > 0,
      fold: this.#fold,
      foldRev: this.#foldRev,
      blob: this.#blob,
      on: {
        toggle: (id, collapsed) => {
          this.#fold.set(id, collapsed);
          this.#foldRev += 1;
          this.schedule();
        },
        copy: (text, what) => this.copy(text, what),
        rewind: item => void this.#rewindTo(item),
        editTurn: item => {
          this.editor.set(item.text);
          this.toast("Message copied to the composer");
        },
        retry: () => void this.#retry(),
        pickModel: () => this.#pickModel(),
        openAgent: item => this.#openAgent(item),
        open: () => undefined,
      },
    };
  }

  #activity(): string {
    for (let index = this.conv.items.length - 1; index >= 0; index -= 1) {
      const item = this.conv.items[index]!;
      if (item.kind === "user") break;
      if (item.kind === "agent" && (item.agentStatus === "running" || item.agentStatus === "pending")) return `Running ${item.agentType || "a subagent"}`;
      if (item.kind === "tool" && (item.status === "running" || item.status === "pending")) {
        const name = String(item.name || "tool").toLowerCase();
        const args = item.args || {};
        const what = firstLine(args.description ?? args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query ?? "", 70);
        const verb: Record<string, string> = { bash: "Running", read: "Reading", edit: "Editing", write: "Writing", grep: "Searching", find: "Finding", ls: "Listing", todo: "Tracking the work" };
        return [verb[name] ?? `Running ${name}`, name === "todo" ? "" : showPath(what, this.#cwd)].filter(Boolean).join(" ");
      }
      if (item.kind === "thinking" && item.status === "running") return "Thinking";
      if (item.kind === "assistant" && item.status === "running") return "Writing";
    }
    return this.conv.shell ? `Running ${firstLine(this.conv.shell.text, 60)}` : "Working";
  }

  #dockState(): DockState {
    return {
      editor: this.editor,
      attachments: this.#attachments,
      vimMode: this.#vimKeys ? this.#vim.label : "",
      drawn: this.#vimKeys ? this.#vim.drawn() : null,
      modelName: this.#model?.name || modelLabel(this.conv.model),
      modelIcon: providerIcon(this.conv.provider, this.conv.model),
      effort: this.conv.thinkingLevel,
      reasoning: this.#model?.reasoning !== false && this.#levels.length > 1,
      statuses: this.#statuses,
      widgets: this.#widgets,
      blocked: Boolean(this.#picker || this.#approvals.length || this.#field || this.#sheet || this.#prefs || this.#rewind),
      starting: this.#starting,
      activity: this.#activity(),
      blob: this.#blob,
    };
  }

  #dockActions(): DockActions {
    return {
      submit: () => void this.#submit(),
      interrupt: () => void this.#interrupt(),
      pickModel: () => this.#pickModel(),
      cycleEffort: () => void this.#cycleEffort(),
      showContext: () => this.#showContext(),
      showSession: () => this.#showSession(),
      dequeue: () => void this.#dequeue(),
      detach: index => {
        this.#attachments.splice(index, 1);
        this.schedule();
      },
      togglePlan: () => void this.#prompt("/plan"),
      edit: event => {
        if (this.editor.applyEdit(event)) this.#updateCompletion();
        this.schedule();
      },
      undo: () => {
        this.editor.undo();
        this.schedule();
      },
      send: event => {
        // An explicit prompt from Tern: blank is a no-op, and the draft it
        // replaces is kept for recall rather than lost.
        const text = event.text ?? "";
        if (!text.trim() || this.#dockState().blocked) return;
        if (this.editor.text.trim()) this.editor.remember(this.editor.expanded());
        this.editor.clear();
        void this.#submit(text);
      },
    };
  }

  render(): void {
    if (this.#stopping || this.#surface.closed) return;
    const ctx = this.#viewCtx();
    const conv = this.conv;
    const built = this.#transcript.build(conv, ctx);
    const blocks = new Set(built.map(node => String(node.props["key"])));
    const rewind = this.#rewind;
    if (rewind) {
      // The chosen message is marked; everything after it is what the rewind leaves behind.
      const order = new Map(conv.items.map((item, index) => [item.id, index]));
      const pick = order.get(rewind.entries[rewind.at]!.item.id) ?? 0;
      built.forEach((node, index) => {
        const at = order.get(String(node.props["key"])) ?? -1;
        if (at >= pick) built[index] = new TernNode(node.kind, { ...node.props, mark: at === pick ? "pick" : "drop" }, node.children, node.handlers, node.slots);
      });
    }
    const main: Node[] = [
      this.#mainHead.top,
      this.#welcome(),
      this.#mainHead.gap,
      ...built,
    ];
    const plan = planNode(conv, () => void this.#prompt("/implement"));
    if (plan) main.push(plan);
    const approval = this.#approvals[0];
    const above = approval
      ? approvalPanel(
          { ...approval, ...(approval.deadline ? { remaining: approval.deadline - Date.now() } : {}) },
          {
            take: id => this.#answerApproval(approval, id),
            approve: () => this.#answerApproval(approval, approval.choices.find(choice => !choice.deny)?.id ?? null),
            deny: () => this.#answerApproval(approval, approval.choices.find(choice => choice.deny)?.id ?? null),
            expand: () => {
              approval.expanded = !approval.expanded;
              this.schedule();
            },
          },
        )
      : null;
    // A turn that ended on an error keeps it in view above the composer until the next turn.
    const failed = conv.busy ? undefined : conv.items.findLast(item => item.kind !== "usage");
    const pinned = failed?.kind === "error" ? failed : undefined;
    if (pinned && this.#banner.id !== pinned.id) this.#banner = { id: pinned.id, expanded: false, dismissed: false };
    const banner =
      pinned && !this.#banner.dismissed
        ? errorBanner(pinned.text, this.#banner.expanded, {
            details: () => ((this.#banner.expanded = !this.#banner.expanded), this.schedule()),
            dismiss: () => ((this.#banner.dismissed = true), this.schedule()),
          })
        : null;
    const field = this.#field;
    const rewindNode = rewind
      ? rewindPanel(
          {
            text: firstLine(rewind.entries[rewind.at]!.item.text, 200),
            dropped: built.filter(node => node.props["mark"] === "drop").length,
            index: rewind.at + 1,
            total: rewind.entries.length,
          },
          { confirm: () => void this.#confirmRewind(), cancel: () => ((this.#rewind = null), this.schedule()) },
        )
      : null;
    const instead = rewindNode ?? (field
      ? fieldDialog(
          { title: field.title, detail: field.detail, placeholder: field.placeholder, multiline: field.multiline, editor: field.editor, ...(field.deadline ? { remaining: field.deadline - Date.now() } : {}) },
          {
            submit: () => this.#closeField(field.editor.text),
            cancel: () => this.#closeField(null),
            edit: (event: EditEvent) => {
              field.editor.applyEdit(event);
              this.schedule();
            },
            undo: () => {
              field.editor.undo();
              this.schedule();
            },
          },
        )
      : null);
    const layer: (Node | null)[] = [];
    const completion = this.#completion;
    if (completion && !this.#dockState().blocked) layer.push(completionPopup(completion.items, completion.selected, index => this.#acceptCompletion(index, true)));
    if (this.#picker) {
      const picker = this.#picker;
      layer.push(
        pickerNode(picker.view(), {
          select: id => {
            picker.selected = id;
            picker.confirm = null;
            this.schedule();
          },
          activate: id => {
            picker.selected = id;
            void this.#choose(picker);
          },
          change: () => undefined,
        }),
      );
    }
    if (this.#prefs) layer.push(this.#prefsView());
    if (this.#sheet) {
      const open = this.#sheet;
      layer.push(sheet(open.id, open.head, open.size, open.body(), () => this.#closeSheet(), open.extra?.() ?? []));
    }
    layer.push(...toastNodes(this.#toasts));
    this.#surface.render({ dock: dock(conv, this.#dockState(), this.#dockActions(), [banner, above], instead), layer: h("col", { key: "layer" }, layer) });

    const mainOps = this.#main.ops(main, this.#surface.id);
    if (mainOps.length) this.#surface.send(mainOps);
    if (this.#settlePending && !conv.busy) {
      this.#settlePending = false;
      if (this.#session.caps.features.includes("settle")) {
        const live = new Set<string>();
        for (const item of conv.items) {
          live.add(item.id);
          const done = item.kind === "agent" ? item.agentStatus !== "running" && item.agentStatus !== "pending" : item.status !== "running" && item.status !== "pending";
          // Only a block's first item is a node of `main`; the rest live inside it.
          if (done && !this.#settled.has(item.id) && blocks.has(item.id)) {
            this.#settled.add(item.id);
            this.#surface.settle(`main.${item.id}`);
          }
        }
        for (const id of this.#settled) if (!live.has(id)) this.#settled.delete(id);
      }
    }
    const focus = this.#picker || this.#prefs || this.#sheet || this.#rewind ? null : field ? fieldInputId(field.multiline) : EDITOR_ID;
    if (focus !== this.#focus) {
      this.#focus = focus;
      this.#surface.focus(focus);
    }
    // Countdowns and the retry wait redraw without an event to cause it.
    const ticking = Boolean(conv.retry || approval?.deadline || field?.deadline);
    if (ticking && !this.#tick) this.#tick = setInterval(() => this.schedule(), 500);
    else if (!ticking && this.#tick) {
      clearInterval(this.#tick);
      this.#tick = null;
    }
  }

  toast(text: string, tone: Toast["tone"] = "info", action?: Toast["action"]): void {
    if (!text) return;
    const toast: Toast = { id: ++this.#toastSeq, text: text.length > 300 ? `${text.slice(0, 299)}…` : text, tone, ...(action ? { action } : {}) };
    this.#toasts.push(toast);
    setTimeout(
      () => {
        this.#toasts = this.#toasts.filter(entry => entry !== toast);
        this.schedule();
      },
      action ? 6200 : 2600,
    );
    this.schedule();
  }

  /** Copies through the terminal's clipboard (OSC 52). */
  copy(text: string, what = "Text"): void {
    if (!text) {
      this.toast("Nothing to copy", "warning");
      return;
    }
    process.stdout.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
    this.toast(`${what} copied`);
  }

  /** A desktop notification (OSC 99) for a pane the user is not looking at. */
  #notify(title: string, body: string): void {
    if (process.env.PI_NOTIFICATIONS === "0") return;
    const clean = (text: string): string => text.replace(/[\x00-\x1f\x7f]/g, " ");
    process.stdout.write(`\x1b]99;i=pi:d=0:p=title;${clean(title)}\x1b\\\x1b]99;i=pi:d=1:p=body;${clean(body)}\x1b\\`);
  }

  // ───────────────────────────────────────────────────────────── TSP events

  #onEvent(event: TspEvent): void {
    // The transcript is outside the SDK's view, so its nodes' handlers are run here.
    if (this.#main.dispatch(event)) return;
    switch (event.ev) {
      case "visible":
        this.#visible = event.visible;
        break;
      case "resize":
        if (typeof event.visible === "boolean") this.#visible = event.visible;
        break;
      case "toggle":
        // A fold with no handler of its own: remember it by node id so a redraw keeps it.
        this.#fold.set(event.id.split(".").at(-1) ?? event.id, event.collapsed === true);
        break;
      case "action":
        if (event.id === "layer.picker" && this.#picker) void this.#pickerAction(this.#picker, event.act, typeof event.value === "string" ? event.value : undefined);
        else if (event.id === "layer.prefs" && this.#prefs) this.#prefsAction(event.act, typeof event.value === "string" ? event.value : undefined);
        break;
      case "select":
        if (event.id === "layer.prefs" && this.#prefs) this.#prefs.focus = event.item;
        break;
      case "change":
        if (event.id === "layer.prefs" && this.#prefs) void this.#prefsChange(String(event.item), event.value);
        break;
      case "focus":
        break;
      case "error":
        // Tern rejected an op, so its document and ours may differ: send the
        // whole view again, at most once a few seconds.
        if (Date.now() - this.#resyncAt > 3000) {
          this.#resyncAt = Date.now();
          this.#main.reset();
          this.#surface.render(null);
          this.#focus = undefined;
        }
        if (process.env.PI_TSP_TRACE) {
          try {
            writeFileSync(process.env.PI_TSP_TRACE, `${new Date().toISOString()} TSP error ${JSON.stringify(event.raw)}\n`, { flag: "a" });
          } catch {
            /* tracing is best effort */
          }
        }
        break;
      default:
        break;
    }
  }

  // ───────────────────────────────────────────────────────────── keys

  async #onKey(pressed: Key): Promise<void> {
    // Tern's scripted sessions send Ctrl as Meta; `PI_TSP_META_AS_CTRL=1` lets a scenario drive the Ctrl shortcuts.
    const key = META_AS_CTRL && pressed.meta ? { ...pressed, ctrl: true, meta: false } : pressed;
    if (this.#keymap.action(key) === "app.clear") return this.#ctrlC();
    if (this.#sheet) return this.#sheetKey(key);
    if (this.#prefs) return this.#prefsKey(key);
    if (this.#picker) return this.#pickerKey(this.#picker, key);
    if (this.#rewind) return this.#rewindKey(this.#rewind, key);
    if (this.#field) return this.#fieldKey(this.#field, key);
    if (this.#approvals[0] && this.#approvalKey(this.#approvals[0], key)) return;
    return this.#composerKey(key);
  }

  async #ctrlC(): Promise<void> {
    const now = Date.now();
    if (this.#sheet) return this.#closeSheet();
    if (this.#prefs) {
      this.#prefs = null;
      return;
    }
    if (this.#picker) return this.#closePicker();
    if (this.#rewind) {
      this.#rewind = null;
      return;
    }
    if (this.#field) return this.#closeField(null);
    if (this.#approvals[0]) return this.#answerApproval(this.#approvals[0], this.#approvals[0].choices.find(choice => choice.deny)?.id ?? null);
    if (now - this.#lastCtrlC < 1500) return this.quit();
    this.#lastCtrlC = now;
    if (!this.editor.empty) {
      this.editor.remember(this.editor.expanded());
      this.editor.clear();
      this.#attachments = [];
      this.#completion = null;
    } else if (this.conv.busy || this.conv.shell || this.conv.retry) await this.#interrupt();
    this.toast("Press Ctrl+C again to exit");
  }

  #approvalKey(approval: Approval, key: Key): boolean {
    const at = approval.choices.findIndex(choice => choice.id === approval.selected);
    if (key.ctrl && (key.name === "enter" || key.name === "q")) {
      this.#answerApproval(approval, approval.choices.find(choice => !choice.deny)?.id ?? null);
      return true;
    }
    if (key.ctrl && key.name === "o") {
      approval.expanded = !approval.expanded;
      return true;
    }
    // While a draft is being typed the keys belong to the composer.
    if (!this.editor.empty) return false;
    switch (key.name) {
      case "up":
        approval.selected = approval.choices[Math.max(0, at - 1)]?.id ?? approval.selected;
        return true;
      case "down":
        approval.selected = approval.choices[Math.min(approval.choices.length - 1, at + 1)]?.id ?? approval.selected;
        return true;
      case "enter":
        this.#answerApproval(approval, approval.selected);
        return true;
      case "escape":
        this.#answerApproval(approval, approval.choices.find(choice => choice.deny)?.id ?? null);
        return true;
      default:
        if (!key.ctrl && !key.alt && /^[1-9]$/.test(key.name)) {
          const choice = approval.choices[Number(key.name) - 1];
          if (choice) {
            this.#answerApproval(approval, choice.id);
            return true;
          }
        }
        return false;
    }
  }

  #fieldKey(field: Field, key: Key): void {
    const editor = field.editor;
    if (key.name === "escape") return this.#closeField(null);
    if (key.name === "enter") {
      if (field.multiline && !key.ctrl && !key.meta) editor.insert("\n");
      else this.#closeField(editor.text);
      return;
    }
    this.#textKey(editor, key, field.multiline);
  }

  /** The editing keys shared by the composer and dialogs; true when handled. */
  #textKey(editor: TextEditor, key: Key, multiline: boolean): boolean {
    switch (this.#keymap.action(key)) {
      case "tui.editor.cursorLeft":
        editor.left();
        return true;
      case "tui.editor.cursorRight":
        editor.right();
        return true;
      case "tui.editor.cursorWordLeft":
        editor.left(false, true);
        return true;
      case "tui.editor.cursorWordRight":
        editor.right(false, true);
        return true;
      case "tui.editor.cursorLineStart":
        editor.home();
        return true;
      case "tui.editor.cursorLineEnd":
        editor.end();
        return true;
      case "tui.editor.deleteCharBackward":
        editor.backspace();
        return true;
      case "tui.editor.deleteCharForward":
        editor.deleteForward();
        return true;
      case "tui.editor.deleteWordBackward":
        editor.backspace(true);
        return true;
      case "tui.editor.deleteWordForward":
        editor.deleteForward(true);
        return true;
      case "tui.editor.deleteToLineStart":
        editor.killToStart();
        return true;
      case "tui.editor.deleteToLineEnd":
        editor.killToEnd();
        return true;
      case "tui.editor.yank":
        editor.yank();
        return true;
      case "tui.editor.undo":
        editor.undo();
        return true;
      case "tui.editor.redo":
        editor.redo();
        return true;
      case "tui.input.newLine":
        if (multiline) editor.insert("\n");
        return true;
      default:
        break;
    }
    // Shift extends the selection; these are not remapped.
    switch (key.name) {
      case "paste":
        if (key.text) editor.paste(multiline ? key.text : key.text.replace(/\s*\n\s*/g, " "));
        return true;
      case "left":
        editor.left(key.shift, key.ctrl || key.alt);
        return true;
      case "right":
        editor.right(key.shift, key.ctrl || key.alt);
        return true;
      case "home":
        if (key.ctrl) editor.moveTo(0, key.shift);
        else editor.home(key.shift);
        return true;
      case "end":
        if (key.ctrl) editor.moveTo(editor.text.length, key.shift);
        else editor.end(key.shift);
        return true;
      case "up":
        return editor.vertical(-1, key.shift);
      case "down":
        return editor.vertical(1, key.shift);
      default:
        break;
    }
    if (key.ctrl && key.shift && !key.alt && key.name === "a") {
      editor.selectAll();
      return true;
    }
    if (!key.ctrl && !key.alt && !key.meta && key.text) {
      editor.insert(key.text);
      return true;
    }
    return false;
  }

  async #composerKey(key: Key): Promise<void> {
    const editor = this.editor;
    const completion = this.#completion;
    const plain = !key.ctrl && !key.alt && !key.meta;

    if (completion) {
      if (key.name === "up" || (key.ctrl && key.name === "p")) {
        completion.selected = (completion.selected - 1 + completion.items.length) % completion.items.length;
        return;
      }
      if (key.name === "down" || (key.ctrl && key.name === "n")) {
        completion.selected = (completion.selected + 1) % completion.items.length;
        return;
      }
      if (key.name === "tab" && !key.shift) return this.#acceptCompletion(completion.selected, false);
      if (key.name === "enter" && plain && !key.shift) return this.#acceptCompletion(completion.selected, true);
      if (key.name === "escape") {
        this.#completionDismissed = editor.text;
        this.#completion = null;
        return;
      }
    }

    if (this.#vimKeys) {
      // Outside Insert mode the arrows are Vim's motions; in it they stay the editor's.
      const arrows: Record<string, string> = { left: "h", right: "l", up: "k", down: "j", home: "0", end: "$", backspace: "h", space: " " };
      const insert = this.#vim.mode === "insert";
      const typed = key.name === "escape" ? "escape" : plain ? (insert ? undefined : (arrows[key.name] ?? key.text)) : undefined;
      if (typed !== undefined && this.#vim.key(typed)) {
        this.#updateCompletion();
        return;
      }
      // Normal mode never types: only Enter and the application's shortcuts pass.
      if (!insert && plain && key.text && key.name !== "enter") return;
    }
    const action = this.#keymap.action(key);
    if (action && (await this.#run(action))) {
      this.#updateCompletion();
      return;
    }

    switch (key.name) {
      case "enter":
        if (action === "tui.input.submit") await this.#submit();
        else if (action === "tui.input.newLine") editor.insert("\n");
        this.#updateCompletion();
        return;
      case "escape":
        if (editor.selection()) editor.moveTo(editor.cursor);
        return;
      case "tab":
        if (!key.shift && !this.#openFileCompletion()) editor.insert("  ");
        return;
      case "up":
        if (plain && !key.shift && !editor.vertical(-1)) editor.recall(-1);
        else if (key.shift) editor.vertical(-1, true);
        this.#updateCompletion();
        return;
      case "down":
        if (plain && !key.shift && !editor.vertical(1)) editor.recall(1);
        else if (key.shift) editor.vertical(1, true);
        this.#updateCompletion();
        return;
      case "page_up":
      case "page_down":
        if (this.#session.caps.features.includes("scroll")) this.#surface.scroll("main", key.name === "page_up" ? "page-up" : "page-down");
        return;
      case "paste":
        if (key.text !== undefined) this.#paste(key.text);
        this.#updateCompletion();
        return;
      default:
        break;
    }
    if (this.#textKey(editor, key, true)) this.#updateCompletion();
  }

  /** Runs a bound action from the composer; false when it does not apply now, so the key types as usual. */
  async #run(action: Action): Promise<boolean> {
    const editor = this.editor;
    switch (action) {
      case "app.interrupt":
        if (!this.conv.busy && !this.conv.shell && !this.conv.retry) return false;
        await this.#interrupt();
        return true;
      case "app.exit":
        if (!editor.empty || this.conv.busy) return false;
        await this.quit();
        return true;
      case "app.editor.external":
        await this.#externalEditor();
        return true;
      case "app.clipboard.pasteImage":
        this.#pasteClipboard();
        return true;
      case "app.session.new":
        await this.#newSession();
        return true;
      case "app.session.tree":
        await this.#pickTree();
        return true;
      case "app.session.fork":
        await this.#pickFork();
        return true;
      case "app.session.resume":
        this.#pickSession();
        return true;
      case "app.model.select":
        this.#pickModel();
        return true;
      case "app.model.cycleForward":
        await this.#cycleModel();
        return true;
      case "app.thinking.cycle":
        await this.#cycleEffort();
        return true;
      case "app.thinking.toggle":
        this.#hideThinking = !this.#hideThinking;
        this.#foldRev += 1;
        this.#saveDisplay();
        this.toast(this.#hideThinking ? "Thinking hidden" : "Thinking shown");
        return true;
      case "app.tools.expand":
        this.#expandAll = !this.#expandAll;
        this.#fold.clear();
        this.#foldRev += 1;
        this.#saveDisplay();
        this.toast(this.#expandAll ? "Expanded every block" : "Collapsed to defaults");
        return true;
      case "app.message.copy":
        this.copy(this.conv.lastAnswer(), "Answer");
        return true;
      case "app.message.followUp":
        await this.#followUp();
        return true;
      case "app.message.dequeue":
        await this.#dequeue();
        return true;
      case "app.history.search":
        this.#pickHistory();
        return true;
      case "app.retry":
        await this.#retry();
        return true;
      case "app.settings":
        this.#openPrefs();
        return true;
      default:
        return false;
    }
  }

  // ───────────────────────────────────────────────────────────── completion

  #commands(): Command[] {
    const local: Command[] = [
      { name: "model", description: "Switch model for this session", icon: "model", value: () => this.conv.model, run: args => this.#pickModel(args) },
      { name: "effort", description: "Set the thinking effort for this session", icon: "gauge", value: () => this.conv.thinkingLevel, run: args => this.#setEffort(args) },
      { name: "resume", description: "Resume a different session", icon: "history", run: () => this.#pickSession() },
      { name: "new", description: "Start a new session", icon: "plus", run: () => this.#newSession() },
      { name: "clear", description: "Start a new session (the current one stays on disk)", icon: "eraser", run: () => this.#newSession() },
      { name: "compact", description: "Summarize the conversation to free context", icon: "compaction", value: () => (this.conv.contextWindow ? `${Math.round((this.conv.contextTokens / this.conv.contextWindow) * 100)}%` : ""), run: args => this.#compact(args) },
      { name: "tree", description: "Jump to any point of this session", icon: "branch", run: () => this.#pickTree() },
      { name: "rewind", description: "Rewind the conversation to an earlier message", icon: "rewind", run: () => this.#rewindTo() },
      { name: "fork", description: "Start a new session from an earlier message", icon: "fork", run: () => this.#pickFork() },
      { name: "clone", description: "Copy this session into a new one", icon: "copy", run: () => this.#clone() },
      { name: "outline", description: "Jump to a message or tool call in the transcript", icon: "list", run: () => this.#pickOutline() },
      { name: "copy", description: "Copy a message from this session", icon: "copy", run: () => this.#pickCopy() },
      { name: "name", description: "Name this session", icon: "edit", value: () => this.conv.sessionName, run: args => this.#rename(args) },
      { name: "context", description: "Show what fills the context window", icon: "context", value: () => (this.conv.contextWindow ? `${Math.round((this.conv.contextTokens / this.conv.contextWindow) * 100)}%` : ""), run: () => this.#showContext() },
      { name: "session", description: "Show session details and usage", icon: "info", run: () => this.#showSession() },
      { name: "export", description: "Export this session as HTML", icon: "export", run: args => this.#export(args) },
      { name: "settings", description: "Open settings", icon: "settings", run: () => this.#openPrefs() },
      { name: "agents", description: "Show this session's subagents", icon: "users", value: () => (this.conv.agents().length ? String(this.conv.agents().length) : ""), run: () => this.#pickAgents() },
      { name: "attach", description: "Attach an image to the next message", icon: "image", run: args => this.#attachPath(args) },
      { name: "retry", description: "Send the last message again", icon: "refresh", run: () => this.#retry() },
      { name: "login", description: "Sign in to a provider (opens pi's own sign-in, then returns here)", icon: "key", run: () => this.#login("login") },
      { name: "logout", description: "Sign out of a provider (opens pi's own sign-out, then returns here)", icon: "key", run: () => this.#login("logout") },
      { name: "hotkeys", description: "Show keyboard shortcuts", icon: "keyboard", run: () => this.#showHotkeys() },
      { name: "help", description: "Show keyboard shortcuts and commands", icon: "help", run: () => this.#showHotkeys() },
      { name: "quit", description: "Exit pi", icon: "x", run: () => this.quit() },
    ];
    const names = new Set(local.map(command => command.name));
    return [...local, ...this.#remote.filter(command => !names.has(command.name))];
  }

  /** Opens, refreshes or closes the popup to match the draft at the caret. */
  #updateCompletion(): void {
    const text = this.editor.text;
    if (text === this.#completionDismissed) return;
    this.#completionDismissed = "";
    const keep = this.#completion?.items[this.#completion.selected]?.id;
    let next: CompletionState | null = null;
    if (/^\/[^\s]*$/.test(text) && this.editor.cursor === text.length) {
      const query = text.slice(1);
      const ranked = rank(query, this.#commands(), command => command.name).sort((a, b) => Number(b.item.name.startsWith(query)) - Number(a.item.name.startsWith(query)));
      const items = ranked.slice(0, 100).map(({ item }) => ({
        id: item.name,
        label: item.name,
        mark: item.name.startsWith(query) ? query.length : 0,
        detail: item.description,
        value: item.value?.() || undefined,
        icon: item.icon,
      }));
      if (items.length) next = { kind: "command", from: 0, items, selected: 0 };
    } else {
      const before = text.slice(0, this.editor.cursor);
      const match = before.match(/(?:^|\s)@([^\s@]*)$/);
      if (match) {
        const query = match[1] ?? "";
        const from = before.length - query.length - 1;
        const files = this.#files.list(() => {
          this.#updateCompletion();
          this.schedule();
        });
        const ranked = rank(query, files, file => file).slice(0, 50);
        const items = ranked.map(({ item }) => ({ id: item, label: item, icon: item.endsWith("/") ? "folder" : "file" }));
        if (items.length) next = { kind: "file", from, items, selected: 0 };
      }
    }
    if (next && keep) {
      const at = next.items.findIndex(item => item.id === keep);
      if (at > 0 && this.#completion?.selected !== 0) next.selected = at;
    }
    this.#completion = next;
  }

  /** Tab on a path-like word with no popup: open file completion for it. */
  #openFileCompletion(): boolean {
    const before = this.editor.text.slice(0, this.editor.cursor);
    const match = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match) return false;
    this.#updateCompletion();
    return true;
  }

  #acceptCompletion(index: number, run: boolean): void {
    const completion = this.#completion;
    const item = completion?.items[index];
    if (!completion || !item) return;
    const editor = this.editor;
    if (completion.kind === "command") {
      const command = this.#commands().find(entry => entry.name === item.id);
      this.#completion = null;
      editor.set(`/${item.id} `);
      // Enter on a command that needs nothing more runs it at once.
      if (run && command) void this.#submit();
      return;
    }
    const directory = item.id.endsWith("/");
    editor.splice(completion.from, editor.cursor, `@${item.id}${directory ? "" : " "}`);
    this.#completion = null;
    if (directory) this.#updateCompletion();
    this.schedule();
  }

  // ───────────────────────────────────────────────────────────── prompts

  async #submit(explicit?: string): Promise<void> {
    const editor = this.editor;
    const text = (explicit ?? editor.expanded()).trim();
    const images = this.#attachments;
    if (!text && !images.length) return;
    if (explicit === undefined) {
      editor.remember(editor.text);
      editor.clear();
    }
    this.#completion = null;
    this.#completionDismissed = "";
    if (text.startsWith("/")) {
      const [, name = "", args = ""] = text.match(/^\/(\S*)\s*([\s\S]*)$/) ?? [];
      const command = this.#commands().find(entry => entry.name === name);
      if (command?.run) {
        await command.run(args.trim());
        return;
      }
      // Anything else is pi's: an extension command, a prompt template or a skill.
      this.#attachments = [];
      return this.#prompt(text);
    }
    if (text.startsWith("!")) {
      const excluded = text.startsWith("!!");
      const command = text.slice(excluded ? 2 : 1).trim();
      if (command) return this.#shell(command, excluded);
      return;
    }
    this.#attachments = [];
    const item = this.conv.addUser(text, images);
    try {
      await this.#rpc.command("prompt", {
        message: text,
        ...(images.length ? { images: images.map(image => ({ type: "image", data: image.data, mimeType: image.mimeType })) } : {}),
        ...(this.conv.busy ? { streamingBehavior: "steer" } : {}),
      });
      // A steering message is shown in the queue until pi takes it.
      if (this.conv.busy && this.conv.queue.steering.includes(text)) this.conv.remove(item);
    } catch (error) {
      this.conv.remove(item);
      editor.set(text);
      this.#attachments = images;
      this.toast(`Could not send: ${(error as Error).message}`, "error");
    }
  }

  /** Sends text to pi without a local echo (commands pi handles itself). */
  async #prompt(text: string): Promise<void> {
    try {
      await this.#rpc.command("prompt", { message: text });
      // An extension command may have changed the session under us.
      await this.#refreshState().catch(() => undefined);
    } catch (error) {
      this.toast(firstLine((error as Error).message, 200), "error");
    }
  }

  async #followUp(): Promise<void> {
    const text = this.editor.expanded().trim();
    if (!text) return;
    if (!this.conv.busy) return this.#submit();
    this.editor.remember(this.editor.text);
    this.editor.clear();
    try {
      await this.#rpc.command("follow_up", { message: text });
      this.toast("Queued for after the current turn");
    } catch (error) {
      this.editor.set(text);
      this.toast(`Could not queue: ${(error as Error).message}`, "error");
    }
  }

  async #dequeue(): Promise<void> {
    if (!this.conv.queue.steering.length && !this.conv.queue.followUp.length) {
      this.toast("No queued messages to restore");
      return;
    }
    try {
      const queued = await this.#rpc.command("clear_queue");
      const messages = [...(queued.steering ?? []), ...(queued.followUp ?? [])];
      if (messages.length) this.editor.set([this.editor.text, ...messages].filter(Boolean).join("\n\n"));
      this.toast("Restored queued messages to the editor");
    } catch (error) {
      this.toast(`Could not restore the queue: ${(error as Error).message}`, "error");
    }
  }

  async #shell(command: string, excluded: boolean): Promise<void> {
    const item = this.conv.startShell(command, excluded);
    try {
      const result = await this.#rpc.command("bash", { command, excludeFromContext: excluded }, 24 * 3600_000);
      this.conv.finishShell(item, result);
    } catch (error) {
      this.conv.finishShell(item, null, (error as Error).message);
    }
    this.schedule();
  }

  async #interrupt(): Promise<void> {
    try {
      if (this.conv.shell) await this.#rpc.command("abort_bash");
      else if (this.conv.retry) await this.#rpc.command("abort_retry");
      else if (this.conv.busy) await this.#rpc.command("abort");
    } catch (error) {
      this.toast(`Could not stop: ${(error as Error).message}`, "error");
    }
  }

  /** Sends the last user message again, replacing a failed answer. */
  async #retry(): Promise<void> {
    if (this.conv.busy) return;
    const last = [...this.conv.items].reverse().find(item => item.kind === "user");
    if (!last) {
      this.toast("Nothing to retry", "warning");
      return;
    }
    for (const item of [...this.conv.items]) if (item.kind === "error") this.conv.remove(item);
    await this.#submit(last.text);
  }

  #paste(text: string): void {
    const trimmed = text.trim();
    // A pasted image path (a file dropped on the pane) attaches the image.
    if (trimmed && !trimmed.includes("\n") && isImagePath(trimmed)) {
      this.#attachImage(readImageFile(trimmed.replace(/^['"]|['"]$/g, "")));
      return;
    }
    if (!text) return this.#pasteClipboard();
    this.editor.paste(text);
  }

  #attachImage(image: Attachment | null): boolean {
    if (!image) return false;
    if (this.#attachments.length >= 8) {
      this.toast("At most 8 images per message", "warning");
      return true;
    }
    if (this.#model?.input && !this.#model.input.includes("image")) this.toast(`${this.#model.name ?? this.#model.id} does not read images`, "warning");
    this.#attachments.push(image);
    return true;
  }

  #pasteClipboard(): void {
    if (this.#attachImage(readClipboardImage())) return;
    for (const path of readClipboardFilePaths()) if (isImagePath(path) && this.#attachImage(readImageFile(path))) return;
    const text = readClipboardText();
    if (!text) {
      this.toast("The clipboard has no image or text", "warning");
      return;
    }
    if (isImagePath(text.trim()) && this.#attachImage(readImageFile(text.trim()))) return;
    this.editor.paste(text);
  }

  #attachPath(args: string): void {
    const raw = args.trim().replace(/^['"]|['"]$/g, "");
    if (!raw) {
      this.toast("Usage: /attach <image path>", "warning");
      return;
    }
    const path = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : isAbsolute(raw) ? raw : resolve(this.#cwd, raw);
    if (!this.#attachImage(readImageFile(path))) this.toast(`Not a readable image: ${raw}`, "error");
  }

  /**
   * Hands the pane to another program and takes it back when it exits: the
   * surface is suspended, the tty is cooked for the child, and the surface
   * resumes with the caret put back.
   */
  async #external(bin: string, args: string[], env: Record<string, string> = {}, note = ""): Promise<void> {
    this.#surface.suspend();
    process.stdin.setRawMode?.(false);
    if (note) process.stdout.write(`${note}\n`);
    try {
      await new Promise<void>((done, fail) => {
        const child = spawn(bin, args, { stdio: "inherit", cwd: this.#cwd, env: { ...process.env, ...env } });
        child.on("error", fail);
        child.on("exit", () => done());
      });
    } finally {
      process.stdin.setRawMode?.(true);
      this.#surface.resume();
      this.#focus = undefined;
      this.schedule();
    }
  }

  /** Edits the draft in `$VISUAL`/`$EDITOR`. */
  async #externalEditor(): Promise<void> {
    const command = process.env.VISUAL || process.env.EDITOR;
    if (!command) {
      this.toast("Set $VISUAL or $EDITOR to edit the draft in your editor", "warning");
      return;
    }
    const path = join(piTspHome(), `draft-${process.pid}.md`);
    const [bin, ...rest] = command.split(" ").filter(Boolean);
    try {
      writeFileSync(path, this.editor.expanded(), { mode: 0o600 });
      await this.#external(bin!, [...rest, path]);
      this.editor.set(readFileSync(path, "utf8").replace(/\n$/, ""));
    } catch (error) {
      this.toast(`Could not run ${command}: ${(error as Error).message}`, "error");
    } finally {
      rmSync(path, { force: true });
    }
  }

  /**
   * Signing in to a provider is an interactive flow pi keeps to its own
   * terminal UI, so `/login` opens pi itself on pi-tsp's config, and the
   * model list is read again when it exits.
   */
  async #login(command: string): Promise<void> {
    if (this.conv.busy) {
      this.toast("Wait for pi to finish, or stop it, before signing in", "warning");
      return;
    }
    try {
      await this.#external(stockPath(), ["--no-session"], { PI_CODING_AGENT_DIR: configDir(), PI_TSP_STOCK: "1" }, `pi-tsp: type /${command} here, then /quit to return.`);
      const models = await this.#rpc.command("get_available_models").catch(() => null);
      if (models?.models) this.#models = models.models;
      await this.#refreshState().catch(() => undefined);
      this.toast(`${this.#models.length} models available`);
    } catch (error) {
      this.toast(`Could not open pi: ${(error as Error).message}`, "error");
    }
  }

  // ───────────────────────────────────────────────────────────── model, effort

  async #cycleEffort(): Promise<void> {
    try {
      const result = await this.#rpc.command("cycle_thinking_level");
      if (result?.level) {
        this.conv.thinkingLevel = result.level;
        this.toast(`Thinking effort: ${result.level}`);
      } else this.toast("This model has no thinking levels", "warning");
    } catch (error) {
      this.toast(firstLine((error as Error).message, 160), "error");
    }
  }

  async #setEffort(args: string): Promise<void> {
    const level = args.trim().toLowerCase();
    if (!level) return this.#pickEffort();
    if (!this.#levels.includes(level)) {
      this.toast(`Unknown level "${level}". Available: ${this.#levels.join(", ")}`, "warning");
      return;
    }
    try {
      await this.#rpc.command("set_thinking_level", { level });
      this.conv.thinkingLevel = level;
      this.toast(`Thinking effort: ${level}`);
    } catch (error) {
      this.toast(firstLine((error as Error).message, 160), "error");
    }
  }

  async #cycleModel(): Promise<void> {
    try {
      const result = await this.#rpc.command("cycle_model");
      if (!result?.model) {
        this.toast("Only one model is available", "warning");
        return;
      }
      await this.#refreshState();
      this.toast(`Model: ${result.model.name ?? result.model.id}`);
    } catch (error) {
      this.toast(firstLine((error as Error).message, 160), "error");
    }
  }

  async #setModel(model: ModelInfo): Promise<void> {
    try {
      await this.#rpc.command("set_model", { provider: model.provider, modelId: model.id });
      await this.#refreshState();
      const levels = await this.#rpc.command("get_available_thinking_levels").catch(() => null);
      if (levels?.levels) this.#levels = levels.levels;
      this.toast(`Model: ${model.name ?? model.id}`);
    } catch (error) {
      this.toast(`Could not switch model: ${firstLine((error as Error).message, 160)}`, "error");
    }
  }

  // ───────────────────────────────────────────────────────────── pickers

  #openPicker(options: PickerOptions): Picker {
    if (this.#picker) this.#closePicker();
    this.#completion = null;
    this.#picker = new Picker(options);
    this.schedule();
    return this.#picker;
  }

  #closePicker(): void {
    const picker = this.#picker;
    this.#picker = null;
    picker?.options.cancel?.();
    this.schedule();
  }

  async #choose(picker: Picker): Promise<void> {
    if (picker.confirm) return this.#pickerAction(picker, picker.confirm.act, undefined);
    const id = picker.selected;
    if (!id) return;
    const item = picker.items.find(entry => entry.id === id);
    if (item?.disabled) return;
    await picker.options.choose(id, picker);
    this.schedule();
  }

  async #pickerAction(picker: Picker, act: string, value: string | undefined): Promise<void> {
    if (act === "close" || act === "cancel") return this.#closePicker();
    if (act === "tab" && value) {
      picker.tab = value;
      picker.refilter(true);
    } else if (act === "scope" && value) {
      picker.scope = value;
      picker.refilter(true);
    } else if (picker.options.actions.find(action => action.id === act)?.primary) await this.#choose(picker);
    else await picker.options.act?.(act, picker.selected, picker);
    this.schedule();
  }

  async #pickerKey(picker: Picker, key: Key): Promise<void> {
    const result = picker.key(key);
    if (result.type === "close") this.#closePicker();
    else if (result.type === "choose") await this.#choose(picker);
    else if (result.type === "act") await this.#pickerAction(picker, result.act, undefined);
  }

  #pickModel(query = ""): void {
    if (!this.#models.length) {
      this.toast("No models are configured. Run `pi auth` or add one to models.json.", "warning");
      return;
    }
    const idOf = (model: ModelInfo): string => `${model.provider}/${model.id}`;
    const byId = new Map(this.#models.map(model => [idOf(model), model]));
    const current = this.#model ? idOf(this.#model) : "";
    const price = (model: ModelInfo): string => {
      const input = model.cost?.input ?? 0;
      const output = model.cost?.output ?? 0;
      return input || output ? `$${input}/${output}` : "free";
    };
    const providers = [...new Set(this.#models.map(model => model.provider))].sort();
    const items: PickerItem[] = this.#models.map(model => ({
      id: idOf(model),
      label: idOf(model),
      mono: true,
      mark: { text: model.provider, seed: model.provider, ...(providerIcon(model.provider, model.id) ? { icon: providerIcon(model.provider, model.id)! } : {}) },
      search: model.name ?? "",
      group: model.provider,
      facts: { ctx: model.contextWindow ? tokens(model.contextWindow) : "", price: price(model) },
      badges: [...(model.reasoning ? [{ text: "reasoning" }] : []), ...(model.input?.includes("image") ? [{ text: "vision" }] : [])],
    }));
    const picker = this.#openPicker({
      props: {
        title: "Models",
        icon: "cpu",
        noun: "models",
        size: "lg",
        layout: "rows",
        preview: "side",
        placeholder: "Search models…",
        columns: [
          { id: "ctx", head: "Ctx", format: "num", priority: 2 },
          { id: "price", head: "$/M", format: "price", priority: 1 },
        ],
      },
      items,
      selected: current || null,
      current: current ? [current] : [],
      searchable: true,
      grouped: providers.length > 1,
      scopes:
        providers.length > 1
          ? [{ id: "all", label: "All models", icon: "list", test: () => true }, ...providers.map(provider => ({ id: provider, label: provider, group: "Providers", test: (item: PickerItem) => item.group === provider }))]
          : undefined,
      tabs: [
        { id: "all", label: "All", test: () => true },
        { id: "reasoning", label: "Reasoning", test: item => Boolean(byId.get(item.id)?.reasoning) },
        { id: "vision", label: "Vision", test: item => Boolean(byId.get(item.id)?.input?.includes("image")) },
      ],
      actions: [
        { id: "use", label: "Use model", keys: ["enter"], primary: true },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      empty: "No models match",
      preview: id => {
        const model = id ? byId.get(id) : undefined;
        if (!model) return [];
        const kv = (k: string, v: string): { k: ReturnType<typeof s>[]; v: ReturnType<typeof s>[] } => ({ k: [s(k, "muted")], v: [s(v, "mono")] });
        return [
          h("text", { key: "title", role: "omp.picker.title", text: model.name ?? model.id }),
          h("text", { key: "id", truncate: "middle", title: "Copy model id", spans: [s(idOf(model), "mono")], onClick: () => this.copy(idOf(model), "Model id") }),
          h("row", { key: "badges", gap: "xs", wrap: true }, [
            idOf(model) === current ? h("badge", { key: "current", text: "current", tone: "success" }) : null,
            model.reasoning ? h("badge", { key: "reasoning", text: "reasoning" }) : null,
            model.input?.includes("image") ? h("badge", { key: "vision", text: "vision" }) : null,
          ]),
          h("kv", {
            key: "facts",
            items: [
              ...(model.contextWindow ? [kv("Context", model.contextWindow.toLocaleString("en-US"))] : []),
              ...(model.maxTokens ? [kv("Max output", model.maxTokens.toLocaleString("en-US"))] : []),
              kv("Price", model.cost?.input || model.cost?.output ? `$${model.cost?.input ?? 0} in · $${model.cost?.output ?? 0} out per M` : "free"),
              kv("Input", (model.input ?? ["text"]).join(" · ")),
              kv("Reasoning", model.reasoning ? "yes" : "no"),
              kv("Provider", model.provider),
            ],
          }),
        ];
      },
      choose: async id => {
        const model = byId.get(id);
        this.#picker = null;
        if (model) await this.#setModel(model);
      },
    });
    if (query) {
      picker.query.set(query);
      picker.refilter(true);
    }
  }

  #pickEffort(): void {
    if (this.#levels.length < 2) {
      this.toast("This model has no thinking levels", "warning");
      return;
    }
    this.#openPicker({
      props: { title: "Thinking effort", icon: "gauge", noun: "levels", size: "md", layout: "rows", preview: "none" },
      items: this.#levels.map(level => ({ id: level, label: level, detail: EFFORT_DETAIL[level] ?? "" })),
      selected: this.conv.thinkingLevel || null,
      current: this.conv.thinkingLevel ? [this.conv.thinkingLevel] : [],
      searchable: false,
      actions: [
        { id: "use", label: "Select", keys: ["enter"], primary: true },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      choose: async id => {
        this.#picker = null;
        await this.#setEffort(id);
      },
    });
  }

  #sessionItems(rows: SessionRow[]): PickerItem[] {
    return rows.map(row => ({
      id: row.path,
      label: row.name || row.title || "(empty session)",
      detail: [row.cwd === this.#cwd ? "" : showPath(row.cwd, ""), row.preview].filter(Boolean).join(" · ") || undefined,
      icon: "session",
      search: `${row.title} ${row.cwd}`,
      group: row.cwd === this.#cwd ? "here" : "elsewhere",
      facts: { when: row.when, size: `${row.messages} msg` },
    }));
  }

  #pickSession(): void {
    let rows = listSessions(sessionDir(), this.#cwd);
    const byPath = (): Map<string, SessionRow> => new Map(rows.map(row => [row.path, row]));
    let index = byPath();
    this.#openPicker({
      props: {
        icon: "history",
        noun: "sessions",
        size: "lg",
        layout: "cards",
        preview: "side",
        placeholder: `Search sessions in ${showPath(this.#cwd, "").split("/").at(-1)}…`,
        columns: [
          { id: "when", format: "dim" },
          { id: "size", format: "dim" },
        ],
      },
      items: this.#sessionItems(rows),
      current: this.#sessionFile ? [this.#sessionFile] : [],
      searchable: true,
      scopes: [
        { id: "here", label: "This folder", icon: "folder", test: item => item.group === "here" },
        { id: "all", label: "All projects", icon: "list", test: () => true },
      ],
      scope: rows.some(row => row.cwd === this.#cwd) ? "here" : "all",
      actions: [
        { id: "resume", label: "Resume", keys: ["enter"], primary: true },
        { id: "delete", label: "Delete", keys: ["ctrl", "d"], danger: true },
        { id: "rename", label: "Rename", keys: ["f2"] },
        { id: "scope", label: "All projects", keys: ["ctrl", "a"] },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      empty: "No sessions yet",
      preview: id => {
        const row = id ? index.get(id) : undefined;
        if (!row) return [];
        return [
          h("text", { key: "title", role: "omp.picker.title", text: row.name || row.title || "(empty session)" }),
          h("text", { key: "meta", spans: [s(`${row.messages} messages · ${row.size} · ${row.when}`, "muted")] }),
          h("text", { key: "cwd", truncate: "middle", spans: [s(showPath(row.cwd, ""), "mono dim")] }),
          h("md", { key: "recent", text: row.previewMessages.map(message => `**${message.role === "user" ? "You" : "pi"}** ${message.text}`).join("\n\n") }),
        ];
      },
      choose: async id => {
        this.#picker = null;
        if (id === this.#sessionFile) return;
        try {
          const result = await this.#rpc.command("switch_session", { sessionPath: id });
          if (result?.cancelled) return;
          await this.#reload();
        } catch (error) {
          this.toast(`Could not resume: ${firstLine((error as Error).message, 160)}`, "error");
        }
      },
      act: async (act, id, picker) => {
        const row = id ? index.get(id) : undefined;
        if (act === "scope") {
          picker.scope = picker.scope === "all" ? "here" : "all";
          picker.refilter(true);
        } else if (act === "delete" && row) {
          if (row.path === this.#sessionFile) {
            this.toast("The open session cannot be deleted", "warning");
            return;
          }
          picker.confirm = { text: `Delete “${firstLine(row.name || row.title || "this session", 60)}”? This removes the session file.`, act: "delete-confirm", label: "Delete" };
        } else if (act === "delete-confirm" && row) {
          picker.confirm = null;
          try {
            rmSync(row.path);
            rows = rows.filter(entry => entry !== row);
            index = byPath();
            picker.setItems(this.#sessionItems(rows));
            this.toast("Session deleted");
          } catch (error) {
            this.toast(`Could not delete: ${(error as Error).message}`, "error");
          }
        } else if (act === "rename" && row) {
          if (row.path !== this.#sessionFile) {
            this.toast("Resume a session to rename it", "warning");
            return;
          }
          this.#picker = null;
          this.#rename("");
        }
      },
    });
  }

  async #newSession(): Promise<void> {
    if (this.conv.busy) await this.#interrupt();
    try {
      const result = await this.#rpc.command("new_session");
      if (result?.cancelled) return;
      await this.#reload();
      this.#attachments = [];
    } catch (error) {
      this.toast(`Could not start a session: ${firstLine((error as Error).message, 160)}`, "error");
    }
  }

  async #compact(instructions: string): Promise<void> {
    if (this.conv.compacting) return;
    this.conv.compacting = true;
    this.schedule();
    try {
      await this.#rpc.command("compact", instructions ? { customInstructions: instructions } : {}, 600_000);
      await this.#reload();
    } catch (error) {
      this.toast(firstLine((error as Error).message, 200), /nothing to compact/i.test((error as Error).message) ? "info" : "error");
    } finally {
      this.conv.compacting = false;
      this.schedule();
    }
  }

  async #clone(): Promise<void> {
    try {
      const result = await this.#rpc.command("clone");
      if (result?.cancelled) return;
      await this.#reload();
      this.toast("Session cloned");
    } catch (error) {
      this.toast(`Could not clone: ${firstLine((error as Error).message, 160)}`, "error");
    }
  }

  async #export(args: string): Promise<void> {
    try {
      const result = await this.#rpc.command("export_html", args ? { outputPath: resolve(this.#cwd, args) } : {});
      this.toast(`Exported to ${showPath(result.path, this.#cwd)}`);
    } catch (error) {
      this.toast(`Could not export: ${firstLine((error as Error).message, 160)}`, "error");
    }
  }

  #rename(args: string): void {
    const apply = async (name: string): Promise<void> => {
      try {
        await this.#rpc.command("set_session_name", { name });
        this.conv.sessionName = name;
        this.toast(`Session named “${firstLine(name, 60)}”`);
      } catch (error) {
        this.toast(`Could not rename: ${firstLine((error as Error).message, 160)}`, "error");
      }
      this.schedule();
    };
    if (args.trim()) return void apply(args.trim());
    this.#openField({ id: null, title: "Name this session", placeholder: "Session name", multiline: false, text: this.conv.sessionName, done: value => void (value?.trim() && apply(value.trim())) });
  }

  /**
   * Opens the rewind page: the transcript stays in view with the chosen
   * message marked and what follows it dimmed, until Enter forks from it.
   */
  async #rewindTo(item?: Item): Promise<void> {
    if (this.conv.busy) {
      this.toast("Stop pi before rewinding", "warning");
      return;
    }
    try {
      const { messages } = (await this.#rpc.command("get_fork_messages")) as { messages: { entryId: string; text: string }[] };
      const users = this.conv.items.filter(entry => entry.kind === "user");
      // pi lists the forkable user messages in order; they pair with the user rows shown.
      const entries = messages.flatMap((message, index) => (users[index] ? [{ entryId: message.entryId, item: users[index] }] : []));
      if (!entries.length) {
        this.toast("Nothing to rewind to yet", "warning");
        return;
      }
      const at = item ? entries.findIndex(entry => entry.item === item) : entries.length - 1;
      this.#completion = null;
      this.#rewind = { entries, at: at < 0 ? entries.length - 1 : at };
      this.#revealRewind();
    } catch (error) {
      this.toast(`Could not rewind: ${firstLine((error as Error).message, 160)}`, "error");
    }
  }

  #revealRewind(): void {
    const rewind = this.#rewind;
    if (!rewind) return;
    this.render();
    this.#surface.reveal(`main.${rewind.entries[rewind.at]!.item.id}`, "nearest");
  }

  #rewindKey(rewind: RewindState, key: Key): Promise<void> | void {
    switch (key.name) {
      case "escape":
        this.#rewind = null;
        return;
      case "enter":
        return this.#confirmRewind();
      case "up":
      case "k":
        rewind.at = Math.max(0, rewind.at - 1);
        return this.#revealRewind();
      case "down":
      case "j":
        rewind.at = Math.min(rewind.entries.length - 1, rewind.at + 1);
        return this.#revealRewind();
      case "home":
        rewind.at = 0;
        return this.#revealRewind();
      case "end":
        rewind.at = rewind.entries.length - 1;
        return this.#revealRewind();
      default:
        return;
    }
  }

  async #confirmRewind(): Promise<void> {
    const entry = this.#rewind?.entries[this.#rewind.at];
    this.#rewind = null;
    if (!entry) return;
    try {
      await this.#fork(entry.entryId);
    } catch (error) {
      this.toast(`Could not rewind: ${firstLine((error as Error).message, 160)}`, "error");
    }
  }

  async #fork(entryId: string): Promise<void> {
    const result = await this.#rpc.command("fork", { entryId });
    if (result?.cancelled) return;
    await this.#reload();
    if (result?.text) this.editor.set(result.text);
    this.toast("Rewound: edit the message and send");
  }

  async #pickFork(): Promise<void> {
    let messages: { entryId: string; text: string }[];
    try {
      messages = (await this.#rpc.command("get_fork_messages")).messages ?? [];
    } catch (error) {
      this.toast(firstLine((error as Error).message, 160), "error");
      return;
    }
    if (!messages.length) {
      this.toast("No messages to fork from yet", "warning");
      return;
    }
    const byId = new Map(messages.map(message => [message.entryId, message]));
    this.#openPicker({
      props: { title: "Fork from a message", icon: "fork", noun: "messages", size: "lg", layout: "timeline", preview: "side", placeholder: "Search your messages…" },
      items: messages.map(message => ({ id: message.entryId, label: firstLine(message.text, 110) || "(empty)", node: "user" as const })),
      selected: messages.at(-1)?.entryId ?? null,
      actions: [
        { id: "fork", label: "Fork here", keys: ["enter"], primary: true },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      preview: id => (id && byId.get(id) ? [h("md", { key: "text", text: byId.get(id)!.text })] : []),
      choose: async id => {
        this.#picker = null;
        try {
          await this.#fork(id);
        } catch (error) {
          this.toast(`Could not fork: ${firstLine((error as Error).message, 160)}`, "error");
        }
      },
    });
  }

  async #pickTree(): Promise<void> {
    let data: { tree: any[]; leafId: string | null };
    try {
      data = await this.#rpc.command("get_tree");
    } catch (error) {
      this.toast(firstLine((error as Error).message, 160), "error");
      return;
    }
    const items: PickerItem[] = [];
    const texts = new Map<string, string>();
    const visit = (node: any, depth: number): void => {
      const entry = node.entry ?? node;
      const message = entry.message;
      let label = "";
      let kind: PickerItem["node"] = "marker";
      if (entry.type === "message" && message) {
        const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter((block: any) => block?.type === "text").map((block: any) => block.text).join(" ") : "";
        if (message.role === "user") kind = "user";
        else if (message.role === "assistant") kind = "assistant";
        else if (message.role === "toolResult") kind = "tool";
        label = firstLine(text, 110) || (message.role === "assistant" ? "(tool calls)" : message.role === "toolResult" ? `${message.toolName ?? "tool"} result` : "");
        texts.set(String(entry.id), text);
      } else if (entry.type === "compaction") label = "Compaction";
      else if (entry.type === "branch_summary") label = "Branch summary";
      const children: any[] = node.children ?? [];
      if (label && kind !== "tool") {
        items.push({ id: String(entry.id), label, node: kind, depth, ...(node.label || entry.label ? { badges: [{ text: String(node.label ?? entry.label), tone: "accent" }] } : {}) });
      }
      // A single child continues the line; siblings are branches and indent.
      children.forEach(child => visit(child, children.length > 1 ? depth + 1 : depth));
    };
    for (const root of data.tree ?? []) visit(root, 0);
    if (!items.length) {
      this.toast("This session has no history yet", "warning");
      return;
    }
    this.#openPicker({
      props: { title: "Session tree", icon: "branch", noun: "entries", size: "lg", layout: "tree", preview: "side", placeholder: "Search the session…" },
      items,
      selected: data.leafId && items.some(item => item.id === data.leafId) ? data.leafId : (items.at(-1)?.id ?? null),
      current: data.leafId ? [data.leafId] : [],
      searchable: true,
      actions: [
        { id: "go", label: "Go here", keys: ["enter"], primary: true },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      preview: id => (id && texts.get(id) ? [h("md", { key: "text", text: texts.get(id)! })] : []),
      choose: async id => {
        this.#picker = null;
        await this.#prompt(`/tsp-tree ${id}`);
        await this.#reload().catch(() => undefined);
      },
    });
  }

  #pickCopy(): void {
    const rows = this.conv.items.filter(item => (item.kind === "user" || item.kind === "assistant") && item.text.trim());
    if (!rows.length) {
      this.toast("Nothing to copy yet", "warning");
      return;
    }
    const byId = new Map(rows.map(item => [item.id, item]));
    this.#openPicker({
      props: { title: "Copy a message", icon: "copy", noun: "messages", size: "lg", layout: "timeline", preview: "side", placeholder: "Search messages…" },
      items: rows.map(item => ({ id: item.id, label: firstLine(item.text, 110), node: item.kind === "user" ? ("user" as const) : ("assistant" as const), facts: { when: clock(item.at, this.#session.caps.hour12) }, search: item.text.slice(0, 2000) })),
      selected: rows.at(-1)?.id ?? null,
      searchable: true,
      actions: [
        { id: "copy", label: "Copy", keys: ["enter"], primary: true },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      preview: id => (id && byId.get(id) ? [h("md", { key: "text", text: byId.get(id)!.text })] : []),
      choose: id => {
        this.#picker = null;
        const item = byId.get(id);
        if (item) this.copy(item.text, item.kind === "user" ? "Message" : "Answer");
      },
    });
  }

  /** The transcript's landmarks (your messages, tool calls, subagents, failures); Enter scrolls to one. */
  #pickOutline(): void {
    const rows = this.conv.items.flatMap((item): PickerItem[] => {
      const args = item.args ?? {};
      switch (item.kind) {
        case "user":
          return [{ id: item.id, label: firstLine(item.text, 110) || "(image)", node: "user", facts: { when: clock(item.at, this.#session.caps.hour12) } }];
        case "tool":
          // Reads are grouped under the first of a run, which is not always this one.
          if (String(item.name).toLowerCase() === "read") return [];
          return [{ id: item.id, label: `${item.name}  ${firstLine(args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query ?? "", 90)}`.trim(), node: "tool", depth: 1, ...(item.status === "error" ? { tone: "error" } : {}) }];
        case "agent":
          return [{ id: item.id, label: `${item.agentType ?? "agent"}  ${firstLine(args.description ?? args.task ?? "", 90)}`.trim(), node: "tool", depth: 1 }];
        case "bash":
        case "python":
          return [{ id: item.id, label: `!${firstLine(item.text, 100)}`, node: "tool", depth: 1 }];
        case "error":
          return [{ id: item.id, label: firstLine(item.text, 110), node: "marker", tone: "error", depth: 1 }];
        case "compaction":
          return [{ id: item.id, label: "Compacted", node: "marker" }];
        default:
          return [];
      }
    });
    if (!rows.length) {
      this.toast("Nothing in the transcript yet", "warning");
      return;
    }
    this.#openPicker({
      props: { title: "Outline", icon: "list", noun: "entries", size: "md", layout: "timeline", preview: "none", placeholder: "Search the transcript…" },
      items: rows,
      selected: rows.at(-1)?.id ?? null,
      searchable: true,
      actions: [
        { id: "go", label: "Go there", keys: ["enter"], primary: true },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      choose: id => {
        this.#picker = null;
        this.render();
        this.#surface.reveal(`main.${id}`, "start");
      },
    });
  }

  #pickHistory(): void {
    const history = [...new Set([...this.editor.history].reverse())];
    if (!history.length) {
      this.toast("No prompt history yet", "warning");
      return;
    }
    this.#openPicker({
      props: { title: "Prompt history", icon: "history", noun: "prompts", size: "lg", layout: "rows", preview: "below", placeholder: "Search your prompts…" },
      items: history.map((text, index) => ({ id: String(index), label: firstLine(text, 140), search: text.slice(0, 2000) })),
      searchable: true,
      actions: [
        { id: "use", label: "Use prompt", keys: ["enter"], primary: true },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      preview: id => (id !== null && history[Number(id)]?.includes("\n") ? [h("code", { key: "text", text: history[Number(id)]!, wrap: true })] : []),
      choose: id => {
        this.#picker = null;
        this.editor.set(history[Number(id)] ?? "");
      },
    });
  }

  #pickAgents(): void {
    const agents = this.conv.agents();
    if (!agents.length) {
      this.toast("No subagents in this session", "warning");
      return;
    }
    this.#openPicker({
      props: { title: "Subagents", icon: "users", noun: "subagents", size: "lg", layout: "rows", preview: "side", columns: [{ id: "tools", head: "Tools", format: "num" }, { id: "tok", head: "Tokens", format: "num" }] },
      items: agents.map(item => ({
        id: item.id,
        label: firstLine(item.args?.description ?? item.args?.task ?? item.agentType ?? "agent", 100),
        detail: [item.agentType, item.model].filter(Boolean).join(" · "),
        dot: item.agentStatus === "done" ? "success" : item.agentStatus === "failed" ? "error" : item.agentStatus === "aborted" ? "muted" : "pending",
        facts: { tools: item.stats?.tools ? String(item.stats.tools) : "", tok: item.stats?.tokens ? tokens(item.stats.tokens) : "" },
      })),
      actions: [
        { id: "open", label: "Open transcript", keys: ["enter"], primary: true },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      preview: id => {
        const item = agents.find(agent => agent.id === id);
        return item?.output ? [h("md", { key: "output", text: item.output.slice(0, 8000) })] : [h("text", { key: "none", spans: [s("No report yet", "muted")] })];
      },
      choose: id => {
        this.#picker = null;
        const item = agents.find(agent => agent.id === id);
        if (item) this.#openAgent(item);
      },
    });
  }

  // ───────────────────────────────────────────────────────────── dialogs, sheets

  #openField(options: { id: string | null; title: string; placeholder: string; multiline: boolean; text: string; timeout?: unknown; done(value: string | null): void }): void {
    if (this.#field) this.#closeField(null);
    const lines = options.title.split("\n");
    const editor = new TextEditor();
    editor.set(options.text);
    const field: Field = { id: options.id, title: lines[0]?.trim() ?? "", detail: lines.slice(1).join("\n").trim(), placeholder: options.placeholder, multiline: options.multiline, editor, done: options.done };
    if (Number(options.timeout) > 0) {
      field.deadline = Date.now() + Number(options.timeout);
      field.timer = setTimeout(() => this.#field === field && this.#closeField(null), Number(options.timeout));
    }
    this.#field = field;
    this.schedule();
  }

  #closeField(value: string | null): void {
    const field = this.#field;
    if (!field) return;
    this.#field = null;
    clearTimeout(field.timer);
    field.done(value);
    this.schedule();
  }

  #closeSheet(): void {
    this.#sheet = null;
    this.schedule();
  }

  #sheetKey(key: Key): void {
    if (key.name === "escape" || key.name === "enter" || key.name === "q") return this.#closeSheet();
    if (!this.#session.caps.features.includes("scroll") || !this.#sheet) return;
    const id = `layer.${this.#sheet.id}`;
    const by = ({ up: "line-up", down: "line-down", page_up: "page-up", page_down: "page-down", home: "start", end: "end", space: "page-down" } as const)[key.name as "up"];
    if (by) this.#surface.scroll(id, by);
  }

  #showSession(): void {
    const conv = this.conv;
    void this.#rpc
      .command("get_session_stats")
      .then(stats => {
        const kv = (k: string, v: string): { k: ReturnType<typeof s>[]; v: ReturnType<typeof s>[] } => ({ k: [s(k, "muted")], v: [s(v, "mono")] });
        const usage = stats.contextUsage;
        this.#sheet = {
          id: "session",
          head: conv.sessionName || "Session",
          size: "md",
          body: () => [
            usage?.contextWindow
              ? h("meter", { key: "context", style: "bar", size: "lg", value: usage.tokens != null ? Math.min(1, usage.tokens / usage.contextWindow) : null, label: usage.percent != null ? `${Math.round(usage.percent)}%` : "unknown", total: tokens(usage.contextWindow), thresholds: { warn: 0.7, bad: 0.9 } })
              : null,
            h("kv", {
              key: "facts",
              items: [
                kv("Model", `${conv.provider}/${conv.model}`),
                kv("Thinking", conv.thinkingLevel || "off"),
                kv("Messages", `${stats.userMessages} you · ${stats.assistantMessages} pi · ${stats.toolCalls} tool calls`),
                kv("Tokens", `${tokens(stats.tokens?.input)} in · ${tokens(stats.tokens?.output)} out · ${tokens(stats.tokens?.cacheRead)} cache read · ${tokens(stats.tokens?.cacheWrite)} cache write`),
                kv("Cost", money(stats.cost) || "$0.00"),
                kv("Context", usage?.tokens != null ? `${tokens(usage.tokens)} of ${tokens(usage.contextWindow)}` : "unknown until the next reply"),
                kv("Auto-compact", conv.autoCompaction ? "on" : "off"),
                kv("Folder", showPath(this.#cwd, "")),
                kv("Session id", stats.sessionId ?? this.#sessionId),
                kv("File", stats.sessionFile ? showPath(stats.sessionFile, "") : "not saved"),
              ],
            }),
          ],
          extra: () => [h("button", { key: "copy", text: "Copy session id", size: "md", onClick: () => this.copy(stats.sessionId ?? this.#sessionId, "Session id") })],
        };
        this.schedule();
      })
      .catch(error => this.toast(firstLine((error as Error).message, 160), "error"));
  }

  /**
   * What fills the context window. pi reports only the total, so the split
   * by kind is each kind's share of the transcript's text applied to that
   * total: an estimate, and labelled as one.
   */
  #showContext(): void {
    const conv = this.conv;
    const window = conv.contextWindow;
    if (!window) {
      this.toast("The context size is unknown until the model answers", "warning");
      return;
    }
    const kinds: [string, string, (item: Item) => number][] = [
      ["You", "accent", item => (item.kind === "user" ? item.text.length + (item.images?.length ?? 0) * 4000 : 0)],
      ["Replies", "success", item => (item.kind === "assistant" ? item.text.length : 0)],
      ["Thinking", "thinkingText", item => (item.kind === "thinking" ? item.text.length : 0)],
      ["Tool calls", "info", item => (item.kind === "tool" || item.kind === "agent" ? JSON.stringify(item.args ?? {}).length : 0)],
      ["Tool results", "warning", item => (item.kind === "tool" || item.kind === "agent" || item.kind === "bash" || item.kind === "python" ? (item.output?.length ?? 0) : 0)],
      ["Summaries", "muted", item => (item.kind === "compaction" || item.kind === "branch" || item.kind === "custom" || item.kind === "hook" ? item.text.length : 0)],
    ];
    const sizes = kinds.map(([, , size]) => conv.items.reduce((sum, item) => sum + size(item), 0));
    const text = sizes.reduce((sum, size) => sum + size, 0);
    const used = Math.max(0, conv.contextTokens);
    // What the transcript does not account for is the system prompt and tool schemas.
    const transcript = Math.min(used, Math.round(text / 4));
    const fixed = used - transcript;
    const rows = [
      { label: "System prompt and tools", token: "dim", value: fixed },
      ...kinds.map(([label, token], index) => ({ label, token, value: text ? Math.round((sizes[index]! / text) * transcript) : 0 })),
    ].filter(row => row.value > 0);
    this.#sheet = {
      id: "context",
      head: "Context window",
      size: "md",
      body: () => [
        h("meter", {
          key: "meter",
          style: "bar",
          size: "lg",
          value: Math.min(1, used / window),
          parts: rows.map(row => ({ value: row.value / window, token: row.token, label: row.label })),
          label: `${Math.round((used / window) * 100)}%`,
          total: tokens(window),
          thresholds: { warn: 0.7, bad: 0.9 },
        }),
        h("kv", {
          key: "rows",
          items: [
            ...rows.map(row => ({ k: [s(row.label, row.token)], v: [s(`~${tokens(row.value)}`, "mono"), s(`  ${((row.value / window) * 100).toFixed(1)}%`, "dim mono")] })),
            { k: [s("Free", "muted")], v: [s(tokens(Math.max(0, window - used)), "mono")] },
          ],
        }),
        h("text", { key: "note", wrap: "word", spans: [s(`${tokens(used)} of ${tokens(window)} tokens used, as pi reports it. The split is estimated from the transcript's text.${conv.autoCompaction ? " Auto-compact is on." : ""}`, "muted")] }),
      ],
      extra: () => [h("button", { key: "compact", text: "Compact now", size: "md", onClick: () => (this.#closeSheet(), void this.#compact("")) })],
    };
    this.schedule();
  }

  #showHotkeys(): void {
    const bound = (action: Action, what: string): [string, string][] => (this.#keymap.label(action) ? [[this.#keymap.label(action), what]] : []);
    const rows: [string, string][] = [
      ["Enter", "Send, or steer while pi works"],
      ["Shift+Enter", "New line"],
      ...bound("app.message.followUp", "Queue for after the current turn"),
      ...bound("app.message.dequeue", "Bring queued messages back to edit"),
      ...bound("app.interrupt", "Stop pi, a running !command, or a retry wait"),
      ...bound("app.clear", "Clear the draft, or stop; twice to exit"),
      ["↑ / ↓", "Move in the draft, then prompt history"],
      ...bound("app.history.search", "Search prompt history"),
      ["/", "Commands"],
      ["@", "Files"],
      ["!cmd", "Run a shell command (!! keeps it from the model)"],
      ...bound("app.model.select", "Switch model"),
      ...bound("app.model.cycleForward", "Cycle models"),
      ...bound("app.thinking.cycle", "Cycle thinking effort"),
      ...bound("app.tools.expand", "Expand or collapse every block"),
      ...bound("app.thinking.toggle", "Show or hide thinking"),
      ...bound("app.clipboard.pasteImage", "Paste an image or text from the clipboard"),
      ...bound("app.editor.external", "Edit the draft in $EDITOR"),
      ...bound("app.message.copy", "Copy the last answer"),
      ...bound("app.retry", "Retry the last message"),
      ...bound("app.settings", "Settings"),
      ...bound("app.session.new", "New session"),
      ...bound("app.session.resume", "Resume a session"),
      ...bound("app.session.tree", "Session tree"),
      ...bound("app.session.fork", "Fork from a message"),
      ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo in the draft"],
      ["PgUp / PgDn", "Scroll the transcript"],
      ...bound("app.exit", "Exit (empty draft)"),
    ];
    this.#sheet = {
      id: "hotkeys",
      head: "Keyboard shortcuts",
      size: "md",
      body: () => [h("kv", { key: "keys", items: rows.map(([key, what]) => ({ k: [s(key, "key")], v: [s(what)] })) })],
    };
  }

  #openAgent(item: Item): void {
    const path = transcriptPath(item, this.#cwd, this.#sessionId);
    let nodes: Node[] = [];
    let note = "";
    if (path) {
      try {
        nodes = transcriptNodes(path);
      } catch (error) {
        note = `Could not read the transcript: ${(error as Error).message}`;
      }
    }
    if (!nodes.length && item.output) nodes = [h("md", { key: "report", text: item.output.slice(0, 40_000) })];
    if (!nodes.length && !note) note = item.agentStatus === "running" ? "This subagent has not written anything yet." : "This subagent runtime kept no transcript.";
    const title = firstLine(item.args?.description ?? item.args?.task ?? item.agentType ?? "Subagent", 80);
    this.#sheet = {
      id: "agent",
      head: title,
      size: "lg",
      body: () => [
        h("text", { key: "meta", spans: [s([item.agentType, item.model, item.agentStatus, item.stats?.tools ? `${item.stats.tools} tools` : "", item.stats?.tokens ? `${tokens(item.stats.tokens)} tok` : "", item.stats?.took != null ? duration(item.stats.took) : ""].filter(Boolean).join(" · "), "muted")] }),
        note ? h("text", { key: "note", spans: [s(note, "muted")] }) : null,
        h("col", { key: "transcript", gap: "sm" }, nodes),
      ],
      extra: () => [h("button", { key: "copy", text: "Copy report", size: "md", onClick: () => this.copy(item.output ?? "", "Report") })],
    };
    this.schedule();
  }

  // ───────────────────────────────────────────────────────────── settings

  #prefRows(): { id: string; title: string; page: string; rows: PrefsRow[] }[] {
    const conv = this.conv;
    const mode = (value: string): Record<string, unknown> => ({
      k: "choice",
      value,
      options: [
        { value: "one-at-a-time", label: "One at a time" },
        { value: "all", label: "All at once" },
      ],
      style: "segmented",
    });
    return [
      {
        id: "model",
        title: "Model",
        page: "session",
        rows: [
          { id: "model", label: "Model", hint: "The model answering this session", control: { k: "action", label: modelLabel(conv.model) || "Choose…", act: "pick-model" } },
          ...(this.#levels.length > 1
            ? [{ id: "effort", label: "Thinking effort", hint: "How long the model may reason before it answers", control: { k: "choice", value: conv.thinkingLevel, options: this.#levels.map(level => ({ value: level, label: level, detail: EFFORT_DETAIL[level] })), style: "menu" } }]
            : []),
        ],
      },
      {
        id: "turns",
        title: "Turns",
        page: "session",
        rows: [
          { id: "auto-compaction", label: "Auto-compact", hint: "Summarize the conversation when the context window fills", changed: !conv.autoCompaction, defaultLabel: "on", control: { k: "switch", on: conv.autoCompaction } },
          { id: "auto-retry", label: "Auto-retry", hint: "Retry a failed request after a short wait", changed: !conv.autoRetry, defaultLabel: "on", control: { k: "switch", on: conv.autoRetry } },
          { id: "steering-mode", label: "Steering messages", hint: "How messages typed while pi works are delivered", control: mode(conv.steeringMode) },
          { id: "follow-up-mode", label: "Follow-up messages", hint: "How messages queued for after the turn are delivered", control: mode(conv.followUpMode) },
        ],
      },
      {
        id: "transcript",
        title: "Transcript",
        page: "display",
        rows: [
          { id: "expand-all", label: "Expand every block", hint: "Open tool cards and thinking by default  Ctrl+O", changed: this.#expandAll, defaultLabel: "off", control: { k: "switch", on: this.#expandAll } },
          { id: "hide-thinking", label: "Hide thinking", hint: "Leave the model's reasoning out of the transcript  Ctrl+T", changed: this.#hideThinking, defaultLabel: "off", control: { k: "switch", on: this.#hideThinking } },
          { id: "vim-keys", label: "Vim keys", hint: "Normal, Insert and Visual modes in the composer; Esc leaves Insert mode", changed: this.#vimKeys, defaultLabel: "off", control: { k: "switch", on: this.#vimKeys } },
          { id: "show-usage", label: "Token usage per message", hint: "A line under each reply with its tokens, time to first token and speed", changed: this.#showUsage, defaultLabel: "off", control: { k: "switch", on: this.#showUsage } },
          { id: "show-images", label: "Show images", hint: "Draw attached and tool-result images inline", changed: !this.#showImages, defaultLabel: "on", control: { k: "switch", on: this.#showImages } },
        ],
      },
    ];
  }

  #openPrefs(): void {
    this.#completion = null;
    this.#prefs = { page: "session", focus: "model" };
  }

  #prefsView(): Node {
    const prefs = this.#prefs!;
    const sections = this.#prefRows().filter(section => section.page === prefs.page);
    return prefsNode(
      {
        title: "pi settings",
        pages: [
          { id: "session", label: "Session", icon: "model" },
          { id: "display", label: "Display", icon: "appearance" },
        ],
        page: prefs.page,
        lead: prefs.page === "session" ? "The model and how turns run. These apply to the open session." : "How the transcript is drawn in this pane.",
        sections: sections.map(({ id, title, rows }) => ({ id, title, rows })),
        focus: prefs.focus,
      },
      { change: (row, value) => void this.#prefsChange(row, value), select: item => ((prefs.focus = item), this.schedule()) },
    );
  }

  #prefsAction(act: string, value: string | undefined): void {
    const prefs = this.#prefs;
    if (!prefs) return;
    if (act === "close" || act === "cancel") this.#prefs = null;
    else if (act === "page" && value) {
      prefs.page = value;
      prefs.focus = this.#prefRows().find(section => section.page === value)?.rows[0]?.id ?? null;
    } else if (act === "pick-model") {
      this.#prefs = null;
      this.#pickModel();
    }
  }

  async #prefsChange(row: string, value: unknown): Promise<void> {
    const conv = this.conv;
    try {
      switch (row) {
        case "auto-compaction":
          conv.autoCompaction = value === null ? true : Boolean(value);
          await this.#rpc.command("set_auto_compaction", { enabled: conv.autoCompaction });
          break;
        case "auto-retry":
          conv.autoRetry = value === null ? true : Boolean(value);
          await this.#rpc.command("set_auto_retry", { enabled: conv.autoRetry });
          break;
        case "steering-mode":
          conv.steeringMode = String(value ?? "one-at-a-time");
          await this.#rpc.command("set_steering_mode", { mode: conv.steeringMode });
          break;
        case "follow-up-mode":
          conv.followUpMode = String(value ?? "one-at-a-time");
          await this.#rpc.command("set_follow_up_mode", { mode: conv.followUpMode });
          break;
        case "effort":
          if (typeof value === "string") await this.#setEffort(value);
          break;
        case "expand-all":
          this.#expandAll = Boolean(value);
          this.#fold.clear();
          this.#foldRev += 1;
          break;
        case "hide-thinking":
          this.#hideThinking = Boolean(value);
          this.#foldRev += 1;
          break;
        case "show-images":
          this.#showImages = value === null ? true : Boolean(value);
          this.#foldRev += 1;
          break;
        case "vim-keys":
          this.#vimKeys = Boolean(value);
          this.#vim.reset();
          break;
        case "show-usage":
          this.#showUsage = Boolean(value);
          this.#foldRev += 1;
          break;
        default:
          break;
      }
    } catch (error) {
      this.toast(firstLine((error as Error).message, 160), "error");
    }
    this.#saveDisplay();
    this.schedule();
  }

  /** Display choices are the surface's own and outlive the session. */
  #displayPath(): string {
    return join(piTspHome(), "display.json");
  }

  #loadDisplay(): void {
    try {
      const stored = JSON.parse(readFileSync(this.#displayPath(), "utf8")) as Record<string, unknown>;
      this.#expandAll = stored.expandAll === true;
      this.#hideThinking = stored.hideThinking === true;
      this.#showImages = stored.showImages !== false;
      this.#showUsage = stored.showUsage === true;
      this.#vimKeys = stored.vimKeys === true;
    } catch {
      /* defaults */
    }
  }

  #saveDisplay(): void {
    try {
      mkdirSync(piTspHome(), { recursive: true, mode: 0o700 });
      writeFileSync(this.#displayPath(), JSON.stringify({ expandAll: this.#expandAll, hideThinking: this.#hideThinking, showImages: this.#showImages, showUsage: this.#showUsage, vimKeys: this.#vimKeys }), { mode: 0o600 });
    } catch {
      /* a preference that is not saved still applies now */
    }
  }

  #prefsKey(key: Key): void {
    const prefs = this.#prefs!;
    const pages = ["session", "display"];
    const rows = this.#prefRows()
      .filter(section => section.page === prefs.page)
      .flatMap(section => section.rows);
    const at = rows.findIndex(row => row.id === prefs.focus);
    const row = rows[at];
    const step = (delta: number): void => {
      if (!row) return;
      const control = row.control as { k: string; on?: boolean; value?: string; options?: { value: string }[]; act?: string };
      if (control.k === "switch") void this.#prefsChange(row.id, !control.on);
      else if (control.k === "choice" && control.options?.length) {
        const index = control.options.findIndex(option => option.value === control.value);
        const next = control.options[(index + delta + control.options.length) % control.options.length];
        if (next) void this.#prefsChange(row.id, next.value);
      } else if (control.k === "action" && control.act) this.#prefsAction(control.act, undefined);
    };
    switch (key.name) {
      case "escape":
        this.#prefs = null;
        return;
      case "up":
        prefs.focus = rows[Math.max(0, at - 1)]?.id ?? prefs.focus;
        return;
      case "down":
        prefs.focus = rows[Math.min(rows.length - 1, at + 1)]?.id ?? prefs.focus;
        return;
      case "tab": {
        const next = pages[(pages.indexOf(prefs.page) + (key.shift ? -1 : 1) + pages.length) % pages.length]!;
        this.#prefsAction("page", next);
        return;
      }
      case "left":
        step(-1);
        return;
      case "right":
      case "enter":
      case "space":
        step(1);
        return;
      default:
        return;
    }
  }

  // ───────────────────────────────────────────────────────────── history file

  #historyPath(): string {
    return join(piTspHome(), "history.json");
  }

  #loadHistory(): void {
    try {
      const stored = JSON.parse(readFileSync(this.#historyPath(), "utf8")) as unknown;
      if (Array.isArray(stored)) this.editor.history = stored.filter((entry): entry is string => typeof entry === "string").slice(-500);
    } catch {
      /* no history yet */
    }
  }

  #saveHistory(): void {
    try {
      mkdirSync(piTspHome(), { recursive: true, mode: 0o700 });
      writeFileSync(this.#historyPath(), JSON.stringify(this.editor.history.slice(-500)), { mode: 0o600 });
    } catch {
      /* history is a nicety */
    }
  }
}
