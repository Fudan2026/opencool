/**
 * Topic taxonomy — the editable vocabulary surface for article routing.
 *
 * Data only: keys, bilingual labels, display order, and the provisional
 * category→topic fallback used when no rule fires. The matching logic and
 * its keyword tables live in `classify.ts`; editing labels here must never
 * require touching that file.
 *
 * Both labels are declared even though only one is rendered per locale,
 * mirroring the `TEXTS_ZH` / `TEXTS_EN` pairing rule in render.ts.
 */

import type { Category } from "../sources/types";

/** The seven topics. Exactly one is assigned to every article. */
export type TopicKey =
  | "cn-finance"
  | "global-markets"
  | "policy"
  | "tech-ai"
  | "filings"
  | "opinion"
  | "world";

export interface TopicDef {
  key: TopicKey;
  /** Display label for REPORT_LOCALE=zh. */
  zh: string;
  /** Display label for REPORT_LOCALE=en. */
  en: string;
}

/**
 * Declared order doubles as the tie-break priority when two topics score
 * identically: earlier entries win.
 */
export const TOPICS: readonly TopicDef[] = [
  { key: "cn-finance", zh: "国内财经", en: "China Finance" },
  { key: "global-markets", zh: "全球市场", en: "Global Markets" },
  { key: "policy", zh: "政策政务", en: "Policy" },
  { key: "tech-ai", zh: "科技AI", en: "Tech & AI" },
  { key: "filings", zh: "公司公告", en: "Filings" },
  { key: "opinion", zh: "观点解读", en: "Analysis" },
  { key: "world", zh: "国际时政", en: "World" },
] as const;

export const TOPIC_KEYS: readonly TopicKey[] = TOPICS.map((t) => t.key);

const LABELS: Record<TopicKey, { zh: string; en: string }> = TOPICS.reduce(
  (acc, t) => {
    acc[t.key] = { zh: t.zh, en: t.en };
    return acc;
  },
  {} as Record<TopicKey, { zh: string; en: string }>,
);

export function isTopicKey(value: unknown): value is TopicKey {
  return typeof value === "string" && value in LABELS;
}

/**
 * Localized label. Deliberately takes the locale as an argument instead of
 * importing `REPORT_LOCALE`, so this module stays pure and testable without
 * loading sources.config.json.
 */
export function topicLabel(key: TopicKey, locale: "zh" | "en" = "zh"): string {
  const def = LABELS[key];
  if (!def) return "";
  return locale === "en" ? def.en : def.zh;
}

/**
 * Provisional routing when no keyword rule fires. Three tiers, most specific
 * first: the source's `subcategory` (already declared in sources.config.json),
 * then the category refined by the article's own script, then the bare
 * category.
 *
 * This is the audit's precedence step 7 — a *fallback*, not the router.
 * Increment 2 replaces it with a per-source `defaultTopic` in config; keeping
 * the mapping here means increment 1 needs no config change at all.
 */
export const FALLBACK_TOPIC_BY_CATEGORY: Record<Category, TopicKey> = {
  finance: "cn-finance",
  politics: "world",
  tech: "tech-ai",
};

/**
 * `finance` spans two very different venues. Every English finance wire
 * (Bloomberg, WSJ, CNBC, FT, Economist…) is offshore market copy, while the
 * Chinese-language finance feeds are domestic by default. Routing on the
 * headline's script keeps the prior honest without adding config fields.
 */
export const FALLBACK_TOPIC_BY_CATEGORY_AND_SCRIPT: Readonly<
  Record<Category, { cjk: TopicKey; latin: TopicKey }>
> = {
  finance: { cjk: "cn-finance", latin: "global-markets" },
  politics: { cjk: "world", latin: "world" },
  tech: { cjk: "tech-ai", latin: "tech-ai" },
};

export const FALLBACK_TOPIC_BY_SUBCATEGORY: Readonly<Record<string, TopicKey>> = {
  // finance
  "cn-news": "cn-finance",
  wire: "global-markets",
  "x-mirror": "tech-ai",
  // politics
  world: "world",
  hot: "world",
  // tech
  "ai-news": "tech-ai",
  "github-trending": "tech-ai",
  "x-viral": "tech-ai",
  "trending-papers": "tech-ai",
  "cn-community": "tech-ai",
};
