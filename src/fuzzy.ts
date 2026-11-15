/** Subsequence matching with scores and hit ranges, for pickers and completion. */

export interface Match {
  score: number;
  /** UTF-16 `[from, to)` ranges of the matched characters in the text. */
  hits: [number, number][];
}

const boundary = (text: string, at: number): boolean => at === 0 || /[\s/\\._\-:]/.test(text[at - 1] ?? "") || (/[A-Z]/.test(text[at] ?? "") && /[a-z]/.test(text[at - 1] ?? ""));

/**
 * Matches every character of `query` in order in `text`, ignoring case and
 * spaces in the query. A contiguous substring scores highest; otherwise word
 * starts and runs score over scattered letters. Null when there is no match.
 */
export function fuzzy(query: string, text: string): Match | null {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (!needle) return { score: 0, hits: [] };
  const hay = text.toLowerCase();
  const exact = hay.indexOf(needle);
  if (exact >= 0) {
    return { score: 1000 - exact + (boundary(text, exact) ? 200 : 0) - (text.length - needle.length) * 0.1, hits: [[exact, exact + needle.length]] };
  }
  let score = 0;
  let at = 0;
  let run = 0;
  const hits: [number, number][] = [];
  for (const ch of needle) {
    const found = hay.indexOf(ch, at);
    if (found < 0) return null;
    const last = hits[hits.length - 1];
    if (last && last[1] === found) {
      last[1] = found + 1;
      run += 1;
      score += 8 + run * 2;
    } else {
      hits.push([found, found + 1]);
      run = 0;
      score += boundary(text, found) ? 12 : 2;
      score -= Math.min(6, found - at) * 0.5;
    }
    at = found + 1;
  }
  return { score: score - text.length * 0.05, hits };
}

/** Ranks `items` by how well `text(item)` matches `query`; stable for equal scores. */
export function rank<T>(query: string, items: readonly T[], text: (item: T) => string): { item: T; match: Match }[] {
  if (!query.trim()) return items.map(item => ({ item, match: { score: 0, hits: [] } }));
  const out: { item: T; match: Match; at: number }[] = [];
  items.forEach((item, at) => {
    const match = fuzzy(query, text(item));
    if (match) out.push({ item, match, at });
  });
  out.sort((a, b) => b.match.score - a.match.score || a.at - b.at);
  return out;
}
