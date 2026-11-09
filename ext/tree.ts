/**
 * pi-tsp tree navigation command.
 *
 * Pi exposes tree navigation only to extension command handlers, not as an RPC
 * command. This tiny bridge lets the Tern tree picker move the active session
 * branch without creating a separate fork. The TUI command is internal; users
 * select the node in pi-tsp's /tree picker.
 */

type Pi = any;
type Ctx = any;

export default function treeNavigation(pi: Pi) {
  pi.registerCommand("tsp-tree", {
    description: "Internal: navigate to a session-tree entry",
    handler: async (args: string, ctx: Ctx) => {
      const entryId = String(args || "").trim();
      if (!entryId) {
        ctx.ui.notify("A tree entry id is required", "warning");
        return;
      }
      try {
        const result = await ctx.navigateTree(entryId, { summarize: true });
        if (result?.cancelled) ctx.ui.notify("Tree navigation cancelled", "warning");
      } catch (error: any) {
        ctx.ui.notify(`Tree navigation failed: ${error?.message || error}`, "error");
      }
    },
  });

  pi.registerCommand("tsp-label", {
    description: "Internal: label a session-tree entry",
    handler: async (args: string, ctx: Ctx) => {
      const trimmed = String(args || "").trim();
      const space = trimmed.indexOf(" ");
      const entryId = space < 0 ? trimmed : trimmed.slice(0, space);
      const label = space < 0 ? "" : trimmed.slice(space + 1).trim();
      if (!entryId) {
        ctx.ui.notify("A tree entry id is required", "warning");
        return;
      }
      try {
        pi.setLabel(entryId, label || undefined);
        ctx.ui.notify(label ? `Labeled tree entry: ${label}` : "Tree label cleared", "info");
      } catch (error: any) {
        ctx.ui.notify(`Tree label failed: ${error?.message || error}`, "error");
      }
    },
  });
}
