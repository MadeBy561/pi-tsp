/**
 * Where pi lives, and where a subagent runtime writes its transcripts.
 *
 * Both the launcher and the surface have to find pi: the launcher execs it
 * outside Tern, and the surface spawns `pi --mode rpc` inside it. A hardcoded
 * /usr/local/bin/pi is wrong on Homebrew (arm64), asdf/mise shims and an npm
 * prefix install — the spawn then fails with ENOENT before a surface exists.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

export function stockPath({ skip = process.argv[1] } = {}) {
  if (process.env.PI_TSP_PI) return process.env.PI_TSP_PI;
  for (const name of ["pi", "pi-bolt"]) {
    for (const dir of (process.env.PATH || "").split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, name);
      if (candidate === skip) continue;
      if (existsSync(candidate)) return candidate;
    }
  }
  return "/usr/local/bin/pi";
}

/** `/home/u/proj` → `home-u-proj`, the per-project key pi-subagents uses for scratch dirs. */
export function encodeCwd(cwd = "") {
  return String(cwd)
    .replace(/[/\\]/g, "-")
    .replace(/^[A-Za-z]:-/, "")
    .replace(/^-+/, "");
}

/**
 * Candidate task directories for pi-subagents' streamed agent transcripts,
 * `<tmp>/pi-subagents-<uid>/<encoded-cwd>/<session>/tasks`. The session id in
 * the path changes on resume, so every session dir for this project is a
 * candidate — the recorded one first.
 */
export function subagentTaskDirs({ cwd = "", sessionId = "", home = tmpdir(), uid = process.getuid?.() ?? 0 } = {}) {
  const root = join(home, `pi-subagents-${uid}`, encodeCwd(cwd));
  const dirs = [];
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
export function toolNamesInSource(source = "") {
  const names = new Set();
  const marker = "registerTool(";
  let index = source.indexOf(marker);
  while (index >= 0) {
    const match = source.slice(index, index + 600).match(/name\s*:\s*["']([\w-]+)["']/);
    if (match) names.add(match[1]);
    index = source.indexOf(marker, index + marker.length);
  }
  return names;
}

/**
 * Every tool name the extensions under `dirs` register.
 *
 * pi treats a duplicate tool name as an extension load error, and it takes the
 * session down with it — a pi setup that already has a hand-rolled `todo` tool
 * dies on pi-tsp's own ext/todo.ts. It cannot be settled at load time (an
 * extension cannot ask what is registered while it is still loading), so the
 * surface reads the files on disk before it spawns pi.
 */
export function toolNamesRegisteredUnder(dirs = [], { depth = 2, maxBytes = 256 * 1024 } = {}) {
  const names = new Set();
  const visit = (dir, level) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (level < depth && entry.name !== "node_modules") visit(path, level + 1);
        continue;
      }
      if (!/\.(ts|js|mjs|cjs)$/.test(entry.name)) continue;
      let source;
      try {
        if (statSync(path).size > maxBytes) continue;
        source = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      for (const name of toolNamesInSource(source)) names.add(name);
    }
  };
  for (const dir of dirs) visit(dir, 0);
  return names;
}
