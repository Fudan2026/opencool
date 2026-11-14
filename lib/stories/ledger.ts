/**
 * Story ledger — the persistent, point-in-time record of "when did we first
 * see this story, and how did it move".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What this is for
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A daily brief is a series of snapshots; a *ledger* is what makes those
 * snapshots comparable. Every edition re-fetches the same feeds, so the same
 * story recurs and every wire eventually piles on. Two things become
 * computable only because we timestamp each fetch:
 *
 *   谁最先报道  — first-mover ranking per wire, with the lead in minutes over
 *                 the runner-up. Requires knowing who was earliest *to us*.
 *   消息修订史  — the revision trail: when a wire rewrites a headline we keep
 *                 both versions, in order, with timestamps.
 *
 * Both are pure arithmetic over persisted state. Zero LLM, zero network.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Where the clock comes from (the load-bearing decision)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `firstSeenAt` is **our** observation time, never the feed's `pubDate`. The
 * point-in-time claim is "what was knowable to us, and when" — a feed that
 * back-dates a story by six hours, or a wire whose clock is off by two, must
 * not be able to rewrite our own history. The feed's timestamp is still
 * recorded (`publishedAt` per sighting, plus the record's earliest
 * `publishedAt`) and the gap between the two is exposed as
 * `publishLagMinutes`: a negative lag means the wire claims it published
 * before we could possibly have seen it, which is exactly the kind of thing a
 * point-in-time consumer needs to be able to see rather than have smoothed
 * away.
 *
 * `firstSeenAt` is **frozen at creation**. If a later backfill of an older
 * edition carries an even earlier observation, the record keeps its original
 * instant and the out-of-order sighting is ignored for the first-seen claim.
 * Rewriting first-seen after the fact is how a vintage store turns into a
 * story about itself.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Clustering: the primitives are shared, the verdict is gated (v2)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The cluster primitive is still `storyCluster()` from `lib/topics/dedupe.ts`
 * — entity-first (`entity:nvidia`), exact-title fallback (`title:…`) — and it
 * stays the routing density cap's key, so one event, one budget, across
 * language lanes. What v2 changed is what a cluster key *proves* at ingest:
 *
 *   - a cluster key is a CANDIDATE, not a verdict. `entity:trump` had
 *     accumulated 500 sightings of unrelated stories under v1 (any headline
 *     naming the entity attached to the newest record); a candidate only
 *     wins if its current anchors (original + latest observed headline)
 *     still carry the incoming headline under the gated `sameStoryHeadlines`
 *     affinity. Otherwise the article is a new story that shares an entity,
 *     and it gets its own record.
 *   - a reworded repeat that drops or swaps its entity mention ("Man United
 *     sack…" vs "Manchester United sack…") now finds its record through the
 *     same affinity gate over recently-seen records, instead of being split
 *     by its different cluster key.
 *
 * `dedupeStories()` is used for its own job — counting exact/near duplicates
 * per edition — but duplicates are *not* dropped from `sightings`: two wires
 * printing the same sentence are two observations, and dropping one would
 * silently delete a first-mover credit. `exactStoryKey()` decides whether a
 * headline actually changed (a rewrite) or merely repeated.
 *
 * Two identity guards came out of running this over the real 11-edition
 * window, both of them things a url-only heuristic gets wrong:
 *
 *   - a **url match must agree on cluster**. Rolling newsletter urls (FirstFT,
 *     "Markets Wrap", live blogs) keep one address while the lead story
 *     changes completely; trusting the url filed "Oil price falls" as a
 *     revision of an Nvidia headline.
 *   - a **wire repeating its own unchanged headline** on a later edition is
 *     the feed resurfacing, not a new observation. v2 widened this from
 *     url-history to *any* observed surface: real wires repeat unchanged
 *     under new urls too (Yahoo's daily "Stock Market: Will S&P 500 Open Up
 *     or Down Today?", 财联社's `早间新闻精选`), which v1 let through and one
 *     wire's trail inflated by one sighting per edition.
 *
 * Identity across runs: a record's `id` is a hash of the earliest entity set
 * plus the normalized title tokens, computed **once** at creation and then
 * persisted. A cluster never changes id when a new wire joins it, because the
 * id is data, not a derived value. A cluster may now hold several records
 * (one per story about that entity); each keeps its own frozen id and trail,
 * and the gates above decide which one a new headline joins.
 */

import { createHash } from "node:crypto";

import { tokenizeTitle } from "../nlp/tokenize-title";
import { classifyArticle, normalizeTitle } from "../topics/classify";
import {
  exactStoryKey,
  storyCluster,
  storyEntities,
  dedupeStories,
  sameStoryHeadlines,
} from "../topics/dedupe";
import type { LaneKey, TopicKey } from "../topics/taxonomy";
import { getReportTz } from "../utils";
import { civilDate, isoWithOffset, minutesBetween, parseInstant, shiftDateKey } from "./time";

export const LEDGER_VERSION = 1 as const;

/** Retained history. 30 days matches the articles-sidecar prune in build-site. */
export const DEFAULT_RETENTION_DAYS = 30;
/** Hard cap, so a pathological day cannot make the published file unbounded. */
export const DEFAULT_MAX_STORIES = 2000;
/** Rolling window the first-mover ranking aggregates over. */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * Days around the current edition in which a reworded repeat may find its
 * record under a *different* cluster key (the wire dropped or swapped its
 * entity mention). A same-cycle phenomenon: reworded repeats do not resurface
 * a week later.
 */
export const REWORDED_REPEAT_WINDOW_DAYS = 2;

// ---------------------------------------------------------------------------
// Record shapes
// ---------------------------------------------------------------------------

export interface StorySighting {
  sourceId: string;
  /** When *we* observed it — never the feed's timestamp. */
  observedAt: string;
  title: string;
  url: string;
  /** `<date>/<hour>` of the edition this observation came from. */
  edition: string;
  /** The wire's own claim of when it published, when the feed carried one. */
  publishedAt?: string;
}

/**
 * One wire rewriting its own headline for the story it already carried.
 *
 * Both versions are kept. A revision is deliberately *not* "another wire said
 * it differently" — that is a sighting, and collapsing the two would turn a
 * 17-wire event into 17 fake revisions and destroy the trail's meaning.
 */
export interface HeadlineRevision {
  at: string;
  sourceId: string;
  edition: string;
  url: string;
  from: string;
  to: string;
}

export interface FirstMover {
  /** Credited wire when it broke the story alone on our clock; else null. */
  sourceId: string | null;
  observedAt: string | null;
  /** True when more than one wire was first seen at the same instant. */
  tied: boolean;
  /** Every wire observed at the earliest instant, sorted. */
  coFirstSourceIds: string[];
  runnerUpSourceId: string | null;
  runnerUpObservedAt: string | null;
  /** Minutes from the earliest observation to the runner-up's first. */
  leadMinutes: number | null;
}

export interface StoryRecord {
  id: string;
  /** `storyCluster()` key the record was created under. Frozen. */
  cluster: string;
  /** The headline as it read when the story broke (first observation). */
  title: string;
  url: string;
  /** Our first observation. Frozen — see the module note. */
  firstSeenAt: string;
  firstEdition: string;
  firstSourceId: string;
  /** Earliest feed timestamp seen for this story, when any carried one. */
  publishedAt: string | null;
  /** `firstSeenAt` minus `publishedAt`, in minutes. Negative = wire claims an earlier publish than our fetch. */
  publishLagMinutes: number | null;
  lastSeenAt: string;
  lastEdition: string;
  topic: TopicKey;
  lane: LaneKey;
  domestic: boolean;
  entities: string[];
  /** Distinct wires, in first-seen order. */
  sources: string[];
  /** Subsequent observations, chronological. The first one is the record's own fields. */
  sightings: StorySighting[];
  headlineRevisions: HeadlineRevision[];
  firstMover: FirstMover;
}

/** Persisted state. Everything else in the published file is derived. */
export interface StoryLedger {
  version: typeof LEDGER_VERSION;
  timezone: string;
  retentionDays: number;
  maxStories: number;
  updatedAt: string;
  stories: StoryRecord[];
}

// ---------------------------------------------------------------------------
// Derived artifacts
// ---------------------------------------------------------------------------

export interface FirstMoverRow {
  sourceId: string;
  /**
   * Stories where this wire's observation was the earliest, contested or not.
   * Includes single-wire stories, so it tracks output volume as much as
   * speed; `contestedFirsts` is the honest headline.
   */
  soleFirsts: number;
  /** Earliest on a story another wire later had to catch up on. */
  contestedFirsts: number;
  /** Stories where it was one of several wires first seen at the same instant. */
  coFirsts: number;
  /** Stories the wire appears on at all, in the window. */
  stories: number;
  /** Samples behind `medianLeadMinutes` (contested stories only). */
  leadSamples: number;
  medianLeadMinutes: number | null;
}

export interface FirstMoverRanking {
  windowDays: number;
  from: string;
  to: string;
  storiesInWindow: number;
  /** Stories where the earliest observation had a single wire. */
  soleFirstStories: number;
  /** Stories where that single wire was later followed by a second one. */
  contestedStories: number;
  /** Stories where several wires were first seen at the same instant. */
  tiedFirstStories: number;
  /**
   * How finely the lead can be measured. Leads are bounded below by the
   * edition cadence: we observe at 06:00/13:00/19:00, so "led by 900 minutes"
   * means "had it at the morning fetch while the runner-up only showed up at
   * the evening one", not a stopwatch on the wire. `observed` is stated
   * explicitly so nobody reads these numbers as publication latency.
   */
  leadBasis: "observed";
  wires: FirstMoverRow[];
}

export interface RevisionStep {
  at: string;
  from: string;
  to: string;
  removed: string[];
  added: string[];
}

export interface RevisionTrailEntry {
  id: string;
  title: string;
  topic: TopicKey;
  revisions: number;
  steps: RevisionStep[];
}

export interface RevisionTrail {
  storiesWithRevisions: number;
  totalRevisions: number;
  /** Longest trails first, capped by the caller. */
  items: RevisionTrailEntry[];
}

export interface LedgerStats {
  editions: number;
  articles: number;
  /** Exact/near duplicates `dedupeStories` found; kept as sightings, counted here. */
  duplicates: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * URL identity. Feeds repeat the same article across editions with rotating
 * tracking params (`?mod=rss_markets_main`), so a query string must not create
 * a second story. The path is the identity; the host is lowercased; the
 * tracking fragment is dropped.
 */
export function canonicalUrl(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    const host = u.host.toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return s.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  }
}

/** `2026-11-13/13` — the edition a sighting came from. */
export function editionKey(date: string, hour: string): string {
  return `${date}/${String(hour).padStart(2, "0")}`;
}

function hashSeed(entities: readonly string[], tokens: readonly string[]): string {
  const seed = JSON.stringify({ entities: [...entities].sort(), tokens: [...tokens].sort() });
  return createHash("sha1").update(seed).digest("hex").slice(0, 10);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(raw * 10) / 10;
}

function tokenDelta(from: string, to: string): { removed: string[]; added: string[] } {
  const a = tokenizeTitle(normalizeTitle(from));
  const b = tokenizeTitle(normalizeTitle(to));
  const removed: string[] = [];
  const added: string[] = [];
  for (const t of a) if (!b.has(t)) removed.push(t);
  for (const t of b) if (!a.has(t)) added.push(t);
  return { removed: removed.sort().slice(0, 8), added: added.sort().slice(0, 8) };
}

// ---------------------------------------------------------------------------
// Construction / revival
// ---------------------------------------------------------------------------

export interface LedgerOptions {
  retentionDays?: number;
  maxStories?: number;
  now?: Date;
}

/**
 * The zone the ledger's offsets describe. `REPORT_TZ` when set; otherwise the
 * host's resolved zone — never the literal string "system", which would tell a
 * consumer nothing and is what shipped once before this was tightened.
 */
export function ledgerTimezone(): string {
  return (
    getReportTz() ??
    Intl.DateTimeFormat().resolvedOptions().timeZone ??
    "UTC"
  );
}

export function emptyLedger(opts: LedgerOptions = {}): StoryLedger {
  const now = opts.now ?? new Date();
  return {
    version: LEDGER_VERSION,
    timezone: ledgerTimezone(),
    retentionDays: opts.retentionDays ?? DEFAULT_RETENTION_DAYS,
    maxStories: opts.maxStories ?? DEFAULT_MAX_STORIES,
    updatedAt: isoWithOffset(now),
    stories: [],
  };
}

function readTopic(value: unknown): TopicKey | null {
  const s = typeof value === "string" ? value : "";
  return s ? (s as TopicKey) : null;
}

function readLane(value: unknown): LaneKey | null {
  const s = typeof value === "string" ? value : "";
  return s === "zh" || s === "external" ? s : null;
}

/**
 * Rebuild the first-mover view from the record's own observations.
 *
 * Ties are real: one fetch observes every wire at the same instant, so
 * "who was first" within a single edition is unknowable and is recorded as
 * `tied` rather than as an arbitrary alphabetical win. The runner-up is the
 * earliest observation from a *different* wire than the first set, which is
 * what "lead over the second distinct source" means.
 */
function computeFirstMover(
  story: Pick<StoryRecord, "firstSeenAt" | "firstSourceId" | "sightings">,
): FirstMover {
  const observations: Array<{ at: Date; sourceId: string }> = [];
  const seedAt = parseInstant(story.firstSeenAt);
  if (seedAt) observations.push({ at: seedAt, sourceId: story.firstSourceId });
  for (const s of story.sightings) {
    const at = parseInstant(s.observedAt);
    if (at) observations.push({ at, sourceId: s.sourceId });
  }
  observations.sort((a, b) => a.at.getTime() - b.at.getTime() || a.sourceId.localeCompare(b.sourceId));

  if (observations.length === 0) {
    return {
      sourceId: null,
      observedAt: null,
      tied: false,
      coFirstSourceIds: [],
      runnerUpSourceId: null,
      runnerUpObservedAt: null,
      leadMinutes: null,
    };
  }

  const earliest = observations[0].at;
  const firstSources = new Set(
    observations.filter((o) => o.at.getTime() === earliest.getTime()).map((o) => o.sourceId),
  );
  const runnerUp = observations.find(
    (o) => o.at.getTime() > earliest.getTime() && !firstSources.has(o.sourceId),
  );

  const coFirst = [...firstSources].sort();
  return {
    sourceId: coFirst.length === 1 ? coFirst[0] : null,
    observedAt: isoWithOffset(earliest),
    tied: coFirst.length > 1,
    coFirstSourceIds: coFirst,
    runnerUpSourceId: runnerUp?.sourceId ?? null,
    runnerUpObservedAt: runnerUp ? isoWithOffset(runnerUp.at) : null,
    leadMinutes: runnerUp ? minutesBetween(earliest, runnerUp.at) : null,
  };
}

/**
 * Recompute a record's derived fields from its observations. Used at creation,
 * after every attach, and once on revival so a hand-edited or older file
 * cannot leave `firstMover` disagreeing with `sightings`.
 */
export function recomputeDerived(story: StoryRecord): StoryRecord {
  const stamps = [
    { at: parseInstant(story.firstSeenAt), edition: story.firstEdition },
    ...story.sightings.map((s) => ({ at: parseInstant(s.observedAt), edition: s.edition })),
  ]
    .filter((x): x is { at: Date; edition: string } => x.at !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const last = stamps[stamps.length - 1];
  if (last) {
    story.lastSeenAt = isoWithOffset(last.at);
    if (last.edition) story.lastEdition = last.edition;
  }

  const published = [
    story.publishedAt,
    ...story.sightings.map((s) => s.publishedAt),
  ]
    .map((iso) => parseInstant(iso))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  story.publishedAt = published ? published.toISOString() : null;
  const first = parseInstant(story.firstSeenAt);
  story.publishLagMinutes =
    published && first ? minutesBetween(published, first) : null;

  const seen = new Set<string>();
  const sources: string[] = [];
  for (const id of [story.firstSourceId, ...story.sightings.map((s) => s.sourceId)]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    sources.push(id);
  }
  story.sources = sources;
  story.firstMover = computeFirstMover(story);
  return story;
}

function readSighting(raw: unknown): StorySighting | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const sourceId = typeof r.sourceId === "string" ? r.sourceId.trim() : "";
  const observedAt = parseInstant(r.observedAt);
  if (!sourceId || !observedAt) return null;
  return {
    sourceId,
    observedAt: isoWithOffset(observedAt),
    title: typeof r.title === "string" ? r.title : "",
    url: typeof r.url === "string" ? r.url : "",
    edition: typeof r.edition === "string" ? r.edition : "",
    ...(parseInstant(r.publishedAt)
      ? { publishedAt: (parseInstant(r.publishedAt) as Date).toISOString() }
      : {}),
  };
}

function readRevision(raw: unknown): HeadlineRevision | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const at = parseInstant(r.at);
  if (!at || typeof r.from !== "string" || typeof r.to !== "string") return null;
  return {
    at: isoWithOffset(at),
    sourceId: typeof r.sourceId === "string" ? r.sourceId : "",
    edition: typeof r.edition === "string" ? r.edition : "",
    url: typeof r.url === "string" ? r.url : "",
    from: r.from,
    to: r.to,
  };
}

function readStory(raw: unknown): StoryRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  const firstSeenAt = parseInstant(r.firstSeenAt);
  const firstSourceId = typeof r.firstSourceId === "string" ? r.firstSourceId : "";
  if (!id || !firstSeenAt || !firstSourceId) return null;

  const sightings = Array.isArray(r.sightings)
    ? r.sightings.map(readSighting).filter((s): s is StorySighting => s !== null)
    : [];
  const revisions = Array.isArray(r.headlineRevisions)
    ? r.headlineRevisions.map(readRevision).filter((x): x is HeadlineRevision => x !== null)
    : [];

  const story: StoryRecord = {
    id,
    cluster: typeof r.cluster === "string" ? r.cluster : storyCluster(String(r.title ?? "")),
    title: typeof r.title === "string" ? r.title : "",
    url: typeof r.url === "string" ? r.url : "",
    firstSeenAt: isoWithOffset(firstSeenAt),
    firstEdition: typeof r.firstEdition === "string" ? r.firstEdition : "",
    firstSourceId,
    publishedAt: parseInstant(r.publishedAt)
      ? (parseInstant(r.publishedAt) as Date).toISOString()
      : null,
    publishLagMinutes:
      typeof r.publishLagMinutes === "number" && Number.isFinite(r.publishLagMinutes)
        ? r.publishLagMinutes
        : null,
    lastSeenAt: isoWithOffset(firstSeenAt),
    lastEdition: typeof r.lastEdition === "string" ? r.lastEdition : "",
    topic: readTopic(r.topic) ?? classifyArticle({ title: String(r.title ?? "") }).topic,
    lane: readLane(r.lane) ?? classifyArticle({ title: String(r.title ?? "") }).lane,
    domestic: typeof r.domestic === "boolean" ? r.domestic : false,
    entities: Array.isArray(r.entities)
      ? r.entities.filter((e): e is string => typeof e === "string")
      : storyEntities(String(r.title ?? "")),
    sources: [],
    sightings,
    headlineRevisions: revisions,
    firstMover: {
      sourceId: null,
      observedAt: null,
      tied: false,
      coFirstSourceIds: [],
      runnerUpSourceId: null,
      runnerUpObservedAt: null,
      leadMinutes: null,
    },
  };
  return recomputeDerived(story);
}

/**
 * Fail-open revival. A record that cannot be read is skipped and counted —
 * never fatal, because a corrupt ledger must degrade to "we lost some history"
 * rather than to "the edition does not publish".
 */
export function reviveLedger(
  raw: unknown,
  opts: LedgerOptions = {},
): { ledger: StoryLedger; skipped: number } {
  const base = emptyLedger(opts);
  if (!raw || typeof raw !== "object") return { ledger: base, skipped: 0 };
  const r = raw as Record<string, unknown>;
  const list = Array.isArray(r.stories) ? r.stories : [];
  const stories: StoryRecord[] = [];
  let skipped = 0;
  for (const item of list) {
    const story = readStory(item);
    if (story) stories.push(restamp(story));
    else skipped++;
  }
  return {
    ledger: {
      ...base,
      // The file's own `timezone` is deliberately NOT inherited: it names the
      // zone the *previous* run rendered offsets in. Instants are re-stamped
      // into the active zone below, so declaring the stale zone would be a lie
      // and would pin every future edition to a runner's clock.
      retentionDays:
        typeof r.retentionDays === "number" && r.retentionDays >= 0
          ? r.retentionDays
          : base.retentionDays,
      maxStories:
        typeof r.maxStories === "number" && r.maxStories > 0
          ? r.maxStories
          : base.maxStories,
      updatedAt: parseInstant(r.updatedAt)
        ? isoWithOffset(parseInstant(r.updatedAt) as Date)
        : base.updatedAt,
      stories,
    },
    skipped,
  };
}

/**
 * Re-render every instant in a record into the active timezone.
 *
 * Self-healing on purpose: the ledger's instants are absolute, so the offset
 * they are *written* with is presentation. A file stamped in a runner's UTC
 * (`+00:00`) is corrected the next time it is revived under `REPORT_TZ`, which
 * is how the one mis-stamped publication repaired itself instead of needing a
 * hand edit of published history.
 */
function restamp(story: StoryRecord): StoryRecord {
  const fix = (iso: string): string => {
    const at = parseInstant(iso);
    return at ? isoWithOffset(at) : iso;
  };
  story.firstSeenAt = fix(story.firstSeenAt);
  story.lastSeenAt = fix(story.lastSeenAt);
  for (const s of story.sightings) s.observedAt = fix(s.observedAt);
  for (const r of story.headlineRevisions) r.at = fix(r.at);
  return recomputeDerived(story);
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/** One article as it arrives from an edition sidecar. */
export interface StoryArticle {
  sourceId: string;
  title: string;
  url: string;
  publishedAt?: Date | string | null;
  topic?: string | null;
  lane?: string | null;
  domestic?: boolean | null;
}

export interface EditionInput {
  date: string;
  hour: string;
  /** When *we* fetched this edition — `fetch_health.generated_at`, else the slot. */
  observedAt: Date;
  articles: readonly StoryArticle[];
}

export interface IngestStats {
  created: number;
  attached: number;
  revisions: number;
  duplicates: number;
}

/**
 * Every title a url has been observed with, chronologically.
 *
 * Replay order matters here: a warm rebuild replays the *whole* retention
 * window, so "the previous headline for this url" must mean "the headline as of
 * the instant being ingested", not "the newest headline we ever saw". Reading
 * the newest one would make replaying an older edition look like the wire had
 * rewritten its newest headline back into the old text, and invent a revision
 * on every rebuild.
 */
interface TitleEvent {
  at: Date;
  title: string;
}

function titleHistory(story: StoryRecord): Map<string, TitleEvent[]> {
  const out = new Map<string, TitleEvent[]>();
  const push = (url: string, at: Date | null, title: string) => {
    if (!at || !url) return;
    const key = canonicalUrl(url);
    if (!key) return;
    const list = out.get(key);
    if (list) list.push({ at, title });
    else out.set(key, [{ at, title }]);
  };
  push(story.url, parseInstant(story.firstSeenAt), story.title);
  for (const s of story.sightings) push(s.url, parseInstant(s.observedAt), s.title);
  for (const r of story.headlineRevisions) push(r.url, parseInstant(r.at), r.to);
  for (const list of out.values()) list.sort((a, b) => a.at.getTime() - b.at.getTime());
  return out;
}

/**
 * Merge one edition into the ledger.
 *
 * Idempotent by construction: a sighting is keyed by
 * `edition|sourceId|canonicalUrl`, so re-baking the same edition (CI rebuilds
 * a slot on retry) adds nothing, and a rebuild that carries a rewritten
 * headline adds exactly one revision rather than one per attempt.
 */
export function ingestEdition(ledger: StoryLedger, edition: EditionInput): IngestStats {
  const stats: IngestStats = { created: 0, attached: 0, revisions: 0, duplicates: 0 };
  const observedAt = isoWithOffset(edition.observedAt);
  if (!observedAt) return stats;
  const editionTag = editionKey(edition.date, edition.hour);

  // ---- v2 identity helpers (see `lib/topics/dedupe.ts` for the rules) ----
  /** Calendar days between two `YYYY-MM-DD` keys. */
  const dayGap = (fromDay: string, toDay: string): number =>
    Math.round(
      (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000,
    );

  /** An observed headline that can vouch for the record's identity. */
  interface Anchor {
    title: string;
    day: string;
  }

  /**
   * Does the record currently carry this headline as its story? A repeat must
   * look like the record's *current* surface or its original headline — not
   * any of the intermediate titles the v1 mega-merge once folded in. (Comparing
   * against every historical title is how entity buckets like `entity:trump`
   * (500 sightings) absorbed everything.)
   */
  const carriesHeadline = (story: StoryRecord, title: string): boolean =>
    // A byte-identical reprint of any observed surface attaches even when the
    // current anchor has moved on (v1 semantics: exact surface = same story).
    exactRepeatCarried(story, title) ||
    // Otherwise the current anchors must vouch under the v2 gates.
    anchorsOf(story).some((anchor) =>
      sameStoryHeadlines(anchor.title, title, dayGap(anchor.day, edition.date)),
    );

  /** Any observed surface of this record is byte-identical to `title`. */
  const exactRepeatCarried = (story: StoryRecord, title: string): boolean =>
    [story.title, ...story.sightings.map((s) => s.title), ...story.headlineRevisions.map((r) => r.to)]
      .some((t) => exactStoryKey(t) === exactStoryKey(title));

  /** Newest-first order shared by both candidate searches. */
  const newestFirst = (a: StoryRecord, b: StoryRecord): number =>
    (parseInstant(b.lastSeenAt)?.getTime() ?? 0) - (parseInstant(a.lastSeenAt)?.getTime() ?? 0) ||
    a.id.localeCompare(b.id);

  /** Civil day of a record's most recent observation (REPORT_TZ wall clock). */
  const dayCache = new Map<string, string>();
  const civilDateOf = (story: StoryRecord): string => {
    const hit = dayCache.get(story.id);
    if (hit !== undefined) return hit;
    const at = parseInstant(story.lastSeenAt);
    const day = at ? civilDate(at, getReportTz()) : edition.date;
    dayCache.set(story.id, day);
    return day;
  };

  /**
   * Cached anchors: recomputed only when the record actually changed. The
   * cache key embeds the mutation counters so a fresh sighting invalidates it.
   */
  const anchorCache = new Map<string, Anchor[]>();
  const anchorsOf = (story: StoryRecord): Anchor[] => {
    const key = `${story.id}|${story.sightings.length}|${story.headlineRevisions.length}|${story.lastSeenAt}`;
    const hit = anchorCache.get(key);
    if (hit !== undefined) return hit;
    const computed = computeAnchors(story);
    anchorCache.set(key, computed);
    return computed;
  };

  function computeAnchors(story: StoryRecord): Anchor[] {
    const out: Anchor[] = [];
    const first = parseInstant(story.firstSeenAt);
    out.push({
      title: story.title,
      day: first ? civilDate(first, getReportTz()) : edition.date,
    });
    const lastSighting = [...story.sightings].sort(
      (a, b) =>
        (parseInstant(b.observedAt)?.getTime() ?? 0) - (parseInstant(a.observedAt)?.getTime() ?? 0),
    )[0];
    if (lastSighting) {
      const at = parseInstant(lastSighting.observedAt);
      out.push({
        title: lastSighting.title,
        day: at ? civilDate(at, getReportTz()) : edition.date,
      });
    }
    const lastRevision = [...story.headlineRevisions].sort(
      (a, b) =>
        (parseInstant(b.at)?.getTime() ?? 0) - (parseInstant(a.at)?.getTime() ?? 0),
    )[0];
    if (lastRevision) {
      const at = parseInstant(lastRevision.at);
      out.push({
        title: lastRevision.to,
        day: at ? civilDate(at, getReportTz()) : edition.date,
      });
    }
    return out;
  }

  const byCluster = new Map<string, StoryRecord[]>();
  const byUrl = new Map<string, StoryRecord>();
  for (const story of ledger.stories) {
    const list = byCluster.get(story.cluster);
    if (list) list.push(story);
    else byCluster.set(story.cluster, [story]);
    if (story.url) byUrl.set(canonicalUrl(story.url), story);
    for (const s of story.sightings) {
      if (s.url) byUrl.set(canonicalUrl(s.url), story);
    }
  }

  const histories = new Map<string, Map<string, TitleEvent[]>>();
  const historyOf = (story: StoryRecord): Map<string, TitleEvent[]> => {
    let m = histories.get(story.id);
    if (!m) {
      m = titleHistory(story);
      histories.set(story.id, m);
    }
    return m;
  };

  /** Last known title for a url strictly before `at`, or undefined. */
  const titleBefore = (
    history: Map<string, TitleEvent[]>,
    urlKey: string,
    at: Date,
  ): string | undefined => {
    const list = history.get(urlKey);
    if (!list) return undefined;
    let found: string | undefined;
    for (const e of list) {
      if (e.at.getTime() >= at.getTime()) break;
      found = e.title;
    }
    return found;
  };

  // Deterministic order so two runs over the same input build the same ids.
  const ordered = [...edition.articles].sort(
    (a, b) =>
      (a.sourceId ?? "").localeCompare(b.sourceId ?? "") ||
      (a.url ?? "").localeCompare(b.url ?? "") ||
      (a.title ?? "").localeCompare(b.title ?? ""),
  );

  // Duplicate reporting only — the duplicates themselves stay as sightings.
  try {
    stats.duplicates = dedupeStories(
      ordered.map((a) => ({ title: a.title, sourceId: a.sourceId })),
    ).dropped.length;
  } catch {
    stats.duplicates = 0;
  }

  /**
   * Records seen within `REWORDED_REPEAT_WINDOW_DAYS` of this edition — the
   * cross-cluster search space for reworded repeats, newest first. Computed
   * once; records created during this edition are appended as they appear.
   */
  const recentCandidates = ledger.stories
    .filter((s) => Math.abs(dayGap(civilDateOf(s), edition.date)) <= REWORDED_REPEAT_WINDOW_DAYS)
    .sort(newestFirst);

  for (const article of ordered) {
    const title = (article.title ?? "").trim();
    const url = (article.url ?? "").trim();
    if (!title || !article.sourceId) continue;
    const urlKey = canonicalUrl(url);
    const cluster = storyCluster(title);

    let story = urlKey ? byUrl.get(urlKey) : undefined;
    // A url is not proof of identity. Rolling newsletter urls (FirstFT, "Markets
    // Wrap", a live blog) keep one address while their lead story changes
    // completely, so a url match only joins when the article still belongs to
    // the same entity cluster. Otherwise it is a different story that happens to
    // reuse an address, and attaching it would file "Oil price falls" as a
    // revision of an Nvidia headline.
    if (story && story.cluster !== cluster) story = undefined;
    if (!story) {
      // v2: a cluster key is a *candidate*, not a verdict. The entity
      // mega-records taught the lesson — attach only if the record's current
      // anchors still carry this headline (gated headline affinity; the
      // gates live in lib/topics/dedupe.ts and are measured on the labeled
      // corpus). Otherwise this is a new story that happens to share the
      // entity, and it gets its own record.
      const candidates = byCluster.get(cluster);
      if (candidates?.length) {
        const ranked = [...candidates].sort(newestFirst);
        for (const cand of ranked) {
          if (carriesHeadline(cand, title)) {
            story = cand;
            break;
          }
        }
      }
    }
    if (!story) {
      // v2: the reworded-repeat channel. A wire may drop or swap its entity
      // mention when rewording ("Man United sack…" vs "Manchester United
      // sack…"), leaving a different cluster key for the same story. Only
      // recently-seen records are searched — a reworded repeat is a same-news-
      // cycle phenomenon, and the bound keeps ingest linear enough. The list
      // is precomputed once per edition (and extended with fresh records), so
      // each article only walks a handful of candidates.
      for (const cand of recentCandidates) {
        if (cand.cluster === cluster) continue; // already gated above
        if (carriesHeadline(cand, title)) {
          story = cand;
          break;
        }
      }
    }

    const published = parseInstant(article.publishedAt);

    if (!story) {
      const classified = classifyArticle({ title });
      const created: StoryRecord = {
        id: "",
        cluster,
        title,
        url,
        firstSeenAt: observedAt,
        firstEdition: editionTag,
        firstSourceId: article.sourceId,
        publishedAt: published ? published.toISOString() : null,
        publishLagMinutes: null,
        lastSeenAt: observedAt,
        lastEdition: editionTag,
        topic: (readTopic(article.topic) ?? classified.topic),
        lane: (readLane(article.lane) ?? classified.lane),
        domestic:
          typeof article.domestic === "boolean" ? article.domestic : classified.domestic,
        entities: storyEntities(title),
        sources: [],
        sightings: [],
        headlineRevisions: [],
        firstMover: {
          sourceId: null,
          observedAt: null,
          tied: false,
          coFirstSourceIds: [],
          runnerUpSourceId: null,
          runnerUpObservedAt: null,
          leadMinutes: null,
        },
      };
      // Id = hash(entity set + normalized title tokens), then persisted. Two
      // different stories hashing alike is astronomically unlikely but is
      // resolved deterministically rather than by overwriting.
      const base = `st_${hashSeed(created.entities.length ? created.entities : [cluster], [
        ...tokenizeTitle(normalizeTitle(title)),
      ])}`;
      let id = base;
      for (let n = 2; ledger.stories.some((s) => s.id === id); n++) id = `${base}-${n}`;
      created.id = id;

      recomputeDerived(created);
      ledger.stories.push(created);
      byCluster.set(cluster, [...(byCluster.get(cluster) ?? []), created]);
      recentCandidates.unshift(created);
      if (urlKey) byUrl.set(urlKey, created);
      histories.delete(created.id);
      stats.created++;
      continue;
    }

    const seenKey = `${editionTag}|${article.sourceId}|${urlKey}`;
    const alreadySeen =
      seenKey === `${story.firstEdition}|${story.firstSourceId}|${canonicalUrl(story.url)}` ||
      story.sightings.some(
        (s) => `${editionTag}|${s.sourceId}|${canonicalUrl(s.url)}` === seenKey,
      );

    // "What did this url read like at the moment we are replaying?" — not
    // "what does it read like now", which on a warm rebuild would make every
    // older edition look like a wire rewriting its newest headline backwards.
    const history = historyOf(story);
    const observed = parseInstant(observedAt);
    const previous = urlKey && observed ? titleBefore(history, urlKey, observed) : undefined;
    if (
      previous !== undefined &&
      observed &&
      exactStoryKey(previous) !== exactStoryKey(title) &&
      // A revision already recorded for this url with the same new text is not
      // re-recorded (rebuild idempotency).
      !story.headlineRevisions.some(
        (r) =>
          canonicalUrl(r.url) === urlKey &&
          exactStoryKey(r.to) === exactStoryKey(title) &&
          parseInstant(r.at)?.getTime() === observed.getTime(),
      )
    ) {
      story.headlineRevisions.push({
        at: observedAt,
        sourceId: article.sourceId,
        edition: editionTag,
        url,
        from: previous,
        to: title,
      });
      stats.revisions++;
    }

    if (alreadySeen) continue;

    // A wire re-printing the *same* headline it already carried on an earlier
    // edition is the feed repeating itself, not a new observation of the story:
    // a rolling "Markets Wrap" url would otherwise accrue one sighting per run
    // and hand its wire a fictitious first-mover trail. A *changed* headline
    // from the same wire at the same url is a genuine follow-up: it is kept as
    // a sighting (so the observation clock and the first-mover view see it) and
    // the revision above already preserves what it replaced.
    //
    // v2: the url-history check (`previous`) only catches repeats under a url
    // the record already saw. Real wires also repeat unchanged under *new*
    // urls — Yahoo's daily "Stock Market: Will S&P 500 Open Up or Down
    // Today?", 财联社's `早间新闻精选` — which inflated those trails with one
    // sighting per edition. Any observed surface with the exact same key, from
    // the same wire, on any url, is the feed resurfacing.
    const repeatedBySameWire =
      story.sources.includes(article.sourceId) &&
      (previous !== undefined
        ? exactStoryKey(previous) === exactStoryKey(title)
        : exactRepeatCarried(story, title));
    if (repeatedBySameWire) continue;

    story.sightings.push({
      sourceId: article.sourceId,
      observedAt,
      title,
      url,
      edition: editionTag,
      ...(published ? { publishedAt: published.toISOString() } : {}),
    });
    histories.delete(story.id);
    recomputeDerived(story);
    stats.attached++;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------

/**
 * Deterministic retention. Two rules, both stable across runs:
 *
 *   1. drop stories whose last observation is older than `retentionDays`;
 *   2. keep at most `maxStories`, newest `lastSeenAt` first, ties broken by id.
 *
 * No randomness, no dictionary order — the same input always prunes the same
 * records, so a re-run cannot reshuffle history.
 */
export function pruneLedger(ledger: StoryLedger, now: Date = new Date()): number {
  const before = ledger.stories.length;
  const cutoff = shiftDateKey(civilDate(now), -ledger.retentionDays);
  const kept = ledger.stories.filter((story) => {
    const at = parseInstant(story.lastSeenAt);
    if (!at) return false;
    return civilDate(at) >= cutoff;
  });
  kept.sort(
    (a, b) =>
      (parseInstant(b.lastSeenAt)?.getTime() ?? 0) - (parseInstant(a.lastSeenAt)?.getTime() ?? 0) ||
      a.id.localeCompare(b.id),
  );
  ledger.stories = kept.slice(0, ledger.maxStories);
  return before - ledger.stories.length;
}

/** Stable output order: newest first, then id. Keeps diffs readable in git. */
export function sortStories(ledger: StoryLedger): void {
  ledger.stories.sort(
    (a, b) =>
      (parseInstant(b.firstSeenAt)?.getTime() ?? 0) - (parseInstant(a.firstSeenAt)?.getTime() ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

// ---------------------------------------------------------------------------
// Derived artifacts
// ---------------------------------------------------------------------------

/**
 * Per-wire first-mover table over a rolling window.
 *
 * The ranking deliberately splits "first" into two numbers, because the honest
 * version of this metric is not the flattering one:
 *
 *   `contestedFirsts` — stories where the wire was earliest **and** at least one
 *     other wire had to catch up later. This is the number that means something:
 *     the story reached us through this wire first, and someone else followed.
 *
 *   `soleFirsts` — every story where the wire's observation was the earliest,
 *     including stories only one wire ever carried. On a real edition those
 *     dominate (a single-source feature story is "first" by definition), so
 *     ranking on this alone just measures output volume. Reported for
 *     completeness, never as the headline.
 *
 *   `coFirsts` — stories where several wires were first observed in the same
 *     fetch. That is the common case (one fetch sees every wire at once), and
 *     no lead can be claimed, so it is counted apart.
 *
 * The sort is `contestedFirsts`, then median lead, then `coFirsts`.
 */
export function firstMoverRanking(
  ledger: StoryLedger,
  opts: { windowDays?: number; now?: Date } = {},
): FirstMoverRanking {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const from = shiftDateKey(civilDate(now), -windowDays);
  const to = civilDate(now);

  const rows = new Map<string, FirstMoverRow & { leads: number[] }>();
  const row = (sourceId: string) => {
    let r = rows.get(sourceId);
    if (!r) {
      r = {
        sourceId,
        soleFirsts: 0,
        contestedFirsts: 0,
        coFirsts: 0,
        stories: 0,
        leadSamples: 0,
        medianLeadMinutes: null,
        leads: [],
      };
      rows.set(sourceId, r);
    }
    return r;
  };

  let inWindow = 0;
  let soleFirstStories = 0;
  let contestedStories = 0;
  let tiedFirstStories = 0;

  for (const story of ledger.stories) {
    const first = parseInstant(story.firstSeenAt);
    if (!first) continue;
    if (civilDate(first) < from || civilDate(first) > to) continue;
    inWindow++;

    for (const id of story.sources) row(id).stories++;

    const fm = story.firstMover;
    if (fm.tied) {
      tiedFirstStories++;
      for (const id of fm.coFirstSourceIds) row(id).coFirsts++;
    } else if (fm.sourceId) {
      soleFirstStories++;
      const r = row(fm.sourceId);
      r.soleFirsts++;
      if (fm.runnerUpSourceId) {
        contestedStories++;
        r.contestedFirsts++;
        if (typeof fm.leadMinutes === "number") r.leads.push(fm.leadMinutes);
      }
    }
  }

  const wires: FirstMoverRow[] = [...rows.values()]
    .map((r) => ({
      sourceId: r.sourceId,
      soleFirsts: r.soleFirsts,
      contestedFirsts: r.contestedFirsts,
      coFirsts: r.coFirsts,
      stories: r.stories,
      leadSamples: r.leads.length,
      medianLeadMinutes: median(r.leads),
    }))
    .sort(
      (a, b) =>
        b.contestedFirsts - a.contestedFirsts ||
        b.soleFirsts - a.soleFirsts ||
        (b.medianLeadMinutes ?? -Infinity) - (a.medianLeadMinutes ?? -Infinity) ||
        b.coFirsts - a.coFirsts ||
        a.sourceId.localeCompare(b.sourceId),
    );

  return {
    windowDays,
    from,
    to,
    storiesInWindow: inWindow,
    soleFirstStories,
    contestedStories,
    tiedFirstStories,
    leadBasis: "observed",
    wires,
  };
}

/** Per-story diff sequence of how the framing changed, longest trails first. */
export function revisionTrail(ledger: StoryLedger, opts: { limit?: number } = {}): RevisionTrail {
  const withRevisions = ledger.stories.filter((s) => s.headlineRevisions.length > 0);
  const totalRevisions = withRevisions.reduce((n, s) => n + s.headlineRevisions.length, 0);
  const items: RevisionTrailEntry[] = withRevisions
    .map((story) => ({
      id: story.id,
      title: story.title,
      topic: story.topic,
      revisions: story.headlineRevisions.length,
      steps: [...story.headlineRevisions]
        .sort(
          (a, b) =>
            (parseInstant(a.at)?.getTime() ?? 0) - (parseInstant(b.at)?.getTime() ?? 0),
        )
        .map((r) => ({ at: r.at, from: r.from, to: r.to, ...tokenDelta(r.from, r.to) })),
    }))
    .sort(
      (a, b) =>
        b.revisions - a.revisions ||
        (parseInstant(b.steps[b.steps.length - 1]?.at)?.getTime() ?? 0) -
          (parseInstant(a.steps[a.steps.length - 1]?.at)?.getTime() ?? 0) ||
        a.id.localeCompare(b.id),
    );

  const limit = opts.limit ?? 50;
  return {
    storiesWithRevisions: withRevisions.length,
    totalRevisions,
    items: items.slice(0, limit),
  };
}

/** Everything published to `daily_reports/stories.json`. */
export interface StoriesPayload extends StoryLedger {
  generatedAt: string;
  counts: {
    stories: number;
    sightings: number;
    multiSightingStories: number;
    storiesWithRevisions: number;
    skippedRecords: number;
    editions: number;
    articles: number;
    duplicates: number;
  };
  firstMover: FirstMoverRanking;
  revisionTrail: RevisionTrail;
}

export function buildPayload(
  ledger: StoryLedger,
  stats: LedgerStats & { skippedRecords?: number },
  opts: { windowDays?: number; now?: Date; revisionLimit?: number } = {},
): StoriesPayload {
  return {
    ...ledger,
    generatedAt: isoWithOffset(opts.now ?? new Date()),
    counts: {
      stories: ledger.stories.length,
      sightings: ledger.stories.reduce((n, s) => n + s.sightings.length, 0),
      multiSightingStories: ledger.stories.filter((s) => s.sightings.length > 0).length,
      storiesWithRevisions: ledger.stories.filter((s) => s.headlineRevisions.length > 0).length,
      skippedRecords: stats.skippedRecords ?? 0,
      editions: stats.editions,
      articles: stats.articles,
      duplicates: stats.duplicates,
    },
    firstMover: firstMoverRanking(ledger, {
      windowDays: opts.windowDays,
      now: opts.now,
    }),
    revisionTrail: revisionTrail(ledger, { limit: opts.revisionLimit }),
  };
}
