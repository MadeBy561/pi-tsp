import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PiTsp } from "../src/ui.mjs";

const surface = (cwd, args = []) => new PiTsp({ hello: { v: 1, kinds: [], dark: true }, leftover: null, args, cwd });
const names = (app) => app.extensionPaths().map((path) => basename(path)).sort();

test("pi-tsp loads its own todo extension when nobody else registers todo", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-tsp-home-"));
  const saved = process.env.PI_TSP_HOME;
  process.env.PI_TSP_HOME = home;
  try {
    assert.deepEqual(names(surface(mkdtempSync(join(tmpdir(), "pi-tsp-proj-")))), [
      "permissions.ts", "plan.ts", "todo.ts", "tree.ts",
    ]);
  } finally {
    if (saved === undefined) delete process.env.PI_TSP_HOME;
    else process.env.PI_TSP_HOME = saved;
  }
});

test("pi-tsp skips its own todo extension when the user's config registers todo", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-tsp-home-"));
  const saved = process.env.PI_TSP_HOME;
  process.env.PI_TSP_HOME = home;
  try {
    // The surface symlinks ~/.pi/agent/extensions here; pi treats a second
    // `todo` tool as a load error and the session dies with it.
    const extensions = join(home, "agent", "extensions");
    mkdirSync(extensions, { recursive: true });
    writeFileSync(join(extensions, "todo.ts"), 'export default (pi) => pi.registerTool({ name: "todo" });\n');
    assert.deepEqual(names(surface(mkdtempSync(join(tmpdir(), "pi-tsp-proj-")))), [
      "permissions.ts", "plan.ts", "tree.ts",
    ]);
  } finally {
    if (saved === undefined) delete process.env.PI_TSP_HOME;
    else process.env.PI_TSP_HOME = saved;
  }
});

test("pi-tsp skips its own todo when the user's todo is a symlinked file", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-tsp-home-"));
  const targetDir = mkdtempSync(join(tmpdir(), "pi-tsp-target-"));
  const saved = process.env.PI_TSP_HOME;
  process.env.PI_TSP_HOME = home;
  try {
    const extensions = join(home, "agent", "extensions");
    mkdirSync(extensions, { recursive: true });
    const target = join(targetDir, "user-todo.ts");
    writeFileSync(target, 'export default (pi) => pi.registerTool({ name: "todo" });\n');
    symlinkSync(target, join(extensions, "todo.ts"));
    assert.deepEqual(names(surface(mkdtempSync(join(tmpdir(), "pi-tsp-proj-")))), [
      "permissions.ts", "plan.ts", "tree.ts",
    ]);
  } finally {
    if (saved === undefined) delete process.env.PI_TSP_HOME;
    else process.env.PI_TSP_HOME = saved;
  }
});

test("pi-tsp skips its own todo when --extension supplies a todo file", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-tsp-home-"));
  const targetDir = mkdtempSync(join(tmpdir(), "pi-tsp-target-"));
  const saved = process.env.PI_TSP_HOME;
  process.env.PI_TSP_HOME = home;
  try {
    const target = join(targetDir, "explicit-todo.ts");
    writeFileSync(target, 'export default (pi) => pi.registerTool({ name: "todo" });\n');
    const project = mkdtempSync(join(tmpdir(), "pi-tsp-proj-"));
    assert.deepEqual(names(surface(project, ["--extension", target])), [
      "permissions.ts", "plan.ts", "tree.ts",
    ]);
    assert.deepEqual(names(surface(project, [`--extension=${target}`])), [
      "permissions.ts", "plan.ts", "tree.ts",
    ]);
  } finally {
    if (saved === undefined) delete process.env.PI_TSP_HOME;
    else process.env.PI_TSP_HOME = saved;
  }
});
