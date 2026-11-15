/**
 * A subagent's transcript, read from the file its runtime writes and turned
 * into nodes for the transcript sheet.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Item } from "./model.js";
import { subagentTaskDirs } from "./paths.js";
import { firstLine, h, s, type Node } from "./view/h.js";

/** The transcript file of an agent run, when its runtime wrote one. */
export function transcriptPath(agent: Item, cwd: string, sessionId: string): string {
  if (agent.transcriptPath && existsSync(agent.transcriptPath)) return agent.transcriptPath;
  if (agent.asyncDir) {
    // pi-subagents keeps a status file per background run that names each step's session.
    try {
      const status = JSON.parse(readFileSync(join(agent.asyncDir, "status.json"), "utf8")) as { steps?: { transcriptPath?: string; sessionFile?: string }[] };
      const path = status.steps?.[0]?.transcriptPath || status.steps?.[0]?.sessionFile;
      if (path && existsSync(path)) return path;
    } catch {
      /* no status yet */
    }
  }
  if (agent.runId) {
    // @tintinweb/pi-subagents streams turns to `<tmp>/pi-subagents-<uid>/<cwd>/<session>/tasks/<id>.output`.
    for (const dir of subagentTaskDirs({ cwd, sessionId })) {
      const path = join(dir, `${agent.runId}.output`);
      if (existsSync(path)) return path;
    }
  }
  return "";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(block => block?.type === "text")
    .map(block => block.text || "")
    .join("\n");
}

function target(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "pattern", "query", "url", "description"]) {
    if (typeof record[key] === "string" && record[key]) return firstLine(record[key], 160);
  }
  return "";
}

/** The nodes of a transcript file's records. */
export function transcriptNodes(path: string): Node[] {
  const records = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as Record<string, any>];
      } catch {
        return [];
      }
    });
  const nodes: Node[] = [];
  let index = 0;
  let lastUser = "";
  const starts = new Map<string, Record<string, any>>();
  // Some runtimes write tool_start/tool_end records beside the messages; the
  // assistant's own toolCall blocks are drawn only when those are absent.
  const hasToolRecords = records.some(record => record.recordType === "tool_start" || record.recordType === "tool_end");
  const tool = (name: string, what: string, failed: boolean): Node =>
    h("tool", { key: `t${index++}`, name: name.toLowerCase(), title: name, target: what || undefined, targetKind: "text", status: failed ? "error" : "done", frame: "inline", collapsible: false });
  for (const record of records) {
    if (record.recordType === "tool_start") {
      starts.set(record.toolCallId, record);
      continue;
    }
    if (record.recordType === "tool_end") {
      const start = starts.get(record.toolCallId);
      nodes.push(tool(String(start?.toolName || "tool"), firstLine(start?.argsPreview ?? "", 160), Boolean(record.isError)));
      continue;
    }
    const message = record.message;
    if (!message) continue;
    if (message.role === "user") {
      // The runtime's own bookkeeping lines are not part of the conversation.
      const text = textOf(message.content)
        .split("\n")
        .filter(line => !/^\s*(Output:|This path is authoritative|Ignore any other output|\[prompt redacted\])/i.test(line))
        .join("\n")
        .trim();
      if (!text || text === lastUser) continue;
      lastUser = text;
      nodes.push(h("card", { key: `u${index++}`, role: "omp.user", tone: "user" }, [h("md", { key: "text", text })]));
    } else if (message.role === "assistant") {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === "thinking" && block.thinking) {
          nodes.push(h("section", { key: `k${index++}`, role: "omp.thinking", head: [s("Thought", "muted")], collapsible: true, collapsed: true }, [h("md", { key: "body", text: block.thinking })]));
        } else if (block.type === "text" && block.text?.trim()) {
          nodes.push(h("md", { key: `a${index++}`, text: block.text }));
        } else if (block.type === "toolCall" && !hasToolRecords) {
          nodes.push(tool(String(block.name || "tool"), target(block.arguments), false));
        }
      }
    } else if (message.role === "toolResult") {
      const text = textOf(message.content).trim();
      if (text) nodes.push(h("ansi", { key: `r${index++}`, text: text.slice(0, 8000), preview: { lines: 6 } }));
    }
  }
  return nodes;
}
