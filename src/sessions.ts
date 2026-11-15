/**
 * pi session discovery for the resume picker.
 *
 * pi stores one JSONL per session under <session-dir>/<project-slug>/. The
 * first record is the session header; message entries carry the conversation.
 * We read just enough of each file to label it and never load a transcript
 * until it is chosen.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

export interface SessionRow {
  id: string;
  path: string;
  title: string;
  name: string;
  cwd: string;
  preview: string;
  previewMessages: { role: string; text: string }[];
  when: string;
  mtime: number;
  messages: number;
  size: string;
  current: boolean;
}

interface Head {
  header: Record<string, any> | null;
  title: string;
  name: string;
  messages: number;
  last: string;
  preview: string;
  recent: { role: string; text: string }[];
}

export function defaultSessionDir(): string {
  return process.env.PI_CODING_AGENT_SESSION_DIR || join(homedir(), ".pi", "agent", "sessions");
}

function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 4) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out, depth + 1);
    else if (entry.name.endsWith(".jsonl")) out.push(path);
  }
}

function readHead(path: string): Head | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  let header: Record<string, any> | null = null;
  let title = "";
  let name = "";
  let messages = 0;
  let last = "";
  let preview = "";
  const recent: { role: string; text: string }[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: Record<string, any>;
    try {
      record = JSON.parse(line) as Record<string, any>;
    } catch {
      continue;
    }
    if (!header && record.type === "session") {
      header = record;
      continue;
    }
    if (record.type === "session_info" && typeof record.name === "string") name = record.name;
    if (record.type === "message" && record.message) {
      const role = record.message.role;
      if (role === "user" || role === "assistant") messages += 1;
      const content = record.message.content;
      const text = typeof content === "string"
        ? content
        : (Array.isArray(content) ? content : []).filter((block: any) => block?.type === "text").map((block: any) => block.text).join(" ");
      // A preview is one flowing line: heading marks, table rules and fences would only be noise in it.
      const plain = String(text || "")
        .replace(/^```.*$/gm, "")
        .replace(/^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/gm, "")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^[ \t]*\|[ \t]*|[ \t]*\|[ \t]*$/gm, "")
        .replace(/[ \t]*\|[ \t]*/g, " · ")
        .replace(/\*\*|__|`/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (role === "user" && !title) {
        title = plain.slice(0, 90);
      }
      if ((role === "user" || role === "assistant") && plain) {
        preview = plain.slice(0, 240);
        recent.push({ role, text: plain.slice(0, 500) });
        if (recent.length > 8) recent.shift();
      }
      if (record.timestamp) last = record.timestamp;
    }
  }
  if (!header && messages === 0) return null;
  return { header, title, name, messages, last, preview, recent };
}

export function relative(iso: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function listSessions(sessionDir: string | undefined, cwd: string, limit = 200): SessionRow[] {
  const dir = sessionDir || defaultSessionDir();
  const files: string[] = [];
  walk(dir, files);
  const rows: SessionRow[] = [];
  for (const path of files) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    const head = readHead(path);
    if (!head) continue;
    const id = String(head.header?.id || basename(path).replace(/\.jsonl$/, ""));
    rows.push({
      id,
      path,
      title: head.title,
      name: head.name,
      cwd: head.header?.cwd || "",
      preview: head.preview || "",
      previewMessages: head.recent || [],
      when: relative(head.last || head.header?.timestamp || stat.mtime.toISOString()),
      mtime: stat.mtimeMs,
      messages: head.messages,
      size: bytes(stat.size),
      current: false,
    });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  // Prefer this project's sessions, but keep the rest behind them so a
  // resume is never impossible because the cwd changed.
  const mine = rows.filter((row) => row.cwd === cwd);
  const rest = rows.filter((row) => row.cwd !== cwd);
  return [...mine, ...rest].slice(0, limit);
}

export function sessionPath(dir: string, id: string): string {
  return join(dir, `${id}.jsonl`);
}
