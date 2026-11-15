/**
 * Where pi lives, and where a subagent runtime writes its transcripts.
 *
 * Both the launcher and the surface have to find pi: the launcher execs it
 * outside Tern, and the surface spawns `pi --mode rpc` inside it.
 */
import { existsSync, readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

/** The stock pi binary: `PI_TSP_PI`, else `pi` (or `pi-bolt`) on PATH. */
export function stockPath({ skip = process.argv[1] }: { skip?: string } = {}): string {
  if (process.env.PI_TSP_PI) return process.env.PI_TSP_PI;
  for (const name of ["pi", "pi-bolt"]) {
    for (const dir of (process.env.PATH || "").split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, name);
      if (candidate === skip) continue;
      if (existsSync(candidate)) return candidate;
    }
  }
  return "pi";
}

/** `/home/u/proj` → `home-u-proj`, the per-project key pi-subagents uses for scratch dirs. */
export function encodeCwd(cwd = ""): string {
  return String(cwd)
    .replace(/[/\\]/g, "-")
    .replace(/^[A-Za-z]:-/, "")
    .replace(/^-+/, "");
}

/**
 * Candidate task directories for pi-subagents' streamed agent transcripts,
 * `<tmp>/pi-subagents-<uid>/<encoded-cwd>/<session>/tasks`. The session id in
 * the path changes on resume, so every session dir for this project is a
 * candidate, the recorded one first.
 */
export function subagentTaskDirs({
  cwd = "",
  sessionId = "",
  home = tmpdir(),
  uid = process.getuid?.() ?? 0,
}: { cwd?: string; sessionId?: string; home?: string; uid?: number } = {}): string[] {
  const root = join(home, `pi-subagents-${uid}`, encodeCwd(cwd));
  const dirs: string[] = [];
  if (sessionId) dirs.push(join(root, sessionId, "tasks"));
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== sessionId) dirs.push(join(root, entry.name, "tasks"));
    }
  } catch {
    /* no scratch dir for this project yet */
  }
  return dirs;
}

/** Tool names an extension source registers, read without importing it. */
export function toolNamesInSource(source = ""): Set<string> {
  const names = new Set<string>();
  const marker = "registerTool(";
  let index = source.indexOf(marker);
  while (index >= 0) {
    const match = source.slice(index, index + 600).match(/name\s*:\s*["']([\w-]+)["']/);
    if (match?.[1]) names.add(match[1]);
    index = source.indexOf(marker, index + marker.length);
  }
  return names;
}

/**
 * Every tool name the extensions at `roots` register. A root may be a
 * directory or a single extension file, and symlinks are followed.
 *
 * pi treats a duplicate tool name as an extension load error that takes the
 * session down, so the surface reads the files on disk before it spawns pi and
 * leaves out its own extension when the user's config already owns the name.
 */
export function toolNamesRegisteredUnder(
  roots: readonly string[] = [],
  { depth = 2, maxBytes = 256 * 1024 }: { depth?: number; maxBytes?: number } = {},
): Set<string> {
  const names = new Set<string>();
  const readNames = (path: string, target: Stats): void => {
    if (!/\.(ts|js|mjs|cjs)$/.test(path)) return;
    let source: string;
    try {
      if (target.size > maxBytes) return;
      source = readFileSync(path, "utf8");
    } catch {
      return;
    }
    for (const name of toolNamesInSource(source)) names.add(name);
  };
  const visit = (dir: string, level: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      let target: Stats;
      try {
        // stat (not lstat): a file linked from a dotfiles directory is scanned like a real one.
        target = statSync(path);
      } catch {
        continue;
      }
      if (target.isDirectory()) {
        if (level < depth && entry.name !== "node_modules") visit(path, level + 1);
        continue;
      }
      readNames(path, target);
    }
  };
  for (const entry of roots) {
    let target: Stats;
    try {
      target = statSync(entry);
    } catch {
      continue;
    }
    if (target.isDirectory()) visit(entry, 0);
    else readNames(entry, target);
  }
  return names;
}
