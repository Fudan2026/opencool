/**
 * Assemble `daily_reports/reactions.json`.
 *
 * Pure: takes the tape store, the ledger and the clock-free options, returns the
 * payload. No I/O, no wall clock, so the same inputs always produce byte-identical
 * output (the baker serializes with sorted keys and a trailing newline).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why the file has no `generatedAt`
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Every other bake in this repo stamps a wall clock, and for a panel that is
 * right. Here it is not: this file's whole claim is that it describes a fixed
 * set of observations, and a `generatedAt` (or `updatedAt`) would make two
 * rebuilds over identical inputs differ byte-for-byte, turning the reproducibility
 * test into a fiction and making diffs unreadable. `dataThrough` is the honest
 * substitute: the newest instant the *inputs* describe.
 */

import { attributeStory, type AttributionContext } from "./attribution";
import { aggregate } from "./aggregate";
import { boardSeriesKey, buildSeries, indexSeriesKey, type SeriesMap } from "./tape-read";
import type { TapeStore } from "./tape-read";
import { measureStories } from "./measure";
import { loadThemeCatalog } from "../themes/catalog";
import {
  HEADLINE_METRIC,
  HEADLINE_REASON,
  HORIZONS,
  MIN_SAMPLE,
  MIN_WINDOW_FRACTION,
  type AttributedStory,
  type HorizonKey,
  type ReactionsPayload,
  type ReactionGap,
  type StoryReaction,
} from "./types";

export const REACTIONS_SCHEMA_VERSION = 1;

/** Minimum viable ledger record — the fields attribution and measurement need. */
export interface LedgerStory {
  id: string;
  firstSeenAt?: unknown;
  firstEdition?: unknown;
  topic?: unknown;
  entities?: unknown;
}

export interface LedgerInput {
  stories?: unknown;
  maxStories?: unknown;
  retentionDays?: unknown;
  updatedAt?: unknown;
  timezone?: unknown;
}

export interface BuildOptions {
  now?: Date;
  /** Cap on published per-story observations, so the file stays readable. */
  maxObservations?: number;
  minCrossSection?: number;
  minWindowFraction?: number;
}

const DEFAULT_MAX_OBSERVATIONS = 400;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Read the ledger's stories, fail-open.
 *
 * A record without a parsable `firstSeenAt` cannot be measured at any horizon,
 * so it is counted as a gap rather than being given an invented clock.
 */
export function readLedgerStories(
  ledger: LedgerInput,
): { stories: LedgerStory[]; skipped: number; noFirstSeen: number } {
  const raw = Array.isArray(ledger.stories) ? ledger.stories : [];
  const stories: LedgerStory[] = [];
  let skipped = 0;
  let noFirstSeen = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      skipped++;
      continue;
    }
    const r = item as Record<string, unknown>;
    const id = asString(r.id);
    const firstSeenAt = asString(r.firstSeenAt);
    if (!id) {
      skipped++;
      continue;
    }
    if (!firstSeenAt || !Number.isFinite(Date.parse(firstSeenAt))) {
      noFirstSeen++;
      continue;
    }
    stories.push({
      id,
      firstSeenAt,
      firstEdition: asString(r.firstEdition),
      topic: asString(r.topic),
      entities: Array.isArray(r.entities) ? r.entities.filter((e): e is string => typeof e === "string") : [],
    });
  }
  return { stories, skipped, noFirstSeen };
}

/** Newest instant any input describes. The file's honest "as of". */
function dataThroughOf(store: TapeStore, stories: readonly LedgerStory[]): string | null {
  let best: string | null = store.summary.to;
  let bestMs = best ? Date.parse(best) : -Infinity;
  for (const s of stories) {
    const ms = Date.parse(asString(s.firstSeenAt));
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = asString(s.firstSeenAt);
    }
  }
  return best;
}

/** Display label for an entity group: the entity id plus the board it was measured on. */
function themeLabelOf(measured: StoryReaction[], entity: string): string {
  const sample = measured.find((s) => s.entity === entity);
  return sample?.targetLabel ?? sample?.target ?? entity;
}

export function buildReactions(
  store: TapeStore,
  ledger: LedgerInput,
  options: BuildOptions = {},
): ReactionsPayload {
  const gaps: ReactionGap[] = [...store.gaps];

  const series: SeriesMap = buildSeries(store);
  const { stories: ledgerStories, skipped, noFirstSeen } = readLedgerStories(ledger);
  if (skipped) {
    gaps.push({ kind: "ledger-record-skipped", detail: "ledger records without an id were skipped", count: skipped });
  }
  if (noFirstSeen) {
    gaps.push({
      kind: "ledger-no-first-seen",
      detail: "ledger records without a parsable firstSeenAt cannot be measured at any horizon",
      count: noFirstSeen,
    });
  }

  const themes = loadThemeCatalog();
  // Whether the tape has started is passed through explicitly. Do NOT infer it
  // from `themeBoards.size === 0`: that is ambiguous between "no capture yet"
  // and "captured, but this theme's board was not quoted", and treating the
  // first as a market fallback is what reported 2,000 stories as sectorless.
  const tapeStarted = store.points.length > 0;
  const ctx: AttributionContext = {
    themeBoards: store.themeBoards,
    themes,
    tapeStarted,
    hasIndex: (code) => series.has(indexSeriesKey(code)),
  };

  const attributed: AttributedStory[] = ledgerStories.map((s) =>
    attributeStory(
      {
        id: s.id,
        firstSeenAt: asString(s.firstSeenAt),
        firstEdition: asString(s.firstEdition),
        topic: asString(s.topic),
        entities: (s.entities as string[]) ?? [],
      },
      ctx,
    ),
  );

  const attributedCounts = { entity: 0, topic: 0, market: 0, pending: 0, unmapped: 0 };
  for (const a of attributed) {
    if (a.attribution === "entity") attributedCounts.entity++;
    else if (a.attribution === "topic") attributedCounts.topic++;
    else if (a.attribution === "market") attributedCounts.market++;
    else if (a.attribution === "pending") attributedCounts.pending++;
    else attributedCounts.unmapped++;
  }
  // Named in `gaps` as well as in the counts, so a reader skimming the gap list
  // learns that the attribution block is provisional rather than empty.
  if (attributedCounts.pending > 0) {
    gaps.push({
      kind: "attribution-pending",
      detail:
        "tape has not started, so no sector board has ever been quoted and no story can be attributed yet — " +
        "these stories are NOT a market fallback and NOT unmapped; they are unattributable so far",
      count: attributedCounts.pending,
    });
  }

  // A gap the arithmetic cannot fix: the ledger's retention window decides how
  // far back `firstSeenAt` goes, so an horizon longer than the window can never
  // be measured however much tape accumulates. Naming it here is the difference
  // between "no samples yet" and "no samples ever", which a reader must be able
  // to tell apart.
  const maxRetention = typeof ledger.retentionDays === "number" ? ledger.retentionDays : null;
  const longestHorizonDays = Math.max(...HORIZONS.map((h) => h.minutes)) / (24 * 60);
  if (maxRetention !== null && maxRetention < longestHorizonDays) {
    gaps.push({
      kind: "retention-shorter-than-horizon",
      detail:
        `ledger retentionDays=${maxRetention} is shorter than the longest horizon ` +
        `(${longestHorizonDays}d), so that horizon can never reach MIN_SAMPLE`,
      count: maxRetention,
    });
  }

  const measured: StoryReaction[] = measureStories(attributed, store, series, {
    minCrossSection: options.minCrossSection,
    minWindowFraction: options.minWindowFraction,
  });

  // Horizon totals across every story, so a reader can see how much of the
  // ledger is even eligible at each horizon.
  const horizonTotals: Record<HorizonKey, { ok: number; pending: number; gap: number }> = {
    "1h": { ok: 0, pending: 0, gap: 0 },
    "1d": { ok: 0, pending: 0, gap: 0 },
    "5d": { ok: 0, pending: 0, gap: 0 },
  };
  let observationsPublished = 0;
  for (const s of measured) {
    for (const h of HORIZONS) {
      const sample = s.horizons[h.key];
      horizonTotals[h.key][sample.status]++;
      if (sample.status === "ok") observationsPublished++;
    }
  }

  // Topic aggregates are sector-level claims, so they hold only sector-
  // attributed samples. Two reasons, both load-bearing:
  //   - a `market`-attributed story is measured on the index, and the index is
  //     not a sector — today that is 1,994 of 2,000 stories, so folding them in
  //     would let the tape's own direction be reported as a topic's reaction;
  //   - a `null` (unmapped) story has no target at all.
  // The counts in `counts.attributed` still report every bucket, so the
  // excluded mass is visible rather than hidden by the filter.
  const byTopic = aggregate(
    measured.filter((s) => s.attribution === "entity" || s.attribution === "topic"),
    (s) => s.topic || "unknown",
    (key) => key,
  );
  // `entity` is non-null only for `attribution: "entity"` (see
  // `attributeStory`), so grouping on it already restricts the aggregate to
  // entity-attributed samples. That invariant is asserted in the tests rather
  // than filtered for here: a filter would be dead code today and would hide a
  // future attribution change that started leaking an entity into a topic or
  // market sample — which is exactly the claim this aggregate must not make.
  const byEntity = aggregate(
    measured,
    (s) => s.entity,
    (key) => `${key} (${themeLabelOf(measured, key)})`,
  );

  // Published per-story observations, newest first, capped. The counts above
  // are always over the full ledger, so truncation can never flatter them.
  const sorted = [...measured].sort(
    (a, b) => (Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt)) || a.id.localeCompare(b.id),
  );
  const maxObs = options.maxObservations ?? DEFAULT_MAX_OBSERVATIONS;
  const observations = sorted.slice(0, Math.max(0, maxObs));

  const maxStories = typeof ledger.maxStories === "number" && ledger.maxStories > 0 ? ledger.maxStories : null;
  const retentionDays =
    typeof ledger.retentionDays === "number" && ledger.retentionDays >= 0 ? ledger.retentionDays : null;
  const firsts = ledgerStories
    .map((s) => asString(s.firstSeenAt))
    .filter((s) => Number.isFinite(Date.parse(s)))
    .sort();

  const updatedAt = asString(ledger.updatedAt);

  return {
    schemaVersion: REACTIONS_SCHEMA_VERSION,
    dataThrough: dataThroughOf(store, ledgerStories),
    timezone: asString(ledger.timezone) || "Asia/Shanghai",
    headlineMetric: HEADLINE_METRIC,
    headlineReason: HEADLINE_REASON,
    method: {
      unit: "percent",
      horizons: HORIZONS.map((h) => ({ key: h.key, label: h.label, minutes: h.minutes })),
      minSample: MIN_SAMPLE,
      minCrossSection: options.minCrossSection ?? 50,
      minWindowFraction: options.minWindowFraction ?? MIN_WINDOW_FRACTION,
      entryRule:
        "earliest tape snapshot whose market clock (asOf) is at or after the story's firstSeenAt",
      exitRule:
        "earliest tape snapshot whose market clock is at or after firstSeenAt + horizon; pending when none exists",
      minWindow:
        `a window shorter than minWindowFraction x horizon is pending, never an ok sample: with one snapshot entry and exit are the same instant and the return would be 0% by construction`,
      rawReturnPct: "ratio of chained board levels between entry and exit",
      sectorExcessPct:
        "rawReturnPct minus the same board's return over an equally long window ending at entry (trailing drift); null until that prior window exists",
      marketExcessPct:
        "rawReturnPct minus the cross-sectional mean of all industry boards over the identical entry→exit window",
      marketUniverse:
        "industry boards only (concepts would double-count the measured sectors); a board counts only when quoted at both endpoints within one chain segment",
      changePct:
        "tape changePct is relative to the previous close, so returns are computed from chained day-over-day levels, never from a difference of two changePct values",
      levels:
        "level(t) = base(day) x (1 + changePct/100), base chained from each day's close; a missing close starts a new segment and a window spanning it is a gap, never interpolated",
      attribution:
        "entity -> theme table (reviewable, in lib/reactions/attribution.ts) first, then topic, then 上证指数 as a market fallback; nothing is inferred",
      attributionStates:
        "entity = a sector board resolved and the tape quoted it; topic = the topic's broad board resolved; " +
        "market = the tape HAS started, the index is quoted, and the story genuinely has no entity or topic link; " +
        "pending = the tape has not started, so no board has ever been quoted and nothing can be attributed either way " +
        "— 'we could not check yet', counted in attributed.pending, never rolled into market; " +
        "null = the tape started but neither a sector board nor the index was quoted (attributed.unmapped)",
      aggregateUniverse:
        "topic rows hold entity- and topic-attributed samples only; market-attributed stories are measured on the index and are reported in counts.attributed instead, never as a sector reaction",
      minimumSample:
        `an aggregate is published only at n >= ${MIN_SAMPLE}; below it the row carries n and status "insufficient" with no mean, median or percentiles`,
      hitRate: "share of marketExcessPct samples > 0, where a sign is declared for the key",
      reproducibility:
        "no wall clock, no randomness; arrays are sorted by stable keys so a cold rebuild over identical inputs is byte-identical",
    },
    tape: store.summary,
    ledger: {
      stories: ledgerStories.length + noFirstSeen,
      withFirstSeen: ledgerStories.length,
      maxStories,
      retentionDays,
      updatedAt: updatedAt || null,
      retainedFrom: firsts.length ? firsts[0] : null,
      retainedTo: firsts.length ? firsts[firsts.length - 1] : null,
      // The cap binds when the ledger is exactly full: the oldest stories were
      // dropped by `maxStories`. That is a real constraint on long horizons,
      // but it is NOT the binding one today — measured on 2026-11-14, raising
      // the cap from 2,000 to 5,000 would add ~5 stories older than 7 days,
      // because retention (30 days) and the sidecar prune are what actually end
      // a story's life. `retentionDays` below is the number to raise first.
      capBinding: maxStories !== null && ledgerStories.length + noFirstSeen >= maxStories,
    },
    counts: {
      stories: ledgerStories.length + noFirstSeen,
      attributed: attributedCounts,
      horizons: horizonTotals,
      aggregates: { byTopic: byTopic.length, byEntity: byEntity.length },
      observationsTotal: measured.length,
      observationsPublished: observations.length,
    },
    aggregates: { byTopic, byEntity },
    observations,
    observationsTruncated: observations.length < measured.length,
    gaps,
  };
}
