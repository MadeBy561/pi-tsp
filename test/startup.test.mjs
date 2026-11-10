import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiTsp } from "../src/ui.mjs";

test("a missing pi reports the path and does not wait for get_state to time out", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-tsp-startup-"));
  const saved = { home: process.env.PI_TSP_HOME, pin: process.env.PI_TSP_PI };
  process.env.PI_TSP_HOME = home;
  process.env.PI_TSP_PI = join(home, "missing-pi");
  try {
    const app = new PiTsp({ hello: { v: 1, kinds: [], dark: true }, args: [], cwd: home });
    app.schedule = () => {};
    const started = Date.now();
    await app.startRpc();
    const elapsed = Date.now() - started;
    assert.match(app.conv.error, /missing-pi/);
    assert.ok(elapsed < 3000, `startup took ${elapsed}ms; the get_state timeout is still in the path`);
  } finally {
    if (saved.home === undefined) delete process.env.PI_TSP_HOME;
    else process.env.PI_TSP_HOME = saved.home;
    if (saved.pin === undefined) delete process.env.PI_TSP_PI;
    else process.env.PI_TSP_PI = saved.pin;
  }
});

test("a pi that exits during startup keeps its exit code and stderr", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-tsp-startup-"));
  const fake = join(home, "fake-pi");
  writeFileSync(fake, "#!/bin/sh\necho 'extension failed to load' >&2\nexit 7\n", { mode: 0o755 });
  const saved = { home: process.env.PI_TSP_HOME, pin: process.env.PI_TSP_PI };
  process.env.PI_TSP_HOME = home;
  process.env.PI_TSP_PI = fake;
  try {
    const app = new PiTsp({ hello: { v: 1, kinds: [], dark: true }, args: [], cwd: home });
    app.schedule = () => {};
    await app.startRpc();
    assert.match(app.conv.error, /pi exited \(7\)/);
    assert.match(app.conv.error, /extension failed to load/);
    assert.doesNotMatch(app.conv.error, /pi is not running|could not start pi/);
  } finally {
    if (saved.home === undefined) delete process.env.PI_TSP_HOME;
    else process.env.PI_TSP_HOME = saved.home;
    if (saved.pin === undefined) delete process.env.PI_TSP_PI;
    else process.env.PI_TSP_PI = saved.pin;
  }
});

test("a prompt rejected after the child exits keeps the exit reason", async () => {
  const app = new PiTsp({ hello: { v: 1, kinds: [], dark: true }, args: [], cwd: process.cwd() });
  app.schedule = () => {};
  let rejectCommand;
  app.rpc = {
    exited: false,
    command: () => new Promise((_, reject) => { rejectCommand = reject; }),
  };
  app.sendPrompt("hello");
  app.conv.error = "pi exited (7)\n\nextension failed to load";
  app.rpc.exited = true;
  rejectCommand(new Error("pi is not running"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(app.conv.error, /pi exited \(7\)/);
  assert.match(app.conv.error, /extension failed to load/);
});
