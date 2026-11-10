import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCwd, stockPath, subagentTaskDirs } from "../src/paths.mjs";

test("encodeCwd matches the pi-subagents scratch-dir key", () => {
  assert.equal(encodeCwd("/Users/jg/Code/pi-tsp"), "Users-jg-Code-pi-tsp");
  assert.equal(encodeCwd("/"), "");
});

test("stockPath honours PI_TSP_PI and then PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tsp-paths-"));
  const fake = join(dir, "pi");
  writeFileSync(fake, "#!/bin/sh\n", { mode: 0o755 });
  const saved = { path: process.env.PATH, pin: process.env.PI_TSP_PI };
  delete process.env.PI_TSP_PI;
  process.env.PATH = `${dir}:/nonexistent`;
  assert.equal(stockPath(), fake);
  process.env.PI_TSP_PI = "/custom/pi";
  assert.equal(stockPath(), "/custom/pi");
  process.env.PATH = saved.path;
  if (saved.pin === undefined) delete process.env.PI_TSP_PI;
  else process.env.PI_TSP_PI = saved.pin;
});

test("subagentTaskDirs finds the session dir and every sibling", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-tsp-tasks-"));
  const root = join(home, "pi-subagents-501", encodeCwd("/work/proj"));
  mkdirSync(join(root, "session-a", "tasks"), { recursive: true });
  mkdirSync(join(root, "session-b", "tasks"), { recursive: true });
  const dirs = subagentTaskDirs({ cwd: "/work/proj", sessionId: "session-b", home, uid: 501 });
  assert.equal(dirs[0], join(root, "session-b", "tasks"));
  assert.ok(dirs.includes(join(root, "session-a", "tasks")));
});
