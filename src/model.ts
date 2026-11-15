/**
 * The conversation model: pi's RPC events folded into an ordered list of
 * renderable items. Nothing here knows about Tern.
 */

export type ToolStatus = "pending" | "running" | "done" | "error" | "cancelled";
export type AgentStatus = "pending" | "running" | "done" | "failed" | "aborted";

export interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "active" | "done" | "dropped" | "blocked";
  note?: string;
}

export interface TodoPhase {
  id: string;
  name: string;
  items: TodoItem[];
}

export interface TurnUsage {
  ms: number;
  input: number;
  output: number;
  total: number;
  cost: number;
}

/** One renderable transcript row. Fields beyond `kind`/`id` depend on the kind. */
export interface Item {
  kind:
    | "user"
    | "assistant"
    | "thinking"
    | "tool"
    | "agent"
    | "compaction"
    | "branch"
    | "custom"
    | "hook"
    | "bash"
    | "python"
    | "notice"
    | "error"
    | "usage"
    | "reminder";
  id: string;
  /** Bumped on every change, so a renderer can keep what it built. */
  v: number;
  at: number;
  text: string;
  key?: string;
  /** The assistant message this block belongs to. */
  msg?: number;
  status?: string;
  endedAt?: number;
  tookMs?: number;
  // user
  images?: any[];
  confirmed?: boolean;
  // assistant
  turn?: TurnUsage;
  model?: string;
  stopReason?: string;
  // tool / agent
  toolCallId?: string;
  name?: string;
  args?: Record<string, any>;
  rawArgs?: string;
  output?: string;
  result?: any;
  details?: Record<string, any>;
  isError?: boolean;
  startedAt?: number;
  durationMs?: number;
  resultImages?: any[];
  // agent
  agentType?: string;
  agentStatus?: AgentStatus;
  stats?: { tools?: number; tokens?: number; took?: number };
  thinking?: string;
  recentTools?: string[];
  recentOutput?: string;
  activity?: string;
  transcriptPath?: string;
  asyncId?: string;
  asyncDir?: string;
  runId?: string;
  background?: boolean;
  error?: string;
  // summaries / custom / execution / notices
  tokensBefore?: number;
  tokensAfter?: number;
  warning?: string;
  customType?: string;
  exitCode?: number | null;
  cancelled?: boolean;
  truncated?: boolean;
  tone?: "muted" | "warning" | "error" | "info";
  /** The todos still open when a run ended (kind `reminder`). */
  open?: TodoPhase[];
  /** A message's token usage (kind `usage`). */
  usage?: { input: number; output: number; cacheRead: number; ms: number; ttftMs: number };
  excluded?: boolean;
}

export interface RetryState {
  attempt: number;
  max: number;
  delayMs: number;
  at: number;
  error: string;
}

export interface PlanState {
  active?: boolean;
  title?: string;
  steps?: { text: string; done?: boolean }[];
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(block => block && block.type === "text")
    .map(block => block.text || "")
    .join("");
}

/** Text of a tool result or custom message; images become placeholders. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(block => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return block.text || "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function resultText(result: any): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result.content === "string" || Array.isArray(result.content)) return contentText(result.content);
  if (typeof result.output === "string") return result.output;
  return "";
}

function resultImages(result: any): any[] {
  if (!result || !Array.isArray(result.content)) return [];
  return result.content.filter((block: any) => block?.type === "image" && block.data);
}

const TODO_STATUS: Record<string, TodoItem["status"]> = {
  completed: "done",
  done: "done",
  in_progress: "active",
  active: "active",
  abandoned: "dropped",
  dropped: "dropped",
  blocked: "blocked",
  pending: "pending",
};

/** Normalizes a todo tool's details (pi-tsp's own, or a phased list) to phases. */
export function todoPhases(details: any): TodoPhase[] | null {
  if (!details || typeof details !== "object") return null;
  const item = (todo: any, index: number): TodoItem => ({
    id: String(todo?.id ?? index + 1),
    text: String(todo?.content ?? todo?.text ?? todo?.title ?? ""),
    status: TODO_STATUS[String(todo?.status || (todo?.done || todo?.completed ? "done" : "pending"))] ?? "pending",
    ...(todo?.blocker ? { note: String(todo.blocker) } : {}),
  });
  const phases = Array.isArray(details.phases) ? details.phases : [];
  if (phases.length) {
    return phases
      .map((phase: any, index: number) => ({
        id: String(phase?.id ?? index),
        name: String(phase?.name ?? phase?.title ?? `Phase ${index + 1}`),
        items: ((phase?.tasks || phase?.items || []) as any[]).map(item).filter(todo => todo.text),
      }))
      .filter((phase: TodoPhase) => phase.items.length);
  }
  const direct = details.todos || details.todoPhases || details.items;
  if (!Array.isArray(direct)) return null;
  return [{ id: "todos", name: String(details.title || "Todos"), items: direct.map(item).filter(todo => todo.text) }];
}

/**
 * The object a JSON text streamed so far describes: the text is closed where
 * it stops (an open string, then every open bracket) and parsed. Arguments
 * arrive as such a prefix while a tool call streams.
 */
export function partialJson(text: string): Record<string, any> | null {
  if (!text.trimStart().startsWith("{")) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let body = text;
  if (inString) body += escaped ? '\\"' : '"';
  for (let cut = 0; cut < 3; cut += 1) {
    try {
      const value: unknown = JSON.parse(body + stack.slice().reverse().join(""));
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
    } catch {
      // A dangling key, colon or comma: drop back to the last complete member.
      const at = Math.max(body.lastIndexOf(","), body.lastIndexOf("{"));
      if (at < 0) return null;
      body = body[at] === "{" ? body.slice(0, at + 1) : body.slice(0, at);
    }
  }
  return null;
}

/** A model id as people read it: provider prefix and `:effort` suffix dropped. */
export function modelLabel(model: unknown): string {
  if (!model) return "";
  return String(model)
    .replace(/^[\w.-]+\//, "")
    .replace(/:(\w+)$/, "");
}

/** Tool names that start a subagent run (pi-subagents' `subagent`, @tintinweb/pi-subagents' `Agent`). */
const AGENT_TOOL_NAMES = new Set(["subagent", "agent", "task"]);

export function isAgentTool(name: unknown): boolean {
  return AGENT_TOOL_NAMES.has(String(name || "").toLowerCase());
}

const AGENT_STATUS: Record<string, AgentStatus> = {
  running: "running",
  queued: "pending",
  background: "running",
  pending: "pending",
  starting: "running",
  complete: "done",
  completed: "done",
  done: "done",
  success: "done",
  succeeded: "done",
  failed: "failed",
  error: "failed",
  cancelled: "aborted",
  canceled: "aborted",
  stopped: "aborted",
  aborted: "aborted",
};

function agentStatusOf(raw: unknown): AgentStatus | undefined {
  return raw ? AGENT_STATUS[String(raw).toLowerCase()] : undefined;
}

/** A token count given as a number or as statusline text ("12.3k", "~11.0k token"). */
function tokenCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^~?([\d.]+)\s*([kmg])?/i);
  if (!match) return undefined;
  const scale = ({ k: 1e3, m: 1e6, g: 1e9 } as Record<string, number>)[String(match[2] || "").toLowerCase()] || 1;
  return Math.round(Number(match[1]) * scale);
}

/** How much of a running `!command`'s output is kept, in characters. */
const SHELL_OUTPUT_CAP = 2_000_000;

interface PendingAssistant {
  seq: number;
  startedAt: number;
  firstTokenAt: number;
}

export class Conversation {
  items: Item[] = [];
  busy = false;
  compacting = false;
  model = "";
  provider = "";
  thinkingLevel = "";
  sessionName = "";
  cost = 0;
  contextTokens = 0;
  contextWindow = 0;
  tokPerSec = 0;
  retry: RetryState | null = null;
  plan: PlanState | null = null;
  todos: TodoPhase[] | null = null;
  autoCompaction = true;
  autoRetry = true;
  steeringMode = "one-at-a-time";
  followUpMode = "one-at-a-time";
  queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
  /** The `!command` running now. */
  shell: Item | null = null;
  /** Bumped on every change. */
  changed = 0;
  runStartedAt = 0;

  #seq = 0;
  #msgSeq = 0;
  #byKey = new Map<string, Item>();
  #byToolCall = new Map<string, Item>();
  #pending: PendingAssistant | null = null;
  #lastModel = "";
  #run = { input: 0, output: 0, total: 0, cost: 0, outputMs: 0 };

  touch(): void {
    this.changed += 1;
  }

  bump(item: Item): void {
    item.v += 1;
    this.changed += 1;
  }

  #id(prefix: string): string {
    this.#seq += 1;
    return `${prefix}${this.#seq}`;
  }

  add(fields: Partial<Item> & Pick<Item, "kind">, prefix: string): Item {
    const item: Item = { id: this.#id(prefix), v: 0, at: Date.now(), text: "", ...fields };
    this.items.push(item);
    if (item.key) this.#byKey.set(item.key, item);
    if (item.toolCallId) this.#byToolCall.set(item.toolCallId, item);
    this.touch();
    return item;
  }

  remove(item: Item): void {
    const index = this.items.indexOf(item);
    if (index >= 0) this.items.splice(index, 1);
    if (item.key) this.#byKey.delete(item.key);
    this.touch();
  }

  findTool(toolCallId: string | undefined): Item | undefined {
    return toolCallId ? this.#byToolCall.get(toolCallId) : undefined;
  }

  agents(): Item[] {
    return this.items.filter(item => item.kind === "agent");
  }

  /** The text of the last assistant block with any. */
  lastAnswer(): string {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index]!;
      if (item.kind === "assistant" && item.text.trim()) return item.text;
    }
    return "";
  }

  /** Every assistant block of the run that ends at `item`. */
  answerOf(item: Item): string {
    const index = this.items.indexOf(item);
    const parts: string[] = [];
    for (let at = index; at >= 0; at -= 1) {
      const row = this.items[at]!;
      if (row.kind === "user") break;
      if (row.kind === "assistant" && row.text.trim()) parts.unshift(row.text);
    }
    return parts.join("\n\n");
  }

  /** The local echo of a prompt, confirmed by the matching `message_start`. */
  addUser(text: string, images: any[] = []): Item {
    return this.add({ kind: "user", text, images, confirmed: false }, "u");
  }

  #confirmUser(message: any, create: boolean): void {
    const text = textOf(message.content);
    const images = Array.isArray(message.content) ? message.content.filter((block: any) => block?.type === "image") : [];
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index]!;
      if (item.kind !== "user" || item.confirmed) continue;
      item.confirmed = true;
      item.at = message.timestamp || item.at;
      if (!item.text) item.text = text;
      if (images.length) item.images = images;
      this.bump(item);
      return;
    }
    if (create && (text || images.length)) {
      const item = this.addUser(text, images);
      item.confirmed = true;
      if (message.timestamp) item.at = message.timestamp;
    }
  }

  #block(index: number, kind: "assistant" | "thinking" | "tool", extra: Partial<Item> = {}): Item {
    const pending = this.#pending!;
    const key = `a${pending.seq}b${index}`;
    const found = this.#byKey.get(key);
    if (found) return found;
    return this.add(
      {
        kind,
        key,
        msg: pending.seq,
        status: kind === "tool" ? "pending" : "running",
        ...extra,
      },
      kind === "assistant" ? "m" : kind === "thinking" ? "k" : "t",
    );
  }

  #firstToken(): void {
    if (this.#pending && !this.#pending.firstTokenAt) this.#pending.firstTokenAt = Date.now();
  }

  onEvent(event: Record<string, any>): void {
    switch (event.type) {
      case "message_start": {
        const message = event.message;
        if (!message) break;
        if (message.role === "user") this.#confirmUser(message, true);
        else if (message.role === "assistant") {
          this.#msgSeq += 1;
          this.#pending = { seq: this.#msgSeq, startedAt: Date.now(), firstTokenAt: 0 };
          this.busy = true;
          this.touch();
        }
        break;
      }
      case "message_update":
        this.#onUpdate(event.assistantMessageEvent || {});
        break;
      case "message_end": {
        const message = event.message;
        if (!message) break;
        if (message.role === "assistant") this.#endAssistant(message);
        else if (message.role === "toolResult") this.#endToolResult(message);
        else if (message.role === "user") this.#confirmUser(message, false);
        else this.#addOther(message);
        break;
      }
      case "tool_execution_start": {
        const item = this.findTool(event.toolCallId);
        if (!item) break;
        item.status = "running";
        item.startedAt = Date.now();
        if (!item.args || !Object.keys(item.args).length) item.args = event.args || {};
        if (!item.name) item.name = event.toolName;
        if (item.kind === "agent") item.agentStatus = "running";
        this.bump(item);
        break;
      }
      case "tool_execution_update": {
        const item = this.findTool(event.toolCallId);
        if (!item) break;
        const partial = event.partialResult || {};
        const text = resultText(partial);
        if (item.kind === "agent") this.#agentProgress(item, partial.details, text, false);
        else {
          const details = partial.details || {};
          const candidate = details.accumulatedOutput || details.output || details.text || text;
          if (typeof candidate === "string" && candidate.length >= (item.output || "").length) item.output = candidate;
        }
        this.bump(item);
        break;
      }
      case "tool_execution_end": {
        const item = this.findTool(event.toolCallId);
        if (!item) break;
        this.#settleTool(item, event.result, Boolean(event.isError), event.durationMs);
        break;
      }
      case "turn_end": {
        for (const result of event.toolResults || []) {
          const item = this.findTool(result.toolCallId);
          if (item && item.status !== "done" && item.status !== "error") {
            this.#settleTool(item, result, Boolean(result.isError), result.durationMs);
          }
        }
        const usage = event.message?.usage;
        if (usage) {
          this.#run.input += usage.input || 0;
          this.#run.output += usage.output || 0;
          // What the turn spent: new input and output, not the cached prefix re-read each step.
          this.#run.total += (usage.input || 0) + (usage.cacheWrite || 0) + (usage.output || 0);
          this.#run.cost += usage.cost?.total || 0;
          this.cost += usage.cost?.total || 0;
          this.contextTokens = usage.totalTokens || this.contextTokens;
          const pending = this.#pending;
          if (pending) {
            const decodeMs = Date.now() - (pending.firstTokenAt || pending.startedAt);
            if (usage.output > 0 && decodeMs > 0) this.tokPerSec = Math.round((usage.output / decodeMs) * 1000);
          }
        }
        this.#pending = null;
        this.touch();
        break;
      }
      case "agent_start":
        this.busy = true;
        this.runStartedAt = Date.now();
        this.#run = { input: 0, output: 0, total: 0, cost: 0, outputMs: 0 };
        this.touch();
        break;
      case "agent_end":
        this.touch();
        break;
      case "agent_settled":
        this.#settleRun();
        break;
      case "auto_retry_start":
        // The failure that led to this retry is superseded: only a final one stays in the transcript.
        for (let index = this.items.length - 1; index >= 0 && this.items[index]!.kind !== "user"; index -= 1) {
          if (this.items[index]!.kind === "error") this.remove(this.items[index]!);
        }
        this.retry = {
          attempt: event.attempt,
          max: event.maxAttempts,
          delayMs: event.delayMs,
          at: Date.now(),
          error: String(event.errorMessage || ""),
        };
        this.touch();
        break;
      case "auto_retry_end":
        if (this.retry && event.success) {
          this.add({ kind: "notice", text: `Recovered after ${this.retry.attempt} ${this.retry.attempt === 1 ? "retry" : "retries"}`, tone: "muted" }, "n");
        }
        this.retry = null;
        this.touch();
        break;
      case "compaction_start":
        this.compacting = true;
        this.touch();
        break;
      case "compaction_end":
        this.compacting = false;
        if (event.result?.summary) {
          this.#addSummary("compaction", {
            summary: event.result.summary,
            tokensBefore: event.result.tokensBefore,
            tokensAfter: event.result.estimatedTokensAfter,
            timestamp: Date.now(),
          });
        } else if (event.errorMessage) {
          this.add({ kind: "notice", text: `Compaction failed: ${event.errorMessage}`, tone: "error" }, "n");
        }
        this.touch();
        break;
      case "thinking_level_changed":
        this.thinkingLevel = event.level;
        this.touch();
        break;
      case "queue_update":
        this.queue = {
          steering: Array.isArray(event.steering) ? event.steering : [],
          followUp: Array.isArray(event.followUp) ? event.followUp : [],
        };
        this.touch();
        break;
      case "session_info_changed":
        this.sessionName = event.name || "";
        this.touch();
        break;
      case "bash_execution_update": {
        const shell = this.shell;
        if (!shell) break;
        // A command can print without end; keep the last of it, as the view shows the tail anyway.
        if (typeof event.delta === "string") shell.output = ((shell.output || "") + event.delta).slice(-SHELL_OUTPUT_CAP);
        this.bump(shell);
        break;
      }
      case "entry_appended": {
        const entry = event.entry || {};
        if (entry.type !== "custom") break;
        if (entry.customType === "pi-tsp-plan") {
          this.plan = entry.data ?? null;
          this.touch();
        } else if (entry.data?.todos || entry.data?.todoPhases || entry.data?.phases) {
          this.#noteTodos(entry.data);
        } else if (entry.customType === "subagents:record" && entry.data?.id) {
          // @tintinweb/pi-subagents records each run with the session file holding its transcript.
          const agent = this.items.find(item => item.kind === "agent" && item.runId === entry.data.id);
          if (agent && entry.data.sessionFile) {
            agent.transcriptPath = entry.data.sessionFile;
            this.bump(agent);
          }
        } else if (entry.customType === "subagent-notification") {
          this.#agentNotification({
            content: entry.data?.content || entry.content,
            details: entry.data?.details || entry.details,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  #onUpdate(update: Record<string, any>): void {
    if (!this.#pending) return;
    const index = update.contentIndex ?? 0;
    switch (update.type) {
      case "thinking_start":
        this.#block(index, "thinking");
        break;
      case "thinking_delta": {
        const item = this.#block(index, "thinking");
        item.text += update.delta || "";
        this.#firstToken();
        this.bump(item);
        break;
      }
      case "thinking_end": {
        const item = this.#block(index, "thinking");
        item.text = update.content || item.text;
        item.status = "done";
        item.endedAt = Date.now();
        item.tookMs ??= Math.max(0, item.endedAt - item.at);
        this.bump(item);
        break;
      }
      case "text_start":
        this.#block(index, "assistant");
        break;
      case "text_delta": {
        const item = this.#block(index, "assistant");
        item.text += update.delta || "";
        this.#firstToken();
        this.bump(item);
        break;
      }
      case "text_end": {
        const item = this.#block(index, "assistant");
        item.text = update.content || item.text;
        item.status = "done";
        item.endedAt = Date.now();
        this.bump(item);
        break;
      }
      case "toolcall_start": {
        const item = this.#block(index, "tool", { toolCallId: update.id, name: update.toolName, args: {}, rawArgs: "", output: "" });
        if (item.toolCallId) this.#byToolCall.set(item.toolCallId, item);
        if (isAgentTool(item.name)) this.#promoteAgent(item);
        this.#firstToken();
        this.bump(item);
        break;
      }
      case "toolcall_delta": {
        const item = this.#block(index, "tool", { args: {}, rawArgs: "", output: "" });
        item.rawArgs = (item.rawArgs || "") + (update.delta || "");
        const partial = partialJson(item.rawArgs);
        if (partial) item.args = partial;
        this.bump(item);
        break;
      }
      case "toolcall_end": {
        const call = update.toolCall || {};
        const item = this.#block(index, "tool", { toolCallId: call.id, name: call.name, output: "" });
        item.toolCallId ??= call.id;
        item.name = call.name || item.name;
        item.args = call.arguments || item.args || {};
        item.rawArgs = "";
        if (item.toolCallId) this.#byToolCall.set(item.toolCallId, item);
        if (isAgentTool(item.name)) this.#promoteAgent(item);
        this.bump(item);
        break;
      }
      case "error":
        // The failed message arrives in message_end with the reason; nothing to add here.
        break;
      default:
        break;
    }
  }

  #settleTool(item: Item, result: any, isError: boolean, durationMs?: number): void {
    item.endedAt = Date.now();
    item.isError = isError;
    item.status = isError ? "error" : "done";
    item.durationMs = durationMs ?? item.durationMs ?? Math.max(0, item.endedAt - (item.startedAt || item.at));
    item.result = result;
    item.details = result?.details || item.details || {};
    const images = resultImages(result);
    if (images.length) item.resultImages = images;
    this.#noteTodos(item.details);
    const text = resultText(result);
    if (text) item.output = text;
    if (item.kind === "agent") this.#agentProgress(item, item.details, text, true);
    this.bump(item);
  }

  #settleRun(): void {
    const wasBusy = this.busy;
    this.busy = false;
    this.#pending = null;
    this.retry = null;
    // Anything still pending when the run settles never ran.
    for (const item of this.items) {
      if (item.kind === "tool" && (item.status === "pending" || item.status === "running")) {
        item.status = "cancelled";
        this.bump(item);
      }
      if ((item.kind === "assistant" || item.kind === "thinking") && item.status === "running") {
        item.status = "done";
        this.bump(item);
      }
    }
    if (wasBusy && this.runStartedAt) {
      for (let index = this.items.length - 1; index >= 0; index -= 1) {
        const item = this.items[index]!;
        if (item.kind === "user") break;
        if (item.kind === "assistant") {
          item.turn = { ms: Date.now() - this.runStartedAt, ...this.#run };
          this.bump(item);
          break;
        }
      }
    }
    // A run that ends with todos still open says so, where it ended.
    const open = (this.todos ?? [])
      .map(phase => ({ ...phase, items: phase.items.filter(item => item.status === "pending" || item.status === "active" || item.status === "blocked") }))
      .filter(phase => phase.items.length);
    if (wasBusy && open.length) this.add({ kind: "reminder", open }, "r");
    this.runStartedAt = 0;
    this.touch();
  }

  #endAssistant(message: any): void {
    const now = Date.now();
    const blocks: any[] = Array.isArray(message.content) ? message.content : [];
    if (!this.#pending) {
      this.#msgSeq += 1;
      this.#pending = { seq: this.#msgSeq, startedAt: now, firstTokenAt: 0 };
    }
    blocks.forEach((block, index) => {
      if (block.type === "text") {
        if (!block.text) return;
        const item = this.#block(index, "assistant");
        item.text = block.text;
        item.status = "done";
        item.endedAt ??= now;
        item.model = message.model;
        this.bump(item);
      } else if (block.type === "thinking") {
        const text = block.thinking || block.text || "";
        if (!text) return;
        const item = this.#block(index, "thinking");
        item.text = text;
        item.status = "done";
        item.endedAt ??= now;
        item.tookMs ??= Math.max(0, item.endedAt - item.at);
        this.bump(item);
      } else if (block.type === "toolCall") {
        const item = this.#block(index, "tool", { toolCallId: block.id, name: block.name, output: "" });
        item.toolCallId ??= block.id;
        item.name = block.name || item.name;
        item.args = block.arguments || item.args || {};
        if (item.toolCallId) this.#byToolCall.set(item.toolCallId, item);
        if (isAgentTool(item.name)) this.#promoteAgent(item);
        this.bump(item);
      } else if (block.type === "image" && block.data) {
        // An image the model produced: drawn in the reply, where it was written.
        const item = this.#block(index, "assistant");
        item.images = [block];
        item.status = "done";
        this.bump(item);
      }
    });
    // A reply from a different model than the one before it says so once.
    if (message.model && blocks.length) {
      if (this.#lastModel && this.#lastModel !== message.model) {
        const first = this.items.findIndex(item => item.msg === this.#pending!.seq);
        const marker: Item = { kind: "notice", id: this.#id("n"), v: 0, at: message.timestamp || now, text: `Model: ${modelLabel(message.model)}`, tone: "info", key: `model:${this.#pending.seq}` };
        if (!this.#byKey.has(marker.key!)) {
          this.items.splice(first < 0 ? this.items.length : first, 0, marker);
          this.#byKey.set(marker.key!, marker);
        }
      }
      this.#lastModel = message.model;
    }
    this.model = message.model || this.model;
    this.provider = message.provider || this.provider;
    if (message.usage?.totalTokens) this.contextTokens = message.usage.totalTokens;
    const usage = message.usage;
    if (usage && (usage.input || usage.output || usage.cacheRead || usage.cacheWrite)) {
      const pending = this.#pending;
      const live = pending.firstTokenAt > 0;
      this.add(
        {
          kind: "usage",
          msg: pending.seq,
          at: message.timestamp || now,
          usage: {
            input: (usage.input || 0) + (usage.cacheWrite || 0),
            output: usage.output || 0,
            cacheRead: usage.cacheRead || 0,
            // Timings exist only for a message seen streaming, not one loaded from disk.
            ms: live ? now - pending.startedAt : 0,
            ttftMs: live ? pending.firstTokenAt - pending.startedAt : 0,
          },
        },
        "g",
      );
    }
    if (message.stopReason === "error") {
      this.add({ kind: "error", text: String(message.errorMessage || "The model stopped with an error."), msg: this.#pending.seq }, "e");
    } else if (message.stopReason === "aborted") {
      this.add({ kind: "notice", text: "Interrupted", tone: "muted" }, "n");
    }
    this.touch();
  }

  #endToolResult(message: any): void {
    const item = this.findTool(message.toolCallId);
    if (item) this.#settleTool(item, message, Boolean(message.isError), message.durationMs);
  }

  #addOther(message: any): void {
    switch (message.role) {
      case "compactionSummary":
        this.#addSummary("compaction", message);
        break;
      case "branchSummary":
        this.#addSummary("branch", message);
        break;
      case "custom":
      case "hookMessage":
        if (message.customType === "subagent-notification" && this.#agentNotification(message)) break;
        this.#addCustom(message);
        break;
      case "bashExecution":
      case "pythonExecution":
        this.#addExecution(message);
        break;
      default:
        break;
    }
  }

  #addSummary(kind: "compaction" | "branch", message: any): void {
    const summary = contentText(message.summary || message.content || "");
    if (!summary.trim()) return;
    const key = `${kind}:${message.tokensBefore || 0}:${summary.slice(0, 120)}`;
    if (this.#byKey.has(key)) return;
    this.add(
      {
        kind,
        key,
        text: summary,
        tokensBefore: message.tokensBefore,
        tokensAfter: message.tokensAfter,
        warning: message.warning,
        at: message.timestamp || Date.now(),
      },
      kind === "compaction" ? "c" : "b",
    );
  }

  #addCustom(message: any): void {
    if (message.display === false) return;
    const text = contentText(message.content);
    if (!text.trim()) return;
    const key = `custom:${message.customType || ""}:${message.timestamp || 0}:${text.slice(0, 80)}`;
    if (this.#byKey.has(key)) return;
    this.add(
      {
        kind: message.role === "hookMessage" ? "hook" : "custom",
        key,
        text,
        customType: message.customType || (message.role === "hookMessage" ? "hook" : "extension"),
        details: message.details,
        at: message.timestamp || Date.now(),
      },
      "x",
    );
  }

  /** A `!command` typed by the user: shown at once, filled as output arrives. */
  startShell(command: string, excluded: boolean): Item {
    const item = this.add({ kind: "bash", text: command, output: "", status: "running", startedAt: Date.now(), excluded }, "s");
    this.shell = item;
    return item;
  }

  finishShell(item: Item, result: { output?: string; exitCode?: number | null; cancelled?: boolean; truncated?: boolean } | null, error?: string): void {
    if (this.shell === item) this.shell = null;
    item.endedAt = Date.now();
    item.durationMs = item.endedAt - (item.startedAt || item.at);
    if (result) {
      if (typeof result.output === "string") item.output = result.output;
      item.exitCode = result.exitCode;
      item.cancelled = result.cancelled;
      item.truncated = result.truncated;
    }
    if (error) item.output = `${item.output || ""}${item.output ? "\n" : ""}${error}`;
    item.status = error ? "error" : item.cancelled ? "cancelled" : item.exitCode ? "error" : "done";
    this.bump(item);
  }

  #addExecution(message: any): void {
    const kind = message.role === "pythonExecution" ? "python" : "bash";
    const code = String((kind === "python" ? message.code : message.command) || "");
    // The row of a command this surface started is already there.
    const local = this.items.find(item => item.kind === kind && item.text === code && !item.key && item.startedAt);
    const key = `${kind}:${message.timestamp || 0}:${code.slice(0, 80)}`;
    if (local) {
      local.key = key;
      this.#byKey.set(key, local);
      return;
    }
    if (this.#byKey.has(key)) return;
    this.add(
      {
        kind,
        key,
        text: code,
        output: String(message.output || ""),
        exitCode: message.exitCode,
        cancelled: message.cancelled,
        truncated: message.truncated,
        excluded: message.excludeFromContext,
        status: message.cancelled ? "cancelled" : message.exitCode ? "error" : "done",
        at: message.timestamp || Date.now(),
      },
      "s",
    );
  }

  #noteTodos(details: any): void {
    const phases = todoPhases(details);
    if (!phases) return;
    this.todos = phases.length ? phases : null;
    this.touch();
  }

  #promoteAgent(item: Item): void {
    item.kind = "agent";
    const args = item.args || {};
    item.agentType = args.subagent_type || args.agent || args.type || item.agentType || "agent";
    item.background = Boolean(args.run_in_background || args.background || args.async);
    item.agentStatus ??= "pending";
    item.startedAt ??= Date.now();
    item.stats ??= { tools: 0, tokens: 0 };
  }

  /** Applies a @tintinweb/pi-subagents completion notification to its agent card. */
  #agentNotification(message: any): boolean {
    const details = message?.details || {};
    const notifications = [details, ...(Array.isArray(details.others) ? details.others : [])];
    const fallback = contentText(message?.content);
    let matched = false;
    for (const raw of notifications) {
      const id = raw?.agentId || raw?.id;
      if (!id) continue;
      const item = this.items.find(entry => entry.kind === "agent" && (entry.runId === id || entry.asyncId === id));
      if (!item) continue;
      const text = raw.resultPreview || fallback;
      if (text) item.output = text;
      this.#agentProgress(item, { ...raw, agentId: id, tokens: raw.tokens ?? raw.totalTokens }, text, true);
      if (Number.isFinite(raw.durationMs)) item.stats = { ...item.stats, took: raw.durationMs };
      item.endedAt ??= Date.now();
      this.bump(item);
      matched = true;
    }
    return matched;
  }

  /** Applies a `subagent-async` widget snapshot of background runs. */
  applySubagentSnapshot(snapshot: any): void {
    if (!snapshot || !Array.isArray(snapshot.runs)) return;
    for (const run of snapshot.runs) {
      let item = this.items.find(
        entry => entry.kind === "agent" && (entry.asyncId === run.id || entry.runId === run.id || (run.toolCallId && entry.toolCallId === run.toolCallId)),
      );
      item ??= this.add({ kind: "agent", agentType: run.label || "agent", agentStatus: "running", stats: { tools: 0, tokens: 0 }, at: run.startedAt || Date.now(), background: true }, "t");
      item.asyncId = run.id;
      item.runId = run.id;
      item.agentType = run.label || item.agentType || "agent";
      item.agentStatus = agentStatusOf(run.state) ?? "running";
      if (run.startedAt) item.startedAt = run.startedAt;
      if (run.endedAt) item.endedAt = run.endedAt;
      item.stats = {
        ...item.stats,
        tools: run.activity?.toolCount ?? item.stats?.tools ?? 0,
        ...(item.endedAt && item.startedAt ? { took: Math.max(0, item.endedAt - item.startedAt) } : {}),
      };
      this.bump(item);
    }
  }

  /**
   * Folds a subagent tool's details into its card. pi-subagents nests a run
   * under `results[].progress`; @tintinweb/pi-subagents reports flat fields
   * (`toolUses`, `tokens` as text, `status`, `agentId`).
   */
  #agentProgress(item: Item, details: any, text: string, final: boolean): void {
    const result = details?.results?.[0] || details;
    const progress = result?.progress || details?.progress;
    const configured = item.args?.agent || item.args?.subagent_type;
    if (configured) item.agentType = configured;
    else if (result?.agent && result.agent !== "agent") item.agentType = result.agent;
    if (result?.model) item.model = modelLabel(result.model);
    if (result?.thinking) item.thinking = result.thinking;
    if (progress) {
      item.stats = {
        tools: progress.toolCount ?? progress.tools ?? item.stats?.tools ?? 0,
        tokens: progress.tokens ?? (progress.inputTokens || 0) + (progress.outputTokens || 0),
        took: progress.durationMs ?? item.stats?.took,
      };
      item.recentTools = progress.recentTools || item.recentTools;
      item.recentOutput = progress.recentOutput || item.recentOutput;
      if (progress.status) item.agentStatus = agentStatusOf(progress.status) ?? "running";
    }
    if (result?.toolCount != null || result?.totalTokens != null || result?.durationMs != null) {
      item.stats = {
        ...item.stats,
        tools: result.toolCount ?? item.stats?.tools ?? 0,
        tokens: result.totalTokens ?? item.stats?.tokens ?? 0,
        took: result.durationMs ?? item.stats?.took,
      };
    }
    if (result?.usage) {
      item.stats = {
        ...item.stats,
        tokens: (result.usage.input || 0) + (result.usage.output || 0) + (result.usage.cacheRead || 0),
      };
    }
    if (result?.transcriptPath) item.transcriptPath = result.transcriptPath;
    if (result?.artifactPaths?.transcriptPath) item.transcriptPath = result.artifactPaths.transcriptPath;
    if (result?.asyncId) item.asyncId = result.asyncId;
    if (result?.asyncDir) item.asyncDir = result.asyncDir;
    if (result?.runId) item.runId = result.runId;
    if (result?.finalOutput) item.output = result.finalOutput;
    const flatTools = details?.toolUses ?? details?.toolCount;
    const flatTokens = tokenCount(details?.tokens) ?? tokenCount(details?.totalTokens);
    const flatStatus = agentStatusOf(details?.status);
    if (flatTools != null || flatTokens != null || details?.durationMs != null) {
      item.stats = {
        ...item.stats,
        tools: flatTools ?? item.stats?.tools ?? 0,
        tokens: flatTokens ?? item.stats?.tokens ?? 0,
        took: details?.durationMs ?? item.stats?.took,
      };
    }
    if (details?.subagentType) item.agentType = details.subagentType;
    if (details?.modelName) item.model = modelLabel(details.modelName);
    if (details?.activity) item.activity = String(details.activity);
    if (details?.agentId) item.runId = details.agentId;
    if (details?.outputFile) item.transcriptPath = details.outputFile;
    if (details?.error) item.error = String(details.error);
    if (flatStatus) item.agentStatus = flatStatus;
    if (final) {
      // A background run returns its tool result at once and keeps going:
      // only the runtime's own status may settle it.
      const detached = Boolean(result?.asyncId && !details?.results?.length) || flatStatus === "running" || flatStatus === "pending";
      const settled: AgentStatus = item.isError || (result?.exitCode != null && result.exitCode !== 0) ? "failed" : "done";
      item.agentStatus = detached ? "running" : (flatStatus ?? settled);
      if (detached) item.background = true;
      else {
        item.endedAt = Date.now();
        if (item.startedAt && item.stats?.took == null) item.stats = { ...item.stats, took: item.endedAt - item.startedAt };
      }
      if (!item.output && text) item.output = text;
    }
  }

  /** Rebuilds from `get_messages` (start, resume, fork, after compaction). */
  loadMessages(messages: any[] = []): void {
    this.items = [];
    this.#byKey.clear();
    this.#byToolCall.clear();
    this.#msgSeq = 0;
    this.#pending = null;
    this.#lastModel = "";
    this.todos = null;
    this.plan = null;
    this.retry = null;
    this.shell = null;
    this.cost = 0;
    for (const message of messages) {
      if (!message || message.role === "system") continue;
      if (message.role === "user") {
        const item = this.addUser(
          textOf(message.content),
          Array.isArray(message.content) ? message.content.filter((block: any) => block?.type === "image") : [],
        );
        item.confirmed = true;
        if (message.timestamp) item.at = message.timestamp;
      } else if (message.role === "toolResult") {
        this.#endToolResult(message);
      } else if (message.role === "assistant") {
        this.#pending = null;
        this.#endAssistant(message);
        for (const item of this.items) if (item.msg === this.#msgSeq && message.timestamp) item.at = message.timestamp;
        this.#pending = null;
        this.cost += message.usage?.cost?.total || 0;
      } else {
        this.#addOther(message);
      }
    }
    // A call with no result in a stored transcript never ran to the end.
    for (const item of this.items) {
      if (item.kind === "tool" && item.status === "pending") item.status = "cancelled";
      if (item.kind === "agent" && (item.agentStatus === "pending" || item.agentStatus === "running") && !item.background) item.agentStatus = "aborted";
      if (item.kind === "thinking") item.tookMs = undefined;
    }
    this.busy = false;
    this.touch();
  }
}
