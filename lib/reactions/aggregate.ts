/**
 * Aggregation — distributions, not point estimates.
 *
 * A news reaction is fat-tailed: one rate decision and one earnings shock can
 * carry a mean that no typical story ever produced. Publishing only a mean is
 * therefore not a simplification, it is a different (and wrong) claim. Every
 * row here carries `n`, `median`, `mean`, `p25`, `p75` and a `hitRate`, and a
 * row below `MIN_SAMPLE` carries `n` and `status: "insufficient"` with **no**
 * distribution fields at all — so a consumer cannot read a mean off a row that
 * was never allowed to have one.
 *
 * Two more properties are load-bearing for a published artifact:
 *
 *   - **order-independent**: samples are sorted by a stable key before any
 *     percentile is taken, so a re-run over a different input order produces
 *     the same row;
 *   - **byte-identical on rebuild**: no wall clock, no `Math.random`, no
 *     `Set`/`Map` iteration order leaking into output. The baker sorts the
 *     top-level arrays itself.
 */

import {
  HEADLINE_METRIC,
  HORIZONS,
  MIN_SAMPLE,
  type AggregateRow,
  type Distribution,
  type HorizonKey,
  type StoryReaction,
} from "./types";

/** Linear-interpolated percentile, `p` in [0, 1] over an ascending array. */
export function percentile(sortedAscending: readonly number[], p: number): number | null {
  const n = sortedAscending.length;
  if (!n) return null;
  if (n === 1) return sortedAscending[0];
  const pos = (n - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAscending[lo];
  const frac = pos - lo;
  return sortedAscending[lo] * (1 - frac) + sortedAscending[hi] * frac;
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

function median(sortedAscending: readonly number[]): number | null {
  return percentile(sortedAscending, 0.5);
}

/**
 * Share of samples with the expected sign. `positive` counts `> 0`; a sample of
 * exactly zero is neither a hit nor a miss, so it counts against the rate —
 * the conservative reading, since "the sector did not move" is not evidence the
 * story mattered.
 */
export function hitRate(values: readonly number[], sign: "positive" | null): number | null {
  if (sign === null || !values.length) return null;
  return Math.round((values.filter((v) => v > 0).length / values.length) * 10_000) / 10_000;
}

/** Build one horizon's distribution from samples that are measurable. */
export function distribution(
  samples: readonly StoryReaction[],
  horizon: HorizonKey,
  sign: "positive" | null,
): Distribution {
  const ok: StoryReaction[] = [];
  let pending = 0;
  let gap = 0;
  for (const s of samples) {
    const h = s.horizons[horizon];
    if (!h) continue;
    if (h.status === "pending") pending++;
    else if (h.status === "gap") gap++;
    else if (h.marketExcessPct !== null) ok.push(s);
    else if (h.rawReturnPct !== null) ok.push(s);
    else gap++;
  }

  const value = (s: StoryReaction): number | null =>
    HEADLINE_METRIC === "marketExcessPct" ? (s.horizons[horizon].marketExcessPct ?? null) : null;

  const values: number[] = [];
  const raws: number[] = [];
  const sectorExcess: number[] = [];
  for (const s of ok) {
    const v = value(s);
    if (v === null) continue;
    values.push(v);
    raws.push(s.horizons[horizon].rawReturnPct ?? 0);
    if (typeof s.horizons[horizon].sectorExcessPct === "number") {
      sectorExcess.push(s.horizons[horizon].sectorExcessPct as number);
    }
  }

  const n = values.length;
  const excluded = { pending, gap };

  if (n < MIN_SAMPLE) {
    // No mean, no median, no percentiles: below the guard there is nothing
    // here that a reader is allowed to interpret as signal.
    return { n, status: "insufficient", excluded };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((a, b) => a + b, 0);
  return {
    n,
    status: "ok",
    mean: round4(total / n),
    median: round4(median(sorted) as number),
    p25: round4(percentile(sorted, 0.25) as number),
    p75: round4(percentile(sorted, 0.75) as number),
    hitRate: hitRate(values, sign),
    hitRateBasis:
      sign === null
        ? null
        : `${HEADLINE_METRIC} > 0 (a zero counts as a miss)`,
    meanRawReturnPct: round4(raws.reduce((a, b) => a + b, 0) / n),
    meanSectorExcessPct: sectorExcess.length
      ? round4(sectorExcess.reduce((a, b) => a + b, 0) / sectorExcess.length)
      : null,
    excluded,
  };
}

export interface GroupSpec {
  key: string;
  label: string;
  /** Declared direction the hit rate scores against. null = undeclared. */
  expectedSign: "positive" | null;
}

/**
 * Declared direction per key.
 *
 * Only keys where the sign of the *reaction to news* is defensible get one:
 * a positive-supply shock to energy reprices the oil board up, a positive AI
 * capex read reprices compute up. Everything else is left null rather than
 * guessed, because a hit rate against an invented sign is a fabricated metric.
 */
export const EXPECTED_SIGN: Readonly<Record<string, "positive" | null>> = {
  "tech-ai": "positive",
  "global-markets": "positive",
  ai: "positive",
  "ai-compute": "positive",
  semiconductor: "positive",
  oil: "positive",
  ev: "positive",
  metals: "positive",
};

export function signFor(key: string): "positive" | null {
  return EXPECTED_SIGN[key] ?? null;
}

/** Group measured stories by a key extractor and build a full row per group. */
export function aggregate(
  samples: readonly StoryReaction[],
  groupOf: (s: StoryReaction) => string | null,
  labelOf: (key: string) => string,
): AggregateRow[] {
  const groups = new Map<string, StoryReaction[]>();
  for (const s of samples) {
    const key = groupOf(s);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }

  const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  return keys.map((key) => {
    // Stable order before any percentile is taken.
    const list = [...(groups.get(key) as StoryReaction[])].sort((a, b) => a.id.localeCompare(b.id));
    const sign = signFor(key);
    const horizons = {} as Record<HorizonKey, Distribution>;
    for (const h of HORIZONS) horizons[h.key] = distribution(list, h.key, sign);
    return { key, label: labelOf(key), expectedSign: sign, horizons };
  });
}
