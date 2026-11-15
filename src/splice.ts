/**
 * Mid-text edits as `splice` ops.
 *
 * The SDK's reconciler sends a text change as an `append` when the new text
 * extends the old, else as a `replace` of the whole text. A keystroke in the
 * middle of a draft, or a markdown block whose tail was reflowed, then
 * re-sends everything. This wraps the reconciler's output and turns such a
 * `replace` into the one changed range, as omp's reconciler does, for the
 * kinds whose text the user or the model edits in place.
 */
import { View, type Op } from "@stencil-hq/tern";

const SPLICED: Readonly<Record<string, true>> = { editor: true, input: true, md: true };

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** The `splice` replacing `before` with `after`, or null when a whole replace is as small. */
export function spliceOf(before: string, after: string, needPrefix: boolean): { at: number; del: number; text: string } | null {
  if (!before) return null;
  const limit = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  // Offsets are UTF-16; a range must not start or end inside a surrogate pair.
  if (prefix > 0 && isLowSurrogate(before.charCodeAt(prefix))) prefix -= 1;
  if (needPrefix && prefix === 0) return null;
  let suffix = 0;
  while (suffix < limit - prefix && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix += 1;
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix -= 1;
  if (prefix === 0 && suffix === 0) return null;
  return { at: prefix, del: before.length - prefix - suffix, text: after.slice(prefix, after.length - suffix) };
}

let installed = false;

/** Makes every surface's frames use `splice` where it applies. Idempotent. */
export function installSplice(): void {
  if (installed) return;
  installed = true;
  const ops = View.prototype.ops;
  View.prototype.ops = function (this: View, next: View, surface: string): Op[] {
    return ops.call(this, next, surface).map((op): Op => {
      if (op[0] !== "text" || op[2] !== "replace") return op;
      const old = this.find(op[1]);
      const before = old?.props["text"];
      if (!old || !SPLICED[old.kind] || typeof before !== "string") return op;
      const edit = spliceOf(before, op[3], old.kind === "md");
      return edit ? ["splice", op[1], edit.at, edit.del, edit.text] : op;
    });
  };
}
