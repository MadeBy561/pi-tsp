/**
 * pi-tsp plan mode.
 *
 * `/plan` puts the session into a read-only exploration mode: edit/write are
 * removed from the active tool set, bash is restricted to a conservative
 * allowlist, and the model is told to answer with a numbered plan instead of
 * making changes. The plan is parsed out of the answer, stored as a custom
 * session entry (`pi-tsp-plan`) so it survives resume, and pi-tsp renders it
 * as a native checklist with an Implement action.
 *
 * `/implement` restores full access and tells the model to execute the steps.
 */

type Pi = any;
type Ctx = any;

const READ_TOOLS = ["read", "bash", "grep", "find", "ls"];
const WRITE_TOOLS = ["edit", "write"];
const SAFE = new Set([
  "cat", "head", "tail", "less", "more", "grep", "rg", "find", "fd", "ls", "pwd", "tree",
  "git", "npm", "yarn", "pnpm", "node", "python", "python3", "wc", "sed", "awk", "jq",
  "uname", "whoami", "date", "uptime", "echo", "printf", "test", "diff", "sort", "uniq",
]);

function firstWord(command: string): string {
  return String(command || "").trim().split(/\s+/)[0] || "";
}

function safeCommand(command: string): boolean {
  const text = String(command || "");
  if (/[;&|]\s*(rm|mv|cp|chmod|chown)\b/.test(text)) return false;
  if (/\b(rm|mv|cp|mkdir|touch|chmod|chown|sudo|kill|reboot|shutdown)\b/.test(firstWord(text))) return false;
  const word = firstWord(text);
  if (word === "git") {
    const sub = text.trim().split(/\s+/)[1] || "";
    return ["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame"].includes(sub);
  }
  return SAFE.has(word);
}

function parseSteps(text: string): { text: string; done: boolean }[] {
  const lines = String(text || "").split("\n");
  const steps: { text: string; done: boolean }[] = [];
  let inPlan = false;
  for (const line of lines) {
    if (/^\s*(plan|implementation plan)\s*:/i.test(line)) {
      inPlan = true;
      continue;
    }
    if (inPlan && /^\s*#{1,6}\s/.test(line) && steps.length) break;
    if (!inPlan) continue;
    const match = line.match(/^\s*(?:\d+[.)]|[-*])\s+(.*\S)\s*$/);
    if (match) steps.push({ text: match[1].slice(0, 300), done: /\[(done|x|✓)\]/i.test(match[1]) });
  }
  return steps;
}

export default function planMode(pi: Pi) {
  let active = false;
  let steps: { text: string; done: boolean }[] = [];
  let before: string[] | undefined;

  const publish = (title = "Plan") => {
    pi.appendEntry("pi-tsp-plan", { active, steps, title, at: Date.now() });
  };

  const enable = (ctx: Ctx) => {
    if (active) return;
    active = true;
    before = pi.getActiveTools();
    const kept = before.filter((name) => !WRITE_TOOLS.includes(name));
    pi.setActiveTools([...new Set([...READ_TOOLS, ...kept])]);
    publish("Plan");
    ctx.ui.notify("Plan mode: read-only exploration. /implement runs the plan.", "info");
  };

  const disable = (ctx: Ctx, execute = false) => {
    if (!active && !execute) return;
    active = false;
    pi.setActiveTools(before ?? [...new Set([...pi.getActiveTools(), ...WRITE_TOOLS])]);
    before = undefined;
    publish(execute ? "Executing plan" : "Plan");
    ctx.ui.notify(execute ? "Plan mode off: executing the plan." : "Plan mode off: full access restored.", "info");
  };

  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only exploration)",
    handler: async (_args: string, ctx: Ctx) => {
      if (active) disable(ctx);
      else enable(ctx);
    },
  });

  pi.registerCommand("implement", {
    description: "Leave plan mode and execute the plan step by step",
    handler: async (_args: string, ctx: Ctx) => {
      if (!steps.length) {
        ctx.ui.notify("No plan yet. Ask for one in /plan mode first.", "warning");
        return;
      }
      disable(ctx, true);
      pi.sendUserMessage(
        `Implement the plan above, step by step. Mark each step [DONE:n] when it is complete.\n\n` +
          steps.map((step, index) => `${index + 1}. ${step.text}`).join("\n"),
      );
    },
  });

  pi.on("tool_call", async (event: any) => {
    if (!active) return;
    if (WRITE_TOOLS.includes(String(event.toolName))) {
      return { block: true, reason: "Plan mode is read-only. Run /implement to execute the plan." };
    }
    if (event.toolName === "bash" && !safeCommand(String(event.input?.command || ""))) {
      return { block: true, reason: "Plan mode only allows read-only shell commands. Run /implement to execute the plan." };
    }
  });

  pi.on("before_agent_start", async (event: any) => {
    if (event.messageType !== "user") return;
    if (active) {
      return {
        message: {
          customType: "pi-tsp-plan-context",
          display: false,
          content:
            "[PLAN MODE ACTIVE]\nYou are in read-only plan mode. Explore the repository, then answer with a numbered plan under a `Plan:` header.\n" +
            "Do not modify files. Do not run commands that change state. Keep each step one line and concrete.",
        },
      };
    }
    if (steps.length) {
      return {
        message: {
          customType: "pi-tsp-plan-context",
          display: false,
          content: `[EXECUTING PLAN]\nRemaining steps:\n${steps.filter((step) => !step.done).map((step, index) => `${index + 1}. ${step.text}`).join("\n")}\nAfter each step, add [DONE:n] to your reply.`,
        },
      };
    }
  });

  pi.on("turn_end", async (event: any) => {
    if (!active && !event?.message) return;
    const content = event?.message?.content;
    const text = Array.isArray(content)
      ? content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n")
      : "";
    const found = parseSteps(text);
    if (found.length) {
      steps = found;
      publish(active ? "Plan" : "Executing plan");
    } else if (active && /\[DONE:(\d+)\]/.test(text)) {
      for (const match of text.matchAll(/\[DONE:(\d+)\]/g)) {
        const index = Number(match[1]) - 1;
        if (steps[index]) steps[index].done = true;
      }
      publish("Executing plan");
    }
  });

  pi.on("session_start", async (_event: any, ctx: Ctx) => {
    // Restore the last published plan from this session's custom entries.
    try {
      const entries = ctx.sessionManager?.getBranch?.() || [];
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry?.type === "custom" && entry.customType === "pi-tsp-plan") {
          active = Boolean(entry.data?.active);
          steps = entry.data?.steps || [];
          if (active) {
            before = pi.getActiveTools();
            pi.setActiveTools([...new Set([...READ_TOOLS, ...before.filter((name: string) => !WRITE_TOOLS.includes(name))])]);
          }
          break;
        }
      }
    } catch {
      /* no session manager in some modes */
    }
  });
}
