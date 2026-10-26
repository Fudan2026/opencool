/**
 * Zero-token market sentiment gauge — dictionary-based scoring of finance
 * article titles + excerpts. No LLM, no API: this is a transparent rule
 * panel (散户学堂 spirit), not a trading signal.
 *
 * Scoring:
 *   - Substring match per article over the title (weight ×2) and the
 *     first 500 chars of summary/excerpt (weight ×1). Longer dictionary
 *     terms match before shorter ones at the same position family.
 *   - Chinese negation guard: a negative CJK term whose occurrence is
 *     directly preceded by 不/未/难/止/无 is skipped ("不再下跌", "止跌…").
 *   - score = round(100 · tanh(raw / 10)) clamped to [-100, 100], where
 *     raw is the signed weighted hit total across finance articles.
 */

import { REPORT_LOCALE } from "../sources/registry";
import type { ArticleInput } from "../ai/pipeline";
import { WATCHLIST, type AssetGroup } from "../trading/watchlist";
import { matchKeysForTicker } from "../invest/events";

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
  /** -100..100 */
  score: number;
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
 * Signed weights: +2 strong bullish … +1 bullish, -1 bearish … -2 strong
 * bearish. Chinese terms first, then English wires.
 */
const TERMS: Readonly<{ term: string; weight: number }[]> = [
  // — zh, bullish —
  { term: "创历史新高", weight: 2 },
  { term: "止跌回升", weight: 2 },
  { term: "扭亏为盈", weight: 2 },
  { term: "大幅增持", weight: 2 },
  { term: "巨额回购", weight: 2 },
  { term: "放量上攻", weight: 2 },
  { term: "涨停", weight: 2 },
  { term: "大涨", weight: 2 },
  { term: "暴涨", weight: 2 },
  { term: "飙升", weight: 2 },
  { term: "超预期", weight: 2 },
  { term: "创新高", weight: 2 },
  { term: "新高", weight: 1 },
  { term: "景气", weight: 1 },
  { term: "复苏", weight: 1 },
  { term: "反弹", weight: 1 },
  { term: "回暖", weight: 1 },
  { term: "增持", weight: 1 },
  { term: "回购", weight: 1 },
  { term: "利好", weight: 1 },
  { term: "上涨", weight: 1 },
  { term: "走高", weight: 1 },
  { term: "走强", weight: 1 },
  { term: "强势", weight: 1 },
  { term: "普涨", weight: 1 },
  { term: "领涨", weight: 1 },
  { term: "突破", weight: 1 },
  { term: "中标", weight: 1 },
  { term: "获批", weight: 1 },
  { term: "签约", weight: 1 },
  { term: "上调", weight: 1 },
  { term: "减亏", weight: 1 },
  { term: "扭亏", weight: 1 },
  // — zh, bearish —
  { term: "创历史新低", weight: -2 },
  { term: "立案调查", weight: -2 },
  { term: "创新低", weight: -2 },
  { term: "跌停", weight: -2 },
  { term: "大跌", weight: -2 },
  { term: "暴跌", weight: -2 },
  { term: "重挫", weight: -2 },
  { term: "崩盘", weight: -2 },
  { term: "爆雷", weight: -2 },
  { term: "巨亏", weight: -2 },
  { term: "违约", weight: -2 },
  { term: "退市", weight: -2 },
  { term: "预亏", weight: -2 },
  { term: "跳水", weight: -2 },
  { term: "新低", weight: -1 },
  { term: "减持", weight: -1 },
  { term: "亏损", weight: -1 },
  { term: "担忧", weight: -1 },
  { term: "风险", weight: -1 },
  { term: "处罚", weight: -1 },
  { term: "罚款", weight: -1 },
  { term: "停牌", weight: -1 },
  { term: "收紧", weight: -1 },
  { term: "制裁", weight: -1 },
  { term: "关税", weight: -1 },
  { term: "下调", weight: -1 },
  { term: "缩水", weight: -1 },
  { term: "失速", weight: -1 },
  { term: "下跌", weight: -1 },
  { term: "走低", weight: -1 },
  { term: "走弱", weight: -1 },
  { term: "普跌", weight: -1 },
  { term: "领跌", weight: -1 },
  { term: "调查", weight: -1 },
  // — en wires —
  { term: "record high", weight: 2 },
  { term: "beats estimates", weight: 2 },
  { term: "surge", weight: 1 },
  { term: "rally", weight: 1 },
  { term: "buyback", weight: 1 },
  { term: "upgrade", weight: 1 },
  { term: "selloff", weight: -2 },
  { term: "plunge", weight: -2 },
  { term: "slump", weight: -2 },
  { term: "default", weight: -2 },
  { term: "downgrade", weight: -1 },
  { term: "lawsuit", weight: -1 },
  { term: "probe", weight: -1 },
  { term: "warning", weight: -1 },
];

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
/** Single-char negators directly before a bearish term. */
const NEGATION_PREFIX = new Set(["不", "未", "难", "无"]);
/** Two-char negation phrases ending right before a bearish term (不再下跌). */
const NEGATION_BIGRAMS = new Set([
  "不再", "并未", "没有", "尚未", "难以", "未能", "未见", "不会",
]);

interface TermMatch {
  term: string;
  weight: number;
  hits: number;
}

/**
 * Longest-match-first scan of one text surface: occurrences of a shorter
 * term that fall INSIDE an already-matched longer term's span are absorbed
 * (创新高 inside 创历史新高 doesn't double-count), and each CJK negative
 * occurrence carries its own negation check (不再下跌 → skipped).
 */
function matchText(text: string): TermMatch[] {
  const spans: [number, number][] = [];
  const out = new Map<string, TermMatch>();
  for (const { term, weight } of SORTED_TERMS) {
    const isCjk = /[\u4e00-\u9fff]/.test(term);
    let idx = text.indexOf(term);
    let hits = 0;
    while (idx >= 0 && hits < 3) {
      const end = idx + term.length;
      const inside = spans.some(([s, e]) => idx >= s && end <= e);
      if (!inside) {
        const prev = idx > 0 ? text[idx - 1] : "";
        const bigram = idx >= 2 ? text.slice(idx - 2, idx) : "";
        const negated =
          weight < 0 &&
          isCjk &&
          (NEGATION_PREFIX.has(prev) || NEGATION_BIGRAMS.has(bigram));
        if (!negated) {
          spans.push([idx, end]);
          hits++;
        }
      }
      idx = text.indexOf(term, idx + term.length);
    }
    if (hits > 0) out.set(term, { term, weight, hits });
  }
  return [...out.values()];
}

function labelFor(score: number, scanned: number): string {
  if (scanned < 5 || Math.abs(score) < 18) {
    return REPORT_LOCALE === "en" ? "Neutral" : "中性";
  }
  if (score >= 50) return REPORT_LOCALE === "en" ? "Strongly Bullish" : "强偏多";
  if (score >= 18) return REPORT_LOCALE === "en" ? "Bullish" : "偏多";
  if (score <= -50) return REPORT_LOCALE === "en" ? "Strongly Bearish" : "强偏空";
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
      score: Math.max(-100, Math.min(100, Math.round(100 * Math.tanh(r / 10)))),
      posHits: sectorHits.get(b)?.pos ?? 0,
      negHits: sectorHits.get(b)?.neg ?? 0,
      articles: sectorArticles.get(b) ?? 0,
      topDrivers: [...(sectorDrivers.get(b)?.values() ?? [])]
        .sort((x, y) => y.hits - x.hits)
        .slice(0, 4),
    }))
    .sort((x, y) => Math.abs(y.score) - Math.abs(x.score));

  const score = Math.max(
    -100,
    Math.min(100, Math.round(100 * Math.tanh(raw / 10))),
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
