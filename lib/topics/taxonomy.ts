/**
 * Topic taxonomy — the editable vocabulary surface for article routing.
 *
 * Data only: keys, bilingual labels, declared order, and the provisional
 * fallbacks used when no keyword rule fires. The matching logic and its
 * keyword tables live in `classify.ts`; editing labels here must never
 * require touching that file.
 *
 * Both labels are declared even though only one is rendered per locale,
 * mirroring the `TEXTS_ZH` / `TEXTS_EN` pairing rule in render.ts.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO ORTHOGONAL AXES (owner correction, 2026-11-13)
 * ─────────────────────────────────────────────────────────────────────────
 * The taxonomy is NOT one flat list. It is two independent axes:
 *
 *   Axis A — `lane`: which language the edition is reading in.
 *     - `zh`        中文财经 — **Chinese-language content**, which routinely
 *                   covers US markets, Japanese rates and European politics.
 *                   The lane name has nothing to do with the venue of the
 *                   story; it is a language lane.
 *     - `external`  外电原文 — non-Chinese-language wire copy.
 *
 *     Because the lane is language, a Chinese-language story about the S&P is
 *     `zh`, and an English-language Bloomberg story about the PBOC is
 *     `external`. Neither is a routing error.
 *
 *   Axis B — `topic`: what the story is about, venue-independent.
 *     global-markets · world · tech-ai · policy · filings · opinion
 *
 * `domestic` is a secondary boolean tag on top of both axes, marking
 * China-oriented content (A-share plumbing, ministries, domestic issuers).
 * It is deliberately NOT a topic: "domestic finance" is not a lane readers
 * want to sit in, but knowing whether a 全球市场 item is about China is
 * useful for sub-grouping later.
 *
 * MIGRATION NOTE — `cn-finance` is retired. The previous flat taxonomy had a
 * `cn-finance` (国内财经) topic, which conflated language with venue: it
 * collected every Chinese-language finance item and then looked "66% foreign"
 * because Chinese wires legitimately cover the world. That was the lane
 * working correctly, not a defect. `cn-finance` is replaced by
 * `lane: "zh"` (the language lane it actually described) plus `domestic: true`
 * for the China-oriented subset, and its market vocabulary now lives in
 * `global-markets`. Any persisted sidecar or consumer that still carries
 * `topic: "cn-finance"` must map it as: lane `zh`, topic `global-markets` if
 * market content else `policy`, domestic `true` — see
 * `lib/topics/taxonomy.ts` `LEGACY_TOPIC_MIGRATION`.
 */

import type { Category } from "../sources/types";

// ---------------------------------------------------------------------------
// Axis A — language lane
// ---------------------------------------------------------------------------

export type LaneKey = "zh" | "external";

export interface LaneDef {
  key: LaneKey;
  /** Display label for REPORT_LOCALE=zh. */
  zh: string;
  /** Display label for REPORT_LOCALE=en. */
  en: string;
}

export const LANES: readonly LaneDef[] = [
  { key: "zh", zh: "中文财经", en: "Chinese-Language" },
  { key: "external", zh: "外电原文", en: "External Wire" },
] as const;

export const LANE_KEYS: readonly LaneKey[] = LANES.map((l) => l.key);

const LANE_LABELS: Record<LaneKey, { zh: string; en: string }> = LANES.reduce(
  (acc, l) => {
    acc[l.key] = { zh: l.zh, en: l.en };
    return acc;
  },
  {} as Record<LaneKey, { zh: string; en: string }>,
);

export function isLaneKey(value: unknown): value is LaneKey {
  return typeof value === "string" && value in LANE_LABELS;
}

export function laneLabel(key: LaneKey, locale: "zh" | "en" = "zh"): string {
  const def = LANE_LABELS[key];
  if (!def) return "";
  return locale === "en" ? def.en : def.zh;
}

// ---------------------------------------------------------------------------
// Axis B — topic
// ---------------------------------------------------------------------------

/** The six topics. Exactly one is assigned to every article. */
export type TopicKey =
  | "global-markets"
  | "world"
  | "tech-ai"
  | "policy"
  | "filings"
  | "opinion";

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
 *
 * `global-markets` leads because market content is the edition's spine and
 * the owner called it the important lane; `world` is next so 国际时政 is a
 * first-class destination rather than a spillover bucket. `opinion` is last
 * on purpose — lowest information density per slot.
 */
export const TOPICS: readonly TopicDef[] = [
  { key: "global-markets", zh: "全球市场", en: "Global Markets" },
  { key: "world", zh: "国际时政", en: "World" },
  { key: "tech-ai", zh: "科技AI", en: "Tech & AI" },
  { key: "policy", zh: "政策政务", en: "Policy" },
  { key: "filings", zh: "公司公告", en: "Filings" },
  { key: "opinion", zh: "观点解读", en: "Analysis" },
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

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

/**
 * Old flat keys → the two axes that replaced them. Kept exported and tested
 * so a consumer reading a pre-change sidecar can translate without guessing.
 */
export const LEGACY_TOPIC_MIGRATION: Readonly<
  Record<string, { lane: LaneKey; topic: TopicKey; domestic: boolean }>
> = {
  // `cn-finance` was a language lane, not a venue: it always meant Chinese
  // language, and its market vocabulary now belongs to global-markets.
  "cn-finance": { lane: "zh", topic: "global-markets", domestic: true },
  "global-markets": { lane: "external", topic: "global-markets", domestic: false },
  world: { lane: "external", topic: "world", domestic: false },
  "tech-ai": { lane: "external", topic: "tech-ai", domestic: false },
  policy: { lane: "external", topic: "policy", domestic: false },
  filings: { lane: "external", topic: "filings", domestic: false },
  opinion: { lane: "external", topic: "opinion", domestic: false },
};

// ---------------------------------------------------------------------------
// Fallbacks — used only when no keyword rule fires
// ---------------------------------------------------------------------------

/**
 * Provisional routing when no keyword rule fires. This is a *fallback*, not
 * the router: increment 2 replaces it with a per-source `defaultTopic` in
 * sources.config.json. Keeping the mapping here means this increment needs no
 * config change at all.
 */
export const FALLBACK_TOPIC_BY_CATEGORY: Record<Category, TopicKey> = {
  finance: "global-markets",
  politics: "world",
  tech: "tech-ai",
};

export const FALLBACK_TOPIC_BY_SUBCATEGORY: Readonly<Record<string, TopicKey>> = {
  // finance
  "cn-news": "global-markets",
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

/**
 * `domestic` prior for content with no China/foreign evidence at all.
 *
 * A Chinese-language finance item with no geographic signal is domestic by
 * default (it came from a 中文 source discussing 中文 subject matter); an
 * English-language item with no geographic signal is not.
 */
export const FALLBACK_DOMESTIC_BY_LANE: Readonly<Record<LaneKey, boolean>> = {
  zh: true,
  external: false,
};
