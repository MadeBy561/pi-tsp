/**
 * pi-tsp permission gate.
 *
 * pi runs tools without asking; this extension adds a native approval step
 * for the calls that can hurt: destructive shell commands, privilege
 * escalation, piping a download into a shell, and writes outside the
 * project. The question goes through ctx.ui.select, which RPC mode forwards
 * to pi-tsp as an extension_ui_request, so the terminal's own approval sheet
 * answers it.
 *
 * `/permissions` toggles the gate for the session.
 */

type Ctx = any;
type Pi = any;

const DANGEROUS = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/,
  /\bsudo\b/,
  /\b(mkfs|fdisk|parted)\b/,
  /\bdd\s+.*\bof=\/dev\//,
  /\bshutdown\b|\breboot\b|\bpoweroff\b/,
  /\bkill\s+-9\b/,
  /\bchmod\s+-R\s+777\b/,
  /\bgit\s+push\s+.*(--force|-f)\b/,
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/,
  />\s*\/dev\/sd[a-z]/,
  /\bgit\s+reset\s+--hard\b/,
];

function shellDanger(command: string): string | null {
  for (const pattern of DANGEROUS) {
    if (pattern.test(command)) return `matches ${pattern}`;
  }
  return null;
}

function outsideCwd(path: string, cwd: string): boolean {
  if (!path) return false;
  const normalized = path.startsWith("/") ? path : `${cwd}/${path}`;
  return !normalized.startsWith(cwd.endsWith("/") ? cwd : `${cwd}/`) && !normalized.startsWith("/tmp/");
}

export default function permissionGate(pi: Pi) {
  let enabled = true;
  const always = new Set<string>();

  pi.registerCommand("permissions", {
    description: "Toggle the pi-tsp approval gate for risky tool calls",
    handler: async (_args: string, ctx: Ctx) => {
      enabled = !enabled;
      ctx.ui.notify(`pi-tsp approval gate ${enabled ? "on" : "off"}`, "info");
    },
  });

  pi.on("tool_call", async (event: any, ctx: Ctx) => {
    if (!enabled) return;
    const name = String(event.toolName || "");
    const input = event.input || {};
    let reason: string | null = null;
    if (name === "bash") reason = shellDanger(String(input.command || ""));
    if (name === "write" || name === "edit") {
      if (outsideCwd(String(input.path || input.file_path || ""), ctx.cwd)) reason = "writes outside the project directory";
    }
    if (!reason) return;
    if (always.has(`${name}:${reason}`)) return;
    const choice = await ctx.ui.select(`Allow ${name}?`, ["Allow once", "Always this session", "Deny"]);
    if (!choice || choice === "Deny") {
      return { block: true, reason: `pi-tsp: denied by the user (${reason})` };
    }
    if (choice === "Always this session") always.add(`${name}:${reason}`);
  });
}
