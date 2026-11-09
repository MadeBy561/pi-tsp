/**
 * The conversation model: pi's RPC events folded into an ordered list of
 * renderable items. Nothing here knows about Tern; it is the same model a
 * terminal UI would use, which keeps the renderer replaceable.
 */

let sequence = 0;
const nextId = (prefix) => `${prefix}${++sequence}`;

export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text")
    .map((block) => block.text || "")
    .join("");
}

export function resultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result.content === "string") return result.content;
  if (Array.isArray(result.content)) {
    return result.content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block?.type === "text") return block.text || "";
        if (block?.type === "image") return `[image ${block.mimeType || ""}]`;
        return "";
      })
      .join("\n");
  }
  if (typeof result.output === "string") return result.output;
  return "";
}

/** Text out of a custom/summary message, including simple image placeholders. */
export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return block.text || "";
      if (block?.type === "image") return `[image ${block.mimeType || ""}]`;
      return "";
    })
    .join("\n");
}

/** Normalize pi/omp todo tool details to one stable board shape. */
function todosFromDetails(details) {
  if (!details || typeof details !== "object") return null;
  const direct = details.todos || details.todoPhases || details.items;
  const phases = Array.isArray(details.phases) ? details.phases : [];
  const raw = Array.isArray(direct)
    ? direct
    : phases.flatMap((phase) => Array.isArray(phase?.items) ? phase.items : []);
  if (!Array.isArray(raw)) return null;
  return raw.map((todo, index) => {
    const status = String(todo?.status || (todo?.done ? "done" : todo?.completed ? "done" : "pending"));
    return {
      id: String(todo?.id ?? index + 1),
      text: String(todo?.text ?? todo?.content ?? todo?.title ?? ""),
      status: status === "completed" ? "done" : status,
    };
  }).filter((todo) => todo.text);
}


function fmtModel(model) {
  if (!model) return "";
  const id = String(model)
    .replace(/^reaper\//, "")
    .replace(/\s*\([^)]*:\d+\)\s*$/, "")
    .replace(/:(\w+)$/, "");
  const friendly = {
    "deepseek-v4.1-flash-1017": "DeepSeek V4.1 Flash",
    "deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
  };
  return friendly[id] || id;
}

export class Conversation {
  constructor() {
    this.items = [];
    this.byKey = new Map();
    this.byToolCall = new Map();
    this.pendingAssistant = null;
    this.messageSeq = 0;
    this.busy = false;
    this.startedAt = 0;
    this.settledAt = 0;
    this.model = "";
    this.provider = "";
    this.thinkingLevel = "";
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    this.cost = 0;
    this.contextTokens = 0;
    this.contextWindow = 0;
    this.turnStartedAt = 0;
    this.turnFirstTokenAt = 0;
    this.lastTurnMs = 0;
    this.lastTurnTokens = 0;
    this.lastTokPerSec = 0;
    this.error = null;
    this.sessionName = "";
    this.plan = null;
    this.todos = null;
    this.approval = null;
    this.compacting = false;
    this.retry = null;
    this.streamingItem = null;
    this.toolCount = 0;
    this.changed = 0;
  }

  touch() {
    this.changed += 1;
  }

  add(item) {
    item.seq = this.items.length;
    this.items.push(item);
    if (item.key) this.byKey.set(item.key, item);
    if (item.toolCallId) this.byToolCall.set(item.toolCallId, item);
    this.touch();
    return item;
  }

  findTool(toolCallId) {
    return this.byToolCall.get(toolCallId);
  }

  /** The local echo of a prompt: confirmed by the matching message_start. */
  addUser(text, images = []) {
    const item = {
      kind: "user",
      id: nextId("u"),
      text: text || "",
      images,
      at: Date.now(),
      confirmed: false,
    };
    this.add(item);
    return item;
  }

  confirmUser(message, create = true) {
    const text = textOf(message.content);
    const images = Array.isArray(message.content)
      ? message.content.filter((block) => block?.type === "image")
      : [];
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index];
      if (item.kind === "user" && !item.confirmed) {
        item.confirmed = true;
        item.at = message.timestamp || item.at;
        if (!item.text) item.text = text;
        if (images.length) item.images = images;
        this.touch();
        return item;
      }
    }
    return create ? this.addUser(text, images) : null;
  }

  beginAssistant(message) {
    this.messageSeq += 1;
    this.pendingAssistant = {
      key: `a${this.messageSeq}`,
      message,
      startedAt: Date.now(),
      textIndex: 0,
      thinkingIndex: 0,
      toolIndex: 0,
      firstTokenAt: 0,
      toolResults: [],
    };
    this.busy = true;
    this.turnStartedAt = Date.now();
    this.turnFirstTokenAt = 0;
    this.error = null;
    this.touch();
  }

  blockItem(blockIndex, kind, extra = {}) {
    const pending = this.pendingAssistant;
    const key = `${pending.key}b${blockIndex}`;
    let item = this.byKey.get(key);
    if (!item) {
      item = this.add({
        kind,
        id: nextId(kind === "assistant" ? "m" : kind === "thinking" ? "th" : "t"),
        key,
        text: "",
        at: Date.now(),
        status: kind === "tool" ? "queued" : kind === "thinking" ? "running" : "streaming",
        ...extra,
      });
      if (kind === "assistant") this.streamingItem = item;
    }
    return item;
  }

  onEvent(event) {
    switch (event.type) {
      case "message_start": {
        const message = event.message;
        if (!message) break;
        if (message.role === "user") this.confirmUser(message);
        else if (message.role === "assistant") this.beginAssistant(message);
        this.touch();
        break;
      }
      case "message_update": {
        const update = event.assistantMessageEvent || {};
        const pending = this.pendingAssistant;
        if (!pending) break;
        const index = update.contentIndex ?? 0;
        if (update.type === "thinking_start") {
          this.blockItem(index, "thinking");
        } else if (update.type === "thinking_delta") {
          const item = this.blockItem(index, "thinking");
          item.text += update.delta || "";
          if (!this.turnFirstTokenAt) {
            this.turnFirstTokenAt = Date.now();
            pending.firstTokenAt = this.turnFirstTokenAt;
          }
          this.touch();
        } else if (update.type === "thinking_end") {
          const item = this.blockItem(index, "thinking");
          item.text = update.content || item.text;
          item.status = "done";
          item.endedAt = Date.now();
          if (!item.tookMs) item.tookMs = Math.max(0, item.endedAt - item.at);
          this.touch();
        } else if (update.type === "text_start") {
          this.blockItem(index, "assistant");
        } else if (update.type === "text_delta") {
          const item = this.blockItem(index, "assistant");
          item.text += update.delta || "";
          if (!this.turnFirstTokenAt) {
            this.turnFirstTokenAt = Date.now();
            pending.firstTokenAt = this.turnFirstTokenAt;
          }
          this.touch();
        } else if (update.type === "text_end") {
          const item = this.blockItem(index, "assistant");
          item.text = update.content || item.text;
          item.status = "done";
          item.endedAt = Date.now();
          this.touch();
        } else if (update.type === "toolcall_start") {
          const isAgent = update.toolName === "subagent";
          const tool = this.blockItem(index, isAgent ? "agent" : "tool", {
            toolCallId: update.id,
            name: update.toolName,
            args: {},
            rawArgs: "",
            output: "",
          });
          if (isAgent) {
            tool.agentType = "agent";
            tool.agentStatus = "running";
            tool.name = "Subagent";
            tool.stats = { tools: 0, tokens: 0 };
          }
        } else if (update.type === "toolcall_delta") {
          const item = this.blockItem(index, "tool", { toolCallId: update.id, name: update.toolName });
          item.rawArgs += update.delta || "";
        } else if (update.type === "toolcall_end") {
          const toolCall = update.toolCall || {};
          const item = this.blockItem(index, "tool", {
            toolCallId: toolCall.id,
            name: toolCall.name,
            args: toolCall.arguments || {},
          });
          item.args = toolCall.arguments || {};
          item.rawArgs = "";
          if (item.toolCallId) this.byToolCall.set(item.toolCallId, item);
          if (item.name === "subagent") this.promoteAgent(item);
          this.touch();
        } else if (update.type === "error") {
          this.error = update.error || "the model stream failed";
          this.touch();
        }
        break;
      }
      case "message_end": {
        const message = event.message;
        if (!message) break;
        if (message.role === "assistant") this.endAssistant(message);
        else if (message.role === "toolResult") this.endToolResult(message);
        else if (message.role === "user") this.confirmUser(message, false);
        else if (message.role === "compactionSummary") this.addSummary("compaction", message);
        else if (message.role === "branchSummary") this.addSummary("branch", message);
        else if (message.role === "custom" || message.role === "hookMessage") this.addCustom(message);
        else if (message.role === "bashExecution" || message.role === "pythonExecution") this.addExecution(message);
        break;
      }
      case "tool_execution_start": {
        const item = this.findTool(event.toolCallId);
        if (item) {
          item.status = "running";
          item.startedAt = Date.now();
          item.args = item.args || event.args || {};
          if (!item.name) item.name = event.toolName;
          if (item.kind === "agent") item.agentStatus = "running";
        }
        this.touch();
        break;
      }
      case "tool_execution_update": {
        const item = this.findTool(event.toolCallId);
        if (!item) break;
        const partial = event.partialResult || {};
        const text = resultText(partial);
        if (item.kind === "agent") {
          this.agentProgress(item, partial.details, text, false);
        } else {
          const details = partial.details || {};
          const candidate = details.accumulatedOutput || details.output || details.text || text;
          if (typeof candidate === "string" && candidate.length >= (item.output || "").length) {
            item.output = candidate;
          }
          item.partialDetails = details;
        }
        this.touch();
        break;
      }
      case "tool_execution_end": {
        const item = this.findTool(event.toolCallId);
        if (item) {
          item.endedAt = Date.now();
          item.status = event.isError ? "error" : "done";
          item.isError = Boolean(event.isError);
          item.durationMs = event.durationMs ?? Math.max(0, item.endedAt - (item.startedAt || item.at));
          item.result = event.result;
          item.details = event.result?.details || {};
          this.noteTodos(item.details);
          const text = resultText(event.result);
          if (text && !item.output) item.output = text;
          if (item.kind === "agent") this.agentProgress(item, item.details, text, true);
        }
        this.touch();
        break;
      }
      case "turn_end": {
        const pending = this.pendingAssistant;
        if (pending && event.message) {
          for (const result of event.toolResults || []) {
            const item = this.findTool(result.toolCallId);
            if (item) {
              item.isError = item.isError || Boolean(result.isError);
              item.status = item.isError ? "error" : item.status === "queued" ? "done" : item.status;
              item.result = item.result || result;
              item.details = item.details || result.details || {};
              item.durationMs = item.durationMs ?? result.durationMs;
              this.noteTodos(result.details);
              const text = resultText(result);
              if (text && !item.output) item.output = text;
            }
          }
          const assistant = event.message;
          if (assistant.usage) {
            this.usage = {
              input: this.usage.input + (assistant.usage.input || 0),
              output: this.usage.output + (assistant.usage.output || 0),
              cacheRead: this.usage.cacheRead + (assistant.usage.cacheRead || 0),
              cacheWrite: this.usage.cacheWrite + (assistant.usage.cacheWrite || 0),
              total: this.usage.total + (assistant.usage.totalTokens || 0),
            };
            this.contextTokens = assistant.usage.totalTokens || this.contextTokens;
            this.cost += assistant.usage.cost?.total || 0;
          }
          this.lastTurnMs = Date.now() - this.turnStartedAt;
          this.lastTurnTokens = assistant.usage?.output || 0;
          const outputTokens = assistant.usage?.output || 0;
          const decodeMs = Date.now() - (this.turnFirstTokenAt || this.turnStartedAt);
          if (outputTokens > 0 && decodeMs > 0) {
            this.lastTokPerSec = Math.round((outputTokens / decodeMs) * 1000);
          }
        }
        this.pendingAssistant = null;
        this.streamingItem = null;
        this.touch();
        break;
      }
      case "agent_start":
        this.busy = true;
        this.startedAt = Date.now();
        this.touch();
        break;
      case "agent_end":
        this.touch();
        break;
      case "agent_settled":
        this.busy = false;
        this.settledAt = Date.now();
        this.pendingAssistant = null;
        this.streamingItem = null;
        this.touch();
        break;
      case "auto_retry_start":
        this.retry = { attempt: event.attempt, max: event.maxAttempts, delayMs: event.delayMs, error: event.errorMessage };
        this.touch();
        break;
      case "auto_retry_end":
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
          this.addSummary("compaction", {
            summary: event.result.summary,
            tokensBefore: event.result.tokensBefore,
            tokensAfter: event.result.estimatedTokensAfter,
            timestamp: Date.now(),
          });
        }
        this.touch();
        break;
      case "thinking_level_changed":
        this.thinkingLevel = event.level;
        this.touch();
        break;
      case "session_info_changed":
        this.sessionName = event.name || "";
        this.touch();
        break;
      case "entry_appended": {
        const entry = event.entry || {};
        if (entry.type === "custom" && entry.customType === "pi-tsp-plan") {
          this.plan = { ...entry.data, at: Date.now() };
          this.touch();
        } else if (entry.type === "custom" && (entry.data?.todos || entry.data?.todoPhases)) {
          this.noteTodos(entry.data);
        }
        break;
      }
      default:
        break;
    }
  }

  addSummary(kind, message) {
    const summary = contentText(message.summary || message.content || "");
    if (!summary.trim()) return;
    const key = `${kind}:${message.tokensBefore || 0}:${summary.slice(0, 120)}`;
    if (this.byKey.has(key)) return;
    this.add({
      kind,
      id: nextId(kind === "compaction" ? "cmp" : "br"),
      key,
      text: summary,
      tokensBefore: message.tokensBefore,
      tokensAfter: message.tokensAfter,
      method: message.method,
      warning: message.warning,
      status: "done",
      at: message.timestamp || Date.now(),
    });
  }

  addCustom(message) {
    if (message.display === false) return;
    const text = contentText(message.content);
    if (!text.trim()) return;
    const key = `custom:${message.customType || "custom"}:${message.timestamp || 0}:${text.slice(0, 80)}`;
    if (this.byKey.has(key)) return;
    this.add({
      kind: message.role === "hookMessage" ? "hook" : "custom",
      id: nextId("cm"),
      key,
      text,
      customType: message.customType || "extension",
      details: message.details,
      status: "done",
      at: message.timestamp || Date.now(),
    });
  }

  addExecution(message) {
    const kind = message.role === "pythonExecution" ? "python" : "bash";
    const code = kind === "python" ? message.code || "" : message.command || "";
    const output = message.output || "";
    const key = `${kind}:${message.timestamp || 0}:${code.slice(0, 80)}:${output.slice(-80)}`;
    if (this.byKey.has(key)) return;
    this.add({
      kind,
      id: nextId(kind === "python" ? "py" : "sh"),
      key,
      text: code,
      output,
      exitCode: message.exitCode,
      cancelled: message.cancelled,
      truncated: message.truncated,
      status: message.cancelled || (message.exitCode != null && message.exitCode !== 0) ? "error" : "done",
      at: message.timestamp || Date.now(),
    });
  }

  noteTodos(details) {
    const todos = todosFromDetails(details);
    if (!todos) return;
    this.todos = { items: todos, at: Date.now() };
    this.touch();
  }

  endAssistant(message) {
    const pending = this.pendingAssistant;
    const now = Date.now();
    const blocks = Array.isArray(message.content) ? message.content : [];
    if (pending) {
      blocks.forEach((block, index) => {
        if (block.type === "text") {
          const item = this.blockItem(index, "assistant");
          item.text = block.text || item.text;
          item.status = "done";
          item.endedAt = now;
        } else if (block.type === "thinking") {
          const item = this.blockItem(index, "thinking");
          item.text = block.thinking || block.text || item.text;
          item.status = "done";
          item.endedAt = now;
          if (!item.tookMs) item.tookMs = Math.max(0, item.endedAt - item.at);
        } else if (block.type === "toolCall") {
          const item = this.blockItem(index, "tool", {
            toolCallId: block.id,
            name: block.name,
            args: block.arguments || {},
          });
          item.args = block.arguments || item.args;
          item.status = item.status === "queued" ? "queued" : item.status;
          if (item.name === "subagent") this.promoteAgent(item);
        }
      });
    } else {
      // A completed message with no stream (resume, or a provider that sent none).
      blocks.forEach((block, index) => {
        const key = `m${++this.messageSeq}b${index}`;
        if (block.type === "text") {
          this.add({ kind: "assistant", id: nextId("m"), key, text: block.text || "", status: "done", at: message.timestamp || now });
        } else if (block.type === "thinking") {
          this.add({ kind: "thinking", id: nextId("th"), key, text: block.thinking || "", status: "done", at: message.timestamp || now });
        } else if (block.type === "toolCall") {
          const item = this.add({
            kind: "tool",
            id: nextId("t"),
            key,
            toolCallId: block.id,
            name: block.name,
            args: block.arguments || {},
            text: "",
            status: "queued",
            at: message.timestamp || now,
          });
          if (item.name === "subagent") this.promoteAgent(item);
        }
      });
    }
    this.model = message.model || this.model;
    this.provider = message.provider || this.provider;
    if (message.usage) {
      this.contextTokens = message.usage.totalTokens || this.contextTokens;
      this.cost += 0; // turn_end adds it once; a message_end must not double count
    }
    if (message.stopReason === "error") {
      this.error = message.errorMessage || "the model stopped with an error";
    } else if (message.stopReason === "aborted") {
      this.error = null;
      this.add({ kind: "info", id: nextId("i"), text: "Stopped", tone: "muted", at: now });
    }
    const pendingItem = pending ? this.byKey.get(`${pending.key}b0`) : null;
    if (pendingItem && pending.firstTokenAt) pendingItem.ttftMs = pending.firstTokenAt - pending.startedAt;
    this.touch();
  }

  endToolResult(message) {
    const item = this.findTool(message.toolCallId);
    if (!item) return;
    item.status = message.isError ? "error" : "done";
    item.isError = Boolean(message.isError);
    item.result = message;
    item.details = message.details || item.details || {};
    item.durationMs = message.durationMs ?? item.durationMs;
    this.noteTodos(item.details);
    const text = resultText(message);
    if (text && !item.output) item.output = text;
    if (item.kind === "agent") this.agentProgress(item, item.details, text, true);
    this.touch();
  }

  promoteAgent(item) {
    if (item.kind === "agent") return;
    item.kind = "agent";
    item.agentType = item.args?.agent || item.args?.subagent_type || "agent";
    item.name = item.args?.task ? String(item.args.task).split("\n")[0].slice(0, 90) : item.args?.description || "Subagent";
    item.agentStatus = "running";
    item.startedAt = item.startedAt || Date.now();
    item.stats = { tools: 0, tokens: 0 };
  }

  agentProgress(item, details, text, final) {
    const result = details?.results?.[0] || details;
    const progress = result?.progress || details?.progress;
    const configuredAgent = item.args?.agent || item.args?.subagent_type;
    if (configuredAgent) item.agentType = configuredAgent;
    else if (result?.agent && result.agent !== "agent") item.agentType = result.agent;
    if (result?.model) item.model = fmtModel(result.model);
    if (result?.thinking) item.thinking = result.thinking;
    if (result?.sessionName) item.sessionName = result.sessionName;
    if (progress) {
      item.stats = {
        tools: progress.toolCount ?? progress.tools ?? item.stats?.tools ?? 0,
        tokens: progress.tokens ?? (progress.inputTokens || 0) + (progress.outputTokens || 0),
        took: progress.durationMs ?? item.stats?.took,
      };
      item.recentTools = progress.recentTools || item.recentTools;
      item.recentOutput = progress.recentOutput || item.recentOutput;
      if (progress.status) item.agentStatus = progress.status === "completed" ? "done" : progress.status === "failed" ? "failed" : "running";
    }
    if (result?.toolCount != null || result?.totalTokens != null || result?.durationMs != null) {
      item.stats = {
        ...(item.stats || {}),
        tools: result.toolCount ?? item.stats?.tools ?? 0,
        tokens: result.totalTokens ?? item.stats?.tokens ?? 0,
        took: result.durationMs ?? item.stats?.took,
      };
    }
    if (result?.usage) {
      item.stats = {
        ...(item.stats || {}),
        tokens: (result.usage.input || 0) + (result.usage.output || 0) + (result.usage.cacheRead || 0),
        tools: item.stats?.tools ?? 0,
      };
    }
    if (result?.transcriptPath) item.transcriptPath = result.transcriptPath;
    if (result?.artifactPaths?.transcriptPath) item.transcriptPath = result.artifactPaths.transcriptPath;
    if (result?.finalOutput) item.output = result.finalOutput;
    if (final) {
      item.agentStatus = item.isError || (result?.exitCode != null && result.exitCode !== 0) ? "failed" : "done";
      item.endedAt = Date.now();
      if (item.startedAt) item.stats = { ...(item.stats || {}), took: item.endedAt - item.startedAt };
      if (!item.output && text) item.output = text;
      const run = details?.results?.[0];
      if (run?.usage) item.tokens = (run.usage.input || 0) + (run.usage.output || 0);
    } else if (!item.output && text && text !== "(running...)") {
      item.previewOutput = text;
    }
    this.touch();
  }

  /** Rebuild from `get_messages` (resume): user, assistant blocks and tool results. */
  loadMessages(messages = []) {
    this.items = [];
    this.byKey.clear();
    this.byToolCall.clear();
    this.messageSeq = 0;
    this.todos = null;
    let lastAssistantId = null;
    for (const message of messages) {
      if (!message || message.role === "system") continue;
      if (message.role === "compactionSummary") {
        this.addSummary("compaction", message);
        continue;
      }
      if (message.role === "branchSummary") {
        this.addSummary("branch", message);
        continue;
      }
      if (message.role === "custom" || message.role === "hookMessage") {
        this.addCustom(message);
        continue;
      }
      if (message.role === "bashExecution" || message.role === "pythonExecution") {
        this.addExecution(message);
        continue;
      }
      if (message.role === "user") {
        this.addUser(textOf(message.content), Array.isArray(message.content) ? message.content.filter((b) => b?.type === "image") : []);
        this.items.at(-1).confirmed = true;
        if (message.timestamp) this.items.at(-1).at = message.timestamp;
        continue;
      }
      if (message.role === "toolResult") {
        this.endToolResult(message);
        continue;
      }
      if (message.role !== "assistant") continue;
      this.messageSeq += 1;
      lastAssistantId = `m${this.messageSeq}`;
      const blocks = Array.isArray(message.content) ? message.content : [];
      blocks.forEach((block, index) => {
        const key = `${lastAssistantId}b${index}`;
        if (block.type === "text") {
          this.add({ kind: "assistant", id: nextId("m"), key, text: block.text || "", status: "done", at: message.timestamp || Date.now() });
        } else if (block.type === "thinking") {
          this.add({ kind: "thinking", id: nextId("th"), key, text: block.thinking || "", status: "done", at: message.timestamp || Date.now() });
        } else if (block.type === "toolCall") {
          const item = this.add({
            kind: "tool",
            id: nextId("t"),
            key,
            toolCallId: block.id,
            name: block.name,
            args: block.arguments || {},
            text: "",
            status: "queued",
            at: message.timestamp || Date.now(),
          });
          if (item.name === "subagent") this.promoteAgent(item);
        }
      });
      if (message.usage) {
        this.contextTokens = message.usage.totalTokens || this.contextTokens;
        this.usage.total += message.usage.totalTokens || 0;
        this.cost += message.usage.cost?.total || 0;
      }
      this.model = message.model || this.model;
      this.provider = message.provider || this.provider;
    }
    this.busy = false;
    this.pendingAssistant = null;
    this.streamingItem = null;
    this.touch();
  }
}

export { fmtModel };
