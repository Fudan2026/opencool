/**
 * Reaction windows — the arithmetic shapes.
 *
 * A reaction is a statement about a *window*: "after we first saw this story,
 * the sector it belongs to moved X% more than the market did, over the next
 * hour / day / five days". Everything in this file exists to keep that
 * statement measurable and falsifiable rather than decorative.
 *
 * Three separate returns are reported for every measurable window, because a
 * raw sector move answers a much weaker question than readers think it does:
 *
 *   rawReturnPct       the sector's own move. Useless alone: 3% in a 3% tape is
 *                      not a reaction to anything.
 *   sectorExcessPct    raw minus the sector's *own* trailing drift over a
 *                      window of the same length. Removes "this sector was
 *                      already trending".
 *   marketExcessPct    raw minus the cross-sectional mean of all sectors over
 *                      the same window. Removes "the whole tape moved".
 *
 * `marketExcessPct` is the headline (see `HEADLINE_METRIC`): it is computable
 * from the two snapshots the measurement already needs, whereas the trailing
 * drift needs a full prior window of tape that will not exist for the first
 * days of history. Leading with a number that is null through the whole early
 * history would make the file look broken rather than honest.
 */

/** The three horizons, fixed. Minutes are nominal; the tape slot decides the truth. */
export type HorizonKey = "1h" | "1d" | "5d";

export interface HorizonDef {
  key: HorizonKey;
  label: string;
  minutes: number;
}

export const HORIZONS: readonly HorizonDef[] = [
  { key: "1h", label: "+1h", minutes: 60 },
  { key: "1d", label: "+1d", minutes: 24 * 60 },
  { key: "5d", label: "+5d", minutes: 5 * 24 * 60 },
] as const;

export const HORIZON_KEYS: readonly HorizonKey[] = HORIZONS.map((h) => h.key);

/** A published aggregate needs this many measured samples per key and horizon. */
export const MIN_SAMPLE = 20;

/**
 * The measured window must cover at least this share of the nominal horizon.
 *
 * Without it a single snapshot produces a "measurement": with one capture, the
 * entry and the exit are the same instant, the return is trivially 0%, and the
 * file reports thousands of `ok` samples of pure noise. That is the precise
 * failure this metric cannot afford, so a window shorter than half the horizon
 * is `pending` — the next capture extends it — never an `ok` sample of zero.
 *
 * Half is deliberately loose: the tape's own cadence is 30 minutes, so a +1h
 * window is normally measured over 30-120 minutes and never near the floor. A
 * `+1h` result measured over a whole afternoon still reports its true window
 * length and overshoot, so a reader can see how coarse it is.
 */
export const MIN_WINDOW_FRACTION = 0.5;

/** Below this many sectors the cross-section is not a market factor. */
export const MIN_CROSS_SECTION = 50;

/** Which of the three returns is the headline, and why. */
export const HEADLINE_METRIC = "marketExcessPct" as const;

export const HEADLINE_REASON =
  "Cross-sectional excess is the standard market-factor abnormal return and is " +
  "computable from exactly the two snapshots a horizon needs, so the headline is " +
  "never absent for a window that is otherwise measurable. `rawReturnPct` and " +
  "`sectorExcessPct` (vs the sector's own trailing drift over the same length) are " +
  "published alongside for every sample, but the trailing baseline needs a full " +
  "prior window of tape and is therefore null through the early history.";

/** How a story was attached to the sector it is measured on. */
export type AttributionKind = "entity" | "topic" | "market";

export type HorizonStatus = "ok" | "pending" | "gap";

export interface AttributedStory {
  id: string;
  firstSeenAt: string;
  firstEdition: string;
  topic: string;
  /** Board/market target the story is measured on, e.g. `theme:ai-compute`. */
  target: string | null;
  targetLabel: string | null;
  /** `null` when nothing defensible maps this story to a sector. */
  attribution: AttributionKind | null;
  /** The `entities[]` entry that selected the target, when attribution is entity/market. */
  entity: string | null;
  /** Why this target — short, human-readable, and stable. */
  attributionReason: string;
}

export interface Instant {
  /** Epoch ms of the snapshot's `asOf` (the market clock, not our fetch clock). */
  ms: number;
  /** ISO with offset, as published in the tape. */
  asOf: string;
  /** `YYYY-MM-DD` of that instant in the report timezone. */
  date: string;
  /** Capture slot `HH:MM`. */
  slot: string;
}

export interface HorizonSample {
  status: HorizonStatus;
  /** Named cause when the horizon could not be measured. */
  reason?: string;
  entry?: Instant;
  exit?: Instant;
  /** How far past `firstSeenAt` the entry snapshot landed, in minutes. */
  entryOvershootMinutes?: number;
  /** How far past `firstSeenAt + horizon` the exit snapshot landed, in minutes. */
  overshootMinutes?: number;
  /** Actual length of the measured window (exit − entry), in minutes. */
  windowMinutes?: number;
  /** Sector return over [entry, exit]. */
  rawReturnPct?: number | null;
  /** Baseline (a): the sector's own return over the equally long window before entry. */
  trailingDriftPct?: number | null;
  /** Raw minus baseline (a). Null when the trailing window is not measurable yet. */
  sectorExcessPct?: number | null;
  /** Baseline (b): cross-sectional mean of all sectors over [entry, exit]. */
  marketMeanPct?: number | null;
  /** Raw minus baseline (b). The headline. */
  marketExcessPct?: number | null;
  /** Sectors that entered the cross-section mean. */
  marketUniverse?: number;
}

export interface StoryReaction extends AttributedStory {
  horizons: Record<HorizonKey, HorizonSample>;
}

/** One distribution. Fields are absent (not null) below `MIN_SAMPLE`. */
export interface Distribution {
  n: number;
  status: "ok" | "insufficient";
  mean?: number;
  median?: number;
  p25?: number;
  p75?: number;
  /** Share of samples strictly beyond 0 in the declared direction. */
  hitRate?: number | null;
  hitRateBasis?: string | null;
  /** Means of the two supporting returns, present whenever the headline is. */
  meanRawReturnPct?: number | null;
  meanSectorExcessPct?: number | null;
  /** Samples that exist but were not measurable at this horizon. */
  excluded: { pending: number; gap: number };
}

export interface AggregateRow {
  key: string;
  label: string;
  /** Declared direction the hit rate is scored against; null = no defensible sign. */
  expectedSign: "positive" | null;
  horizons: Record<HorizonKey, Distribution>;
}

export interface ReactionGap {
  kind: string;
  detail: string;
  /** Optional file or path the gap is about. */
  file?: string;
  count?: number;
}

export interface TapeSummary {
  days: number;
  snapshots: number;
  from: string | null;
  to: string | null;
  /** Days present versus weekdays spanned, so a thin tape is visible. */
  slots: string[];
}

export interface LedgerSummary {
  stories: number;
  withFirstSeen: number;
  maxStories: number | null;
  retentionDays: number | null;
  updatedAt: string | null;
  retainedFrom: string | null;
  retainedTo: string | null;
  /** True when the ledger's cap, not its retention window, cut the oldest record. */
  capBinding: boolean;
}

export interface ReactionsPayload {
  schemaVersion: number;
  /** Newest instant the inputs describe. There is deliberately no wall clock. */
  dataThrough: string | null;
  timezone: string;
  headlineMetric: typeof HEADLINE_METRIC;
  headlineReason: string;
  method: Record<string, unknown>;
  tape: TapeSummary;
  ledger: LedgerSummary;
  counts: {
    stories: number;
    attributed: { entity: number; topic: number; market: number; unmapped: number };
    horizons: Record<HorizonKey, { ok: number; pending: number; gap: number }>;
    aggregates: { byTopic: number; byEntity: number };
    observationsTotal: number;
    observationsPublished: number;
  };
  aggregates: {
    byTopic: AggregateRow[];
    byEntity: AggregateRow[];
  };
  observations: StoryReaction[];
  observationsTruncated: boolean;
  gaps: ReactionGap[];
}
