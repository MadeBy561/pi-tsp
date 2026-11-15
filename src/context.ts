/**
 * What fills the context window, from pi's own token counts.
 *
 * pi reports, for every reply, how many tokens the request sent and how many
 * the model wrote. The request for one reply is the request for the reply
 * before it, plus what that reply wrote, plus whatever was added in between:
 * tool results and your messages. So everything added after the first
 * request is known exactly by subtraction. Only the first request cannot be
 * taken apart: it is the system prompt, the tool schemas and your first
 * message in one number, and that one split is estimated from the message's
 * length.
 */
import type { Item } from "./model.js";

export interface ContextRow {
  label: string;
  /** The colour token of the row and its part of the meter. */
  token: string;
  value: number;
  exact: boolean;
}

const chars = (items: readonly Item[], pick: (item: Item) => number): number => items.reduce((sum, item) => sum + pick(item), 0);
const userChars = (item: Item): number => (item.kind === "user" ? item.text.length + (item.images?.length ?? 0) * 4000 : 0);
const resultChars = (item: Item): number => (item.kind === "tool" || item.kind === "agent" || ((item.kind === "bash" || item.kind === "python") && !item.excluded) ? (item.output?.length ?? 0) : 0);

/** The rows of the breakdown for a context holding `used` tokens. */
export function contextBreakdown(items: readonly Item[], used: number): ContextRow[] {
  // Only what follows the last compaction is in the window as itself.
  const live = items.slice(Math.max(0, items.findLastIndex(item => item.kind === "compaction")));
  const requests = live.flatMap((item, index) => (item.kind === "usage" && item.usage?.prompt ? [{ index, item, usage: item.usage }] : []));
  let written = 0;
  let yours = 0;
  let results = 0;
  let base = 0;
  let estimated = false;
  requests.forEach((request, at) => {
    written += request.usage.output;
    const previous = requests[at - 1];
    if (!previous) {
      // The first request: the system prompt, the tool schemas, any summary, and your first message.
      const first = Math.min(request.usage.prompt, Math.round(chars(live.slice(0, request.index), userChars) / 4));
      yours += first;
      base = request.usage.prompt - first;
      estimated = true;
      return;
    }
    const added = Math.max(0, request.usage.prompt - previous.usage.prompt - previous.usage.output);
    // Added since the request before: your messages typed since, and the results of that reply's tool calls.
    const typed = chars(live.slice(previous.index, request.index), userChars);
    const returned = chars(live.filter(item => item.msg === previous.item.msg), resultChars);
    if (typed + returned === 0) base += added;
    else {
      const mine = Math.round((added * typed) / (typed + returned));
      yours += mine;
      results += added - mine;
    }
  });
  // What pi counts beyond the last request it reported (results still to be sent, or no request yet).
  const rest = Math.max(0, used - (requests.at(-1) ? requests.at(-1)!.usage.prompt + requests.at(-1)!.usage.output : 0));
  return [
    { label: "Written by the model", token: "success", value: Math.min(used, written), exact: true },
    { label: "Tool results", token: "warning", value: results, exact: true },
    { label: "Your messages", token: "accent", value: yours, exact: !estimated },
    { label: "System prompt, tools and summaries", token: "dim", value: base, exact: !estimated },
    { label: "Not yet attributed", token: "muted", value: rest, exact: true },
  ].filter(row => row.value > 0);
}
