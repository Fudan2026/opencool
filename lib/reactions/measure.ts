/**
 * Measuring one story's reaction over a horizon.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The two rules that decide whether the number means anything
 * ─────────────────────────────────────────────────────────────────────────
 *
 * **No lookahead.** An exit snapshot is the *earliest* snapshot whose market
 * clock is at or after `firstSeenAt + horizon`. Two failure modes are excluded
 * by construction and both are tested:
 *
 *   - an entry from before `firstSeenAt` (a story cannot move a board before we
 *     saw it);
 *   - an exit that predates the target instant, which would silently measure a
 *     shorter window and call it +1d.
 *
 * When no snapshot has reached the target instant yet, the horizon is
 * `pending`. It is never extrapolated, never filled from a shorter window.
 *
 * **Abnormal return.** The board's raw move is not the reaction. Two baselines
 * are subtracted, per horizon:
 *
 *   (a) the *same* board's own return over an equally long window ending at
 *       entry — its trailing drift, so a sector that was already running does
 *       not get credited to the story;
 *   (b) the cross-sectional mean of all industry boards over the *identical*
 *       [entry, exit] window — the market factor, so a sector that simply rode
 *       the tape nets to zero.
 *
 * Both are reported. `marketExcessPct` is the headline because it needs only
 * the two snapshots a horizon already requires; baseline (a) needs a full prior
 * window of tape and is honestly null until that history exists.
 */

import {
  boardSeriesKey,
  indexSeriesKey,
  levelAt,
  lastLevelBefore,
  type SeriesMap,
  type SnapshotPoint,
  type TapeStore,
} from "./tape-read";
import {
  HEADLINE_METRIC,
  HORIZONS,
  MIN_CROSS_SECTION,
  MIN_WINDOW_FRACTION,
  type AttributedStory,
  type HorizonKey,
  type HorizonSample,
  type StoryReaction,
} from "./types";

/** Mean of a numeric list; null when empty. */
function mean(values: readonly number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** Percent change between two levels, or null when either is unusable. */
export function pctChange(from: number | null, to: number | null): number | null {
  if (from === null || to === null) return null;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

/** The earliest snapshot at or after `targetMs`. Never an earlier one. */
export function earliestAtOrAfter(points: readonly SnapshotPoint[], targetMs: number): SnapshotPoint | null {
  for (const p of points) if (p.ms >= targetMs) return p;
  return null;
}

export interface MeasureOptions {
  /** Minimum industry boards for the cross-section to count as a market factor. */
  minCrossSection?: number;
  /** Share of the nominal horizon the measured window must cover. */
  minWindowFraction?: number;
}

/**
 * Cross-sectional mean of all industry boards' returns over [entry, exit].
 *
 * Industry-only on purpose: the theme/concept boards are the ones being
 * measured, and including them would fold the treatment into the control. A
 * board counts only when it has a level at *both* instants inside one chain
 * segment, so a partially-quoted day shrinks the universe instead of biasing
 * the mean toward whichever boards happened to be in the tape.
 */
export function marketMeanPct(
  series: SeriesMap,
  entry: { ms: number; date: string },
  exit: { ms: number; date: string },
): { meanPct: number | null; universe: number } {
  const returns: number[] = [];
  for (const s of series.values()) {
    if (s.kind !== "board" || s.boardKind !== "industry") continue;
    const a = levelAt(s, entry.ms);
    const b = levelAt(s, exit.ms);
    if (!a || !b) continue;
    // A chain break between the two makes the ratio meaningless.
    if (a.segment !== b.segment) continue;
    const r = pctChange(a.level, b.level);
    if (r === null) continue;
    returns.push(r);
  }
  return { meanPct: mean(returns), universe: returns.length };
}

/**
 * Baseline (a): the target's own return over an equally long window ending at
 * entry. `null` until the tape covers a full window before the entry — this is
 * the field that is legitimately absent through early history.
 */
export function trailingDriftPct(
  series: SeriesMap,
  targetKey: string,
  entry: { ms: number; date: string },
  horizonMinutes: number,
): number | null {
  const s = series.get(targetKey);
  if (!s) return null;
  const exitLevel = levelAt(s, entry.ms);
  if (!exitLevel) return null;
  const start = lastLevelBefore(s, entry.ms - horizonMinutes * 60_000);
  if (!start) return null;
  if (start.segment !== exitLevel.segment) return null;
  return pctChange(start.level, exitLevel.level);
}

/**
 * Measure one story over one horizon.
 *
 * Entry is the first snapshot at or after `firstSeenAt` — the earliest instant
 * at which the tape can show us what the sector did *once we knew*. A story
 * first seen inside a session therefore enters on the next capture, and the
 * entry overshoot is reported so a reader can see how coarse that is.
 */
export function measureHorizon(
  story: AttributedStory,
  horizon: { key: HorizonKey; minutes: number },
  store: TapeStore,
  series: SeriesMap,
  options: MeasureOptions = {},
): HorizonSample {
  const minCross = options.minCrossSection ?? MIN_CROSS_SECTION;
  const minWindowFraction = options.minWindowFraction ?? MIN_WINDOW_FRACTION;
  if (!story.target) {
    // A `pending` attribution has no target *because the tape has not started*,
    // which is a waiting condition — the same thing as any other pending
    // horizon. Reporting it as `gap` would say "this can never be measured",
    // and on day one that would mislabel every horizon of every story as a
    // permanent hole instead of "not yet".
    if (story.attribution === "pending") {
      return { status: "pending", reason: `attribution pending: ${story.attributionReason}` };
    }
    return { status: "gap", reason: "unmapped: no sector or index to measure" };
  }
  const seenMs = Date.parse(story.firstSeenAt);
  if (!Number.isFinite(seenMs)) {
    return { status: "gap", reason: `firstSeenAt is not a readable instant: ${story.firstSeenAt}` };
  }
  if (!store.points.length) {
    return { status: "pending", reason: "no tape snapshots captured yet" };
  }

  const entry = earliestAtOrAfter(store.points, seenMs);
  if (!entry) {
    return {
      status: "pending",
      reason: `no snapshot at or after firstSeenAt (${story.firstSeenAt}); tape ends ${store.summary.to ?? "empty"}`,
    };
  }

  const targetMs = seenMs + horizon.minutes * 60_000;
  const exit = earliestAtOrAfter(store.points, targetMs);
  if (!exit) {
    return {
      status: "pending",
      reason: `no snapshot at or after ${story.firstSeenAt} + ${horizon.key}; tape ends ${store.summary.to ?? "empty"}`,
      entry: { ms: entry.ms, asOf: entry.asOf, date: entry.date, slot: entry.slot },
      entryOvershootMinutes: Math.round(((entry.ms - seenMs) / 60_000) * 10) / 10,
    };
  }

  const windowMinutes = Math.round(((exit.ms - entry.ms) / 60_000) * 10) / 10;
  if (windowMinutes < horizon.minutes * minWindowFraction) {
    // Entry and exit are the same instant (or nearly), so the "return" would be
    // 0% by construction. Not a measurement: wait for a later capture.
    return {
      status: "pending",
      reason:
        `measured window would be ${windowMinutes}min of a ${horizon.minutes}min horizon ` +
        `(< ${Math.round(horizon.minutes * minWindowFraction)}min floor); a later capture extends it`,
      entry: { ms: entry.ms, asOf: entry.asOf, date: entry.date, slot: entry.slot },
      entryOvershootMinutes: Math.round(((entry.ms - seenMs) / 60_000) * 10) / 10,
    };
  }

  const key = story.target;
  const s = series.get(key);
  const entryLevel = levelAt(s, entry.ms);
  const exitLevel = levelAt(s, exit.ms);
  const entryInstant = { ms: entry.ms, asOf: entry.asOf, date: entry.date, slot: entry.slot };
  const exitInstant = { ms: exit.ms, asOf: exit.asOf, date: exit.date, slot: exit.slot };
  const overshootMinutes = Math.round(((exit.ms - targetMs) / 60_000) * 10) / 10;
  // How coarse the entry is, reported because a story seen at 10:00 measured
  // from a 10:35 capture has already lost 35 minutes of its reaction.
  const entryOvershootMinutes = Math.round(((entry.ms - seenMs) / 60_000) * 10) / 10;

  if (!s) {
    return {
      status: "gap",
      reason: `${key} never appears in the tape`,
      entry: entryInstant,
      exit: exitInstant,
      entryOvershootMinutes,
      overshootMinutes,
    };
  }
  if (!entryLevel || !exitLevel) {
    return {
      status: "gap",
      reason: `${story.targetLabel ?? key} was not quoted at ${!entryLevel ? "entry" : "exit"} (${!entryLevel ? entry.asOf : exit.asOf})`,
      entry: entryInstant,
      exit: exitInstant,
      entryOvershootMinutes,
      overshootMinutes,
    };
  }
  if (entryLevel.segment !== exitLevel.segment) {
    return {
      status: "gap",
      reason: `${story.targetLabel ?? key} has a broken quote chain between entry and exit — the window cannot be bridged`,
      entry: entryInstant,
      exit: exitInstant,
      entryOvershootMinutes,
      overshootMinutes,
    };
  }

  const raw = pctChange(entryLevel.level, exitLevel.level);
  if (raw === null) {
    return {
      status: "gap",
      reason: "entry level was zero — ratio undefined",
      entry: entryInstant,
      exit: exitInstant,
      entryOvershootMinutes,
      overshootMinutes,
    };
  }

  const market = marketMeanPct(series, entry, exit);
  const crossUsable = market.meanPct !== null && market.universe >= minCross;
  const drift = trailingDriftPct(series, key, entry, horizon.minutes);

  return {
    status: "ok",
    entry: entryInstant,
    exit: exitInstant,
    entryOvershootMinutes,
    overshootMinutes,
    windowMinutes,
    rawReturnPct: round4(raw),
    trailingDriftPct: drift === null ? null : round4(drift),
    sectorExcessPct: drift === null ? null : round4(raw - drift),
    marketMeanPct: market.meanPct === null ? null : round4(market.meanPct),
    marketExcessPct: crossUsable ? round4(raw - (market.meanPct as number)) : null,
    marketUniverse: market.universe,
  };
}

/** Measure every story over every horizon. Order in, order out. */
export function measureStories(
  stories: readonly AttributedStory[],
  store: TapeStore,
  series: SeriesMap,
  options: MeasureOptions = {},
): StoryReaction[] {
  return stories.map((story) => {
    const horizons = {} as Record<HorizonKey, HorizonSample>;
    for (const h of HORIZONS) horizons[h.key] = measureHorizon(story, h, store, series, options);
    return { ...story, horizons };
  });
}

/** The headline number for one sample, or null. */
export function headlineOf(sample: HorizonSample): number | null {
  return HEADLINE_METRIC === "marketExcessPct" ? (sample.marketExcessPct ?? null) : null;
}

/** Kept for symmetry with the type module's explanation. */
export const HEADLINE = HEADLINE_METRIC;
