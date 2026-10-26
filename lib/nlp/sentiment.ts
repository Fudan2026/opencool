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

export interface SentimentDriver {
  term: string;
  hits: number;
  polarity: 1 | -1;
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
  note: string;
}

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

export function scoreSentiment(articles: ArticleInput[]): MarketSentiment {
  const finance = articles.filter((a) => a.category === "finance");
  let raw = 0;
  let posHits = 0;
  let negHits = 0;
  const driverMap = new Map<string, SentimentDriver>();

  for (const a of finance) {
    const title = a.title ?? "";
    const excerpt = (a.summary || a.excerpt || "").slice(0, 500);
    const surfaces: [string, number][] = [
      [title, 2],
      [excerpt, 1],
    ];
    // Match each surface separately but merge overlapping terms across
    // surfaces (a term found in the title usually also appears in the
    // excerpt — count the surface hits, weight title double).
    for (const [text, surfaceWeight] of surfaces) {
      const hay = text.toLowerCase();
      for (const { term, weight, hits } of matchText(hay)) {
        raw += weight * hits * surfaceWeight;
        if (weight > 0) posHits += hits;
        else negHits += hits;
        const d =
          driverMap.get(term) ??
          { term, hits: 0, polarity: (weight > 0 ? 1 : -1) as 1 | -1 };
        d.hits += hits;
        driverMap.set(term, d);
      }
    }
  }

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
    note,
  };
}
