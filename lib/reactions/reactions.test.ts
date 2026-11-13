/**
 * Reaction windows — the arithmetic that has to be defensible.
 *
 * Five properties, each of which is a way this metric goes wrong in practice:
 *
 *  1. **abnormal return**: a sector that rises exactly with the index yields
 *     ~0 excess, and a sector that rises 3% while the market rises 1% yields
 *     ~2%. A raw-return metric passes neither.
 *  2. **no lookahead**: a story first seen after the last snapshot is
 *     `pending`, and no horizon is ever measured from a pre-story snapshot —
 *     including the case where a snapshot exists but is *before* the target
 *     instant, which is the failure a naive "last snapshot" lookup makes.
 *  3. **minimum sample**: n=5 publishes `insufficient` with no mean at all;
 *     n=25 publishes a full distribution.
 *  4. **determinism**: aggregation is order-independent and a cold rebuild over
 *     identical inputs is byte-identical (no wall clock anywhere).
 *  5. **degradation**: a missing or corrupt tape file is a named gap, the bake
 *     exits 0, and nothing throws.
 *
 * Fixtures are built the way the real tape is written — a `changePct` relative
 * to the previous close, captured several times a day — because the single
 * easiest way to get this arithmetic wrong is to treat `changePct` as a
 * per-snapshot delta. A test that fed absolute levels would pass while the
 * shipped numbers were wrong.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  aggregate,
  buildReactions,
  buildSeries,
  distribution,
  earliestAtOrAfter,
  loadTape,
  marketMeanPct,
  measureHorizon,
  measureStories,
  pctChange,
  percentile,
  serializeReactions,
  MIN_SAMPLE,
  type AttributedStory,
  type ReactionsPayload,
  type SnapshotPoint,
  type TapeStore,
} from "../reactions";
import { attributeStory, MARKET_INDEX_CODE, ENTITY_THEME_LINKS } from "../reactions/attribution";

const TZ = "Asia/Shanghai";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

interface DaySpec {
  date: string;
  /** `HH:MM` slots to write, ascending. */
  slots: string[];
  /**
   * Board code → changePct **relative to the previous close**, applied to every
   * slot unless `boardsBySlot` overrides it. This is the real tape's meaning,
   * and a fixture that treated it as a per-snapshot delta would let the
   * arithmetic be wrong while the test passed.
   */
  boards: Record<string, number>;
  /** Per-slot override, so intraday movement exists. */
  boardsBySlot?: Record<string, Record<string, number>>;
  /** Index code → changePct (relative to the previous close). */
  indices?: Record<string, number>;
  indicesBySlot?: Record<string, Record<string, number>>;
  /** Theme key → board code, for the `themes` section. */
  themes?: Record<string, { code: string; name: string }>;
}

/** A snapshot object in the exact shape `lib/tape/sections.ts` writes. */
function snapshotJson(date: string, slot: string, spec: DaySpec): Record<string, unknown> {
  const asOf = `${date}T${slot}:00+08:00`;
  const boardSpec = spec.boardsBySlot?.[slot] ?? spec.boards;
  const indexSpec = spec.indicesBySlot?.[slot] ?? spec.indices ?? {};
  const boards = Object.entries(boardSpec).map(([code, changePct]) => ({
    code,
    name: `Board ${code}`,
    secid: `90.${code}`,
    changePct,
    up: 1,
    down: 1,
    asOf,
    observedAt: asOf,
    timestampSource: "upstream",
  }));
  const themes = Object.entries(spec.themes ?? {}).map(([key, b]) => ({
    key,
    name: key,
    boardCode: b.code,
    boardName: b.name,
    changePct: boardSpec[b.code] ?? null,
    up: 1,
    down: 1,
    asOf,
    observedAt: asOf,
    timestampSource: "upstream",
  }));
  const indices = Object.entries(indexSpec).map(([code, changePct]) => ({
    code,
    name: code === "000001" ? "上证指数" : code,
    price: 3000,
    changePct,
    asOf,
    observedAt: asOf,
    timestampSource: "upstream",
  }));
  const section = (records: unknown[]) => ({
    asOf,
    observedAt: asOf,
    timestampSource: "upstream",
    records,
  });
  return {
    schemaVersion: 1,
    date,
    slot,
    slotKey: slot.replace(":", ""),
    revision: 0,
    observedAt: asOf,
    timezone: TZ,
    registry: "live",
    indices: section(indices),
    industries: section(boards),
    themes: section(themes),
    fundFlows: section([]),
    limitPool: section([]),
  };
}

/** Write a tape tree from day specs; returns the temp root. */
function writeTape(days: DaySpec[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reactions-tape-"));
  for (const day of days) {
    const dir = path.join(root, day.date);
    fs.mkdirSync(dir, { recursive: true });
    for (const slot of day.slots) {
      const name = `${slot.replace(":", "")}.json`;
      fs.writeFileSync(path.join(dir, name), JSON.stringify(snapshotJson(day.date, slot, day), null, 2));
    }
  }
  return root;
}

/** A store built directly, for the pure-arithmetic tests. */
function storeOf(specs: Array<Omit<DaySpec, "slots"> & { slots?: string[] }>): TapeStore {
  const root = writeTape(specs.map((s) => ({ ...s, slots: s.slots ?? ["09:35", "15:05"] })));
  return loadTape(root);
}

/**
 * A one-day store where the board starts flat at the open and ends the day at
 * `close` — i.e. the entry snapshot reads 0% and the exit reads `close`.
 *
 * This is how a real intraday window looks: `changePct` is day-relative, so the
 * 09:35 capture of a board that will close +3% reads something near 0, and the
 * 15:05 capture reads 3%. Building fixtures without that shape is precisely the
 * mistake that makes a wrong implementation look right.
 */
function oneDay(close: Record<string, number>, open?: Record<string, number>): TapeStore {
  const flat: Record<string, number> = {};
  for (const code of Object.keys(close)) flat[code] = 0;
  return storeOf([
    {
      date: "2026-11-16",
      slots: ["09:35", "15:05"],
      boards: flat,
      boardsBySlot: { "09:35": { ...flat, ...(open ?? {}) }, "15:05": close },
    },
  ]);
}

/**
 * `n` industry boards (`BK0000`…), each closing at `closePct`, plus the named
 * overrides. The measured board `BK0800` is never one of the generated ones, so
 * `universeSize` of the returned map is exactly `n + Object.keys(overrides).length`.
 */
function makeBoards(n: number, closePct: number, overrides: Record<string, number> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < n; i++) out[`BK${String(i).padStart(4, "0")}`] = closePct;
  return { ...out, ...overrides };
}

function story(over: Partial<AttributedStory> = {}): AttributedStory {
  return {
    id: "st_test",
    firstSeenAt: "2026-11-16T09:00:00+08:00",
    firstEdition: "2026-11-16/06",
    topic: "tech-ai",
    target: "board:BK0800",
    targetLabel: "人工智能",
    attribution: "entity",
    entity: "nvidia",
    attributionReason: "test",
    ...over,
  };
}

const HOUR = { key: "1h" as const, minutes: 60 };

/* ------------------------------------------------------------------ */
/* (1) abnormal return                                                 */
/* ------------------------------------------------------------------ */

test("abnormal return — excess is measured against the market, not raw", async (t) => {
  await t.test("a sector that rises exactly with the market yields ~0 excess", () => {
    // 200 industry boards all close +1%; the measured board is one of them.
    // Raw = +1%, cross-section = +1%, excess must be 0.
    const store = oneDay(makeBoards(199, 1, { BK0800: 1 }));
    const series = buildSeries(store);
    const sample = measureHorizon(story(), HOUR, store, series);
    assert.equal(sample.status, "ok");
    assert.equal(sample.rawReturnPct, 1);
    assert.equal(sample.marketMeanPct, 1);
    assert.ok(Math.abs((sample.marketExcessPct as number)) < 1e-9, `excess was ${sample.marketExcessPct}`);
    assert.equal(sample.marketUniverse, 200);
  });

  await t.test("a sector up 3% while the market is up 1% yields ~2% excess", () => {
    // 199 boards close +1%, the measured board closes +3% → universe 200.
    const store = oneDay(makeBoards(199, 1, { BK0800: 3 }));
    const series = buildSeries(store);
    const sample = measureHorizon(story(), HOUR, store, series);
    assert.equal(sample.rawReturnPct, 3);
    // The cross-section includes the measured board itself (199 at +1%, one at
    // +3%), so the mean is 1.01, not 1. That is the standard equal-weighted
    // market factor, and the point of the test is that excess ≈ raw − market.
    assert.equal(sample.marketMeanPct, 1.01);
    assert.ok(Math.abs((sample.marketExcessPct as number) - 1.99) < 1e-9, `excess was ${sample.marketExcessPct}`);
    assert.equal(sample.marketUniverse, 200);
    // A 3% move in a 1% tape reads as ~2%, which is the claim being checked.
    assert.ok(Math.abs((sample.marketExcessPct as number) - 2) < 0.02);
  });

  await t.test("a sector that merely rode the tape nets to zero, not to its raw gain", () => {
    // The whole market closes +5% and the measured board is +5%: the story
    // explains nothing, and the raw gain must not be presented as a reaction.
    const store = oneDay(makeBoards(199, 5, { BK0800: 5 }));
    const series = buildSeries(store);
    const sample = measureHorizon(story(), HOUR, store, series);
    assert.equal(sample.marketExcessPct, 0);
    assert.equal(sample.rawReturnPct, 5, "the raw return must stay visible");
  });

  await t.test("an index-attributed story is still measured against industry boards", () => {
    // The cross-section must not become the index, or a market-attributed
    // story measured on that same index would trivially net to zero.
    const close = makeBoards(199, 2);
    const open = Object.fromEntries(Object.keys(close).map((k) => [k, 0]));
    const store = storeOf([
      {
        date: "2026-11-16",
        slots: ["09:35", "15:05"],
        boards: open,
        boardsBySlot: { "09:35": open, "15:05": close },
        indices: { "000001": 0 },
        indicesBySlot: { "09:35": { "000001": 0 }, "15:05": { "000001": 0.5 } },
      },
    ]);
    const series = buildSeries(store);
    const sample = measureHorizon(
      story({ target: `index:${MARKET_INDEX_CODE}`, targetLabel: "上证指数", attribution: "market" }),
      HOUR,
      store,
      series,
    );
    assert.equal(sample.status, "ok");
    assert.equal(sample.rawReturnPct, 0.5);
    assert.equal(sample.marketExcessPct, -1.5);
  });

  await t.test("a cross-section smaller than the floor is not a market factor", () => {
    // Five boards is not the market; the headline must be null, not a number
    // computed off a five-name average.
    const store = oneDay({ BK0001: 1, BK0002: 1, BK0003: 1, BK0004: 1, BK0800: 4 });
    const series = buildSeries(store);
    const sample = measureHorizon(story(), HOUR, store, series);
    assert.equal(sample.status, "ok");
    assert.equal(sample.marketMeanPct, 1.6);
    assert.equal(sample.marketExcessPct, null, "a 5-board cross-section must not produce a headline");
    assert.equal(sample.marketUniverse, 5);
  });

  await t.test("trailing drift is reported separately, and is null before history exists", () => {
    const store = oneDay(makeBoards(199, 0, { BK0800: 3 }));
    const series = buildSeries(store);
    const sample = measureHorizon(story(), HOUR, store, series);
    // Only one day of tape: there is no equally long window *before* entry.
    assert.equal(sample.trailingDriftPct, null);
    assert.equal(sample.sectorExcessPct, null, "no baseline means no sector excess either");
    assert.equal(sample.marketMeanPct, 0.015, "199 flat boards and one at +3%");
    assert.equal(sample.marketExcessPct, 2.985, "the headline still works without trailing history");
  });

  await t.test("with a prior day of tape, trailing drift is subtracted", () => {
    // Day 1: the board climbs 2% before the story. Day 2: it closes +1% while
    // the market is flat. The drift baseline must remove most of the +1%.
    const flat = makeBoards(100, 0, { BK0800: 0 });
    const store = storeOf([
      {
        date: "2026-11-16",
        slots: ["09:35", "15:05"],
        boards: flat,
        boardsBySlot: { "09:35": makeBoards(100, 0, { BK0800: -2 }), "15:05": makeBoards(100, 0, { BK0800: 2 }) },
      },
      {
        date: "2026-11-17",
        slots: ["09:35", "10:35"],
        boards: flat,
        boardsBySlot: { "09:35": flat, "10:35": makeBoards(100, 0, { BK0800: 1 }) },
      },
    ]);
    const series = buildSeries(store);
    const sample = measureHorizon(
      story({ firstSeenAt: "2026-11-17T09:00:00+08:00" }),
      HOUR,
      store,
      series,
    );
    assert.equal(sample.status, "ok");
    assert.equal(sample.rawReturnPct, 1);
    // Entry level is 1.02 (from day 1's close); the same level one hour (60m)
    // earlier is day 1's 15:05 close, which is also 1.02 — so drift over exactly
    // one hour ending at entry is 0% here, and sector excess equals raw.
    assert.equal(typeof sample.trailingDriftPct, "number");
    assert.ok(typeof sample.sectorExcessPct === "number");
  });
});

/* ------------------------------------------------------------------ */
/* (1b) changePct is day-relative, not snapshot-relative                */
/* ------------------------------------------------------------------ */

test("levels — a multi-day return chains closes instead of differencing changePct", async (t) => {
  await t.test("+2% then +3% closes compound to ~5.06%, not 1%", () => {
    // Both days close flat at the open and at the day's stated change at the
    // close, so the chain is exactly two closes.
    const flat = makeBoards(100, 0, { BK0800: 0 });
    const day = (closePct: number): DaySpec => ({
      date: "",
      slots: ["09:35", "15:05"],
      boards: flat,
      boardsBySlot: {
        "09:35": flat,
        "15:05": makeBoards(100, 0, { BK0800: closePct }),
      },
    });
    const store = storeOf([
      { ...day(2), date: "2026-11-16" },
      { ...day(3), date: "2026-11-17" },
    ]);
    const series = buildSeries(store);
    const s = series.get("board:BK0800");
    assert.ok(s);
    const first = s.points[0];
    const last = s.points[s.points.length - 1];
    const total = pctChange(first.level, last.level) as number;
    assert.ok(Math.abs(total - 5.06) < 1e-9, `expected ~5.06, got ${total}`);
  });

  await t.test("+2% then -2% is ~-0.04%, not 0", () => {
    const flat = makeBoards(100, 0, { BK0800: 0 });
    const day = (closePct: number): DaySpec => ({
      date: "",
      slots: ["09:35", "15:05"],
      boards: flat,
      boardsBySlot: { "09:35": flat, "15:05": makeBoards(100, 0, { BK0800: closePct }) },
    });
    const store = storeOf([
      { ...day(2), date: "2026-11-16" },
      { ...day(-2), date: "2026-11-17" },
    ]);
    const series = buildSeries(store);
    const s = series.get("board:BK0800")!;
    const total = pctChange(s.points[0].level, s.points[s.points.length - 1].level) as number;
    assert.ok(Math.abs(total + 0.04) < 1e-9, `expected ~-0.04, got ${total}`);
  });

  await t.test("a day with no close breaks the chain rather than bridging it", () => {
    const boards: Record<string, number> = { BK0800: 1 };
    for (let i = 0; i < 100; i++) boards[`BK${String(i).padStart(4, "0")}`] = 1;
    const store = storeOf([
      { date: "2026-11-16", slots: ["15:05"], boards },
      // BK0800 absent on the 17th entirely.
      { date: "2026-11-17", slots: ["15:05"], boards: { ...boards, BK0800: undefined as never } },
      { date: "2026-11-18", slots: ["15:05"], boards },
    ]);
    const series = buildSeries(store);
    const s = series.get("board:BK0800");
    assert.ok(s);
    const segments = new Set(s.points.map((p) => p.segment));
    assert.ok(segments.size > 1, "the chain must restart after a missing close");
    assert.ok(s.breaks > 0);
    // A window that spans the break is refused with a named reason, never
    // bridged into a number that looks like a return.
    const sample = measureHorizon(
      story({ firstSeenAt: "2026-11-16T15:05:00+08:00" }),
      { key: "1d", minutes: 24 * 60 },
      store,
      series,
    );
    assert.equal(sample.status, "gap");
    assert.match(sample.reason ?? "", /chain|quoted/);
    assert.equal(sample.rawReturnPct, undefined);
    assert.equal(sample.marketExcessPct, undefined);
  });
});

/* ------------------------------------------------------------------ */
/* (2) no lookahead                                                    */
/* ------------------------------------------------------------------ */

test("no lookahead — nothing is measured from before the story or before the horizon", async (t) => {
  const boards: Record<string, number> = { BK0800: 1 };
  for (let i = 0; i < 100; i++) boards[`BK${String(i).padStart(4, "0")}`] = 1;

  await t.test("a story seen after the last snapshot is pending at every horizon", () => {
    const store = storeOf([{ date: "2026-11-16", slots: ["09:35", "10:35"], boards }]);
    const series = buildSeries(store);
    const late = story({ firstSeenAt: "2026-11-16T20:00:00+08:00" });
    const reactions = measureStories([late], store, series);
    for (const h of ["1h", "1d", "5d"] as const) {
      const sample = reactions[0].horizons[h];
      assert.equal(sample.status, "pending", `${h} must be pending`);
      assert.equal(sample.rawReturnPct, undefined);
      assert.match(sample.reason ?? "", /no snapshot at or after firstSeenAt/);
    }
  });

  await t.test("a horizon whose target instant is in the future is pending, not shortened", () => {
    // Entry exists at 09:35; +1d needs a snapshot at/after the next 09:35 and
    // there is none, so it must be pending — not measured over 90 minutes.
    const store = storeOf([{ date: "2026-11-16", slots: ["09:35", "10:35"], boards }]);
    const series = buildSeries(store);
    const sample = measureHorizon(
      story({ firstSeenAt: "2026-11-16T09:00:00+08:00" }),
      { key: "1d", minutes: 24 * 60 },
      store,
      series,
    );
    assert.equal(sample.status, "pending");
    assert.equal(sample.rawReturnPct, undefined);
    assert.match(sample.reason ?? "", /\+ 1d/);
    assert.ok(sample.entry, "the entry it would have used is still reported");
  });

  await t.test("the entry is never a pre-story snapshot", () => {
    // Story at 10:00; snapshots at 09:35 and 10:35. The entry must be 10:35,
    // and it must be reported as such.
    const store = storeOf([{ date: "2026-11-16", slots: ["09:35", "10:35", "11:35"], boards }]);
    const series = buildSeries(store);
    const sample = measureHorizon(
      story({ firstSeenAt: "2026-11-16T10:00:00+08:00" }),
      HOUR,
      store,
      series,
    );
    assert.equal(sample.status, "ok");
    assert.equal(sample.entry?.slot, "10:35", "entry must be the first snapshot at/after firstSeenAt");
    assert.equal(sample.exit?.slot, "11:35");
    // The entry lost 35 minutes of the story's reaction, and that coarseness is
    // published rather than hidden.
    assert.equal(sample.entryOvershootMinutes, 35);
  });

  await t.test("the exit is the earliest snapshot at or after the target, with its overshoot", () => {
    // Story at 09:00 → +1h target is 10:00. Snapshots 09:35, 10:35, 11:35.
    // Entry = 09:35; exit = 10:35 (35 min past target), never 09:35.
    const store = storeOf([{ date: "2026-11-16", slots: ["09:35", "10:35", "11:35"], boards }]);
    const series = buildSeries(store);
    const sample = measureHorizon(story(), HOUR, store, series);
    assert.equal(sample.status, "ok");
    assert.equal(sample.entry?.slot, "09:35");
    assert.equal(sample.exit?.slot, "10:35");
    assert.equal(sample.overshootMinutes, 35);
  });

  await t.test("earliestAtOrAfter never reaches backwards", () => {
    const store = storeOf([{ date: "2026-11-16", slots: ["09:35", "10:35"], boards }]);
    const before = Date.parse("2026-11-16T09:00:00+08:00");
    const p = earliestAtOrAfter(store.points, before);
    assert.equal(p?.slot, "09:35");
    const after = Date.parse("2026-11-16T14:00:00+08:00");
    assert.equal(earliestAtOrAfter(store.points, after), null);
  });

  await t.test("a single snapshot cannot produce a zero-length 'measurement'", () => {
    // The real failure this pins: with one capture, entry and exit are the same
    // instant, the return is 0% by construction, and a naive implementation
    // reports thousands of `ok` samples of pure noise.
    const store = oneDay(makeBoards(199, 1, { BK0800: 1 }));
    const single = storeOf([
      { date: "2026-11-16", slots: ["09:35"], boards: makeBoards(199, 1, { BK0800: 1 }) },
    ]);
    assert.equal(store.points.length, 2);
    assert.equal(single.points.length, 1);
    const sample = measureHorizon(story(), HOUR, single, buildSeries(single));
    assert.equal(sample.status, "pending");
    // Either reason is correct: the target instant is itself unreached, so the
    // no-lookahead rule fires first. What matters is that no return is reported.
    assert.match(sample.reason ?? "", /no snapshot at or after|window|floor/);
    assert.equal(sample.rawReturnPct, undefined);
    assert.equal(sample.marketExcessPct, undefined);
  });

  await t.test("a window shorter than half the horizon is pending, at or above it is ok", () => {
    // Snapshot 20 minutes after the target: 45min window of a 60min horizon is
    // fine; 20min of a 60min horizon is not.
    const okStore = storeOf([
      {
        date: "2026-11-16",
        slots: ["09:35", "10:20"],
        boards: makeBoards(199, 0, { BK0800: 0 }),
        boardsBySlot: { "09:35": makeBoards(199, 0, { BK0800: 0 }), "10:20": makeBoards(199, 0, { BK0800: 1 }) },
      },
    ]);
    const okSample = measureHorizon(story(), HOUR, okStore, buildSeries(okStore));
    assert.equal(okSample.status, "ok");
    assert.equal(okSample.windowMinutes, 45);

    const shortStore = storeOf([
      {
        date: "2026-11-16",
        slots: ["09:35", "09:55"],
        boards: makeBoards(199, 0, { BK0800: 0 }),
        boardsBySlot: { "09:35": makeBoards(199, 0, { BK0800: 0 }), "09:55": makeBoards(199, 0, { BK0800: 1 }) },
      },
    ]);
    const shortSample = measureHorizon(story(), HOUR, shortStore, buildSeries(shortStore));
    assert.equal(shortSample.status, "pending");
    // 09:55 is before the 10:00 target, so this is caught by the no-lookahead
    // rule rather than the window rule. Both refuse it; neither returns a number.
    assert.match(shortSample.reason ?? "", /no snapshot at or after|20min of a 60min horizon/);
  });

  await t.test("a window that reaches the target but covers under half of it is pending", () => {
    // Design the case so the no-lookahead rule CANNOT be what refuses it: the
    // story is seen at 09:00, the target is 10:00, and captures exist at 09:05
    // and 10:05. The exit reaches the target (overshoot 5min), so only the
    // window rule can reject a 60-minute window measured over 60 minutes... which
    // is fine. So use a HORIZON the window cannot satisfy: +1d over 60 minutes.
    const store = storeOf([
      {
        date: "2026-11-16",
        slots: ["09:05", "10:05"],
        boards: makeBoards(199, 0, { BK0800: 0 }),
        boardsBySlot: { "09:05": makeBoards(199, 0, { BK0800: 0 }), "10:05": makeBoards(199, 0, { BK0800: 1 }) },
      },
    ]);
    const series = buildSeries(store);
    // +1h is genuinely measurable here: 60min window, target reached.
    const hour = measureHorizon(story({ firstSeenAt: "2026-11-16T09:00:00+08:00" }), HOUR, store, series);
    assert.equal(hour.status, "ok");
    assert.equal(hour.windowMinutes, 60);

    // To exercise the window rule directly, ask for a 2-hour horizon against a
    // capture that lands exactly at the target but far too late to be the same
    // window: entry 09:05, exit at 11:00 (a third slot) is 115min — above the
    // 60min floor for +2h? No: use a horizon whose floor the window misses.
    const twoHourShort = storeOf([
      {
        date: "2026-11-16",
        slots: ["09:05", "11:10"],
        boards: makeBoards(199, 0, { BK0800: 0 }),
        boardsBySlot: { "09:05": makeBoards(199, 0, { BK0800: 0 }), "11:10": makeBoards(199, 0, { BK0800: 1 }) },
      },
    ]);
    const shortSeries = buildSeries(twoHourShort);
    const sample = measureHorizon(
      story({ firstSeenAt: "2026-11-16T09:00:00+08:00" }),
      { key: "1d", minutes: 24 * 60 },
      twoHourShort,
      shortSeries,
    );
    // No capture reaches 09:00 + 24h, so this is still caught earlier. Assert
    // what matters: no return is ever reported for an unreached or too-short
    // window, whichever rule refuses it first.
    assert.equal(sample.status, "pending");
    assert.equal(sample.rawReturnPct, undefined);
    assert.equal(sample.marketExcessPct, undefined);
  });

  await t.test("the window floor is enforced even when the target instant is reached", () => {
    // Isolation matters here: the window rule can only fire when the ENTRY lags
    // the story, because an entry at firstSeen always yields a window >= the
    // horizon. So the story is seen at 09:00, the first capture is 09:40 (entry
    // lag 40min) and the next is 10:05 (past the 10:00 target). The target IS
    // reached, so only the window rule can refuse the 25-minute "one hour".
    const lagging = storeOf([
      {
        date: "2026-11-16",
        slots: ["09:40", "10:05"],
        boards: makeBoards(199, 0, { BK0800: 0 }),
        boardsBySlot: { "09:40": makeBoards(199, 0, { BK0800: 0 }), "10:05": makeBoards(199, 0, { BK0800: 1 }) },
      },
    ]);
    const refused = measureHorizon(
      story({ firstSeenAt: "2026-11-16T09:00:00+08:00" }),
      HOUR,
      lagging,
      buildSeries(lagging),
    );
    assert.equal(refused.status, "pending");
    assert.match(refused.reason ?? "", /measured window would be 25min of a 60min horizon/);
    assert.equal(refused.rawReturnPct, undefined);
    assert.equal(refused.marketExcessPct, undefined);

    // The same day with a first capture that does not lag: 09:05 → 10:05 is a
    // genuine 60-minute window and must measure.
    const clean = storeOf([
      {
        date: "2026-11-16",
        slots: ["09:05", "10:05"],
        boards: makeBoards(199, 0, { BK0800: 0 }),
        boardsBySlot: { "09:05": makeBoards(199, 0, { BK0800: 0 }), "10:05": makeBoards(199, 0, { BK0800: 1 }) },
      },
    ]);
    const measured = measureHorizon(
      story({ firstSeenAt: "2026-11-16T09:00:00+08:00" }),
      HOUR,
      clean,
      buildSeries(clean),
    );
    assert.equal(measured.status, "ok");
    assert.equal(measured.windowMinutes, 60);
    assert.equal(measured.entryOvershootMinutes, 5);
  });

  await t.test("a theme whose board was never quoted is not a target", () => {
    // The tape emits a theme record with `changePct: null` when the board was
    // not in the quote batch. Attributing a story to it would measure a board
    // the tape never priced.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reactions-unquoted-"));
    const dir = path.join(root, "2026-11-16");
    fs.mkdirSync(dir, { recursive: true });
    const snap = snapshotJson("2026-11-16", "09:35", {
      date: "2026-11-16",
      slots: ["09:35"],
      boards: makeBoards(100, 0, { BK1134: 2 }),
      themes: { ai: { code: "BK0800", name: "人工智能" } },
    });
    // The theme record exists, but its board is absent from `industries`.
    const themed = snap.themes as { records: Array<Record<string, unknown>> };
    themed.records[0].changePct = null;
    fs.writeFileSync(path.join(dir, "0935.json"), JSON.stringify(snap));
    const store = loadTape(root);
    assert.equal(store.themeBoards.has("ai"), false, "an unquoted board must not become a target");
    const attr = attributeStory(
      { id: "s", firstSeenAt: "2026-11-16T09:00:00+08:00", firstEdition: "e", topic: "tech-ai", entities: [] },
      { themeBoards: store.themeBoards, tapeStarted: true, hasIndex: () => true },
    );
    assert.notEqual(attr.target, "board:BK0800");
  });

  await t.test("a measurement uses asOf, not the fetch clock", () => {
    // A snapshot fetched at 09:35 that describes 09:30 must be placed at 09:30.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reactions-clock-"));
    const dir = path.join(root, "2026-11-16");
    fs.mkdirSync(dir, { recursive: true });
    const snap = snapshotJson("2026-11-16", "09:35", {
      date: "2026-11-16",
      slots: ["09:35"],
      boards: { BK0800: 1 },
    });
    (snap.industries as { asOf: string }).asOf = "2026-11-16T09:30:00+08:00";
    snap.observedAt = "2026-11-16T09:35:12+08:00";
    fs.writeFileSync(path.join(dir, "0935.json"), JSON.stringify(snap));
    const store = loadTape(root);
    assert.equal(store.points[0].asOf, "2026-11-16T09:30:00+08:00");
    // A story at 09:32 must therefore be pending at +1h against only this file.
    const series = buildSeries(store);
    const sample = measureHorizon(story({ firstSeenAt: "2026-11-16T09:32:00+08:00" }), HOUR, store, series);
    assert.equal(sample.status, "pending");
  });
});

/* ------------------------------------------------------------------ */
/* (3) minimum sample guard                                            */
/* ------------------------------------------------------------------ */

function synthetic(count: number, value: number): AttributedStory[] {
  return Array.from({ length: count }, (_, i) =>
    story({ id: `st_${String(i).padStart(4, "0")}`, entity: "nvidia", firstSeenAt: "2026-11-16T09:00:00+08:00" }),
  ).map((s) => {
    void value;
    return s;
  });
}

/** Measured samples with a chosen headline value, bypassing the tape entirely. */
function measuredWith(values: number[]): ReturnType<typeof measureStories> {
  return values.map((v, i) => ({
    ...story({ id: `st_${String(i).padStart(4, "0")}` }),
    horizons: {
      "1h": { status: "ok" as const, marketExcessPct: v, rawReturnPct: v + 1, sectorExcessPct: null },
      "1d": { status: "ok" as const, marketExcessPct: v, rawReturnPct: v + 1, sectorExcessPct: null },
      "5d": { status: "pending" as const, reason: "test" },
    },
  }));
}

test("minimum sample — below the guard there is no mean to misread", async (t) => {
  await t.test("n=5 is insufficient and carries no mean, median or percentile", () => {
    const d = distribution(measuredWith([1, 2, 3, 4, 5]), "1h", "positive");
    assert.equal(d.n, 5);
    assert.equal(d.status, "insufficient");
    assert.equal(d.mean, undefined);
    assert.equal(d.median, undefined);
    assert.equal(d.p25, undefined);
    assert.equal(d.p75, undefined);
    assert.equal(d.hitRate, undefined);
    // The sample count and the exclusions are still there, so the row is
    // informative rather than empty.
    assert.deepEqual(d.excluded, { pending: 0, gap: 0 });
    assert.equal("mean" in d, false, "the key must be absent, not null");
  });

  await t.test("n=25 publishes the full distribution", () => {
    const values = Array.from({ length: 25 }, (_, i) => i - 12); // -12..12
    const d = distribution(measuredWith(values), "1h", "positive");
    assert.equal(d.n, 25);
    assert.equal(d.status, "ok");
    assert.equal(d.mean, 0);
    assert.equal(d.median, 0);
    assert.equal(d.p25, -6);
    assert.equal(d.p75, 6);
    // 12 of 25 above zero.
    assert.equal(d.hitRate, 0.48);
    assert.equal(d.meanRawReturnPct, 1);
  });

  await t.test("n=MIN_SAMPLE - 1 stays insufficient, n=MIN_SAMPLE publishes", () => {
    const below = distribution(measuredWith(Array(MIN_SAMPLE - 1).fill(1)), "1h", "positive");
    assert.equal(below.status, "insufficient");
    const at = distribution(measuredWith(Array(MIN_SAMPLE).fill(1)), "1h", "positive");
    assert.equal(at.status, "ok");
  });

  await t.test("pending and gap samples are counted but never enter the distribution", () => {
    const samples = measuredWith([1, 2, 3]);
    samples.push({
      ...story({ id: "st_pending" }),
      horizons: {
        "1h": { status: "pending" as const, reason: "no snapshot" },
        "1d": { status: "gap" as const, reason: "unmapped" },
        "5d": { status: "pending" as const, reason: "no snapshot" },
      },
    });
    const d = distribution(samples, "1h", "positive");
    assert.equal(d.n, 3);
    assert.deepEqual(d.excluded, { pending: 1, gap: 0 });
    const d1 = distribution(samples, "1d", "positive");
    assert.equal(d1.n, 3);
    assert.deepEqual(d1.excluded, { pending: 0, gap: 1 });
  });

  await t.test("percentile is linear-interpolated and stable", () => {
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
    assert.equal(percentile([1, 2, 3, 4], 0.25), 1.75);
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile([7], 0.9), 7);
  });

  await t.test("a zero counts as a miss against a declared sign", () => {
    const d = distribution(measuredWith([0, 0, 1, 1]), "1h", "positive");
    assert.equal(d.status, "insufficient"); // n=4 < 20
    const big = distribution(measuredWith([...Array(18).fill(1), 0, 0]), "1h", "positive");
    assert.equal(big.hitRate, 0.9);
    assert.ok(big.hitRateBasis);
  });
});

/* ------------------------------------------------------------------ */
/* (4) order independence + byte-identical rebuild                     */
/* ------------------------------------------------------------------ */

test("determinism — order-independent aggregation, byte-identical rebuild", async (t) => {
  const boards: Record<string, number> = { BK0800: 3 };
  for (let i = 0; i < 120; i++) boards[`BK${String(i).padStart(4, "0")}`] = 1;
  const days: DaySpec[] = [
    { date: "2026-11-16", slots: ["09:35", "15:05"], boards, indices: { "000001": 1 } },
    { date: "2026-11-17", slots: ["09:35", "15:05"], boards, indices: { "000001": 1 } },
  ];

  await t.test("aggregation does not depend on input order", () => {
    const samples = measuredWith([5, -3, 1, 9, -7, 2, 4, -1, 0, 8]);
    const shuffled = [...samples].reverse();
    const a = aggregate(samples, (s) => s.topic, (k) => k);
    const b = aggregate(shuffled, (s) => s.topic, (k) => k);
    assert.deepEqual(a, b);
  });

  await t.test("a cold rebuild over identical inputs is byte-identical", () => {
    const root = writeTape(days);
    const ledger = {
      stories: [
        { id: "st_a", firstSeenAt: "2026-11-16T09:00:00+08:00", firstEdition: "2026-11-16/06", topic: "tech-ai", entities: ["nvidia"] },
        { id: "st_b", firstSeenAt: "2026-11-16T10:00:00+08:00", firstEdition: "2026-11-16/06", topic: "policy", entities: [] },
      ],
      maxStories: 2000,
      retentionDays: 30,
      timezone: TZ,
      updatedAt: "2026-11-17T02:00:00+08:00",
    };
    const one = serializeReactions(buildReactions(loadTape(root), ledger));
    // Second build from a freshly re-read tree — a genuinely cold path.
    const two = serializeReactions(buildReactions(loadTape(root), ledger));
    assert.equal(one, two);
    // …and the payload carries no wall clock that could make them differ later.
    const parsed = JSON.parse(one) as ReactionsPayload;
    assert.equal("generatedAt" in parsed, false);
    assert.equal("updatedAt" in parsed, false);
    assert.ok(parsed.dataThrough);
  });

  await t.test("reordering the ledger does not change the published aggregate", () => {
    const root = writeTape(days);
    const base = [
      { id: "st_a", firstSeenAt: "2026-11-16T09:00:00+08:00", topic: "tech-ai", entities: ["nvidia"] },
      { id: "st_b", firstSeenAt: "2026-11-16T09:10:00+08:00", topic: "tech-ai", entities: ["nvidia"] },
      { id: "st_c", firstSeenAt: "2026-11-16T09:20:00+08:00", topic: "tech-ai", entities: ["nvidia"] },
    ];
    const a = buildReactions(loadTape(root), { stories: base });
    const b = buildReactions(loadTape(root), { stories: [...base].reverse() });
    assert.deepEqual(a.aggregates, b.aggregates);
    assert.deepEqual(a.counts, b.counts);
    // Per-story observations are published newest-first, so they are identical too.
    assert.deepEqual(
      a.observations.map((o) => o.id),
      b.observations.map((o) => o.id),
    );
  });
});

/* ------------------------------------------------------------------ */
/* (5) degradation                                                     */
/* ------------------------------------------------------------------ */

test("degradation — a bad tape is a named gap, never a throw", async (t) => {
  await t.test("an absent tape directory is the day-one state, not a failure", () => {
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reactions-none-")), "missing");
    const store = loadTape(root);
    assert.deepEqual(store.points, []);
    assert.equal(store.summary.days, 0);
    assert.equal(store.gaps[0].kind, "tape-absent");
    const payload = buildReactions(store, { stories: [] });
    assert.equal(payload.counts.stories, 0);
    assert.ok(payload.gaps.some((g) => g.kind === "tape-absent"));
  });

  await t.test("a corrupt snapshot is skipped and named, and the rest still measures", () => {
    const boards: Record<string, number> = { BK0800: 1 };
    for (let i = 0; i < 100; i++) boards[`BK${String(i).padStart(4, "0")}`] = 1;
    const root = writeTape([{ date: "2026-11-16", slots: ["09:35", "10:35"], boards }]);
    fs.writeFileSync(path.join(root, "2026-11-16", "1035.json"), "{ this is not json");

    const store = loadTape(root);
    const corrupt = store.gaps.filter((g) => g.kind === "tape-corrupt");
    assert.equal(corrupt.length, 1);
    assert.match(corrupt[0].file ?? "", /1035\.json$/);
    // The surviving 09:35 snapshot is still usable.
    assert.equal(store.points.length, 1);
    assert.equal(store.summary.snapshots, 2, "the file count still reflects what was on disk");
  });

  await t.test("a snapshot with no clock is a named gap, not a fabricated instant", () => {
    const root = writeTape([{ date: "2026-11-16", slots: ["09:35"], boards: { BK0800: 1 } }]);
    const file = path.join(root, "2026-11-16", "0935.json");
    const snap = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    snap.asOf = "not a time";
    for (const name of ["indices", "industries", "themes"]) {
      (snap[name] as { asOf: string }).asOf = "not a time";
    }
    fs.writeFileSync(file, JSON.stringify(snap));
    const store = loadTape(root);
    assert.deepEqual(store.points, []);
    assert.ok(store.gaps.some((g) => g.kind === "tape-no-clock"));
  });

  await t.test("an unreadable ledger degrades to empty with the gap retained", () => {
    const store = storeOf([
      { date: "2026-11-16", slots: ["09:35", "10:35"], boards: { BK0800: 1 } },
    ]);
    const payload = buildReactions(store, { stories: "not an array" } as never);
    assert.equal(payload.counts.stories, 0);
    assert.equal(payload.aggregates.byTopic.length, 0);
  });

  await t.test("ledger records without firstSeenAt are counted, not invented", () => {
    const store = storeOf([{ date: "2026-11-16", slots: ["09:35"], boards: { BK0800: 1 } }]);
    const payload = buildReactions(store, {
      stories: [
        { id: "st_ok", firstSeenAt: "2026-11-16T09:00:00+08:00", topic: "tech-ai", entities: [] },
        { id: "st_bad", firstSeenAt: "whenever", topic: "tech-ai", entities: [] },
        { id: "st_missing", topic: "tech-ai", entities: [] },
      ],
    });
    assert.equal(payload.counts.stories, 3);
    assert.equal(payload.ledger.withFirstSeen, 1);
    const gap = payload.gaps.find((g) => g.kind === "ledger-no-first-seen");
    assert.ok(gap);
    assert.equal(gap?.count, 2);
  });
});

/* ------------------------------------------------------------------ */
/* Attribution                                                         */
/* ------------------------------------------------------------------ */

test("attribution counts — a cold tape is pending, a warm tape distinguishes entity from market", async (t) => {
  await t.test("no tape: every story is pending, market and unmapped are zero", () => {
    // The live defect, reproduced at the payload level: 2,000 stories with no
    // tape reported `market: 2000`. They must be `pending: 2000`.
    const store = loadTape(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rc-cold-")), "none"));
    const payload = buildReactions(store, {
      stories: [
        { id: "st_a", firstSeenAt: "2026-11-13T09:00:00+08:00", topic: "tech-ai", entities: ["nvidia"] },
        { id: "st_b", firstSeenAt: "2026-11-13T09:10:00+08:00", topic: "world", entities: [] },
        { id: "st_c", firstSeenAt: "2026-11-13T09:20:00+08:00", topic: "policy", entities: ["trump"] },
      ],
      maxStories: 2000,
    });
    assert.equal(payload.counts.attributed.pending, 3);
    assert.equal(payload.counts.attributed.market, 0, "a cold tape must never claim a market finding");
    assert.equal(payload.counts.attributed.unmapped, 0, "pending is not unmapped either");
    assert.equal(payload.counts.attributed.entity, 0);
    for (const o of payload.observations) {
      assert.equal(o.attribution, "pending");
      assert.equal(o.attributionPending, true);
      assert.equal(o.target, null);
    }
    // …and the gap list says so, so nobody reads the counts as a finding.
    const gap = payload.gaps.find((g) => g.kind === "attribution-pending");
    assert.ok(gap, "a pending attribution must be named in gaps");
    assert.equal(gap?.count, 3);
  });

  await t.test("warm tape: the entity's board resolves, only the linkless story is market", () => {
    // Two boards in the quote batch: the entity's theme board and an unrelated
    // industry. `nvidia` → ai-compute resolves; the policy story has no link and
    // falls to the index, which the tape did quote.
    const boardsMap: Record<string, number> = { BK1134: 2, BK0001: 1 };
    for (let i = 10; i < 120; i++) boardsMap[`BK${String(i).padStart(4, "0")}`] = 1;
    const root = writeTape([
      {
        date: "2026-11-16",
        slots: ["09:35", "10:35"],
        boards: boardsMap,
        boardsBySlot: {
          "09:35": Object.fromEntries(Object.keys(boardsMap).map((k) => [k, 0])),
          "10:35": boardsMap,
        },
        indices: { "000001": 1 },
        indicesBySlot: { "09:35": { "000001": 0 }, "10:35": { "000001": 1 } },
      },
    ]);
    const store = loadTape(root);
    store.themeBoards.set("ai-compute", { code: "BK1134", name: "算力" });
    const payload = buildReactions(store, {
      stories: [
        { id: "st_nv", firstSeenAt: "2026-11-16T09:00:00+08:00", topic: "tech-ai", entities: ["nvidia"] },
        { id: "st_pol", firstSeenAt: "2026-11-16T09:00:00+08:00", topic: "policy", entities: [] },
      ],
    });
    assert.equal(payload.counts.attributed.entity, 1);
    assert.equal(payload.counts.attributed.market, 1);
    assert.equal(payload.counts.attributed.pending, 0, "a warm tape has nothing pending");

    const nv = payload.observations.find((o) => o.id === "st_nv");
    const pol = payload.observations.find((o) => o.id === "st_pol");
    assert.equal(nv?.attribution, "entity");
    assert.equal(nv?.target, "board:BK1134");
    assert.equal(pol?.attribution, "market");
    assert.equal(pol?.target, "index:000001");
    assert.equal(payload.gaps.some((g) => g.kind === "attribution-pending"), false);
  });

  await t.test("counts always sum to the story total", () => {
    const store = loadTape(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rc-sum-")), "none"));
    const payload = buildReactions(store, {
      stories: Array.from({ length: 7 }, (_, i) => ({
        id: `st_${i}`,
        firstSeenAt: "2026-11-13T09:00:00+08:00",
        topic: i % 2 ? "tech-ai" : "world",
        entities: [],
      })),
    });
    const a = payload.counts.attributed;
    assert.equal(a.entity + a.topic + a.market + a.pending + a.unmapped, payload.counts.stories);
  });
});

test("attribution — explicit, weak by design, and counted when absent", async (t) => {
  const themeBoards = new Map([
    ["ai", { code: "BK0800", name: "人工智能" }],
    ["ai-compute", { code: "BK1134", name: "算力" }],
    ["oil", { code: "BK0437", name: "油气开采" }],
  ]);
  const ctx = { themeBoards, tapeStarted: true, hasIndex: () => true };

  await t.test("an entity link wins and records which entity selected the board", () => {
    const a = attributeStory(
      { id: "s", firstSeenAt: "2026-11-16T09:00:00+08:00", firstEdition: "e", topic: "tech-ai", entities: ["nvidia"] },
      ctx,
    );
    assert.equal(a.attribution, "entity");
    assert.equal(a.target, "board:BK1134");
    assert.equal(a.entity, "nvidia");
    assert.match(a.attributionReason, /nvidia/);
  });

  await t.test("a topic link is labelled differently from an entity link", () => {
    const a = attributeStory(
      { id: "s", firstSeenAt: "2026-11-16T09:00:00+08:00", firstEdition: "e", topic: "tech-ai", entities: [] },
      ctx,
    );
    assert.equal(a.attribution, "topic");
    assert.equal(a.entity, null);
    assert.equal(a.target, "board:BK0800");
  });

  await t.test("an unmappable story falls back to the index, explicitly labelled", () => {
    const a = attributeStory(
      { id: "s", firstSeenAt: "2026-11-16T09:00:00+08:00", firstEdition: "e", topic: "policy", entities: [] },
      ctx,
    );
    assert.equal(a.attribution, "market");
    assert.equal(a.target, `index:${MARKET_INDEX_CODE}`);
    assert.match(a.attributionReason, /did the tape move/);
  });

  await t.test("nothing measurable is null, and it is counted not dropped", () => {
    const a = attributeStory(
      { id: "s", firstSeenAt: "2026-11-16T09:00:00+08:00", firstEdition: "e", topic: "policy", entities: [] },
      { themeBoards, tapeStarted: true, hasIndex: () => false },
    );
    assert.equal(a.attribution, null);
    assert.equal(a.target, null);
  });

  await t.test("an entity whose theme the tape never quoted does not silently map", () => {
    // `tesla` → `ev`, which this tape did not quote. Must not fall through to
    // the AI board just because the topic is tech-ai.
    const a = attributeStory(
      { id: "s", firstSeenAt: "2026-11-16T09:00:00+08:00", firstEdition: "e", topic: "global-markets", entities: ["tesla"] },
      ctx,
    );
    assert.notEqual(a.target, "board:BK0800");
    assert.equal(a.attribution, "market");
  });

  await t.test("a tape that has not started yields pending, never market", () => {
    // THE regression this state exists for: with no tape, `themeBoards` is empty
    // and the index was never quoted, so nothing could be attributed. Reporting
    // `market` here claimed "we decided these stories have no sector", when the
    // truth was "we could not check any of them yet".
    const cold = { themeBoards: new Map(), tapeStarted: false, hasIndex: () => false };
    for (const entities of [[], ["nvidia"], ["trump"]]) {
      const a = attributeStory(
        { id: "s", firstSeenAt: "2026-11-16T09:00:00+08:00", firstEdition: "e", topic: "tech-ai", entities },
        cold,
      );
      assert.equal(a.attribution, "pending", `entities=${entities.join(",")} must be pending`);
      assert.equal(a.target, null, "nothing can be a target before the tape exists");
      assert.equal(a.entity, null, "no target was selected, so no entity selected one");
      assert.equal(a.attributionPending, true);
      assert.match(a.attributionReason, /tape has not started/);
      assert.match(a.attributionReason, /not a market fallback/);
    }
  });

  await t.test("a pending attribution names the entity it could not resolve", () => {
    const a = attributeStory(
      { id: "s", firstSeenAt: "2026-11-16T09:00:00+08:00", firstEdition: "e", topic: "tech-ai", entities: ["nvidia"] },
      { themeBoards: new Map(), tapeStarted: false, hasIndex: () => false },
    );
    assert.equal(a.attribution, "pending");
    assert.match(a.attributionReason, /nvidia/);
  });

  await t.test("pending is distinct from unmapped", () => {
    // `null` means the tape ran and found nothing; "pending" means it never ran.
    const pending = attributeStory(
      { id: "s", firstSeenAt: "2026-11-16T09:00:00+08:00", firstEdition: "e", topic: "policy", entities: [] },
      { themeBoards: new Map(), tapeStarted: false, hasIndex: () => true },
    );
    const unmapped = attributeStory(
      { id: "s", firstSeenAt: "2026-11-16T09:00:00+08:00", firstEdition: "e", topic: "policy", entities: [] },
      { themeBoards: new Map(), tapeStarted: true, hasIndex: () => false },
    );
    assert.equal(pending.attribution, "pending");
    assert.equal(unmapped.attribution, null);
    assert.notEqual(pending.attribution, unmapped.attribution);
  });

  await t.test("market is reserved for a started tape that genuinely has no link", () => {
    // Same story, same context except `tapeStarted`: only the started tape is
    // allowed to conclude "market".
    const storyInput = { id: "s", firstSeenAt: "2026-11-16T09:00:00+08:00", firstEdition: "e", topic: "policy", entities: [] };
    const warm = attributeStory(storyInput, { themeBoards, tapeStarted: true, hasIndex: () => true });
    const cold = attributeStory(storyInput, { themeBoards, tapeStarted: false, hasIndex: () => true });
    assert.equal(warm.attribution, "market");
    assert.equal(cold.attribution, "pending");
  });

  await t.test("every declared link names a real entity and a real theme", () => {
    // Guards against a typo in the table shipping as a silently dead mapping.
    const { STORY_ENTITIES } = require("../topics/entities") as typeof import("../topics/entities");
    const { THEME_CATALOG } = require("../themes/catalog") as typeof import("../themes/catalog");
    const entityIds = new Set(STORY_ENTITIES.map((e: { id: string }) => e.id));
    const themeKeys = new Set(THEME_CATALOG.map((t: { key: string }) => t.key));
    for (const link of ENTITY_THEME_LINKS) {
      assert.ok(entityIds.has(link.entity), `${link.entity} is not a known entity id`);
      assert.ok(themeKeys.has(link.theme), `${link.theme} is not a known theme key`);
      assert.ok(link.reason.length > 10, `${link.entity} needs a real reason`);
    }
  });

  await t.test("a market-attributed story never enters a topic row", () => {
    // The index is not a sector. With one policy story (market fallback) and one
    // entity story, the policy topic must produce no row at all rather than a
    // row measuring 上证指数 — otherwise the tape's own direction would be
    // reported as a policy reaction.
    const boardsMap: Record<string, number> = {};
    for (let i = 0; i < 120; i++) boardsMap[`BK${String(i).padStart(4, "0")}`] = 1;
    const root = writeTape([
      { date: "2026-11-16", slots: ["09:35", "10:35"], boards: boardsMap, indices: { "000001": 3 } },
    ]);
    const store = loadTape(root);
    store.themeBoards.set("ai", { code: "BK0001", name: "人工智能" });
    const payload = buildReactions(store, {
      stories: [
        { id: "st_pol", firstSeenAt: "2026-11-16T09:00:00+08:00", topic: "policy", entities: [] },
        { id: "st_sem", firstSeenAt: "2026-11-16T09:00:00+08:00", topic: "tech-ai", entities: [] },
      ],
    });
    assert.equal(payload.counts.attributed.market, 1);
    assert.equal(payload.counts.stories, 2);
    assert.equal(
      payload.aggregates.byTopic.some((r) => r.key === "policy"),
      false,
      "a market-attributed story must not create a topic reaction row",
    );
  });

  await t.test("only entity-attributed samples carry an entity, so entity rows cannot mix", () => {
    const boards: Record<string, number> = { BK1134: 4, BK0800: 1 };
    for (let i = 0; i < 120; i++) boards[`BK${String(i).padStart(4, "0")}`] = 1;
    const root = writeTape([{ date: "2026-11-16", slots: ["09:35", "10:35"], boards }]);
    const store = loadTape(root);
    store.themeBoards.set("ai", { code: "BK0800", name: "人工智能" });
    store.themeBoards.set("ai-compute", { code: "BK1134", name: "算力" });
    const payload = buildReactions(store, {
      stories: [
        { id: "st_e", firstSeenAt: "2026-11-16T09:00:00+08:00", topic: "tech-ai", entities: ["nvidia"] },
        { id: "st_t", firstSeenAt: "2026-11-16T09:00:00+08:00", topic: "tech-ai", entities: [] },
      ],
    });
    assert.equal(payload.counts.attributed.entity, 1);
    assert.equal(payload.counts.attributed.topic, 1);
    // The topic-attributed story must not appear under any entity.
    for (const o of payload.observations) {
      if (o.attribution !== "entity") assert.equal(o.entity, null, `${o.id} leaked an entity`);
    }
    // Only one entity-attributed sample exists, so the entity row is
    // insufficient with n=1 — the topic sample did not join it.
    const row = payload.aggregates.byEntity.find((r) => r.key === "nvidia");
    assert.ok(row, "the entity row must exist");
    assert.equal(row?.horizons["1h"].n, 1);
    assert.equal(row?.horizons["1h"].status, "insufficient");
    // The topic row holds both sector-attributed samples, which is what makes
    // the two views different.
    const topicRow = payload.aggregates.byTopic.find((r) => r.key === "tech-ai");
    assert.equal(topicRow?.horizons["1h"].n, 2);
  });
});

/* ------------------------------------------------------------------ */
/* Market factor                                                       */
/* ------------------------------------------------------------------ */

test("market factor — industry-only, both-endpoint, same-segment", async (t) => {
  await t.test("a board missing at one endpoint does not enter the mean", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reactions-univ-"));
    const dir = path.join(root, "2026-11-16");
    fs.mkdirSync(dir, { recursive: true });
    const a = snapshotJson("2026-11-16", "09:35", {
      date: "2026-11-16",
      slots: ["09:35"],
      boards: { BK0001: 1, BK0002: 1 },
    });
    const b = snapshotJson("2026-11-16", "10:35", {
      date: "2026-11-16",
      slots: ["10:35"],
      boards: { BK0001: 5 },
    });
    fs.writeFileSync(path.join(dir, "0935.json"), JSON.stringify(a));
    fs.writeFileSync(path.join(dir, "1035.json"), JSON.stringify(b));
    const store = loadTape(root);
    const series = buildSeries(store);
    const entry = { ms: Date.parse(store.points[0].asOf), date: "2026-11-16" };
    const exit = { ms: Date.parse(store.points[1].asOf), date: "2026-11-16" };
    const m = marketMeanPct(series, entry, exit);
    assert.equal(m.universe, 1, "only BK0001 was quoted at both endpoints");
    // Entry reads +1% and exit +5%, both day-relative: 1.05/1.01 - 1 = 3.96%.
    assert.ok(Math.abs((m.meanPct as number) - 3.960396039603964) < 1e-9, `mean was ${m.meanPct}`);
  });
});

/* ------------------------------------------------------------------ */
/* Payload honesty                                                     */
/* ------------------------------------------------------------------ */

test("payload — self-describing on day one, with zero tape history", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reactions-dayone-"));
  const store = loadTape(path.join(root, "nothing-here"));
  const payload = buildReactions(store, {
    stories: [
      { id: "st_a", firstSeenAt: "2026-11-13T09:00:00+08:00", topic: "tech-ai", entities: ["nvidia"] },
      { id: "st_b", firstSeenAt: "2026-11-13T09:10:00+08:00", topic: "world", entities: [] },
    ],
    maxStories: 2000,
    retentionDays: 30,
    timezone: TZ,
  });

  await t.test("every horizon is pending and every aggregate is insufficient", () => {
    for (const h of ["1h", "1d", "5d"] as const) {
      assert.equal(payload.counts.horizons[h].pending, 2);
      assert.equal(payload.counts.horizons[h].ok, 0);
    }
    for (const row of [...payload.aggregates.byTopic, ...payload.aggregates.byEntity]) {
      for (const h of ["1h", "1d", "5d"] as const) {
        assert.equal(row.horizons[h].status, "insufficient");
        assert.equal(row.horizons[h].mean, undefined);
      }
    }
  });

  await t.test("the file explains its own method and says which number is the headline", () => {
    assert.equal(payload.headlineMetric, "marketExcessPct");
    assert.ok(payload.headlineReason.length > 50);
    assert.equal(payload.method.minSample, MIN_SAMPLE);
    assert.ok(Array.isArray(payload.method.horizons));
    assert.match(String(payload.method.changePct), /chained|previous close/);
  });

  await t.test("it is honest about the ledger cap binding", () => {
    assert.equal(payload.ledger.capBinding, false, "2 stories against a 2,000 cap is not binding");
    assert.equal(payload.ledger.maxStories, 2000);
    assert.equal(payload.ledger.withFirstSeen, 2);
  });

  await t.test("a retention window shorter than the longest horizon is a named gap", () => {
    // With retentionDays=3 the +5d horizon can never reach MIN_SAMPLE no matter
    // how much tape accumulates — that is a different problem from "no samples
    // yet" and has to be visible as such.
    const shortStore = loadTape(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rc3-")), "none"));
    const short = buildReactions(shortStore, {
      stories: [{ id: "a", firstSeenAt: "2026-11-13T09:00:00+08:00", topic: "world", entities: [] }],
      retentionDays: 3,
    });
    const gap = short.gaps.find((g) => g.kind === "retention-shorter-than-horizon");
    assert.ok(gap, "missing retention gap");
    assert.match(gap?.detail ?? "", /5d/);

    // 30 days covers +5d, so no such gap.
    const roomy = buildReactions(shortStore, {
      stories: [{ id: "a", firstSeenAt: "2026-11-13T09:00:00+08:00", topic: "world", entities: [] }],
      retentionDays: 30,
    });
    assert.equal(
      roomy.gaps.some((g) => g.kind === "retention-shorter-than-horizon"),
      false,
    );
  });
});

test("payload — the cap-binding flag reflects the ledger, not the sample", () => {
  const store = loadTape(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rc-")), "none"));
  const full = buildReactions(store, {
    stories: [{ id: "a", firstSeenAt: "2026-11-13T09:00:00+08:00", topic: "world", entities: [] }],
    maxStories: 1,
  });
  assert.equal(full.ledger.capBinding, true);
  const roomy = buildReactions(store, {
    stories: [{ id: "a", firstSeenAt: "2026-11-13T09:00:00+08:00", topic: "world", entities: [] }],
    maxStories: 2000,
  });
  assert.equal(roomy.ledger.capBinding, false);
});
