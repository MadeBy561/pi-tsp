/**
 * pi-tsp's entry: inside Tern it opens a native surface over `pi --mode rpc`;
 * anywhere else, and for every non-interactive invocation, it is stock pi
 * with the original arguments.
 */
import { spawn } from "node:child_process";
import { connect, Session, type ConnectOptions } from "@stencil-hq/tern";
import { stockPath } from "./paths.js";
import { ensureConfig } from "./setup.js";

function runStock(args: string[]): Promise<number> {
  const bin = stockPath();
  return new Promise(resolve => {
    const child = spawn(bin, args, { stdio: "inherit", env: { ...process.env, PI_TSP_STOCK: "1" } });
    child.on("error", error => {
      process.stderr.write(`pi-tsp: could not run pi (${bin}): ${error.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else resolve(code ?? 0);
    });
  });
}

const NON_INTERACTIVE = new Set(["-p", "--print", "-h", "--help", "--version", "-v", "--export", "--list-models"]);
const SUBCOMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config", "auth", "mcp"]);

/** Whether this invocation is an interactive session a surface can front. */
export function nativeEligible(args: readonly string[], tty = Boolean(process.stdin.isTTY && process.stdout.isTTY)): boolean {
  if (!tty) return false;
  if (args.some(arg => NON_INTERACTIVE.has(arg.split("=")[0] ?? ""))) return false;
  const at = args.findIndex(arg => arg === "--mode" || arg.startsWith("--mode="));
  if (at >= 0) {
    const mode = args[at]!.includes("=") ? args[at]!.split("=")[1] : args[at + 1];
    if (mode && mode !== "text") return false;
  }
  return !(args[0] && SUBCOMMANDS.has(args[0]));
}

/** Whether the pane is Tern's own, so a surface can be opened before Tern has answered. */
function inTern(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM_PROGRAM === "tern" && env.TERN_TSP !== "0" && !env.TMUX && !env.STY && !env.ZELLIJ;
}

export async function main(args: string[]): Promise<number> {
  if (!nativeEligible(args)) return runStock(args);
  const { VERSION, App } = await import("./app.js");
  const options: ConnectOptions = { app: "pi-tsp", version: VERSION, features: ["edit", "undo", "send"], ...(process.env.PI_TSP_RECORD ? { record: process.env.PI_TSP_RECORD } : {}) };
  const start = (session: Session): InstanceType<typeof App> => {
    ensureConfig();
    return new App({ session, args, cwd: process.cwd() });
  };
  let app: InstanceType<typeof App>;
  if (inTern()) {
    // Tern's own pane: open the surface and draw at once, and let the `hello`
    // reply catch up, instead of holding the first frame for a round trip.
    const session = new Session(process.stdin, process.stdout, options);
    app = start(session);
    app.render();
    if (!(await session.handshake())) return runStock(args);
    app.render();
  } else {
    // Anywhere else nothing is drawn until Tern answers; a terminal that is
    // not Tern answers the DA1 sent with `hello` and the wait ends there.
    const session = await connect(options);
    if (!session) return runStock(args);
    app = start(session);
  }
  try {
    return await app.run();
  } finally {
    await app.quit();
  }
}
