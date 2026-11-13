/**
 * Reaction windows — public surface.
 *
 * Measures, for every story the ledger knows, how the sector it is associated
 * with moved at +1h / +1d / +5d after we first saw the story, relative to that
 * sector's own trailing drift and to the market's cross-section, then
 * aggregates by topic and by entity.
 *
 * Zero LLM, zero network: reads `daily_reports/tape/` and
 * `daily_reports/stories.json` and writes `daily_reports/reactions.json`.
 */

export * from "./types";
export {
  loadTape,
  buildSeries,
  levelAt,
  lastLevelBefore,
  boardSeriesKey,
  indexSeriesKey,
  tapeRoot,
  type LevelPoint,
  type Quote,
  type Series,
  type SeriesMap,
  type SnapshotPoint,
  type TapeStore,
} from "./tape-read";
export {
  attributeStory,
  isUnmapped,
  ENTITY_THEME_LINKS,
  TOPIC_THEME_LINKS,
  MARKET_INDEX_CODE,
  type AttributionContext,
  type EntityThemeLink,
} from "./attribution";
export {
  earliestAtOrAfter,
  marketMeanPct,
  measureHorizon,
  measureStories,
  pctChange,
  trailingDriftPct,
} from "./measure";
export { aggregate, distribution, hitRate, percentile, signFor, EXPECTED_SIGN } from "./aggregate";
export {
  buildReactions,
  readLedgerStories,
  REACTIONS_SCHEMA_VERSION,
  type BuildOptions,
  type LedgerInput,
  type LedgerStory,
} from "./payload";

import type { ReactionsPayload } from "./types";

/**
 * Stable JSON. Key order inside each object is the literal order the builders
 * wrote it in, and every array is already sorted by a stable key, so two builds
 * over identical inputs produce identical bytes.
 */
export function serializeReactions(payload: ReactionsPayload): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}
