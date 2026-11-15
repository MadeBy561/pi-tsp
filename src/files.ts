/** The project's files for `@` completion: git's list when there is one, else a bounded walk. */
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const MAX_FILES = 20_000;
const SKIP = new Set(["node_modules", ".git", "dist", "build", "target", ".venv", "__pycache__", ".next", ".cache"]);

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, rel: string, depth: number): void => {
    if (depth > 6 || out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        out.push(`${path}/`);
        visit(join(dir, entry.name), path, depth + 1);
      } else out.push(path);
      if (out.length >= MAX_FILES) return;
    }
  };
  visit(root, "", 0);
  return out;
}

/** Lists the project once and again when asked after `ttlMs`. */
export class FileIndex {
  #cwd: string;
  #files: string[] = [];
  #at = 0;
  #loading: Promise<void> | null = null;

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  /** The files known now; starts a refresh when the list is older than `ttlMs`. */
  list(onReady: () => void, ttlMs = 15_000): readonly string[] {
    if (!this.#loading && Date.now() - this.#at > ttlMs) {
      this.#loading = this.#load().then(() => {
        this.#loading = null;
        onReady();
      });
    }
    return this.#files;
  }

  #load(): Promise<void> {
    return new Promise(resolve => {
      execFile("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: this.#cwd, maxBuffer: 32 * 1024 * 1024, timeout: 4000 }, (error, stdout) => {
        const listed = error ? [] : stdout.split("\n").filter(Boolean).slice(0, MAX_FILES);
        if (listed.length) {
          const dirs = new Set<string>();
          for (const file of listed) {
            const parts = file.split("/");
            for (let depth = 1; depth < parts.length && depth <= 4; depth += 1) dirs.add(`${parts.slice(0, depth).join("/")}/`);
          }
          this.#files = [...dirs, ...listed];
        } else this.#files = walk(this.#cwd);
        this.#at = Date.now();
        resolve();
      });
    });
  }
}
