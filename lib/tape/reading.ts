/**
 * Reading view over the tape — the numbers behind the prose.
 *
 * The tape stores what the market said at each half-hour slot. A reader does
 * not want the store, they want one sentence: *who moved, how broad it was,
 * what the index did, and what else we learned in the same window*. This module
 * computes exactly those quantities and nothing else — no wording lives here,
 * because every sentence must go through `STR` (see `lib/output/hour-page.ts`).
 * Numbers and words are split so the vocabulary can be reviewed (and
 * translated) without any chance of a figure drifting out of sync with its
 * sentence.
 *
 * Two rules this module is built around:
 *
 *   - **Every figure is a field.** Breadth is counted off `industries.records`,
 *     extremes are the max/min of that same array, fund flows off
 *     `fundFlows.records`, limit counts off the `limitPool` section's `meta`.
 *     Nothing is estimated, interpolated, or carried over from a neighbouring
 *     slot.
 *   - **Thresholds are declared once.** `MOVE_THRESHOLDS` is the only place a
 *     word like 暴跌 can be earned, and the rendered page prints the same
 *     numbers back to the reader as its 口径 line. A reviewer can check a
 *     sentence against the store; a reader can check the sentence against the
 *     stated yardstick.
 */

import fs from "node:fs";
import path from "node:path";

import type { StoryRecord } from "../stories/ledger";
import {
  isoWithOffset as isoWithOffsetStory,
  minutesBetween,
  parseInstant,
} from "../stories/time";
import { TAPE_SLOTS } from "./schedule";
import type { TapeSection } from "./sections";
import { readSnapshot, type TapeSnapshot } from "./store";
import { isoWithOffset, slotKey } from "./time";

/**
 * Yardsticks. Printed on the page alongside the sentences they produce, so an
 * adjective can never outrun its number.
 *
 * Board percentages are per-industry-board change (a 496-row cross-section, so
 * a 5% day is a rout); index percentages are whole-index change, where 2% is
 * already a large session. Breadth is the share of boards advancing.
 */
export const MOVE_THRESHOLDS = {
  board: { big: 2, severe: 5 },
  index: { big: 0.5, severe: 2 },
  breadth: { strong: 0.8, lean: 0.6 },
  /** |change| below this is a flat board, not a small move. */
  flatEps: 0.005,
} as const;

export const READING_LIMITS = {
  /** Days embedded in one page. Older days stay on disk; the page is a window. */
  maxDays: 7,
  /** The story window is the half hour before the capture instant. */
  storyWindowMinutes: 30,
  /** Earlier stories shown when the window is empty (context, not the claim). */
  earlierStories: 3,
  /** Clocks differing by more than this are called out explicitly. */
  clockDriftMinutes: 10,
} as const;

export type MoveTone =
  | "severe-up"
  | "big-up"
  | "up"
  | "flat"
  | "down"
  | "big-down"
  | "severe-down";

export type BreadthTone = "strong-up" | "lean-up" | "mixed" | "lean-down" | "strong-down";

/**
 * A finite number, or null.
 *
 * `Number(null)` is `0` and `Number("")` is `0`, both `Number.isFinite`-true —
 * which silently turns "we never quoted this board" into "this board did not
 * move". The tape writes `null` for a theme whose board was not quoted, so this
 * guard is load-bearing: without it the page claimed 24 of 24 themes were
 * quoted on a snapshot where only 16 were.
 */
function finite(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Tone for one board's change, off `MOVE_THRESHOLDS.board`. */
export function boardTone(pct: number | null): MoveTone {
  const { big, severe } = MOVE_THRESHOLDS.board;
  const eps = MOVE_THRESHOLDS.flatEps;
  if (pct === null || !Number.isFinite(pct)) return "flat";
  if (pct >= severe) return "severe-up";
  if (pct >= big) return "big-up";
  if (pct > eps) return "up";
  if (pct < -severe) return "severe-down";
  if (pct < -big) return "big-down";
  if (pct < -eps) return "down";
  return "flat";
}

/** Tone for a whole index's change, off `MOVE_THRESHOLDS.index`. */
export function indexTone(pct: number | null): MoveTone {
  const { big, severe } = MOVE_THRESHOLDS.index;
  const eps = MOVE_THRESHOLDS.flatEps;
  if (pct === null || !Number.isFinite(pct)) return "flat";
  if (pct >= severe) return "severe-up";
  if (pct >= big) return "big-up";
  if (pct > eps) return "up";
  if (pct < -severe) return "severe-down";
  if (pct < -big) return "big-down";
  if (pct < -eps) return "down";
  return "flat";
}

/** Breadth tone from the share of boards advancing. */
export function breadthTone(upShare: number | null): BreadthTone {
  const { strong, lean } = MOVE_THRESHOLDS.breadth;
  if (upShare === null || !Number.isFinite(upShare)) return "mixed";
  if (upShare >= strong) return "strong-up";
  if (upShare >= lean) return "lean-up";
  if (upShare <= 1 - strong) return "strong-down";
  if (upShare <= 1 - lean) return "lean-down";
  return "mixed";
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface SectionClock {
  section: string;
  asOf: string;
  observedAt: string;
  /** `upstream` when asOf came from the payload, `fetch` when it is our clock. */
  source: "upstream" | "fetch";
  unavailable: boolean;
}

export interface SectionGap {
  section: string;
  reason: string;
}

export interface IndexLine {
  name: string;
  price: number;
  changePct: number;
  /** The row's own market clock, when the payload carried one. */
  asOf: string;
}

export interface BoardMover {
  name: string;
  changePct: number;
}

export interface Breadth {
  total: number;
  up: number;
  down: number;
  flat: number;
  /** up / total, 0…1. */
  upShare: number;
  tone: BreadthTone;
}

export interface BoardSpread {
  best: BoardMover | null;
  worst: BoardMover | null;
  upBig: number;
  downBig: number;
  upSevere: number;
  downSevere: number;
}

export interface FlowExtremes {
  best: { name: string; yi: number } | null;
  worst: { name: string; yi: number } | null;
}

export interface ThemeSummary {
  total: number;
  /** Themes whose board was actually quoted — nulls are not "unmoved". */
  quoted: number;
  up: number;
  best: (BoardMover & { name: string }) | null;
  worst: (BoardMover & { name: string }) | null;
}

export interface StoryHit {
  id: string;
  title: string;
  /** The article the observation came from — the attribution link. */
  url: string;
  sourceId: string;
  sourceName: string;
  firstSeenAt: string;
  /** True when a second wire was later observed on the same story. */
  contested: boolean;
  sources: string[];
}

export interface StoryWindow {
  from: string;
  to: string;
  inWindow: StoryHit[];
  earlier: StoryHit[];
  /** Set when the ledger was missing, so the page can name the gap. */
  unavailable: string | null;
}

export interface SlotReading {
  date: string;
  slot: string;
  /** The revision actually read (`0` = the first capture of the slot). */
  revision: number;
  timezone: string;
  /** Market clock for the page: the newest `asOf` any section reported. */
  asOf: string;
  observedAt: string;
  /** observedAt − asOf, in minutes; null when either is unreadable. */
  driftMinutes: number | null;
  clocks: SectionClock[];
  gaps: SectionGap[];
  index: IndexLine[] | null;
  breadth: Breadth | null;
  boards: BoardSpread | null;
  flows: FlowExtremes | null;
  themes: ThemeSummary | null;
  limits: { up: number; down: number } | null;
  stories: StoryWindow | null;
}

export interface TapeSlotView {
  time: string;
  /** Latest capture of this slot; null when nothing usable is on disk. */
  snapshot: TapeSnapshot | null;
  revision: number;
  /** Named reason this slot renders as a gap (missing, or unreadable). */
  gap: string | null;
}

export interface TapeDayView {
  date: string;
  /** Ten entries, in session order, always. Absent slots carry `gap`. */
  slots: TapeSlotView[];
  /** Expected slot times with no capture at all. */
  missing: string[];
}

// ---------------------------------------------------------------------------
// Loading (fail-open)
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Every capture of one slot, newest revision first. The base file is the
 * original point-in-time record; for *reading* we want the freshest view of
 * that slot, and the page states how many re-captures it took (`revision`).
 */
function slotFiles(dir: string, key: string): Array<{ file: string; revision: number }> {
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ file: string; revision: number }> = [];
  for (const f of fs.readdirSync(dir)) {
    if (f === `${key}.json`) out.push({ file: f, revision: 0 });
    else {
      const m = new RegExp(`^${key}\\.rev-(\\d+)\\.json$`).exec(f);
      if (m) out.push({ file: f, revision: Number(m[1]) });
    }
  }
  return out.sort((a, b) => b.revision - a.revision);
}

/**
 * Read the most recent `READING_LIMITS.maxDays` tape days.
 *
 * Fail-open at every level: an unreadable directory is "no history", a slot
 * whose files will not parse is a named gap, and a day with three of ten slots
 * is a day with seven named gaps — never an exception, because a broken store
 * must degrade the page rather than fail the build that publishes it.
 */
export function readTapeDays(
  tapeDir: string = path.resolve("daily_reports", "tape"),
  opts: { maxDays?: number } = {},
): TapeDayView[] {
  const base = tapeDir;
  let dates: string[] = [];
  try {
    dates = fs
      .readdirSync(base)
      .filter((d) => DATE_RE.test(d))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, opts.maxDays ?? READING_LIMITS.maxDays);
  } catch {
    return [];
  }

  const days: TapeDayView[] = [];
  for (const date of dates) {
    const dir = path.join(base, date);
    const slots: TapeSlotView[] = [];
    for (const time of TAPE_SLOTS as string[]) {
      const key = keyOf(time);
      const files = slotFiles(dir, key);
      if (!files.length) {
        slots.push({ time, snapshot: null, revision: 0, gap: "missing" });
        continue;
      }
      let picked: TapeSnapshot | null = null;
      for (const f of files) {
        picked = readSnapshot(path.join(dir, f.file));
        if (picked) {
          slots.push({ time, snapshot: picked, revision: f.revision, gap: null });
          break;
        }
      }
      if (!picked) slots.push({ time, snapshot: null, revision: 0, gap: "unreadable" });
    }
    days.push({
      date,
      slots,
      missing: slots.filter((s) => s.gap === "missing").map((s) => s.time),
    });
  }
  return days;
}

function keyOf(time: string): string {
  try {
    return slotKey(time);
  } catch {
    return String(time).replace(":", "");
  }
}

// ---------------------------------------------------------------------------
// One slot
// ---------------------------------------------------------------------------

function sectionOf<T>(snap: TapeSnapshot, name: string): TapeSection<T> | null {
  const raw = (snap as unknown as Record<string, unknown>)[name];
  if (!raw || typeof raw !== "object") return null;
  const section = raw as TapeSection<T>;
  return Array.isArray(section.records) ? section : null;
}

function indexLines(snap: TapeSnapshot): IndexLine[] | null {
  const s = sectionOf<{ name?: unknown; price?: unknown; changePct?: unknown; asOf?: unknown }>(
    snap,
    "indices",
  );
  if (!s || s.unavailable) return null;
  const rows: IndexLine[] = [];
  for (const r of s.records) {
    const price = finite(r.price);
    const changePct = finite(r.changePct);
    if (price === null || changePct === null) continue;
    rows.push({
      name: String(r.name ?? ""),
      price,
      changePct,
      asOf: typeof r.asOf === "string" ? r.asOf : String(s.asOf ?? snap.observedAt ?? ""),
    });
  }
  return rows.length ? rows : null;
}

function boardRows(snap: TapeSnapshot): Array<{ name: string; changePct: number }> {
  const s = sectionOf<{ name?: unknown; changePct?: unknown }>(snap, "industries");
  if (!s || s.unavailable) return [];
  const rows: Array<{ name: string; changePct: number }> = [];
  for (const r of s.records) {
    const changePct = finite(r.changePct);
    if (changePct === null) continue;
    rows.push({ name: String(r.name ?? ""), changePct });
  }
  return rows;
}

function breadthOf(rows: ReadonlyArray<{ changePct: number }>): Breadth | null {
  if (!rows.length) return null;
  const eps = MOVE_THRESHOLDS.flatEps;
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const r of rows) {
    if (r.changePct > eps) up++;
    else if (r.changePct < -eps) down++;
    else flat++;
  }
  const total = rows.length;
  const upShare = up / total;
  return { total, up, down, flat, upShare, tone: breadthTone(upShare) };
}

function spreadOf(rows: ReadonlyArray<{ name: string; changePct: number }>): BoardSpread | null {
  if (!rows.length) return null;
  const { big, severe } = MOVE_THRESHOLDS.board;
  let best = rows[0];
  let worst = rows[0];
  let upBig = 0;
  let downBig = 0;
  let upSevere = 0;
  let downSevere = 0;
  for (const r of rows) {
    if (r.changePct > best.changePct) best = r;
    if (r.changePct < worst.changePct) worst = r;
    if (r.changePct >= big) upBig++;
    if (r.changePct <= -big) downBig++;
    if (r.changePct >= severe) upSevere++;
    if (r.changePct <= -severe) downSevere++;
  }
  return {
    best: { name: best.name, changePct: best.changePct },
    worst: { name: worst.name, changePct: worst.changePct },
    upBig,
    downBig,
    upSevere,
    downSevere,
  };
}

function flowsOf(snap: TapeSnapshot): FlowExtremes | null {
  const s = sectionOf<{ name?: unknown; netInflowYi?: unknown }>(snap, "fundFlows");
  if (!s || s.unavailable) return null;
  let best: { name: string; yi: number } | null = null;
  let worst: { name: string; yi: number } | null = null;
  for (const r of s.records) {
    const yi = finite(r.netInflowYi);
    if (yi === null) continue;
    const row = { name: String(r.name ?? ""), yi };
    if (!best || yi > best.yi) best = row;
    if (!worst || yi < worst.yi) worst = row;
  }
  return best && worst ? { best, worst } : null;
}

function themesOf(snap: TapeSnapshot): ThemeSummary | null {
  const s = sectionOf<{ name?: unknown; changePct?: unknown }>(snap, "themes");
  if (!s || s.unavailable) return null;
  let quoted = 0;
  let up = 0;
  let best: BoardMover | null = null;
  let worst: BoardMover | null = null;
  for (const r of s.records) {
    const changePct = finite(r.changePct);
    if (changePct === null) continue;
    quoted++;
    if (changePct > MOVE_THRESHOLDS.flatEps) up++;
    const row = { name: String(r.name ?? ""), changePct };
    if (!best || changePct > best.changePct) best = row;
    if (!worst || changePct < worst.changePct) worst = row;
  }
  return { total: s.records.length, quoted, up, best, worst };
}

function limitsOf(snap: TapeSnapshot): { up: number; down: number } | null {
  const s = sectionOf<unknown>(snap, "limitPool");
  if (!s || s.unavailable) return null;
  const up = finite(s.meta?.limitUp);
  const down = finite(s.meta?.limitDown);
  if (up === null && down === null) return null;
  return { up: up ?? 0, down: down ?? 0 };
}

function clocksOf(snap: TapeSnapshot): SectionClock[] {
  const out: SectionClock[] = [];
  for (const name of ["indices", "industries", "themes", "fundFlows", "limitPool"]) {
    const s = sectionOf<unknown>(snap, name);
    if (!s) continue;
    out.push({
      section: name,
      asOf: String(s.asOf ?? snap.observedAt ?? ""),
      observedAt: String(s.observedAt ?? snap.observedAt ?? ""),
      source: s.timestampSource === "upstream" ? "upstream" : "fetch",
      unavailable: s.unavailable === true,
    });
  }
  return out;
}

function gapsOf(snap: TapeSnapshot): SectionGap[] {
  const out: SectionGap[] = [];
  for (const name of ["indices", "industries", "themes", "fundFlows", "limitPool"]) {
    const s = sectionOf<unknown>(snap, name);
    if (!s) {
      out.push({ section: name, reason: "section absent from the snapshot" });
      continue;
    }
    if (s.unavailable) out.push({ section: name, reason: String(s.reason ?? "unavailable") });
  }
  return out;
}

/**
 * Newest `asOf` across sections that actually carry a market stamp — the clock
 * the prose describes.
 *
 * Only `source: "upstream"` sections are eligible. A section whose `asOf` fell
 * back to the fetch instant (the limit pool has no per-row timestamp) would
 * otherwise always win the max and quietly redefine the market clock as our own
 * clock: the first real build showed "asOf … = observedAt …" for a capture
 * whose quotes were 11 hours old. When nothing carries an upstream stamp the
 * fallback is the capture instant, and `timestampSource` on each section still
 * says so.
 */
function headlineAsOf(clocks: readonly SectionClock[], fallback: string): string {
  let best = "";
  let bestMs = -Infinity;
  for (const c of clocks) {
    if (c.unavailable || c.source !== "upstream") continue;
    const ms = Date.parse(c.asOf);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = c.asOf;
    }
  }
  return best || fallback;
}

export interface StoryContext {
  /** `null` when the ledger file was missing or unreadable. */
  stories: readonly StoryRecord[] | null;
  sourceNames?: Readonly<Record<string, string>>;
  /** Why the ledger is unusable, for the named gap. */
  reason?: string;
}

function toHit(story: StoryRecord, names: Readonly<Record<string, string>>): StoryHit {
  return {
    id: story.id,
    title: story.title,
    url: story.url,
    sourceId: story.firstSourceId,
    sourceName: names[story.firstSourceId] ?? story.firstSourceId,
    firstSeenAt: story.firstSeenAt,
    contested: Boolean(story.firstMover?.runnerUpSourceId),
    sources: [...story.sources],
  };
}

/**
 * Stories that entered the ledger in `[from, to)` — our observation clock, the
 * only clock the ledger claims.
 *
 * The window is the half hour before the capture, which is what makes an
 * edition show up where a reader expects it: the 13:00 edition's stories land
 * in the 13:05 slot's window. A slot whose window holds nothing says so; the
 * three most recent earlier entries are still shown, labelled as earlier,
 * because "what we knew by then" is the useful context and hiding it would
 * read as an empty table.
 */
export function storyWindow(
  ctx: StoryContext,
  from: Date,
  to: Date,
  tz?: string,
): StoryWindow {
  const fromIso = isoWithOffsetStory(from, tz);
  const toIso = isoWithOffsetStory(to, tz);
  const base: StoryWindow = {
    from: fromIso,
    to: toIso,
    inWindow: [],
    earlier: [],
    unavailable: null,
  };
  if (!ctx.stories) {
    return { ...base, unavailable: ctx.reason ?? "ledger unavailable" };
  }
  const names = ctx.sourceNames ?? {};
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const inWindow: StoryHit[] = [];
  const earlierCandidates: Array<{ hit: StoryHit; ms: number }> = [];
  for (const story of ctx.stories) {
    const at = parseInstant(story.firstSeenAt);
    if (!at) continue;
    const ms = at.getTime();
    if (ms >= fromMs && ms <= toMs) inWindow.push(toHit(story, names));
    else if (ms < fromMs) earlierCandidates.push({ hit: toHit(story, names), ms });
  }
  inWindow.sort(
    (a, b) => (Date.parse(b.firstSeenAt) ?? 0) - (Date.parse(a.firstSeenAt) ?? 0),
  );
  earlierCandidates.sort((a, b) => b.ms - a.ms);
  return {
    ...base,
    inWindow,
    earlier: earlierCandidates
      .slice(0, READING_LIMITS.earlierStories)
      .map((x) => x.hit),
  };
}

export interface SlotReadingOptions {
  stories?: StoryContext;
  /** Override for tests; defaults to the snapshot's own `observedAt`. */
  now?: Date;
}

/** Everything the hour page's prose needs for one slot. Never throws. */
export function buildSlotReading(
  snapshot: TapeSnapshot,
  opts: SlotReadingOptions = {},
): SlotReading {
  const tz = snapshot.timezone || "UTC";
  const observedAt = String(snapshot.observedAt ?? "");
  const clocks = clocksOf(snapshot);
  const asOf = headlineAsOf(clocks, observedAt);
  const asOfDate = parseInstant(asOf);
  const observedDate = opts.now ?? parseInstant(observedAt);
  const driftMinutes =
    asOfDate && observedDate ? minutesBetween(asOfDate, observedDate) : null;

  const rows = boardRows(snapshot);
  const windowEnd = observedDate ?? new Date();
  const windowFrom = new Date(
    windowEnd.getTime() - READING_LIMITS.storyWindowMinutes * 60_000,
  );

  return {
    date: String(snapshot.date ?? ""),
    slot: String(snapshot.slot ?? ""),
    revision: Number(snapshot.revision ?? 0),
    timezone: tz,
    asOf,
    observedAt,
    driftMinutes,
    clocks,
    gaps: gapsOf(snapshot),
    index: indexLines(snapshot),
    breadth: breadthOf(rows),
    boards: spreadOf(rows),
    flows: flowsOf(snapshot),
    themes: themesOf(snapshot),
    limits: limitsOf(snapshot),
    stories: opts.stories ? storyWindow(opts.stories, windowFrom, windowEnd, tz) : null,
  };
}

/** True when a day carries at least one usable capture. */
export function dayHasTape(day: TapeDayView): boolean {
  return day.slots.some((s) => s.snapshot !== null);
}
