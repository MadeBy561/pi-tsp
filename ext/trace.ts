/**
 * pi-tsp shell trace.
 *
 * Records which lines of a bash tool call ran, in what order and when, so
 * the surface can show the run step by step. The call is given a one-line
 * prelude that turns on bash's own tracing into a private file; the
 * command, its output and its exit status are otherwise untouched, and
 * shells other than bash 5 skip the prelude.
 *
 * Only line numbers and times are kept. The trace's text, which holds
 * expanded variables and so possibly secrets, is read for its numbers and
 * deleted; it never reaches the result or the session file.
 *
 * `/trace` toggles it for the session.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Pi = any;

interface Step {
  /** The script line that ran, counted from 1. */
  line: number;
  /** Milliseconds since the call started. */
  at: number;
  /** Nesting: 1 for the script itself, 2 inside a command substitution, and so on. */
  depth: number;
}

const MAX_STEPS = 2000;

/** The steps of an xtrace file written with PS4 `+<tab>seconds<tab>line<tab>`. */
export function parseTrace(text: string): { steps: Step[]; trimmed: boolean } {
  const steps: Step[] = [];
  let origin = 0;
  let total = 0;
  for (const row of text.split("\n")) {
    const match = row.match(/^(\++)\t(\d+\.\d+)\t(\d+)\t/);
    if (!match) continue;
    total += 1;
    const seconds = Number(match[2]);
    origin ||= seconds;
    // Line 1 of what bash ran is the prelude; the script starts on line 2.
    if (steps.length < MAX_STEPS) steps.push({ line: Number(match[3]) - 1, at: Math.round((seconds - origin) * 1e6) / 1e3, depth: match[1]!.length });
  }
  return { steps, trimmed: total > steps.length };
}

/** Whether a command turns on, redirects or formats bash's tracing on its own. */
export function usesTracing(command: string): boolean {
  return /\bset\s+[-+][a-wyzA-Z]*x|\bset\s+[-+]o\s+xtrace|BASH_XTRACEFD|\bPS4=/.test(command);
}

export default function shellTrace(pi: Pi) {
  let enabled = true;
  let dir = "";
  let count = 0;
  const files = new Map<string, string>();

  pi.registerCommand("trace", {
    description: "Toggle step-by-step tracing of bash tool calls",
    handler: async (_args: string, ctx: any) => {
      enabled = !enabled;
      ctx.ui.notify(`Shell tracing ${enabled ? "on" : "off"}`, "info");
    },
  });

  pi.on("tool_call", async (event: any) => {
    if (!enabled || event.toolName !== "bash" || typeof event.input?.command !== "string" || !event.input.command.trim()) return;
    // A command that drives tracing itself keeps it: ours would swallow the trace it expects to see.
    if (usesTracing(event.input.command)) return;
    // A directory only this user can read: the raw trace holds expanded values until it is parsed.
    dir ||= mkdtempSync(join(tmpdir(), "pi-tsp-trace-"));
    const file = join(dir, `${++count}`);
    files.set(event.toolCallId, file);
    const prelude = `if [ "\${BASH_VERSINFO:-0}" -ge 5 ]; then eval 'exec {__pitsp}>${file}' && BASH_XTRACEFD=$__pitsp && PS4=$'+\\t\${EPOCHREALTIME}\\t\${LINENO}\\t' && set -x; fi 2>/dev/null`;
    event.input.command = `${prelude}\n${event.input.command}`;
  });

  pi.on("tool_result", async (event: any) => {
    const file = files.get(event.toolCallId);
    if (!file) return;
    files.delete(event.toolCallId);
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    } finally {
      rmSync(file, { force: true });
    }
    const { steps, trimmed } = parseTrace(text);
    if (!steps.length) return;
    return { details: { ...(event.details ?? {}), trace: { steps, ...(trimmed ? { trimmed: true } : {}) } } };
  });

  pi.on("session_shutdown", async () => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
}
