/**
 * One title tokenizer, shared by every consumer that needs "are these two
 * headlines the same story?".
 *
 * Before this module there were two near-identical private copies
 * (`heuristic-digest.ts` for brief clustering, and the dedupe pass added for
 * panel routing). They agreed by luck, not by construction — the kind of
 * drift that silently makes a dedupe threshold meaningless. The rules here
 * are deliberately the digest's original ones so shipped behaviour does not
 * move:
 *
 *  - lowercase, drop URLs, replace punctuation with spaces
 *  - ASCII/Latin words of length >= 2
 *  - CJK overlapping bigrams, so short Chinese titles still overlap
 *
 * Zero dependencies, no network, deterministic.
 */

const CJK = /[\u4e00-\u9fff]/;

/** Normalised surface form used for equality checks and tokenisation. */
export function normalizeTitleForMatch(title: string): string {
  return (title ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Token set for similarity scoring. `minWordLength` is 2 by default because
 * single Latin letters carry no signal; CJK bigrams are emitted regardless
 * since Chinese words are short.
 */
export function tokenizeTitle(title: string, minWordLength = 2): Set<string> {
  const norm = normalizeTitleForMatch(title);
  const parts = norm.split(" ").filter((t) => t.length >= minWordLength);
  const cjk = norm.replace(/\s+/g, "");
  if (CJK.test(cjk) && cjk.length >= 4) {
    for (let i = 0; i < cjk.length - 1; i++) parts.push(cjk.slice(i, i + 2));
  }
  return new Set(parts);
}

/** Jaccard similarity of two token sets, 0..1. Empty sets score 0. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
