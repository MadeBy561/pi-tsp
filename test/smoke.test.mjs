import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fmtModel } from "../src/state.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = join(root, "bin", "pi-tsp");

test("fmtModel gives the local route a friendly name", () => {
  assert.equal(fmtModel("reaper/deepseek-v4.1-flash-1017"), "DeepSeek V4.1 Flash");
  assert.equal(fmtModel("deepseek-v4.1-flash"), "DeepSeek V4.1 Flash");
  assert.equal(fmtModel("DeepSeek V4.1 Flash 1017 (Reaper :5001)"), "DeepSeek V4.1 Flash 1017");
  assert.equal(fmtModel("some-other-model"), "some-other-model");
});

test("the launcher falls back to stock pi for --version", (t) => {
  const probe = spawnSync("pi", ["--version"], { encoding: "utf8" });
  if (probe.error) {
    t.skip("pi is not installed in this environment");
    return;
  }
  const out = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  assert.match(out, /^\d+\.\d+\.\d+/);
});
