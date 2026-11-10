/**
 * Where pi lives, and where a subagent runtime writes its transcripts.
 *
 * Both the launcher and the surface have to find pi: the launcher execs it
 * outside Tern, and the surface spawns `pi --mode rpc` inside it. A hardcoded
 * /usr/local/bin/pi is wrong on Homebrew (arm64), asdf/mise shims and an npm
 * prefix install — the spawn then fails with ENOENT before a surface exists.
 */
import { existsSync, readdirSync } from "node:fs";
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
