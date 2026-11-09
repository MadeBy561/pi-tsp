/**
 * pi session discovery for the resume picker.
 *
 * pi stores one JSONL per session under <session-dir>/<project-slug>/. The
 * first record is the session header; message entries carry the conversation.
 * We read just enough of each file to label it and never load a transcript
 * until it is chosen.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function defaultSessionDir() {
  return process.env.PI_CODING_AGENT_SESSION_DIR || join(homedir(), ".pi", "agent", "sessions");
}

function walk(dir, out, depth = 0) {
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

function readHead(path) {
  let text;
  try {
    const fd = readFileSync(path, "utf8");
    text = fd;
  } catch {
    return null;
  }
  const lines = text.split("\n");
  let header = null;
  let title = "";
  let messages = 0;
  let last = "";
  let preview = "";
  const recent = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!header && record.type === "session") {
      header = record;
      continue;
    }
    if (record.type === "message" && record.message) {
      const role = record.message.role;
      if (role === "user" || role === "assistant") messages += 1;
      const content = record.message.content;
      const text = typeof content === "string"
        ? content
        : (content || []).filter((block) => block.type === "text").map((block) => block.text).join(" ");
      if (role === "user" && !title) {
        title = String(text || "").replace(/\s+/g, " ").slice(0, 90);
      }
      if ((role === "user" || role === "assistant") && text) {
        preview = String(text).replace(/\s+/g, " ").trim().slice(0, 240);
        recent.push({ role, text: String(text).replace(/\s+/g, " ").trim().slice(0, 500) });
        if (recent.length > 8) recent.shift();
      }
      if (record.timestamp) last = record.timestamp;
    }
  }
  if (!header && messages === 0) return null;
  return { header, title, messages, last, preview, recent };
}

function relative(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function bytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export async function listSessions(sessionDir, cwd, limit = 40) {
  const dir = sessionDir || defaultSessionDir();
  const files = [];
  walk(dir, files);
  const rows = [];
  for (const path of files) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    const head = readHead(path);
    if (!head) continue;
    const id = head.header?.id || path.split("/").pop().replace(/\.jsonl$/, "");
    rows.push({
      id,
      path,
      title: head.title,
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
  return [...mine, ...rest].slice(0, limit).map((row, index) => ({ ...row, current: index === 0 && row.cwd === cwd }));
}

export function sessionPath(dir, id) {
  return join(dir, `${id}.jsonl`);
}
