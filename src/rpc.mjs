/**
 * A JSONL client for `pi --mode rpc`.
 *
 * Framing is strict: records split on LF only (U+2028 inside a JSON string is
 * legal and must not split a record), and stdout is read continuously so the
 * child never blocks on a full pipe. Commands correlate by id; events stream
 * to listeners with the raw record.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export class PiRpc extends EventEmitter {
  constructor({ bin, args = [], cwd = process.cwd(), env = {} } = {}) {
    super();
    this.bin = bin;
    this.args = args;
    this.cwd = cwd;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.exited = false;
    this.exitCode = null;
    this.child = spawn(bin, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env, PI_CODING_AGENT: "true", AI_AGENT: "pi" },
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-16000);
      this.emit("stderr", chunk);
    });
    this.child.on("error", (error) => this.emit("error", error));
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.emit("exit", { code, signal });
      for (const { reject } of this.pending.values()) reject(new Error("pi exited"));
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        this.emit("malformed", line);
        continue;
      }
      if (record.type === "response") {
        const pending = this.pending.get(record.id);
        if (pending) {
          this.pending.delete(record.id);
          if (record.success) pending.resolve(record.data ?? {});
          else pending.reject(new Error(record.error || `${record.command} failed`));
        }
        this.emit("response", record);
        continue;
      }
      this.emit("event", record);
    }
  }

  command(type, fields = {}, timeoutMs = 30000) {
    const id = `c${++this.nextId}`;
    const record = { id, type, ...fields };
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new Error("pi is not running"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out: ${type}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify(record)}\n`);
    });
  }

  respondExtensionUi(id, body) {
    this.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...body })}\n`);
  }

  async stop() {
    if (this.exited) return;
    try {
      this.child.stdin.end();
    } catch {
      /* already gone */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.child.kill("SIGTERM");
        } catch {
          /* gone */
        }
        resolve();
      }, 1500);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
