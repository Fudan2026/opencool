/**
 * Search tokenizer — the single token definition shared by the bake
 * (index build), the static search page, and the MCP tool.
 *
 * Tokens: CJK character bigrams (order-1 shingles — robust for headline
 * matching without a segmenter) + ASCII words of 3+ chars, lowercased.
 * Mirrors the cleaning philosophy of lib/nlp/keywords.ts (no stopwords
 * here — postings are per-doc unique and volume is bounded by the cap).
 */

const ASCII_WORD = /[a-z0-9][a-z0-9.+^=-]{2,}/gi;

// Shared stopword table (lib/nlp/keywords.ts) keeps function words like
// "the"/"and" out of the postings — single source of cleaning truth.
import { KEYWORD_STOPWORDS } from "../nlp/keywords";

export function tokenize(text: string): string[] {
  const t = String(text ?? "");
  const out: string[] = [];
  const ascii = t.toLowerCase().match(ASCII_WORD) ?? [];
  for (const w of ascii) {
    if (!KEYWORD_STOPWORDS.has(w)) out.push(w);
  }
  const cjkRuns = t.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) {
      out.push(run.slice(i, i + 2));
    }
  }
  return [...new Set(out)];
}
