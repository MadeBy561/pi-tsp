#!/usr/bin/env node
/**
 * pi-tsp launcher: inside Tern it opens a native surface; anywhere else it is
 * exactly stock pi. Nothing about the fallback is special-cased: the stock
 * binary is found on PATH and exec'd with the original argv.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ensureConfig } from "./setup.mjs";

const ST = "\x1b\\";
const APC = "\x1b_tsp;";

function stockPath() {
  if (process.env.PI_TSP_PI) return process.env.PI_TSP_PI;
  for (const name of ["pi", "pi-bolt"]) {
    for (const dir of (process.env.PATH || "").split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, name);
      if (candidate === process.argv[1]) continue;
      if (existsSync(candidate)) return candidate;
    }
  }
  return "/usr/local/bin/pi";
}

function runStock(args) {
  const bin = stockPath();
  const child = spawn(bin, args, {
    stdio: "inherit",
    env: { ...process.env, PI_TSP_STOCK: "1" },
  });
  child.on("error", (error) => {
    process.stderr.write(`pi-tsp: could not run pi (${bin}): ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

function nativeEligible(args) {
  if (!process.stdin.isTTY) return false;
  const blocked = new Set(["-p", "--print", "-h", "--help", "--version", "-v", "--export", "--list-models"]);
  if (args.some((arg) => blocked.has(arg.split("=")[0]))) return false;
  const modeIndex = args.findIndex((arg) => arg === "--mode" || arg.startsWith("--mode="));
  if (modeIndex >= 0) {
    const mode = args[modeIndex].includes("=") ? args[modeIndex].split("=")[1] : args[modeIndex + 1];
    if (mode && mode !== "text") return false;
  }
  const command = args[0];
  if (command && ["install", "remove", "uninstall", "update", "list", "config", "auth", "mcp"].includes(command)) return false;
  return true;
}

function probe(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let buffer = "";
    let done = false;
    const finish = (hello, leftover) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* not a tty */
      }
      process.stdin.pause();
      resolve({ hello, leftover });
    };
    const onData = (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const start = buffer.indexOf(APC);
        if (start < 0) return;
        const end = buffer.indexOf(ST, start + APC.length);
        if (end < 0) return;
        const inner = buffer.slice(start + APC.length, end);
        const before = buffer.slice(0, start);
        buffer = buffer.slice(end + 2);
        const brace = inner.indexOf("{");
        if (brace < 0) continue;
        let body;
        try {
          body = JSON.parse(inner.slice(brace));
        } catch {
          continue;
        }
        if (body.r === "hello" && body.v >= 1) {
          // Anything before the reply is keystrokes; DA1 replies are not.
          const leftover = `${before}${buffer}`.replace(/\x1b\[[0-9;?]*c/g, "");
          finish(body, Buffer.from(leftover));
          return;
        }
      }
    };
    const timer = setTimeout(() => finish(null, null), timeoutMs);
    process.stdin.setEncoding("utf8");
    try {
      process.stdin.setRawMode(true);
    } catch {
      /* not a tty */
    }
    process.stdin.resume();
    process.stdin.on("data", onData);
    const hello = JSON.stringify({ q: "hello", v: [1], app: "pi-tsp", ver: "1.0.0", features: ["edit", "undo", "send"] });
    process.stdout.write(`${APC}q;${hello}${ST}`);
    process.stdout.write("\x1b[c");
  });
}

export async function main(args) {
  if (!nativeEligible(args)) {
    runStock(args);
    return;
  }
  // A TTY that is not Tern will simply not answer; the timeout is short and
  // the fallback keeps the terminal exactly as pi expects it.
  const { hello, leftover } = await probe(1400);
  if (!hello) {
    runStock(args);
    return;
  }
  ensureConfig();
  const { PiTsp } = await import("./ui.mjs");
  const app = new PiTsp({ hello, leftover, args, cwd: process.cwd() });
  await app.start();
}
