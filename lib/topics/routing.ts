/**
 * lane × topic routing for the rendered news block, with density caps.
 *
 * Increment 2 of the IA redesign. Increment 1 shipped the classifier in shadow
 * mode; this module is where its output starts deciding what readers see. The
 * rules it enforces are the audit's, not new editorial policy:
 *
 *  1. **Route inside each lane.** The page used to flatten nine heterogeneous
 *     wires into one time-sorted list, so a wire publishing every 60 seconds
 *     won every slot (2026-11-13 13:00: 财联社 20 of 24). Now each lane renders
 *     six topic sections in a fixed order — 全球市场 → 国际时政 → 科技AI →
 *     政策政务 → 公司公告 → 观点解读 — and the timestamps only order items
 *     *within* a section.
 *  2. **Cap density.** Per section: at most 40% of the slots from one source,
 *     at most 2 items per story cluster. Per edition: at most 8 items for one
 *     cluster across every lane and topic, so a story cannot relabel itself
 *     once per section (the Nvidia story took 15 slots on 2026-11-13).
 *  3. **Suppress duplicates.** `dedupeStories` runs per lane before routing, so
 *     a headline carried by two wires renders once.
 *  4. **Omit empty sections.** No placeholder shell: a section with zero items
 *     is not rendered at all, which removes the permanently empty 技术动态 and
 *     财经热榜 panels without special-casing them.
 *
 * Everything here is a pure function of the article list plus the source
 * registry: no network, no LLM, no clock, no randomness. `daily.ts` and
 * `scripts/render.ts` share it through `groupRaw`, so a re-render cannot drift
 * from the pipeline's own output.
 *
 * The per-source cap is applied through `roundRobinSelect` — the same
 * interleaver `lib/ai/pipeline.ts` used to keep one source from filling the
 * LLM payload. Sharing it means one algorithm to reason about, not two.
 */

import type { ArticleInput } from "../ai/pipeline";
import { roundRobinSelect } from "../select/round-robin";
import { classifyArticle } from "./classify";
import { dedupeStories, storyCluster } from "./dedupe";
import { TOPIC_KEYS, type LaneKey, type TopicKey } from "./taxonomy";

/**
 * Section order inside every lane. Locked by the owner's taxonomy decision:
 * markets are the edition's spine, 国际时政 is first-class, 观点解读 is last and
 * cheapest because it has the lowest information density per slot.
 */
export const SECTION_ORDER: readonly TopicKey[] = [
  "global-markets",
  "world",
  "tech-ai",
  "policy",
  "filings",
  "opinion",
] as const;

/** Lanes in render order: the Chinese lane is primary. */
export const LANE_ORDER: readonly LaneKey[] = ["zh", "external"] as const;

export interface SectionLimits {
  /** Hard slot count for the section. */
  cap: number;
  /**
   * Maximum share of the section a single source may occupy. Expressed as a
   * fraction and applied against `cap` (not against the item count actually
   * available) so the rule is deterministic before the pool is known.
   */
  sourceShare: number;
}

/**
 * Per-topic section caps.
 *
 * Sized from measured supply per lane on 2026-11-10→13 (the audit's window):
 * `world` and `global-markets` are deep, `filings` and `opinion` are thin, and
 * a cap above ~8 makes one section longer than a reader scrolls. The six caps
 * sum to 32, i.e. a full lane is about the size of the two merged panels it
 * replaces (24 + 14 = 38) but is composed rather than timestamp-ordered.
 */
export const SECTION_LIMITS: Readonly<Record<TopicKey, SectionLimits>> = {
  "global-markets": { cap: 8, sourceShare: 0.4 },
  world: { cap: 6, sourceShare: 0.4 },
  "tech-ai": { cap: 6, sourceShare: 0.4 },
  policy: { cap: 5, sourceShare: 0.4 },
  filings: { cap: 4, sourceShare: 0.4 },
  opinion: { cap: 3, sourceShare: 0.4 },
};

/** Maximum items one story cluster may occupy in a single section. */
export const CLUSTER_CAP_PER_SECTION = 2;

/**
 * Minimum items a section must render to be shown at all.
 *
 * Two (owner decision OC-18, lowered from three). At two items the 40%
 * per-source share is arithmetically unreachable (two sources split 50/50),
 * so a 2-item section is shown *with a visible thin marker* at render time
 * (see `THIN_SECTION_ITEMS` in lib/output/render.ts) and any one-source
 * 2-item section is additionally reported by `sectionsBelowFloor` — real
 * thin news renders honestly labelled instead of being withheld, and 0-item
 * sections still never render at all. Topics that cannot field two items are
 * recorded in `RoutedLane.omitted` so the pipeline log can say so.
 */
export const MIN_SECTION_ITEMS = 2;

/**
 * Maximum items one story cluster may occupy across a whole edition.
 *
 * The audit asked for ≤2 per topic and ≤8 per edition; 8 is the number that
 * survives here because a genuinely large story (a CEO exit that moves four
 * indices) should still be allowed to appear in the lanes and sections it
 * actually belongs to. Anything above this is repetition, not coverage.
 */
export const CLUSTER_CAP_PER_EDITION = 8;

export interface RoutedSection {
  topic: TopicKey;
  /** Selected items, newest first. */
  items: ArticleInput[];
  /** How many candidates the section had before capping. */
  available: number;
  /** True when the cap dropped items. */
  capped: boolean;
}

export interface RoutedLane {
  lane: LaneKey;
  sections: RoutedSection[];
  /** Articles dropped by the dedupe pass. */
  duplicates: number;
  /** Topics that had candidates but could not field a balanced section. */
  omitted: Array<{ topic: TopicKey; available: number; reason: "below-floor" }>;
  /**
   * Every deduplicated article in this lane, before section caps.
   *
   * Carried so the secondary 按来源 view can still reach articles that the
   * topic cap left out — routing must add a way to read, never remove one.
   */
  pool: ArticleInput[];
}

export interface RoutedEdition {
  lanes: RoutedLane[];
  /** Total items rendered. */
  total: number;
  /** Total duplicates suppressed. */
  duplicates: number;
}

/** Source id → declared subcategory, for classifier fallbacks. */
export type SubcategoryMap = Readonly<Record<string, string | undefined>>;

interface Tagged {
  article: ArticleInput;
  lane: LaneKey;
  topic: TopicKey;
}

/**
 * Resolve `lane`/`topic` for an article, tolerating legacy sidecars.
 *
 * Untagged articles are classified on the fly with the same pure classifier
 * increment 1 wrote into the sidecar, so an old edition re-rendered today
 * routes identically to a freshly baked one.
 */
function tag(article: ArticleInput, subcategories: SubcategoryMap): Tagged {
  const withTags = article as ArticleInput & {
    lane?: string;
    topic?: string;
    domestic?: boolean;
  };
  const laneOk = withTags.lane === "zh" || withTags.lane === "external";
  const topicOk =
    typeof withTags.topic === "string" &&
    (TOPIC_KEYS as readonly string[]).includes(withTags.topic);

  if (laneOk && topicOk) {
    return {
      article,
      lane: withTags.lane as LaneKey,
      topic: withTags.topic as TopicKey,
    };
  }
  const r = classifyArticle({
    title: article.title,
    excerpt: article.excerpt,
    summary: article.summary,
    category: article.category,
    subcategory: subcategories[article.sourceId],
    lang: (article as { lang?: "zh" | "en" }).lang,
  });
  return { article, lane: r.lane, topic: r.topic };
}

function newestFirst(a: ArticleInput, b: ArticleInput): number {
  return (
    (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0)
  );
}

/**
 * Drop items from whichever source is over-represented until no source exceeds
 * its share of what the section actually renders.
 *
 * The share is measured against the rendered count, not against the cap: a
 * section whose supply is thin renders fewer items than its cap, and a
 * cap-relative budget would then let one source own 2 of 3 slots (67%). This
 * pass is what makes the guarantee true for the reader.
 *
 * The bound is `max(1, floor(share × n))`, recomputed as items come out. At
 * n = 5 a source may hold exactly 2 slots (40%); at n = 4 it may hold 1 (25%).
 *
 * A pool with a single source is left untouched: trimming it cannot improve the
 * ratio — 1 of 1 is as non-compliant as 2 of 2 — and would only destroy
 * information. Those sections are reported by `sectionsBelowFloor` instead, so
 * the guarantee is stated precisely: *every section drawing on three or more
 * sources* is within 40%.
 *
 * Dropping the *oldest* item of the dominant source keeps the newest angle,
 * which is the one a reader opening an edition wants.
 */
function trimDominantSource(
  items: ArticleInput[],
  sourceShare: number,
): ArticleInput[] {
  let out = items;
  // A pool with one source can never satisfy a share rule by trimming — every
  // removal keeps it at 100%. Holding it to two items makes the ratio question
  // moot instead of letting one wire present itself as a whole section.
  const distinctSources = new Set(out.map((i) => i.sourceId)).size;
  if (distinctSources < 2) return out.slice(0, 2);

  for (let guard = 0; guard < 64; guard++) {
    if (out.length === 0) break;
    const counts = new Map<string, number>();
    for (const item of out) counts.set(item.sourceId, (counts.get(item.sourceId) ?? 0) + 1);
    if (counts.size < 2) {
      out = out.slice(0, 2);
      break;
    }
    let dominant = "";
    let dominantCount = 0;
    for (const [id, n] of counts) {
      if (n > dominantCount || (n === dominantCount && id < dominant)) {
        dominant = id;
        dominantCount = n;
      }
    }
    const allowed = Math.max(1, Math.floor(out.length * sourceShare));
    if (dominantCount <= allowed) break;
    // Newest-first order: remove the last (oldest) item from the dominant source.
    let idx = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].sourceId === dominant) {
        idx = i;
        break;
      }
    }
    if (idx < 0) break;
    out = out.filter((_, i) => i !== idx);
  }
  return out;
}

/**
 * Cap one section: newest-first ordering, then round-robin across sources with
 * the share and per-cluster limits applied as it goes.
 *
 * Does not charge the edition-wide cluster budget — the caller does that only
 * for sections it actually keeps, so a section withheld by the item floor does
 * not consume budget for items the reader never sees.
 */
function capSection(
  candidates: ArticleInput[],
  topic: TopicKey,
  clusterCounts: Map<string, number>,
): RoutedSection {
  const limits = SECTION_LIMITS[topic];
  const perSourceMax = Math.max(1, Math.floor(limits.cap * limits.sourceShare));

  // Cluster keys are needed both inside `accept` and when the section's spend
  // is charged, so resolve each title exactly once.
  const clusterOf = new Map<ArticleInput, string>();
  const clusterFor = (a: ArticleInput): string => {
    let c = clusterOf.get(a);
    if (c === undefined) {
      c = storyCluster(a.title);
      clusterOf.set(a, c);
    }
    return c;
  };
  const selected = roundRobinSelect(candidates, {
    limit: limits.cap,
    keyOf: (a) => a.sourceId,
    compare: newestFirst,
    perBucketMax: perSourceMax,
    // Counted from `picked` rather than a running tally so that the trim below
    // cannot leave a cluster over-charged for an item that never rendered.
    accept: (item, picked) => {
      const cluster = clusterFor(item);
      let inSection = 0;
      for (const p of picked) if (clusterFor(p) === cluster) inSection++;
      if (inSection >= CLUSTER_CAP_PER_SECTION) return false;
      return (clusterCounts.get(cluster) ?? 0) + inSection < CLUSTER_CAP_PER_EDITION;
    },
  });

  const items = trimDominantSource(selected, limits.sourceShare);
  return {
    topic,
    items,
    available: candidates.length,
    capped: items.length < candidates.length,
  };
}

/**
 * Route one edition: dedupe within each lane, split by topic, cap each
 * section, drop empty and under-floor sections, keep the locked section order.
 *
 * Lane order matters: the Chinese lane is processed first, so when a story
 * appears in both lanes the edition-wide cluster budget is spent on the
 * primary lane. That is a deliberate editorial prior, not an accident of
 * iteration order.
 */
export function routeEdition(
  articles: readonly ArticleInput[],
  subcategories: SubcategoryMap = {},
): RoutedEdition {
  const clusterCounts = new Map<string, number>();
  const lanes: RoutedLane[] = [];
  let totalDuplicates = 0;

  for (const lane of LANE_ORDER) {
    const inLane: Tagged[] = [];
    for (const article of articles) {
      const t = tag(article, subcategories);
      if (t.lane === lane) inLane.push(t);
    }

    const deduped = dedupeStories(inLane.map((t) => t.article));
    totalDuplicates += deduped.dropped.length;
    const byArticle = new Map(inLane.map((t) => [t.article, t] as const));

    const sections: RoutedSection[] = [];
    const omitted: RoutedLane["omitted"] = [];
    for (const topic of SECTION_ORDER) {
      const candidates: ArticleInput[] = [];
      for (const article of deduped.kept) {
        const t = byArticle.get(article);
        if (t && t.topic === topic) candidates.push(article);
      }
      if (candidates.length === 0) continue;
      const section = capSection(candidates, topic, clusterCounts);
      if (section.items.length < MIN_SECTION_ITEMS) {
        omitted.push({
          topic,
          available: section.available,
          reason: "below-floor",
        });
        continue;
      }
      for (const item of section.items) {
        const cluster = storyCluster(item.title);
        clusterCounts.set(cluster, (clusterCounts.get(cluster) ?? 0) + 1);
      }
      sections.push(section);
    }
    lanes.push({ lane, sections, duplicates: deduped.dropped.length, omitted, pool: deduped.kept });
  }

  const total = lanes.reduce(
    (n, l) => n + l.sections.reduce((m, s) => m + s.items.length, 0),
    0,
  );
  return { lanes, total, duplicates: totalDuplicates };
}

export interface SectionStat {
  lane: LaneKey;
  topic: TopicKey;
  rendered: number;
  available: number;
  /** sourceId → rendered count. */
  bySource: Record<string, number>;
  /** Largest single-source share among rendered items, 0..1. */
  maxSourceShare: number;
  maxSourceId: string;
  /** Largest item count for one story cluster, per `storyCluster`. */
  maxCluster: number;
  maxClusterKey: string;
}

/**
 * Composition metrics for one section — used by the evidence table in the PR
 * body, by the CI guard in the golden suite, and by `npm run topics:report`.
 */
export function sectionStats(section: RoutedSection, lane: LaneKey): SectionStat {
  const bySource: Record<string, number> = {};
  const byCluster: Record<string, number> = {};
  for (const item of section.items) {
    bySource[item.sourceId] = (bySource[item.sourceId] ?? 0) + 1;
    const c = storyCluster(item.title);
    byCluster[c] = (byCluster[c] ?? 0) + 1;
  }
  let maxSourceId = "";
  let maxSource = 0;
  for (const [id, n] of Object.entries(bySource)) {
    if (n > maxSource || (n === maxSource && id < maxSourceId)) {
      maxSource = n;
      maxSourceId = id;
    }
  }
  let maxClusterKey = "";
  let maxCluster = 0;
  for (const [k, n] of Object.entries(byCluster)) {
    if (n > maxCluster || (n === maxCluster && k < maxClusterKey)) {
      maxCluster = n;
      maxClusterKey = k;
    }
  }
  return {
    lane,
    topic: section.topic,
    rendered: section.items.length,
    available: section.available,
    bySource,
    maxSourceShare: section.items.length === 0 ? 0 : maxSource / section.items.length,
    maxSourceId,
    maxCluster,
    maxClusterKey,
  };
}

/** Flattened stats for a whole edition. */
export function editionStats(edition: RoutedEdition): SectionStat[] {
  return edition.lanes.flatMap((l) => l.sections.map((s) => sectionStats(s, l.lane)));
}

/**
 * Sections that cannot satisfy the per-source share no matter how they are
 * built, because they do not have enough distinct sources.
 *
 * Reported rather than silently rendered non-compliant: a 2-item section from
 * one source is 100%, and the honest answer is to say so in the pipeline log
 * while still showing the news. The alternative — deleting a real section to
 * satisfy a ratio — hides information to make a metric look green, which is
 * the wrong trade for a reader-facing product.
 */
export function sectionsBelowFloor(
  edition: RoutedEdition,
  minSources = 3,
): Array<{ lane: LaneKey; topic: TopicKey; sources: number; rendered: number }> {
  const out: Array<{ lane: LaneKey; topic: TopicKey; sources: number; rendered: number }> = [];
  for (const lane of edition.lanes) {
    for (const section of lane.sections) {
      const sources = new Set(section.items.map((i) => i.sourceId)).size;
      if (sources < minSources) {
        out.push({ lane: lane.lane, topic: section.topic, sources, rendered: section.items.length });
      }
    }
  }
  return out;
}
