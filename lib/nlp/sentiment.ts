/**
 * Zero-token market sentiment gauge — dictionary-based scoring of finance
 * article titles + excerpts. No LLM, no API: this is a transparent rule
 * panel (散户学堂 spirit), not a trading signal.
 *
 * Scoring:
 *   - Match per article over the title (weight ×2) and the first 500
 *     chars of summary/excerpt (weight ×1). CJK terms match as substrings,
 *     Latin terms as whole words; longer terms match before shorter ones
 *     at the same position family (v2: the vocabulary lives in lexicon.ts).
 *   - Negation guard (v2, both polarities): a CJK term directly preceded
 *     by 不/未/难/无/没/止 or a negation bigram (不再/难以/失去/…) is
 *     skipped ("不再下跌", "未获上调"); a Latin term preceded by an
 *     English negator ("won't sink", "Not New Tariffs") is skipped too.
 *     Damping, not flipping: negated words score 0; positive readings of
 *     negated bearish moves ("止跌回升") are explicit lexicon compounds.
 *   - CALIBRATION (wave 6): score = round(100 · tanh((raw / scanned) / K))
 *     with K = 3, clamped to [-100, 100], where raw is the signed
 *     weighted hit total and scanned the number of finance articles.
 *     Per-article mean tone, NOT the additive sum: the additive form
 *     saturated at ±100 on 9 of 10 production editions (raw ≳ 30 pins
 *     tanh(raw/10)). K = 3 separates the observed regimes: quiet days
 *     (|mean| < 0.3 → |score| < 10), strong-event days (|mean| ≈ 1 →
 *     ±32), uniformly one-sided days (|mean| ≈ 3 → ±76, no pinning;
 *     pinning would need |mean| > 9.9, unreachable with hit caps).
 *     `raw` is still exported for observability; `percentile` carries
 *     cross-era comparability against pre-calibration history.
 */

import { REPORT_LOCALE } from "../sources/registry";
import type { ArticleInput } from "../ai/pipeline";
import { WATCHLIST, type AssetGroup } from "../trading/watchlist";
import { matchKeysForTicker } from "../invest/events";
import {
  LEXICON,
  ZH_NEGATION_PREFIX,
  ZH_NEGATION_BIGRAMS,
  EN_NEGATORS,
  type LexiconEntry,
} from "./lexicon";

export interface SentimentDriver {
  term: string;
  hits: number;
  polarity: 1 | -1;
}

export interface SectorSentiment {
  /** AssetGroup key or "general" for articles outside the watchlist. */
  key: AssetGroup | "general";
  /** -100..100 within the bucket. */
  score: number;
  posHits: number;
  negHits: number;
  articles: number;
  topDrivers: SentimentDriver[];
}

export interface MarketSentiment {
  generated_at: string;
  /** -100..100, per-article mean tone (calibrated, see file header). */
  score: number;
  /** Signed weighted hit total before normalization (observability). */
  raw: number;
  label: string;
  posHits: number;
  negHits: number;
  /** Finance articles scanned. */
  scanned: number;
  drivers: SentimentDriver[];
  /** Per-asset-group breakdown; "general" holds unmatched articles. */
  sectors: SectorSentiment[];
  /**
   * Percentile of this score against recent history (0..100), null when
   * fewer than MIN_HISTORY_SAMPLES scores exist. Absolute score is kept
   * unchanged for backward compatibility.
   */
  percentile: number | null;
  note: string;
}

/** Minimum history samples before percentile is trusted. */
export const MIN_HISTORY_SAMPLES = 20;

/**
 * Signed weights live in lexicon.ts (v2 vocabulary table, zh + en).
 * Rules live here: matching order, absorption, negation guards.
 */
const TERMS = LEXICON;

/** Watchlist group → match keys, built once (teaching-grade bucketing). */
const SECTOR_KEYS: ReadonlyArray<{ group: AssetGroup; keys: string[] }> =
  WATCHLIST.map((t) => ({ group: t.group, keys: matchKeysForTicker(t) }));

function groupsForArticle(title: string, excerpt: string): Set<AssetGroup> {
  const hay = `${title}\n${excerpt}`;
  const groups = new Set<AssetGroup>();
  for (const { group, keys } of SECTOR_KEYS) {
    for (const k of keys) {
      if (hay.includes(k)) {
        groups.add(group);
        break;
      }
    }
  }
  return groups;
}

/** Percentile of score within history (0..100); null below sample floor. */
export function percentileFor(
  score: number,
  history: number[] | undefined,
): number | null {
  if (!history || history.length < MIN_HISTORY_SAMPLES) return null;
  const below = history.filter((h) => h < score).length;
  return Math.round((below / history.length) * 100);
}

/** Longest first so 创历史新高 wins over 新高 in the same headline. */
const SORTED_TERMS = [...TERMS].sort((a, b) => b.term.length - a.term.length);
/** Latin terms match as whole words ("surge" must not fire inside "surgeon"). */
const IS_LATIN = /[a-z0-9]/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
const SORTED_MATCHERS: ReadonlyArray<{
  entry: LexiconEntry;
  isCjk: boolean;
  re?: RegExp;
}> = SORTED_TERMS.map((entry) => {
  const isCjk = !IS_LATIN.test(entry.term);
  return {
    entry,
    isCjk,
    re: isCjk ? undefined : new RegExp(`\\b${escapeRe(entry.term)}\\b`, "g"),
  };
});

interface TermMatch {
  term: string;
  weight: number;
  hits: number;
}

/** CJK negation: single char or two-char phrase directly before the term. */
function zhNegated(text: string, idx: number): boolean {
  const prev = idx > 0 ? text[idx - 1] : "";
  const bigram = idx >= 2 ? text.slice(idx - 2, idx) : "";
  return ZH_NEGATION_PREFIX.has(prev) || ZH_NEGATION_BIGRAMS.has(bigram);
}

/** Latin negation: a negator among the ≤3 words immediately before the term. */
function enNegated(text: string, idx: number): boolean {
  const before = text.slice(0, idx).replace(/['’`]/g, "");
  const words = before.split(/[^a-z0-9]+/).filter(Boolean);
  return words.slice(-3).some((w) => EN_NEGATORS.has(w));
}

/**
 * Longest-match-first scan of one lowercased surface: occurrences of a
 * shorter term that fall INSIDE an already-matched longer term's span are
 * absorbed (创新高 inside 创历史新高, 飙升 inside 成本飙升 — context-flip
 * compounds therefore beat their component words), and every occurrence
 * carries its own negation check in BOTH directions (不再下跌 is skipped,
 * and so is 销量不再上涨; v1 only guarded the bearish side).
 */
export function matchText(text: string): TermMatch[] {
  const spans: [number, number][] = [];
  const out = new Map<string, TermMatch>();
  for (const { entry, isCjk, re } of SORTED_MATCHERS) {
    const { term, weight } = entry;
    let hits = 0;
    if (isCjk) {
      let idx = text.indexOf(term);
      while (idx >= 0 && hits < 3) {
        const end = idx + term.length;
        const inside = spans.some(([s, e]) => idx >= s && end <= e);
        if (!inside) {
          // The span is recorded even for negated occurrences: otherwise a
          // negated compound ("不再下跌") leaks its bare component ("跌")
          // as an unguarded hit on the next, shorter pass.
          if (!zhNegated(text, idx)) hits++;
          spans.push([idx, end]);
        }
        idx = text.indexOf(term, idx + 1);
      }
    } else {
      re!.lastIndex = 0;
      for (const m of text.matchAll(re!)) {
        if (hits >= 3) break;
        const idx = m.index!;
        const end = idx + term.length;
        const inside = spans.some(([s, e]) => idx >= s && end <= e);
        if (!inside && !enNegated(text, idx)) {
          spans.push([idx, end]);
          hits++;
        }
      }
    }
    if (hits > 0) out.set(term, { term, weight, hits });
  }
  return [...out.values()];
}

function labelFor(score: number, scanned: number): string {
  // Thresholds live in the per-article tone domain (wave-6 calibration):
  // an average headline carrying even one bearish term (≈ −1) is already
  // meaningful, so the strong bands start at ±30, neutral band at ±8.
  if (scanned < 5 || Math.abs(score) < 8) {
    return REPORT_LOCALE === "en" ? "Neutral" : "中性";
  }
  if (score >= 30) return REPORT_LOCALE === "en" ? "Strongly Bullish" : "强偏多";
  if (score >= 8) return REPORT_LOCALE === "en" ? "Bullish" : "偏多";
  if (score <= -30) return REPORT_LOCALE === "en" ? "Strongly Bearish" : "强偏空";
  return REPORT_LOCALE === "en" ? "Bearish" : "偏空";
}

export function scoreSentiment(
  articles: ArticleInput[],
  history?: number[],
): MarketSentiment {
  const finance = articles.filter((a) => a.category === "finance");
  let raw = 0;
  let posHits = 0;
  let negHits = 0;
  const driverMap = new Map<string, SentimentDriver>();

  // Per-asset-group buckets ("general" collects watchlist-miss articles).
  const sectorRaw = new Map<AssetGroup | "general", number>();
  const sectorHits = new Map<AssetGroup | "general", { pos: number; neg: number }>();
  const sectorArticles = new Map<AssetGroup | "general", number>();
  const sectorDrivers = new Map<AssetGroup | "general", Map<string, SentimentDriver>>();
  for (const g of [
    "china-ashare", "china-etf", "china-equity", "us-equity",
    "crypto", "commodity-fx", "macro", "general",
  ] as const) {
    sectorRaw.set(g, 0);
    sectorHits.set(g, { pos: 0, neg: 0 });
    sectorArticles.set(g, 0);
    sectorDrivers.set(g, new Map());
  }

  for (const a of finance) {
    const title = a.title ?? "";
    const excerpt = (a.summary || a.excerpt || "").slice(0, 500);
    const groups = groupsForArticle(title, excerpt);
    const buckets: (AssetGroup | "general")[] = groups.size
      ? [...groups]
      : ["general"];
    for (const b of buckets) {
      sectorArticles.set(b, (sectorArticles.get(b) ?? 0) + 1);
    }
    // Match each surface separately; title counts double vs excerpt.
    for (const surface of [
      [title, 2],
      [excerpt, 1],
    ] as [string, number][]) {
      const hay = surface[0].toLowerCase();
      for (const { term, weight, hits } of matchText(hay)) {
        if (weight === 0) continue; // absorber (减速机): span only, no score
        const contribution = weight * hits * surface[1];
        raw += contribution;
        if (weight > 0) posHits += hits;
        else negHits += hits;
        const d =
          driverMap.get(term) ??
          { term, hits: 0, polarity: (weight > 0 ? 1 : -1) as 1 | -1 };
        d.hits += hits;
        driverMap.set(term, d);
        for (const b of buckets) {
          sectorRaw.set(b, (sectorRaw.get(b) ?? 0) + contribution);
          const sh = sectorHits.get(b)!;
          if (weight > 0) sh.pos += hits;
          else sh.neg += hits;
          const sd =
            sectorDrivers.get(b)!.get(term) ??
            { term, hits: 0, polarity: (weight > 0 ? 1 : -1) as 1 | -1 };
          sd.hits += hits;
          sectorDrivers.get(b)!.set(term, sd);
        }
      }
    }
  }

  const sectors: SectorSentiment[] = [...sectorRaw.entries()]
    .filter(([b]) => (sectorHits.get(b)?.pos ?? 0) + (sectorHits.get(b)?.neg ?? 0) > 0)
    .map(([b, r]) => ({
      key: b,
      score: Math.max(
        -100,
        Math.min(
          100,
          Math.round(
            100 *
              Math.tanh(
                r / Math.max(sectorArticles.get(b) ?? 1, 1) / 3,
              ),
          ),
        ),
      ),
      posHits: sectorHits.get(b)?.pos ?? 0,
      negHits: sectorHits.get(b)?.neg ?? 0,
      articles: sectorArticles.get(b) ?? 0,
      topDrivers: [...(sectorDrivers.get(b)?.values() ?? [])]
        .sort((x, y) => y.hits - x.hits)
        .slice(0, 4),
    }))
    .sort((x, y) => Math.abs(y.score) - Math.abs(x.score));

  // Per-article mean tone, K = 3 — see the calibration note in the header.
  const score = Math.max(
    -100,
    Math.min(
      100,
      Math.round(
        100 * Math.tanh(raw / Math.max(finance.length, 1) / 3),
      ),
    ),
  );
  const drivers = [...driverMap.values()]
    .sort((a, b) => Math.abs(b.hits * b.polarity) - Math.abs(a.hits * a.polarity))
    .filter((d) => d.hits >= 2)
    .slice(0, 8);

  const note =
    finance.length < 5
      ? REPORT_LOCALE === "en"
        ? `Sample too small (${finance.length} finance items) — treated as neutral.`
        : `样本不足（${finance.length} 条财经），按中性处理。`
      : REPORT_LOCALE === "en"
        ? "Dictionary rules over finance headlines (title ×2, excerpt ×1). Zero AI. Not investment advice."
        : "基于财经标题的词典规则面板（标题 ×2、摘要 ×1）。零 AI。不构成投资建议。";

  return {
    generated_at: new Date().toISOString(),
    score,
    raw,
    label: labelFor(score, finance.length),
    posHits,
    negHits,
    scanned: finance.length,
    drivers,
    sectors,
    percentile: percentileFor(score, history),
    note,
  };
}
