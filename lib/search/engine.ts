/**
 * Minimal inverted-index search engine for the static gh-pages archive.
 * Pure functions — shared by scripts/bake-search.ts (build), the client
 * search page (query, inline port), and the MCP tool (query).
 *
 * Index shape (search-index.json):
 *   { version, generatedAt, docs: [{d,h,t}], postings: { token: [docIdx...] } }
 * docIdx values are ascending within each posting list (docs are pushed
 * in chronological order), so AND = sorted-list intersection.
 */

import { tokenize } from "./tokenize";

export interface SearchDoc {
  /** edition date YYYY-MM-DD */
  d: string;
  /** edition hour HH */
  h: string;
  /** display title (hero headline or edition label) */
  t: string;
}
export interface SearchIndex {
  version: 1;
  generatedAt: string;
  /** Chronological, oldest first. */
  docs: SearchDoc[];
  postings: Record<string, number[]>;
}

export interface SearchEditionInput {
  date: string;
  hour: string;
  hero: string;
  /** Brief titles + summaries (already clipped by the caller). */
  texts: string[];
  keywords?: string[];
}

export const SEARCH_BUDGET_BYTES = 2 * 1024 * 1024;

export function buildIndex(
  editions: SearchEditionInput[],
  opts: { maxDocs?: number } = {},
): SearchIndex {
  // Oldest first so docIdx order == chronological order.
  const chron = [...editions];
  const max = opts.maxDocs ?? chron.length;
  const window = chron.slice(Math.max(0, chron.length - max));
  const docs: SearchDoc[] = [];
  const postings: Record<string, number[]> = {};
  window.forEach((e, idx) => {
    docs.push({ d: e.date, h: e.hour, t: e.hero });
    const tokens = new Set([
      ...tokenize(e.hero),
      ...e.texts.flatMap((x) => tokenize(x)),
      ...(e.keywords ?? []).flatMap((k) => tokenize(k)),
    ]);
    for (const tok of tokens) {
      (postings[tok] ??= []).push(idx);
    }
  });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    docs,
    postings,
  };
}

function intersect(a: number[], b: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(a[i]);
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return out;
}

export interface QueryResult {
  doc: SearchDoc;
  /** How many query terms matched (AND matches = terms.length). */
  terms: number;
}

/**
 * Multi-term search: AND across all terms first; when nothing matches
 * every term, fall back to OR ranked by match count then recency.
 */
export function query(index: SearchIndex, q: string): QueryResult[] {
  const terms = tokenize(q);
  if (terms.length === 0) return [];
  const lists = terms
    .map((t) => index.postings[t])
    .map((l) => l ?? [])
    .filter((l) => l.length > 0);
  if (lists.length === 0) return [];

  let and = lists[0];
  for (let i = 1; i < lists.length; i++) and = intersect(and, lists[i]);

  const scores = new Map<number, number>();
  for (const l of lists) {
    for (const idx of l) scores.set(idx, (scores.get(idx) ?? 0) + 1);
  }
  const pool =
    and.length > 0
      ? and
      : [...scores.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]).map(([idx]) => idx);

  return pool
    .map((idx) => ({
      doc: index.docs[idx],
      terms: and.length > 0 ? terms.length : (scores.get(idx) ?? 0),
    }))
    .sort((a, b) => b.terms - a.terms);
}
