/**
 * pi-tsp permission gate.
 *
 * pi runs tools without asking; this extension adds a native approval step
 * for the calls that can hurt: destructive shell commands, privilege
 * escalation, piping a download into a shell, and writes outside the
 * project. The question goes through ctx.ui.select, which RPC mode forwards
 * to pi-tsp as an extension_ui_request, so the surface's approval panel
 * answers it.
 *
 * `/permissions` toggles the gate for the session.
 */

type Ctx = any;
type Pi = any;

const DANGEROUS: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, "deletes files recursively or by force"],
  [/\bsudo\b/, "runs as root"],
  [/\b(mkfs|fdisk|parted)\b/, "changes disk partitions or filesystems"],
  [/\bdd\s+.*\bof=\/dev\//, "writes straight to a device"],
  [/\bshutdown\b|\breboot\b|\bpoweroff\b/, "shuts the machine down"],
  [/\bkill\s+-9\b/, "force-kills a process"],
  [/\bchmod\s+-R\s+777\b/, "makes a tree world-writable"],
  [/\bgit\s+push\s+.*(--force|-f)\b/, "force-pushes"],
  [/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/, "pipes a download into a shell"],
  [/>\s*\/dev\/sd[a-z]/, "writes straight to a disk"],
  [/\bgit\s+reset\s+--hard\b/, "discards uncommitted changes"],
];

function shellDanger(command: string): string | null {
  for (const [pattern, why] of DANGEROUS) {
    if (pattern.test(command)) return why;
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
    // The first line is the question; the rest is what is asked about, which
    // the surface shows as the request's details.
    const subject = name === "bash" ? String(input.command || "") : String(input.path || input.file_path || "");
    const choice = await ctx.ui.select(`Allow ${name}: ${reason}?\n${subject}`, ["Allow once", "Always this session", "Deny"]);
    if (!choice || choice === "Deny") {
      return { block: true, reason: `pi-tsp: denied by the user (${reason})` };
    }
    if (choice === "Always this session") always.add(`${name}:${reason}`);
  });
}
