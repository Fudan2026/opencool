/**
 * Reading the point-in-time tape into levels.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The trap this file exists to avoid
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A tape record's `changePct` is **relative to the previous close**, not to the
 * snapshot before it. Subtracting two of them to get "the move over five days"
 * is silently wrong the moment the window crosses a session boundary: a board
 * that closed +2% on Monday and +3% on Tuesday has risen ~5.06%, not 1%; one
 * that closed +2% then -2% has lost ~0.04%, not 0%.
 *
 * So a return is never computed from two `changePct` readings. Each instrument
 * gets a **chained level** instead: within a day, `1 + changePct/100` is its
 * price relative to that day's previous close, and the day's last snapshot is
 * that day's close, so chaining `(1 + closeChange/100)` across days rebuilds a
 * price index up to a constant. Two levels then give a return by ratio, which
 * is exact for any window length and any number of day boundaries between.
 *
 * Three consequences, all deliberate:
 *
 *   - **A break is a break.** If an instrument is missing from a day's close,
 *     the chain cannot cross that boundary, so the next day starts a new
 *     segment. Levels inside each segment stay exact; a window that spans a
 *     break is reported unmeasurable rather than bridged with a number nobody
 *     observed.
 *   - **No snapshot is invented.** Entry and exit are chosen from snapshots
 *     that exist, at or after the instant they are meant to describe.
 *   - **The market factor is industry-only.** Concepts are thematic and would
 *     double-count the very sectors being measured; the cross-section is the
 *     industry universe the tape's `industries` section carries.
 */

import fs from "node:fs";
import path from "node:path";

import type { ReactionGap, TapeSummary } from "./types";

export type BoardKind = "industry" | "theme";

/** One quoted row as captured, reduced to what measurement needs. */
export interface Quote {
  name: string;
  changePct: number;
  kind: BoardKind;
}

export interface SnapshotPoint {
  date: string;
  slot: string;
  /** Market clock of the values (`asOf`) — the field every window is measured on. */
  asOf: string;
  ms: number;
  /** Board quotes by code (`BK0800`), industry and theme sections merged. */
  boards: Map<string, Quote>;
  /** Index quotes by code (`000001`). */
  indices: Map<string, Quote>;
}

export interface TapeStore {
  /** Every snapshot, earliest market clock first; same-instant duplicates collapsed. */
  points: SnapshotPoint[];
  /** Distinct days with at least one usable snapshot, ascending. */
  dates: string[];
  summary: TapeSummary;
  gaps: ReactionGap[];
  /**
   * Theme key → the concept board the tape resolved for it (`ai` → `BK0800`).
   *
   * Read from the tape's own `themes` records rather than re-resolved here: the
   * capture already did the name→board resolution, and re-deriving it with a
   * different registry version could point a story at a board the tape never
   * quoted.
   */
  themeBoards: Map<string, { code: string; name: string }>;
}

const SNAPSHOT_RE = /^(\d{4})(?:\.rev-(\d+))?\.json$/;

export function tapeRoot(root?: string): string {
  return root ?? path.resolve("daily_reports", "tape");
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}

function emptySummary(): TapeSummary {
  return { days: 0, snapshots: 0, from: null, to: null, slots: [] };
}

/**
 * Board quotes from the `industries` and `themes` sections.
 *
 * Both are needed and they are not redundant: a theme resolves to a *concept*
 * board (`90.BK0800`) which only the theme section carries, while the market
 * cross-section must be industry boards only. Industry wins when a code appears
 * in both, so the cross-section and a sample never read different numbers for
 * the same board.
 */
function boardQuotes(snapshot: Record<string, unknown>): Map<string, Quote> {
  const out = new Map<string, Quote>();

  const take = (
    section: unknown,
    kind: BoardKind,
    codeOf: (r: Record<string, unknown>) => unknown,
  ) => {
    const records = (section as { records?: unknown } | undefined)?.records;
    if (!Array.isArray(records)) return;
    for (const raw of records) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const code = codeOf(r);
      const change = num(r.changePct);
      if (typeof code !== "string" || !code || change === null) continue;
      if (out.has(code)) continue;
      out.set(code, { name: typeof r.name === "string" ? r.name : code, changePct: change, kind });
    }
  };

  take(snapshot.industries, "industry", (r) => r.code);
  take(snapshot.themes, "theme", (r) => r.boardCode);
  return out;
}

/** Theme key → resolved concept board, from the tape's own theme records. */
function themeBoards(snapshot: Record<string, unknown>): Map<string, { code: string; name: string }> {
  const out = new Map<string, { code: string; name: string }>();
  const records = (snapshot.themes as { records?: unknown } | undefined)?.records;
  if (!Array.isArray(records)) return out;
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const key = typeof r.key === "string" ? r.key : "";
    const code = typeof r.boardCode === "string" ? r.boardCode : "";
    if (!key || !code) continue;
    // Only a theme whose board was actually QUOTED is a usable target. A theme
    // record exists even when its quote is missing (`changePct: null`), and
    // treating that as resolvable would attribute a story to a board the tape
    // never priced — a mapping we cannot justify.
    if (typeof r.changePct !== "number") continue;
    out.set(key, { code, name: typeof r.boardName === "string" ? r.boardName : code });
  }
  return out;
}

/**
 * The market clock of one snapshot.
 *
 * A tape snapshot has no top-level `asOf`: each section carries its own, because
 * each section comes from a different upstream call. Only three sections are
 * measurable here (indices / industries / themes) — `limitPool` and `fundFlows`
 * are irrelevant to a board return and `limitPool` has no upstream stamp at all,
 * so including them would drag the clock to our fetch time.
 *
 * The **earliest** of the present section clocks is used, deliberately. If
 * industries printed 13:59:30 and indices 14:04:00, placing this snapshot at
 * 14:04 would let a board value be treated as if it described a market four
 * minutes later than it does — a lookahead. At 13:59:30 every value in the
 * snapshot is at least that current, so the error can only ever be a lag.
 */
function snapshotClock(raw: Record<string, unknown>): { asOf: string; ms: number } | null {
  const clocks: number[] = [];
  const stamps: string[] = [];
  for (const name of ["indices", "industries", "themes"] as const) {
    const section = raw[name] as { asOf?: unknown; records?: unknown } | undefined;
    if (!section || !Array.isArray(section.records) || !section.records.length) continue;
    const asOf = typeof section.asOf === "string" ? section.asOf : "";
    const ms = asOf ? Date.parse(asOf) : NaN;
    if (!asOf || !Number.isFinite(ms)) continue;
    clocks.push(ms);
    stamps.push(asOf);
  }
  // A hand-made or older snapshot may still carry a top-level `asOf`.
  if (!clocks.length) {
    const asOf = typeof raw.asOf === "string" ? raw.asOf : "";
    const ms = asOf ? Date.parse(asOf) : NaN;
    if (asOf && Number.isFinite(ms)) return { asOf, ms };
    return null;
  }
  let pick = 0;
  for (let i = 1; i < clocks.length; i++) if (clocks[i] < clocks[pick]) pick = i;
  return { asOf: stamps[pick], ms: clocks[pick] };
}

function indexQuotes(snapshot: Record<string, unknown>): Map<string, Quote> {
  const out = new Map<string, Quote>();
  const records = (snapshot.indices as { records?: unknown } | undefined)?.records;
  if (!Array.isArray(records)) return out;
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const code = typeof r.code === "string" ? r.code : "";
    const change = num(r.changePct);
    if (!code || change === null) continue;
    out.set(code, { name: typeof r.name === "string" ? r.name : code, changePct: change, kind: "industry" });
  }
  return out;
}

/**
 * Load every snapshot under the tape root.
 *
 * Fail-open by construction: an unreadable directory, an unparseable snapshot,
 * or one with no usable clock is recorded as a named gap and skipped. A tape
 * file that cannot be understood must never take the bake down — a named gap
 * is the point, because the product still says what it does not know.
 */
export function loadTape(root?: string): TapeStore {
  const dir = tapeRoot(root);
  const gaps: ReactionGap[] = [];

  if (!fs.existsSync(dir)) {
    gaps.push({ kind: "tape-absent", detail: "no tape directory yet — nothing has been captured", file: dir });
    return { points: [], dates: [], summary: emptySummary(), gaps, themeBoards: new Map() };
  }

  let dayEntries: string[];
  try {
    dayEntries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch (e) {
    gaps.push({ kind: "tape-unreadable", detail: `tape root could not be listed: ${errText(e)}`, file: dir });
    return { points: [], dates: [], summary: emptySummary(), gaps, themeBoards: new Map() };
  }

  const points: SnapshotPoint[] = [];
  const dates: string[] = [];
  let files = 0;
  const themes = new Map<string, { code: string; name: string }>();

  for (const date of dayEntries) {
    const dayPath = path.join(dir, date);
    let names: string[];
    try {
      names = fs.readdirSync(dayPath).filter((f) => SNAPSHOT_RE.test(f)).sort();
    } catch (e) {
      gaps.push({ kind: "tape-day-unreadable", detail: errText(e), file: dayPath });
      continue;
    }
    if (!names.length) {
      gaps.push({ kind: "tape-day-empty", detail: `${date} has no snapshot files`, file: dayPath });
      continue;
    }
    dates.push(date);

    for (const name of names) {
      files++;
      const file = path.join(dayPath, name);
      let raw: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not a JSON object");
        }
        raw = parsed as Record<string, unknown>;
      } catch (e) {
        gaps.push({ kind: "tape-corrupt", detail: `${name}: ${errText(e)}`, file });
        continue;
      }

      // Measure on the market clock: `asOf` is what the value describes. Using
      // the fetch clock would let a snapshot fetched three minutes early claim
      // to describe a market that had not printed yet.
      const clock = snapshotClock(raw);
      if (!clock) {
        gaps.push({ kind: "tape-no-clock", detail: `${name}: no section carried a parseable asOf`, file });
        continue;
      }
      const { asOf, ms } = clock;

      const boards = boardQuotes(raw);
      const indices = indexQuotes(raw);
      if (!boards.size && !indices.size) {
        gaps.push({
          kind: "tape-no-quotes",
          detail: `${name}: neither boards nor indices carried a quote`,
          file,
        });
        continue;
      }

      const slotFromName = `${String(name).slice(0, 2)}:${String(name).slice(2, 4)}`;
      for (const [k, v] of themeBoards(raw)) if (!themes.has(k)) themes.set(k, v);
      points.push({
        date: typeof raw.date === "string" ? raw.date : date,
        slot: typeof raw.slot === "string" ? raw.slot : slotFromName,
        asOf,
        ms,
        boards,
        indices,
      });
    }
  }

  // Earliest market clock first. Same-instant duplicates (a slot and its
  // revision, when the revision restated the same clock) collapse to the first
  // one: they describe one instant and must not be counted twice.
  points.sort((a, b) => a.ms - b.ms || a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot));
  const deduped: SnapshotPoint[] = [];
  for (const p of points) {
    const last = deduped[deduped.length - 1];
    if (last && last.ms === p.ms) continue;
    deduped.push(p);
  }

  return {
    points: deduped,
    dates: [...new Set(dates)].sort(),
    summary: {
      days: dates.length,
      snapshots: files,
      from: deduped.length ? deduped[0].asOf : null,
      to: deduped.length ? deduped[deduped.length - 1].asOf : null,
      slots: [...new Set(deduped.map((p) => p.slot))].sort(),
    },
    gaps,
    themeBoards: themes,
  };
}

/* ------------------------------------------------------------------ */
/* Level series                                                        */
/* ------------------------------------------------------------------ */

/** `board:BK0800` / `index:000001`. */
export type SeriesKey = string;

export const boardSeriesKey = (code: string): SeriesKey => `board:${code}`;
export const indexSeriesKey = (code: string): SeriesKey => `index:${code}`;

export interface LevelPoint {
  ms: number;
  asOf: string;
  date: string;
  slot: string;
  /** Chained price index up to a constant. */
  level: number;
  /** Chain segment; two points are comparable only within one segment. */
  segment: number;
}

export interface Series {
  key: SeriesKey;
  kind: "board" | "index";
  name: string;
  boardKind: BoardKind | null;
  points: LevelPoint[];
  firstDate: string;
  /** Days whose close carried the chain forward. */
  closes: string[];
  /** How many times the chain had to restart (a missing close). */
  breaks: number;
}

export type SeriesMap = Map<SeriesKey, Series>;

/**
 * Chain every instrument's `changePct` readings into a level series.
 *
 * `level(t on day d) = base(d) × (1 + changePct(t)/100)`, with
 * `base(d) = Π (1 + closeChange(d')/100)` over the days before `d` since the
 * last chain break. `base` is 1 on the segment's first day, which is exactly
 * right: `changePct` there is already relative to that day's previous close.
 */
export function buildSeries(store: TapeStore): SeriesMap {
  const byDate = new Map<string, SnapshotPoint[]>();
  for (const p of store.points) {
    const list = byDate.get(p.date);
    if (list) list.push(p);
    else byDate.set(p.date, [p]);
  }
  const dates = [...byDate.keys()].sort();

  /** Each day's close, per instrument key. */
  const closes = new Map<string, Map<SeriesKey, number>>();
  for (const date of dates) {
    const list = byDate.get(date)!;
    const last = list.reduce((a, b) => (b.ms > a.ms ? b : a));
    const m = new Map<SeriesKey, number>();
    for (const [code, q] of last.boards) m.set(boardSeriesKey(code), q.changePct);
    for (const [code, q] of last.indices) m.set(indexSeriesKey(code), q.changePct);
    closes.set(date, m);
  }

  // Instrument metadata + the day each first appeared.
  const meta = new Map<SeriesKey, { kind: "board" | "index"; name: string; boardKind: BoardKind | null; firstDate: string }>();
  for (const date of dates) {
    for (const p of byDate.get(date)!) {
      for (const [code, q] of p.boards) {
        const key = boardSeriesKey(code);
        if (!meta.has(key)) meta.set(key, { kind: "board", name: q.name, boardKind: q.kind, firstDate: date });
      }
      for (const [code, q] of p.indices) {
        const key = indexSeriesKey(code);
        if (!meta.has(key)) meta.set(key, { kind: "index", name: q.name, boardKind: null, firstDate: date });
      }
    }
  }

  // One pass per day, so a chain is never restarted by iteration order.
  const out: SeriesMap = new Map();
  for (const [key, info] of meta) {
    out.set(key, {
      key,
      kind: info.kind,
      name: info.name,
      boardKind: info.boardKind,
      points: [],
      firstDate: info.firstDate,
      closes: [],
      breaks: 0,
    });
  }

  const state = new Map<SeriesKey, { base: number; segment: number }>();
  for (const date of dates) {
    for (const p of byDate.get(date)!) {
      for (const [code, q] of p.boards) {
        const s = out.get(boardSeriesKey(code))!;
        if (date < s.firstDate) continue;
        let st = state.get(s.key);
        if (!st) {
          st = { base: 1, segment: 0 };
          state.set(s.key, st);
        }
        s.points.push({
          ms: p.ms,
          asOf: p.asOf,
          date,
          slot: p.slot,
          level: st.base * (1 + q.changePct / 100),
          segment: st.segment,
        });
      }
      for (const [code, q] of p.indices) {
        const s = out.get(indexSeriesKey(code))!;
        if (date < s.firstDate) continue;
        let st = state.get(s.key);
        if (!st) {
          st = { base: 1, segment: 0 };
          state.set(s.key, st);
        }
        s.points.push({
          ms: p.ms,
          asOf: p.asOf,
          date,
          slot: p.slot,
          level: st.base * (1 + q.changePct / 100),
          segment: st.segment,
        });
      }
    }

    // Roll each day's close into the next day's base.
    const closeMap = closes.get(date)!;
    for (const [key, close] of closeMap) {
      const s = out.get(key);
      if (!s || date < s.firstDate) continue;
      const st = state.get(key);
      if (!st) continue;
      st.base = st.base * (1 + close / 100);
      s.closes.push(date);
    }
    // A chain break must be detected *before* the next day's levels use `base`:
    // an instrument that was in the store and quoted today but had no close is
    // already impossible (the close is the day's last quote), so a break only
    // happens for an instrument that was silent all day. Restart it then, and
    // mark it, so windows spanning the break are refused rather than bridged.
    for (const [key, s] of out) {
      if (date < s.firstDate) continue;
      if (closeMap.has(key)) continue;
      const st = state.get(key);
      if (!st) continue;
      const quotedToday = s.points.some((pt) => pt.date === date);
      if (quotedToday) continue;
      st.base = 1;
      st.segment += 1;
      s.breaks += 1;
    }
  }

  for (const s of out.values()) s.points.sort((a, b) => a.ms - b.ms || a.slot.localeCompare(b.slot));
  return out;
}

/** The instrument's level at exactly this instant, or null when it was not quoted. */
export function levelAt(series: Series | undefined, ms: number): LevelPoint | null {
  if (!series) return null;
  return series.points.find((p) => p.ms === ms) ?? null;
}

/** Level of a series at the last snapshot at or before `ms`, within one segment. */
export function lastLevelBefore(series: Series | undefined, ms: number): LevelPoint | null {
  if (!series) return null;
  let found: LevelPoint | null = null;
  for (const p of series.points) {
    if (p.ms > ms) break;
    found = p;
  }
  return found;
}
