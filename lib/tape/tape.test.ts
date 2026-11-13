/**
 * Point-in-time tape — the guarantees that make it worth publishing.
 *
 * Four properties, in the order they matter:
 *
 *  1. every record carries BOTH clocks (`asOf` the market time the value
 *     describes, `observedAt` when we fetched it), with an explicit offset, and
 *     `timestampSource` says honestly when `asOf` is just our fetch time;
 *  2. a second capture of the same slot writes `rev-1` and leaves the original
 *     bytes untouched — a store that rewrites history is worthless;
 *  3. the fund-flow path parses a `ulist.np/get` payload and returns null (not
 *     an exception) on an empty or malformed one, so the existing panel keeps
 *     its fail-open contract after the migration off `clist/get`;
 *  4. the slot list is exactly the ten session slots and weekends are excluded.
 *
 * Fixtures are inline `Response` stubs, matching the style of
 * `lib/invest/board-registry.test.ts`: the parse → capture path runs for real
 * over captured payload shapes, so a payload change fails here rather than
 * silently shipping an empty tape.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertTwoClocks,
  captureSections,
  isoWithOffset,
  type CaptureOptions,
} from "./index";
import {
  changedSections,
  readSnapshot,
  writeDayIndex,
  writeSnapshot,
  dayDir,
  listSnapshots,
  type TapeSnapshot,
} from "./store";
import { fetchFundFlows, fetchBoardFundFlow, parseFundFlowRows, latestQuoteStamp } from "../invest/flows";
import { parseLimitPool } from "./limit-pool";
import { TAPE_SLOTS, dueTapeSlot, isTradingWeekday } from "./schedule";
import { epochSecondsToIso, slotKey, tzOffsetMinutes } from "./time";

const TZ = "Asia/Shanghai";
/** 2026-11-13 14:05:30 Asia/Shanghai — inside the afternoon session. */
const NOW = new Date("2026-11-13T06:05:30Z");

const BOARD_ROWS = [
  { code: "BK0428", name: "电力", secid: "90.BK0428", type: 2 },
  { code: "BK0475", name: "银行Ⅱ", secid: "90.BK0475", type: 2 },
  { code: "BK0800", name: "人工智能", secid: "90.BK0800", type: 3 },
];

/** `ulist.np/get` payload with the quote stamp the tape reads as `asOf`. */
const QUOTE_PAYLOAD = {
  rc: 0,
  data: {
    total: 3,
    diff: [
      { f3: -0.92, f12: "BK0428", f14: "电力", f104: 30, f105: 82, f124: 1794549570 },
      { f3: 1.43, f12: "BK0475", f14: "银行Ⅱ", f104: 21, f105: 22, f124: 1794549570 },
      { f3: -1.78, f12: "BK0800", f14: "人工智能", f104: 123, f105: 624, f124: 1794549570 },
    ],
  },
};

const FLOW_PAYLOAD = {
  rc: 0,
  data: {
    total: 2,
    diff: [
      { f3: 1.43, f12: "BK0475", f14: "银行Ⅱ", f62: 1225672704, f124: 1794549570 },
      { f3: -6.31, f12: "BK0459", f14: "元件", f62: -10423840256, f124: 1794549570 },
    ],
  },
};

const INDEX_PAYLOAD = {
  rc: 0,
  data: { f57: "000001", f58: "上证指数", f43: 363435, f170: -59, f86: 1794549840 },
};

const LIMIT_PAYLOAD = {
  rc: 0,
  data: {
    tc: 37,
    qdate: 20261113,
    pool: [{ c: "001358", n: "兴欣新材", zdp: 9.99, lbc: 2, hybk: "化学制品" }],
  },
};

/**
 * A stubbed upstream that answers by URL shape. Everything the capture path
 * touches is routed here so no test reaches the network.
 */
function stubFetch(overrides: { quote?: unknown; flow?: unknown; fail?: boolean } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (overrides.fail) throw new Error("ETIMEDOUT");
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (url.includes("reportName=RPT_EM_BOARD")) {
      return json({
        result: {
          pages: 1,
          data: BOARD_ROWS.map((b) => ({
            NEW_BOARD_CODE: b.code,
            BOARD_NAME: b.name,
            BOARD_TYPE_NEW: String(b.type),
            IS_VALID: "1",
          })),
        },
      });
    }
    if (url.includes("qt/ulist.np/get")) {
      // One endpoint serves both the board quotes and the fund flow; the
      // requested fields are what distinguishes them.
      if (url.includes("f62")) return json(overrides.flow ?? FLOW_PAYLOAD);
      return json(overrides.quote ?? QUOTE_PAYLOAD);
    }
    if (url.includes("qt/stock/get")) return json(INDEX_PAYLOAD);
    if (url.includes("push2ex.eastmoney.com")) return json(LIMIT_PAYLOAD);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function captureOptions(over: Partial<CaptureOptions> = {}): CaptureOptions {
  return {
    date: "2026-11-13",
    slot: "14:05",
    now: NOW,
    timezone: TZ,
    fetchImpl: stubFetch(),
    sleepImpl: () => Promise.resolve(),
    resolved: { boards: BOARD_ROWS as never, registry: "live" },
    themes: [
      { key: "ai", name: "人工智能", aliases: ["人工智能"], boardHints: ["人工智能"] },
      { key: "bank", name: "银行", aliases: ["银行"], boardHints: ["银行"] },
      { key: "coal", name: "煤炭", aliases: ["煤炭"], boardHints: ["煤炭"] },
    ],
    ...over,
  };
}

async function snapshotFixture(over: Partial<CaptureOptions> = {}): Promise<TapeSnapshot> {
  const options = captureOptions(over);
  const { sections, observedAt } = await captureSections(options);
  return {
    schemaVersion: 1,
    date: options.date,
    slot: options.slot,
    slotKey: "",
    revision: 0,
    observedAt,
    timezone: TZ,
    registry: "live",
    ...sections,
  };
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tape-test-"));
}

/* ------------------------------------------------------------------ */
/* (a) round-trip + two clocks                                         */
/* ------------------------------------------------------------------ */

test("tape snapshot — every record round-trips with both clocks", async (t) => {
  const snap = await snapshotFixture();

  await t.test("the snapshot survives a JSON round-trip byte-identically", () => {
    const parsed = JSON.parse(JSON.stringify(snap)) as TapeSnapshot;
    assert.deepEqual(parsed, snap);
  });

  await t.test("every section and every record carries asOf + observedAt with an offset", () => {
    const violations = assertTwoClocks(snap as unknown as Record<string, unknown>);
    assert.deepEqual(violations, [], JSON.stringify(violations, null, 2));
  });

  await t.test("observedAt is the fetch instant in the market's own offset", () => {
    // 06:05:30Z is 14:05:30 in Asia/Shanghai.
    assert.equal(snap.observedAt, "2026-11-13T14:05:30+08:00");
    for (const name of ["indices", "industries", "themes", "fundFlows", "limitPool"]) {
      const section = snap[name as keyof TapeSnapshot] as { observedAt: string };
      assert.equal(section.observedAt, snap.observedAt, `${name} must share the capture instant`);
    }
  });

  await t.test("asOf comes from the upstream payload where the payload has one", () => {
    // f124 = 1794549570 → 2026-11-13T13:59:30+08:00 (board quotes)
    assert.equal(snap.industries.timestampSource, "upstream");
    assert.equal(snap.industries.asOf, epochSecondsToIso(1794549570, TZ));
    assert.equal(snap.industries.asOf, "2026-11-13T13:59:30+08:00");
    assert.ok(
      snap.industries.records.every((r) => r.asOf === snap.industries.asOf),
      "every board row must carry the batch's market clock",
    );

    assert.equal(snap.fundFlows.timestampSource, "upstream");
    assert.equal(snap.fundFlows.asOf, "2026-11-13T13:59:30+08:00");

    // f86 = 1794549840 → 14:04:00+08:00 (index quotes)
    assert.equal(snap.indices.timestampSource, "upstream");
    assert.equal(snap.indices.asOf, epochSecondsToIso(1794549840, TZ));
    assert.equal(snap.indices.asOf, "2026-11-13T14:04:00+08:00");
  });

  await t.test("a section with no upstream stamp says so instead of pretending", () => {
    // push2ex carries a trade DATE, not an instant, so the limit pool must
    // report the fetch clock and label it "fetch".
    assert.equal(snap.limitPool.timestampSource, "fetch");
    assert.equal(snap.limitPool.asOf, snap.observedAt);
    assert.ok(snap.limitPool.records.every((r) => r.timestampSource === "fetch"));
    assert.ok(snap.limitPool.records.every((r) => r.asOf === r.observedAt));
  });

  await t.test("theme rows carry a real change percent for concept boards", () => {
    // Regression: quoting only industry (type 2) boards left every theme with
    // changePct: null, because a theme resolves to a CONCEPT board
    // (人工智能 → 90.BK0800). Null there reads as "the theme did not move"
    // rather than "we never asked", and it survived every clock assertion.
    const ai = snap.themes.records.find((r) => r.key === "ai");
    assert.ok(ai, "the ai theme must be present");
    assert.equal(ai.boardCode, "BK0800");
    assert.equal(typeof ai.changePct, "number", "a resolved theme board must carry its quote");
    assert.equal(ai.changePct, -1.78);
  });

  await t.test("asOf and observedAt are allowed to differ, and do when upstream has one", () => {
    assert.notEqual(snap.industries.asOf, snap.industries.observedAt);
    assert.ok(
      Date.parse(snap.industries.asOf) < Date.parse(snap.industries.observedAt),
      "the market value being described must predate the fetch that observed it",
    );
  });

  await t.test("a record missing a clock is caught by the guard", () => {
    const broken = JSON.parse(JSON.stringify(snap)) as Record<string, unknown>;
    const industries = broken.industries as { records: Array<Record<string, unknown>> };
    delete industries.records[0].asOf;
    const violations = assertTwoClocks(broken);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].section, "industries");
    assert.equal(violations[0].record, 0);
    assert.equal(violations[0].field, "asOf");
  });

  await t.test("a naive UTC stamp (no offset) is rejected", () => {
    const broken = JSON.parse(JSON.stringify(snap)) as Record<string, unknown>;
    const industries = broken.industries as { records: Array<Record<string, unknown>> };
    industries.records[0].asOf = "2026-11-13T06:05:30Z";
    assert.equal(assertTwoClocks(broken).length, 1);
  });

  await t.test("a dead upstream degrades to an unavailable section, not a throw", async () => {
    const dead = await snapshotFixture({ fetchImpl: stubFetch({ fail: true }) });
    assert.equal(dead.indices.unavailable, true);
    assert.match(dead.indices.reason ?? "", /threw|no indices/);
    assert.deepEqual(dead.indices.records, []);
    // …and the section still has both clocks, so the gap itself is timestamped.
    assert.deepEqual(assertTwoClocks(dead as unknown as Record<string, unknown>), []);
  });
});

/* ------------------------------------------------------------------ */
/* (b) append-only                                                     */
/* ------------------------------------------------------------------ */

test("tape store — a second capture of the same slot never overwrites", async (t) => {
  const root = tmpRoot();
  const first = await snapshotFixture();
  const a = writeSnapshot(first, { root });

  await t.test("the first write lands on <HHMM>.json as revision 0", () => {
    assert.equal(a.slotKey, "1405");
    assert.equal(a.revision, 0);
    assert.equal(a.isRevision, false);
    assert.ok(fs.existsSync(path.join(root, "2026-11-13", "1405.json")));
  });

  const originalBytes = fs.readFileSync(a.file);

  await t.test("a re-capture writes rev-1 and leaves the original bytes untouched", async () => {
    // A second capture at a later instant, with one board moved.
    const second = await snapshotFixture({
      now: new Date("2026-11-13T06:07:00Z"),
      fetchImpl: stubFetch({
        quote: {
          ...QUOTE_PAYLOAD,
          data: {
            ...QUOTE_PAYLOAD.data,
            diff: QUOTE_PAYLOAD.data.diff.map((r) =>
              r.f12 === "BK0428" ? { ...r, f3: -1.31 } : r,
            ),
          },
        },
      }),
    });
    const b = writeSnapshot(second, { root });

    assert.equal(b.slotKey, "1405.rev-1");
    assert.equal(b.revision, 1);
    assert.equal(b.isRevision, true);
    assert.equal(b.changed.includes("industries"), true, "a moved board must be reported as changed");
    assert.equal(b.changed.includes("indices"), false, "an unchanged section must not be reported");

    assert.deepEqual(
      fs.readFileSync(path.join(root, "2026-11-13", "1405.json")),
      originalBytes,
      "the original snapshot's bytes must be identical after a revision",
    );
    assert.ok(fs.existsSync(path.join(root, "2026-11-13", "1405.rev-1.json")));
  });

  await t.test("revisions.jsonl records what changed, append-only", () => {
    const log = fs
      .readFileSync(path.join(root, "2026-11-13", "revisions.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(log.length, 1);
    assert.equal(log[0].wrote, "1405.rev-1.json");
    assert.equal(log[0].base, "1405.json");
    assert.equal(log[0].revision, 1);
    assert.ok(Array.isArray(log[0].changed));
    assert.equal(log[0].observedAtFrom, first.observedAt);
    assert.notEqual(log[0].observedAtTo, first.observedAt);
  });

  await t.test("a third capture takes rev-2 and the log grows to two lines", async () => {
    const third = await snapshotFixture({ now: new Date("2026-11-13T06:09:00Z") });
    const c = writeSnapshot(third, { root });
    assert.equal(c.slotKey, "1405.rev-2");
    const lines = fs
      .readFileSync(path.join(root, "2026-11-13", "revisions.jsonl"), "utf8")
      .trim()
      .split("\n");
    assert.equal(lines.length, 2);
  });

  await t.test("index.json lists every file, base before its revisions", () => {
    const index = JSON.parse(
      fs.readFileSync(path.join(root, "2026-11-13", "index.json"), "utf8"),
    ) as { snapshots: Array<{ slot: string; revision: number }>; expectedSlots: string[] };
    assert.deepEqual(
      index.snapshots.map((s) => `${s.slot}:${s.revision}`),
      ["1405:0", "1405.rev-1:1", "1405.rev-2:2"],
    );
    assert.deepEqual(index.expectedSlots, [...TAPE_SLOTS]);
  });

  await t.test("a different slot is a first capture again", async () => {
    const other = await snapshotFixture({ slot: "14:35", now: new Date("2026-11-13T06:35:00Z") });
    const d = writeSnapshot(other, { root });
    assert.equal(d.isRevision, false);
    assert.equal(d.revision, 0);
    assert.equal(d.slotKey, "1435");
  });

  await t.test("two captures of an unchanged tape report no changed sections", async () => {
    // Same fixtures, same numbers, new clock: the file must still be a new
    // revision (it may not overwrite), but nothing moved.
    const root2 = tmpRoot();
    writeSnapshot(await snapshotFixture(), { root: root2 });
    const again = await snapshotFixture({ now: new Date("2026-11-13T06:08:00Z") });
    const r = writeSnapshot(again, { root: root2 });
    assert.deepEqual(r.changed, [], "an unchanged capture must not claim a section changed");
  });

  await t.test("changedSections compares records, not clocks", async () => {
    const a = await snapshotFixture();
    const b = JSON.parse(JSON.stringify(a)) as TapeSnapshot;
    b.observedAt = "2026-11-13T15:00:00+08:00";
    assert.deepEqual(changedSections(a, b), []);
    b.industries.records[0].changePct = 99;
    assert.deepEqual(changedSections(a, b), ["industries"]);
  });
});

/* ------------------------------------------------------------------ */
/* (c) fund flow on ulist.np                                            */
/* ------------------------------------------------------------------ */

test("fund flow — migrated to ulist.np/get with the panel's fail-open contract", async (t) => {
  await t.test("a ulist.np/get payload parses into ranked sector rows", () => {
    const rows = parseFundFlowRows(FLOW_PAYLOAD);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.name), ["银行Ⅱ", "元件"]);
    assert.equal(rows[0].netInflowYi, 12.25672704);
    assert.ok(rows[1].netInflowYi < 0);
  });

  await t.test("the upstream quote stamp is read, placeholders rejected", () => {
    assert.equal(latestQuoteStamp(FLOW_PAYLOAD), 1794549570);
    assert.equal(latestQuoteStamp({ data: { diff: [{ f124: 0 }, { f124: "-" }] } }), null);
    assert.equal(latestQuoteStamp(null), null);
    assert.equal(latestQuoteStamp("garbage"), null);
  });

  await t.test("a row without f62 is dropped, never read as flat", () => {
    const rows = parseFundFlowRows({
      data: { diff: [{ f12: "BK0001", f14: "无数据", f3: 1 }, { f12: "BK0002", f14: "有数据", f3: 2, f62: 1e8 }] },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "有数据");
  });

  await t.test("an empty payload is null, not an exception", async () => {
    const empty = stubFetch({ flow: { rc: 0, data: { total: 0, diff: [] } } });
    const out = await fetchFundFlows({
      boards: BOARD_ROWS as never,
      fetchImpl: empty,
      sleepImpl: () => Promise.resolve(),
    });
    assert.equal(out, null);
  });

  await t.test("a malformed payload is null, not an exception", async () => {
    for (const body of ["not json", null, { data: null }, { data: { diff: "nope" } }, {}]) {
      const broken = (async () =>
        typeof body === "string"
          ? new Response(body, { status: 200 })
          : new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
      const out = await fetchFundFlows({
        boards: BOARD_ROWS as never,
        fetchImpl: broken,
        sleepImpl: () => Promise.resolve(),
      });
      assert.equal(out, null, `expected null for ${JSON.stringify(body)}`);
    }
  });

  await t.test("a throwing fetch is null, not an exception", async () => {
    const out = await fetchFundFlows({
      boards: BOARD_ROWS as never,
      fetchImpl: stubFetch({ fail: true }),
      sleepImpl: () => Promise.resolve(),
    });
    assert.equal(out, null);
  });

  await t.test("the request uses ulist.np/get with explicit board secids, never clist/get", async () => {
    const asked: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      return new Response(JSON.stringify(FLOW_PAYLOAD), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await fetchFundFlows({
      boards: BOARD_ROWS as never,
      fetchImpl: impl,
      sleepImpl: () => Promise.resolve(),
    });

    assert.ok(asked.length > 0);
    for (const url of asked) {
      assert.match(url, /\/api\/qt\/ulist\.np\/get\?/, `must use ulist.np: ${url}`);
      assert.equal(url.includes("clist/get"), false, `must not use clist/get: ${url}`);
      assert.match(url, /secids=90\.BK/, "must pass explicit board secids");
      assert.match(url, /f62/, "must request the net-inflow field");
    }
  });

  await t.test("the published panel keeps its exact shape", async () => {
    const out = await fetchFundFlows({
      boards: BOARD_ROWS as never,
      fetchImpl: stubFetch(),
      sleepImpl: () => Promise.resolve(),
    });
    assert.ok(out);
    assert.equal(typeof out.fetchedAt, "string");
    assert.equal(typeof out.note, "string");
    assert.match(out.note, /非官方/);
    assert.equal(out.timestampSource, "upstream");
    for (const s of out.sectors) {
      assert.equal(typeof s.name, "string");
      assert.equal(typeof s.changePct, "number");
      assert.equal(typeof s.netInflowYi, "number");
    }
  });

  await t.test("industry rows are preferred over concept rows", async () => {
    const result = await fetchBoardFundFlow(BOARD_ROWS as never, {
      fetchImpl: stubFetch(),
      sleepImpl: () => Promise.resolve(),
    });
    assert.equal(result?.boardType, 2, "industry boards (type 2) first");
  });
});

/* ------------------------------------------------------------------ */
/* (d) schedule                                                        */
/* ------------------------------------------------------------------ */

test("tape schedule — exactly the ten session slots, weekdays only", async (t) => {
  await t.test("the slot list is the ten documented session captures", () => {
    assert.deepEqual(TAPE_SLOTS, [
      "09:35",
      "10:05",
      "10:35",
      "11:05",
      "11:35",
      "13:05",
      "13:35",
      "14:05",
      "14:35",
      "15:05",
    ]);
    assert.equal(TAPE_SLOTS.length, 10);
  });

  await t.test("no slot falls in the lunch break or outside the session", () => {
    for (const slot of TAPE_SLOTS) {
      const [h, m] = slot.split(":").map(Number);
      const mins = h * 60 + m;
      const inMorning = mins > 9 * 60 + 30 && mins <= 11 * 60 + 35;
      const inAfternoon = mins > 13 * 60 && mins <= 15 * 60 + 5;
      assert.ok(inMorning || inAfternoon, `${slot} is outside both sessions`);
    }
  });

  await t.test("weekends are excluded and weekdays are not", () => {
    assert.equal(isTradingWeekday("2026-11-13"), true, "Friday");
    assert.equal(isTradingWeekday("2026-11-14"), false, "Saturday");
    assert.equal(isTradingWeekday("2026-11-15"), false, "Sunday");
    assert.equal(isTradingWeekday("2026-11-16"), true, "Monday");
  });

  await t.test("a slot is due inside its grace window and not outside it", () => {
    // 09:35 exactly.
    assert.equal(dueTapeSlot({ date: "2026-11-13", hour: 9, minute: 35, dow: 5 }, 20), "09:35");
    // 09:52 is inside 09:35 + 20min — a dropped trigger still captures.
    assert.equal(dueTapeSlot({ date: "2026-11-13", hour: 9, minute: 52, dow: 5 }, 20), "09:35");
    // 09:57 is past the grace: capture it as a gap, never as a late 09:35.
    assert.equal(dueTapeSlot({ date: "2026-11-13", hour: 9, minute: 57, dow: 5 }, 20), null);
    // 09:20 is before the first slot.
    assert.equal(dueTapeSlot({ date: "2026-11-13", hour: 9, minute: 20, dow: 5 }, 20), null);
    // Lunch break.
    assert.equal(dueTapeSlot({ date: "2026-11-13", hour: 12, minute: 0, dow: 5 }, 20), null);
  });

  await t.test("no slot fires on a weekend", () => {
    for (const slot of TAPE_SLOTS) {
      const [hour, minute] = slot.split(":").map(Number);
      assert.equal(dueTapeSlot({ date: "2026-11-14", hour, minute, dow: 6 }, 20), null);
    }
  });

  await t.test("the day expects at most ten captures, never 24 hours of them", () => {
    // 24x7 would be ~48; the session schedule must stay at ten.
    assert.ok(TAPE_SLOTS.length <= 10);
  });

  await t.test("slotKey and the timezone offset help are exact", () => {
    assert.equal(slotKey("09:35"), "0935");
    assert.throws(() => slotKey("935"));
    assert.equal(tzOffsetMinutes(new Date("2026-11-13T06:00:00Z"), TZ), 480);
    assert.equal(isoWithOffset(new Date("2026-11-13T06:05:30Z"), TZ), "2026-11-13T14:05:30+08:00");
  });
});

/* ------------------------------------------------------------------ */
/* extras: limit pool, store helpers                                   */
/* ------------------------------------------------------------------ */

test("limit pool — parses push2ex and reports its own unavailability", async (t) => {
  await t.test("a pool payload yields coded, named rows with the board count", () => {
    const parsed = parseLimitPool(LIMIT_PAYLOAD);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].code, "001358");
    assert.equal(parsed.rows[0].boards, 2);
    assert.equal(parsed.rows[0].industry, "化学制品");
    assert.equal(parsed.total, 37);
    assert.equal(parsed.tradeDate, "2026-11-13");
  });

  await t.test("an empty pool is an empty list, not an error", () => {
    assert.deepEqual(parseLimitPool({ data: { tc: 0, pool: [] } }).rows, []);
    assert.deepEqual(parseLimitPool(null).rows, []);
  });
});

test("tape store — index and listing helpers", async (t) => {
  const root = tmpRoot();

  await t.test("an empty day has no snapshots and lists nothing", () => {
    assert.deepEqual(listSnapshots(path.join(root, "2026-11-13")), []);
  });

  await t.test("writeDayIndex over an empty directory still emits expectedSlots", () => {
    const dir = dayDir(root, "2026-11-13");
    fs.mkdirSync(dir, { recursive: true });
    const index = writeDayIndex(dir, "2026-11-13", TZ);
    assert.deepEqual(index.snapshots, []);
    assert.equal(index.expectedSlots.length, 10);
    assert.match(index.updatedAt, /\+08:00$/);
  });

  await t.test("readSnapshot tolerates a missing or corrupt file", () => {
    assert.equal(readSnapshot(path.join(root, "nope.json")), null);
    const bad = path.join(root, "bad.json");
    fs.writeFileSync(bad, "{not json");
    assert.equal(readSnapshot(bad), null);
  });

  await t.test("an unavailable section is visible in the index's missing list", () => {
    const snap = {
      schemaVersion: 1,
      date: "2026-11-13",
      slot: "14:05",
      slotKey: "",
      revision: 0,
      observedAt: "2026-11-13T14:05:00+08:00",
      timezone: TZ,
      registry: "none" as const,
      indices: {
        asOf: "2026-11-13T14:05:00+08:00",
        observedAt: "2026-11-13T14:05:00+08:00",
        timestampSource: "fetch" as const,
        unavailable: true as const,
        reason: "no upstream",
        records: [],
      },
      industries: {
        asOf: "2026-11-13T14:05:00+08:00",
        observedAt: "2026-11-13T14:05:00+08:00",
        timestampSource: "fetch" as const,
        records: [],
      },
      themes: {
        asOf: "2026-11-13T14:05:00+08:00",
        observedAt: "2026-11-13T14:05:00+08:00",
        timestampSource: "fetch" as const,
        records: [],
      },
      fundFlows: {
        asOf: "2026-11-13T14:05:00+08:00",
        observedAt: "2026-11-13T14:05:00+08:00",
        timestampSource: "fetch" as const,
        records: [],
      },
      limitPool: {
        asOf: "2026-11-13T14:05:00+08:00",
        observedAt: "2026-11-13T14:05:00+08:00",
        timestampSource: "fetch" as const,
        records: [],
      },
    } as unknown as TapeSnapshot;
    writeSnapshot(snap, { root });
    const index = JSON.parse(
      fs.readFileSync(path.join(dayDir(root, "2026-11-13"), "index.json"), "utf8"),
    ) as { snapshots: Array<{ missing: string[] }> };
    assert.deepEqual(index.snapshots[0].missing, ["indices"]);
  });
});
