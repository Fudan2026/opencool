/**
 * Keyword cleaning & aggregation — single implementation shared by the
 * heuristic digest (topKeywords) and the keywords.json bake. Lives in TS
 * so it is testable; the bake script runs under tsx.
 */

/** Common stopwords missed by the original table (debt: "to", "po", …). */
export const KEYWORD_STOPWORDS: ReadonlySet<string> = new Set([
  // en function words
  "the", "and", "for", "with", "from", "that", "this", "are", "was", "were",
  "will", "have", "has", "had", "after", "over", "into", "says", "said",
  "to", "of", "in", "on", "at", "by", "it", "its", "is", "be", "been", "am",
  "as", "or", "an", "not", "but", "new", "out", "up", "down", "about",
  "more", "than", "can", "may", "how", "why", "who", "what", "when", "all",
  "also", "just", "now", "get", "one", "two", "first", "amid", "via",
  "po", "com", "www", "http", "https",
  // zh stopwords (kept from the original table)
  "中国", "美国", "市场", "今日", "报道",
  "公司", "企业", "行业", "问题", "工作", "进行", "表示", "记者",
]);

/**
 * Clean one raw keyword token:
 *  - trim, drop empties, drop pure digits, drop lone CJK chars
 *  - ASCII tokens need >= 3 chars (kills "to", "po" fragments)
 *  - CJK tokens need >= 2 chars
 *  - drop stopwords (case-insensitive)
 */
export function cleanKeyword(raw: string): string | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (KEYWORD_STOPWORDS.has(lower)) return null;
  if (/^\d+([.,]\d+)*%?$/.test(t)) return null;
  const hasCjk = /[\u4e00-\u9fff]/.test(t);
  if (hasCjk) {
    if ([...t].length < 2) return null;
  } else if (t.length < 3) {
    return null;
  }
  return t;
}

/** Clean a per-edition keyword list, preserving order, deduped. */
export function cleanKeywords(raw: string[] | undefined | null): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of raw) {
    const c = cleanKeyword(k);
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

export interface KeywordAggItem {
  term: string;
  /** Number of editions in the window containing the term. */
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface KeywordAgg {
  generatedAt: string;
  source: string;
  windowDays: number;
  editions: number;
  items: KeywordAggItem[];
}

/**
 * Aggregate cleaned keywords over a chronological edition window
 * (oldest first). count = number of editions containing the term.
 */
export function aggregateKeywords(
  editions: Array<{ date: string; hour: string; keywords?: string[] }>,
  windowDays: number,
): KeywordAgg {
  const map = new Map<string, KeywordAggItem>();
  for (const e of editions) {
    for (const term of cleanKeywords(e.keywords)) {
      const item = map.get(term) ?? {
        term,
        count: 0,
        firstSeen: e.date,
        lastSeen: e.date,
      };
      item.count++;
      item.lastSeen = e.date;
      map.set(term, item);
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    source: "bake-keywords",
    windowDays,
    editions: editions.length,
    items: [...map.values()]
      .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
      .slice(0, 40),
  };
}
