/**
 * A JSONL client for `pi --mode rpc`.
 *
 * Framing is strict: records split on LF only (U+2028 inside a JSON string is
 * legal and must not split a record), and stdout is read continuously so the
 * child never blocks on a full pipe. Commands correlate by id; events stream
 * to listeners with the raw record.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

/** A JSON record from pi: an event or a response. */
export type RpcRecord = Record<string, any>;

export interface RpcOptions {
  bin: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface Pending {
  resolve(value: any): void;
  reject(error: Error): void;
}

/**
 * Events: `event` (record), `stderr` (chunk), `exit` ({code, signal}),
 * `error` (spawn failure).
 */
export class PiRpc extends EventEmitter {
  readonly bin: string;
  stderr = "";
  exited = false;
  exitCode: number | null = null;
  #nextId = 0;
  #pending = new Map<string, Pending>();
  #buffer = "";
  #child: ChildProcessWithoutNullStreams;

  constructor({ bin, args = [], cwd = process.cwd(), env = {} }: RpcOptions) {
    super();
    this.bin = bin;
    this.#child = spawn(bin, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env, PI_CODING_AGENT: "true", AI_AGENT: "pi" },
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#onData(chunk));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-16000);
      this.emit("stderr", chunk);
    });
    // A write to a child that already exited must not take the surface down.
    this.#child.stdin.on("error", () => undefined);
    this.#child.on("error", (error: Error) => {
      // A spawn failure has no exit event and no process to answer commands.
      if (this.exited) return;
      this.exited = true;
      this.#settle(error);
      this.emit("error", error);
    });
    this.#child.on("exit", (code, signal) => {
      if (this.exited) return;
      this.exited = true;
      this.exitCode = code;
      this.#settle(new Error("pi exited"));
      this.emit("exit", { code, signal });
    });
  }

  #settle(error: Error): void {
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const index = this.#buffer.indexOf("\n");
      if (index < 0) break;
      let line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let record: RpcRecord;
      try {
        record = JSON.parse(line) as RpcRecord;
      } catch {
        this.emit("malformed", line);
        continue;
      }
      if (record.type === "response") {
        const pending = this.#pending.get(record.id);
        if (pending) {
          this.#pending.delete(record.id);
          if (record.success) pending.resolve(record.data ?? {});
          else pending.reject(new Error(record.error || `${record.command} failed`));
        }
        continue;
      }
      this.emit("event", record);
    }
  }

  /** Sends a command and resolves with its `data`. */
  command<T = any>(type: string, fields: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    const id = `c${++this.#nextId}`;
    return new Promise<T>((resolve, reject) => {
      if (this.exited) {
        reject(new Error("pi is not running"));
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timed out: ${type}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#child.stdin.write(`${JSON.stringify({ ...fields, id, type })}\n`);
    });
  }

  /** Answers an `extension_ui_request`. */
  respondExtensionUi(id: string, body: { value: string } | { confirmed: boolean } | { cancelled: true }): void {
    if (this.exited) return;
    this.#child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...body })}\n`);
  }

  /** Ends stdin and waits for the child; SIGTERM after `graceMs`. */
  async stop(graceMs = 1500): Promise<void> {
    if (this.exited) return;
    try {
      this.#child.stdin.end();
    } catch {
      /* already gone */
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        try {
          this.#child.kill("SIGTERM");
        } catch {
          /* gone */
        }
        resolve();
      }, graceMs);
      this.#child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
