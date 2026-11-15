/**
 * The transcript: the welcome block, then one block per message, tool call,
 * summary and notice, in order.
 */
import type { Conversation, Item } from "../model.js";
import { clock, collapsed, duration, firstLine, h, money, s, tokens, type Node, type ToggleEvent, type ViewCtx } from "./h.js";
import { agentNode, executionNode, readGroupNode, toolNode } from "./tools.js";

export interface WelcomeInfo {
  version: string;
  piVersion: string;
  tip: string;
  /** The blob id of pi's mark, when the terminal takes images. */
  logo?: string | undefined;
}

export const TIPS: readonly string[] = [
  "`/model` switches the model for this session; Shift+Tab steps the thinking effort",
  "`@` completes a file path; Tab accepts the highlighted match",
  "`!command` runs a shell command and shares its output with the model; `!!command` keeps it private",
  "Press Esc to stop the model; type while it works to steer it",
  "Alt+Enter queues a message for after the current turn; Alt+Up brings it back to edit",
  "Ctrl+O expands every tool card and thinking block; Ctrl+T hides thinking",
  "`/resume` reopens an earlier session; `/tree` jumps to any point of this one",
  "`/compact` summarizes the conversation when the context meter fills",
  "Ctrl+R searches your prompt history",
  "Paste an image, or `/attach <path>`, to send it with the next message",
];

/** The lockup shown above an empty transcript. */
export function welcome(info: WelcomeInfo): Node {
  return h("card", { key: "welcome", role: "omp.welcome" }, [
    h("row", { key: "lockup", align: "center", gap: "md", role: "omp.welcome.lockup" }, [
      info.logo
        ? h("image", { key: "logo", role: "omp.welcome.logo", blob: info.logo, alt: "pi", w: 128 })
        : h("text", { key: "logo", role: "omp.welcome.logo", wrap: "none", aria: "pi", spans: [s("π", "strong")] }),
      h("col", { key: "mark", role: "omp.welcome.mark" }, [
        h("text", { key: "wordmark", wrap: "none", role: "omp.welcome.wordmark", spans: [s("pi", "strong")] }),
        h("text", {
          key: "version",
          wrap: "none",
          role: "omp.welcome.version",
          spans: [s(info.piVersion ? `v${info.piVersion}` : "pi", "dim mono"), s(` · pi-tsp ${info.version}`, "dim mono")],
        }),
      ]),
    ]),
    h("row", { key: "tip", gap: "sm", align: "start", role: "omp.welcome.tip" }, [
      h("icon", { key: "0", name: "lightbulb", role: "omp.welcome.tip-icon" }),
      h("md", { key: "1", role: "omp.welcome.tip-text", text: info.tip }),
    ]),
  ]);
}

function userNode(item: Item, ctx: ViewCtx): Node {
  const images = (item.images || []).map((image, index) => {
    const blob = ctx.showImages ? ctx.blob(image) : undefined;
    return blob
      ? h("image", { key: `img${index}`, blob, alt: `attachment ${index + 1}`, max: { w: "40ch", h: "12lines" } })
      : h("badge", { key: `img${index}`, text: `image ${index + 1}` });
  });
  const menu = [
    { id: "copy-message", label: "Copy message", icon: "copy" },
    { id: "edit-turn", label: "Edit & resend", icon: "edit", detail: "To composer" },
    { id: "rewind", label: "Rewind to here…", icon: "rewind" },
  ];
  return h(
    "card",
    {
      key: item.id,
      role: "omp.user",
      tone: "user",
      actions: { menu, hold: menu },
      onAction: {
        "copy-message": () => ctx.on.copy(item.text, "Message"),
        "edit-turn": () => ctx.on.editTurn(item),
        rewind: () => ctx.on.rewind(item),
      },
    },
    [
      h("row", { key: "tools", gap: "xs", align: "center", role: "omp.user.tools" }, [
        h("icon", { key: "copy", name: "copy", role: "omp.user.tool", title: "Copy message", aria: "Copy message", onClick: () => ctx.on.copy(item.text, "Message") }),
        h("icon", { key: "rewind", name: "rewind", role: "omp.user.tool", title: "Rewind the conversation to this message", aria: "Rewind", onClick: () => ctx.on.rewind(item) }),
        h("text", { key: "dot", text: "·" }),
        h("text", { key: "time", role: "omp.user.time", title: new Date(item.at).toLocaleString(), spans: [s(clock(item.at, ctx.hour12), "dim mono")] }),
      ]),
      images.length ? h("row", { key: "images", gap: "sm", wrap: true }, images) : null,
      item.text ? h("md", { key: "text", text: item.text }) : null,
    ],
  );
}

function thinkingNode(item: Item, ctx: ViewCtx): Node {
  const live = item.status === "running";
  const label = live ? "Thinking" : item.tookMs != null && item.tookMs >= 1000 ? `Thought for ${duration(Math.round(item.tookMs / 1000) * 1000)}` : "Thought";
  return h(
    "section",
    {
      key: item.id,
      role: "omp.thinking",
      collapsible: true,
      collapsed: collapsed(ctx, item.id, true),
      ...(!live && item.tookMs != null ? { took: Math.round(item.tookMs) } : {}),
      head: h("text", { spans: [s(label, "muted", live ? { fx: "shimmer" } : {})] }),
      onToggle: (event: ToggleEvent) => ctx.on.toggle(item.id, event.collapsed === true),
    },
    [h("md", { key: "body", text: item.text, ...(live ? { stream: true } : {}) })],
  );
}

/** `8.6s · 9.7K tok · $0.02 this turn`, with the breakdown as its tooltip. */
function turnFooter(item: Item, conv: Conversation, ctx: ViewCtx): Node | null {
  const turn = item.turn;
  if (!turn) return null;
  const parts = [turn.ms > 0 ? duration(turn.ms) : "", turn.total ? `${tokens(turn.total)} tok` : "", money(turn.cost)].filter(Boolean);
  if (!parts.length) return null;
  const detail = [
    turn.ms > 0 ? duration(turn.ms) : "",
    turn.total ? `${turn.total.toLocaleString("en-US")} tokens (${turn.input.toLocaleString("en-US")} in · ${turn.output.toLocaleString("en-US")} out)` : "",
    money(turn.cost),
  ].filter(Boolean);
  const copy = (): void => ctx.on.copy(conv.answerOf(item), "Answer");
  return h("row", { key: "turn-usage", role: "omp.turn.usage", gap: "xs", align: "center", title: `This turn: ${detail.join(" · ")}` }, [
    h("icon", { key: "copy", name: "copy", role: "omp.turn.copy", title: "Copy answer", aria: "Copy answer", onClick: copy }),
    h("text", { key: "dot", text: "·" }),
    h("text", { key: "text", text: `${parts.join(" · ")} this turn` }),
  ]);
}

/** The thinking and text blocks of one assistant message. */
function assistantNode(items: Item[], conv: Conversation, ctx: ViewCtx): Node | null {
  const first = items[0]!;
  const children: (Node | null)[] = [];
  let footer: Node | null = null;
  let last: Item | undefined;
  for (const item of items) {
    if (item.kind === "thinking") {
      if (!ctx.hideThinking && item.text.trim()) children.push(thinkingNode(item, ctx));
    } else {
      if (item.text) children.push(h("md", { key: item.id, text: item.text, ...(item.status === "running" ? { stream: true } : {}) }));
      for (const [index, image] of (item.images ?? []).entries()) {
        const blob = ctx.showImages ? ctx.blob(image) : undefined;
        children.push(
          blob
            ? h("image", { key: `${item.id}.img${index}`, role: "omp.assistant.image", blob, alt: image.mimeType || "image", max: { h: "20lines" }, actions: { click: "zoom" } })
            : h("text", { key: `${item.id}.img${index}`, spans: [s(`[image ${image.mimeType || ""}]`, "muted")] }),
        );
      }
      footer = turnFooter(item, conv, ctx) ?? footer;
      last = item;
    }
  }
  if (footer) children.push(footer);
  if (!children.some(Boolean)) return null;
  const menu = [{ id: "copy-answer", label: "Copy reply", icon: "copy" }];
  return h(
    "col",
    {
      key: first.id,
      role: "omp.assistant",
      ...(last ? { actions: { menu, hold: menu }, onAction: { "copy-answer": () => ctx.on.copy(conv.answerOf(last!), "Answer") } } : {}),
    },
    children,
  );
}

function summaryNode(item: Item, ctx: ViewCtx): Node {
  const compaction = item.kind === "compaction";
  const head = compaction
    ? [
        s("Compacted", "muted"),
        ...(item.tokensAfter !== undefined && (item.tokensBefore ?? 0) > 0
          ? [s(` · ${tokens(item.tokensBefore)}`, "muted mono"), s(" → ", "dim"), s(`${tokens(item.tokensAfter)} tokens`, "muted mono")]
          : (item.tokensBefore ?? 0) > 0
            ? [s(` · ${tokens(item.tokensBefore)} tokens`, "muted mono")]
            : []),
      ]
    : [s("Branch summarized", "muted")];
  return h(
    "section",
    {
      key: item.id,
      role: compaction ? "omp.compaction" : "omp.branch",
      head,
      collapsible: true,
      collapsed: collapsed(ctx, item.id, true),
      onToggle: (event: ToggleEvent) => ctx.on.toggle(item.id, event.collapsed === true),
    },
    [
      compaction ? h("text", { key: "caption", role: "omp.compaction.caption", spans: [s("Summary of the earlier conversation", "dim")] }) : null,
      item.warning
        ? h("row", { key: "warning", role: "omp.notice.warning", tone: "warning", gap: "sm", align: "start" }, [
            h("icon", { key: "0", name: "warning", tone: "warning", aria: "Warning" }),
            h("text", { key: "1", text: item.warning, wrap: "word", grow: 1, shrink: 1 }),
          ])
        : null,
      h("md", { key: "summary", text: compaction ? item.text : `**Branch summary**\n\n${item.text}` }),
    ],
  );
}

function customNode(item: Item, ctx: ViewCtx): Node {
  const hook = item.kind === "hook";
  return h(
    "card",
    {
      key: item.id,
      role: hook ? "omp.hook" : "omp.custom",
      head: [s(item.customType || "extension", "customMessageLabel strong")],
      ...(hook ? { collapsible: true, collapsed: collapsed(ctx, item.id, true), preview: { lines: 5 }, onToggle: (event: ToggleEvent) => ctx.on.toggle(item.id, event.collapsed === true) } : {}),
    },
    [h("md", { key: "text", text: item.text })],
  );
}

function noticeNode(item: Item): Node {
  if (item.tone === "warning" || item.tone === "error") {
    return h("row", { key: item.id, role: `omp.notice.${item.tone}`, tone: item.tone, gap: "sm", align: "start" }, [
      h("icon", { key: "0", name: item.tone === "error" ? "error" : "warning", tone: item.tone }),
      h("text", { key: "1", text: item.text, wrap: "word", grow: 1, shrink: 1 }),
    ]);
  }
  if (item.tone === "info") {
    return h("row", { key: item.id, role: "omp.marker.model", gap: "sm", align: "center" }, [h("icon", { key: "0", name: "model" }), h("text", { key: "1", truncate: "end", spans: [s(item.text, "muted")] })]);
  }
  return h("text", { key: item.id, role: "omp.assistant.abort", wrap: "word", spans: [s(item.text, "muted")] });
}

/** `14:02 · in 3.8K · out 660 · cache 12K · ttft 0.4s · 108 tok/s` under a message. */
function usageNode(item: Item, ctx: ViewCtx): Node | null {
  const usage = item.usage;
  if (!usage || !ctx.showUsage) return null;
  const parts = [
    clock(item.at, ctx.hour12),
    `in ${tokens(usage.input)}`,
    `out ${tokens(usage.output)}`,
    usage.cacheRead > 0 ? `cache ${tokens(usage.cacheRead)}` : "",
    usage.ttftMs > 0 ? `ttft ${(usage.ttftMs / 1000).toFixed(1)}s` : "",
  ].filter(Boolean);
  const decodeMs = usage.ms - usage.ttftMs;
  const rate = decodeMs > 100 && usage.output > 0 ? Math.round((usage.output / decodeMs) * 10_000) / 10 : 0;
  return h("row", { key: item.id, role: "omp.usage.turn", gap: "none", align: "baseline", title: new Date(item.at).toLocaleString() }, [
    h("text", { key: "0", spans: [s(parts.join(" · "), "dim")] }),
    rate ? h("text", { key: "1", spans: [s(" · ", "dim")] }) : null,
    rate ? h("rate", { key: "2", value: rate, unit: "tok/s" }) : null,
  ]);
}

/** The frame of a request that failed: the reason, and what to do about it. */
function errorNode(item: Item, ctx: ViewCtx): Node {
  const lines = item.text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  const code = lines[0]?.match(/^(\d{3})\s+(.*)$/);
  if (code) lines[0] = code[2] ?? "";
  const text = lines.filter(Boolean).join("\n") || "Unknown error";
  const open = !collapsed(ctx, item.id, true);
  return h("card", { key: item.id, role: "omp.error", tone: "error" }, [
    h("row", { key: "head", gap: "sm" }, [
      h("text", { key: "0", spans: [s("Request failed", "error strong")] }),
      code ? h("badge", { key: "1", text: code[1] ?? "", tone: "error", role: "omp.error.code" }) : null,
    ]),
    h("text", { key: "message", role: "omp.error.message", wrap: "word", spans: [s(text, "mono")], ...(open ? {} : { lines: 8 }) }),
    h("row", { key: "actions", gap: "sm", role: "omp.error.actions" }, [
      h("row", { key: "retry", gap: "xs", role: "omp.error.action", title: "Retry the failed turn", onClick: () => ctx.on.retry() }, [
        h("text", { key: "0", text: "Retry" }),
        h("kbd", { key: "1", keys: ["F5"] }),
      ]),
      h("row", { key: "copy-error", gap: "xs", role: "omp.error.action", title: "Copy the error message", onClick: () => ctx.on.copy(item.text, "Error") }, [
        h("text", { key: "0", text: "Copy error" }),
      ]),
      h("row", { key: "switch-model", gap: "xs", role: "omp.error.action", title: "Pick another model for this session", onClick: () => ctx.on.pickModel() }, [
        h("text", { key: "0", text: "Switch model" }),
        h("kbd", { key: "1", keys: ["ctrl", "l"] }),
      ]),
    ]),
  ]);
}

const isRead = (item: Item): boolean => item.kind === "tool" && String(item.name).toLowerCase() === "read" && item.status !== "error";
const isProse = (item: Item): boolean => item.kind === "assistant" || item.kind === "thinking";

/** One block of the transcript: the items it draws and how to build it. */
interface Block {
  items: Item[];
  build(): Node | null;
}

function blocks(conv: Conversation, ctx: ViewCtx): Block[] {
  const out: Block[] = [];
  const items = conv.items;
  for (let at = 0; at < items.length; ) {
    const item = items[at]!;
    let run = [item];
    if (isProse(item)) {
      while (at + run.length < items.length && isProse(items[at + run.length]!) && items[at + run.length]!.msg === item.msg) run.push(items[at + run.length]!);
      const group = run;
      out.push({ items: group, build: () => assistantNode(group, conv, ctx) });
    } else if (isRead(item)) {
      while (at + run.length < items.length && isRead(items[at + run.length]!)) run.push(items[at + run.length]!);
      const group = run;
      out.push({ items: group, build: () => (group.length > 1 ? readGroupNode(group, ctx) : toolNode(item, ctx)) });
    } else {
      run = [item];
      out.push({ items: run, build: () => blockOf(item, ctx) });
    }
    at += run.length;
  }
  return out;
}

function blockOf(item: Item, ctx: ViewCtx): Node | null {
  switch (item.kind) {
    case "user":
      return userNode(item, ctx);
    case "tool":
      return toolNode(item, ctx);
    case "agent":
      return agentNode(item, ctx);
    case "compaction":
    case "branch":
      return summaryNode(item, ctx);
    case "custom":
    case "hook":
      return customNode(item, ctx);
    case "bash":
    case "python":
      return executionNode(item, ctx);
    case "notice":
      return noticeNode(item);
    case "error":
      return errorNode(item, ctx);
    case "usage":
      return usageNode(item, ctx);
    default:
      return null;
  }
}

/**
 * Builds the transcript, keeping the node of every block whose items did not
 * change since the last build: a long session costs what changed, not its
 * length, and an unchanged node diffs to nothing.
 */
export class TranscriptView {
  #cache = new Map<string, { rev: string; items: Item[]; versions: number[]; node: Node | null }>();

  build(conv: Conversation, ctx: ViewCtx): Node[] {
    const rev = `${ctx.foldRev}:${ctx.awaitingApproval}`;
    const seen = new Set<string>();
    const out: Node[] = [];
    for (const block of blocks(conv, ctx)) {
      const id = block.items[0]!.id;
      seen.add(id);
      const cached = this.#cache.get(id);
      // A live tool's age and a working agent's stats are read at build time.
      let fresh = !cached || cached.rev !== rev || cached.items.length !== block.items.length;
      for (let index = 0; !fresh && index < block.items.length; index += 1) {
        const item = block.items[index]!;
        fresh = cached!.items[index] !== item || cached!.versions[index] !== item.v || item.status === "running" || item.agentStatus === "running";
      }
      let node: Node | null;
      if (fresh) {
        node = block.build();
        this.#cache.set(id, { rev, items: block.items, versions: block.items.map(item => item.v), node });
      } else node = cached!.node;
      if (node) out.push(node);
    }
    if (this.#cache.size > seen.size) for (const id of this.#cache.keys()) if (!seen.has(id)) this.#cache.delete(id);
    return out;
  }
}

/** The plan the bundled plan extension keeps, with its Implement button. */
export function planNode(conv: Conversation, onImplement: () => void): Node | null {
  const plan = conv.plan;
  const steps = plan?.steps ?? [];
  if (!plan || !steps.length) return null;
  const done = steps.filter(step => step.done).length;
  return h("card", { key: "plan", role: "omp.plan", head: [s(firstLine(plan.title || "Plan", 80), "strong"), s(` · ${done}/${steps.length}`, "muted")] }, [
    h("checklist", {
      key: "steps",
      mode: "full",
      phases: [{ id: "plan", title: "Steps", items: steps.map((step, index) => ({ id: `s${index}`, text: step.text, status: step.done ? "done" : "pending" })) }],
    }),
    plan.active ? h("row", { key: "actions", gap: "sm", justify: "end" }, [h("button", { key: "go", text: "Implement", variant: "primary", size: "sm", icon: "play", onClick: onImplement })]) : null,
  ]);
}
