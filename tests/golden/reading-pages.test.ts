/**
 * GOLDEN: the two reading pages (`/hour.html`, `/stories.html`).
 *
 * These pages carry the project's point-in-time claim in prose, so the
 * assertions are on *sentences*, not on layout:
 *
 *   - every figure in a sentence must be traceable to a fixture field, so the
 *     expected text is written out in full — a change that silently rewords or
 *     recomputes a number fails here;
 *   - both clocks must be visible, and a material divergence must be called out;
 *   - a section that came back `unavailable` must render as a named gap and must
 *     NOT produce a sentence that reads like "nothing moved";
 *   - an empty store must say what it is waiting for, not look broken;
 *   - the first-mover column must exist and must state that leads are observed
 *     granularity rather than reaction latency.
 *
 * Fixtures are built as real `TapeSnapshot` / `StoriesPayload` objects rather
 * than raw JSON strings, so a schema change fails at the type level first.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { renderHourPage } from "../../lib/output/hour-page";
import { renderStoriesPage } from "../../lib/output/stories-page";
import {
  MAX_LABEL_LAG_MINUTES,
  MOVE_THRESHOLDS,
  buildSlotReading,
  classifySlot,
  dayHasTape,
  readTapeDays,
  type SlotReading,
  type TapeDayView,
} from "../../lib/tape/reading";
import type { TapeSnapshot } from "../../lib/tape/store";
import type { StoriesPayload, StoryRecord } from "../../lib/stories/ledger";
import { TAPE_SLOTS } from "../../lib/tape/schedule";
import { isoWithOffset } from "../../lib/stories/time";

const TZ = "Asia/Shanghai";
/** 2026-11-16 13:05 Asia/Shanghai — the first real Monday session. */
const CAPTURE = new Date("2026-11-16T05:05:12Z");

function clock(at: Date): string {
  return isoWithOffset(at, TZ);
}

function section<T>(
  records: T[],
  observedAt: string,
  asOf: string,
  extra: Record<string, unknown> = {},
): {
  asOf: string;
  observedAt: string;
  timestampSource: "upstream" | "fetch";
  records: T[];
} & Record<string, unknown> {
  return {
    asOf,
    observedAt,
    timestampSource: "upstream",
    records,
    ...extra,
  };
}

/**
 * One complete snapshot: 10 boards so breadth arithmetic is checkable by hand —
 * 3 advancing, 6 declining, 1 flat — one index trio, 3 themes (1 unquoted), 2
 * fund-flow rows, and a limit pool with counts in `meta`.
 */
function snapshot(over: Partial<TapeSnapshot> = {}): TapeSnapshot {
  const observedAt = clock(CAPTURE);
  // Quotes struck 43 seconds before we looked: small, intentional drift.
  const asOf = clock(new Date(CAPTURE.getTime() - 43_000));
  // Deliberately far behind, to prove the drift callout can fire.
  const stale = clock(new Date(CAPTURE.getTime() - 11 * 3_600_000));

  const base = {
    schemaVersion: 1,
    date: "2026-11-16",
    slot: "13:05",
    slotKey: "1305",
    revision: 0,
    observedAt,
    timezone: TZ,
    registry: "live" as const,
    indices: section(
      [
        { code: "000001", name: "上证指数", price: 3512.44, changePct: 0.62, asOf, observedAt, timestampSource: "upstream" },
        { code: "399001", name: "深证成指", price: 10688.1, changePct: 1.34, asOf, observedAt, timestampSource: "upstream" },
        { code: "399006", name: "创业板指", price: 2301.77, changePct: 2.41, asOf, observedAt, timestampSource: "upstream" },
      ],
      observedAt,
      asOf,
      { meta: { note: "fixture" } },
    ),
    industries: section(
      [
        { code: "BK0475", name: "银行Ⅱ", secid: "90.BK0475", changePct: 1.42, up: 30, down: 12, asOf, observedAt, timestampSource: "upstream" },
        { code: "BK0428", name: "电力", secid: "90.BK0428", changePct: 0.31, up: 20, down: 18, asOf, observedAt, timestampSource: "upstream" },
        { code: "BK0800", name: "人工智能", secid: "90.BK0800", changePct: 2.68, up: 90, down: 40, asOf, observedAt, timestampSource: "upstream" },
        { code: "BK1036", name: "半导体", secid: "90.BK1036", changePct: -2.11, up: 14, down: 173, asOf, observedAt, timestampSource: "upstream" },
        { code: "BK0459", name: "元件", secid: "90.BK0459", changePct: -1.02, up: 10, down: 40, asOf, observedAt, timestampSource: "upstream" },
        { code: "BK1015", name: "能源金属", secid: "90.BK1015", changePct: -3.44, up: 0, down: 12, asOf, observedAt, timestampSource: "upstream" },
        { code: "BK1016", name: "汽车服务", secid: "90.BK1016", changePct: -0.77, up: 2, down: 8, asOf, observedAt, timestampSource: "upstream" },
        { code: "BK0537", name: "光伏设备", secid: "90.BK0537", changePct: -5.63, up: 1, down: 66, asOf, observedAt, timestampSource: "upstream" },
        { code: "BK0727", name: "医疗服务", secid: "90.BK0727", changePct: -1.9, up: 3, down: 41, asOf, observedAt, timestampSource: "upstream" },
        { code: "BK1027", name: "煤炭", secid: "90.BK1027", changePct: 0, up: 16, down: 16, asOf, observedAt, timestampSource: "upstream" },
      ],
      observedAt,
      asOf,
      { meta: { registryBoards: 10, quoted: 10 } },
    ),
    themes: section(
      [
        { key: "ai", name: "人工智能", boardCode: "BK0800", boardName: "人工智能", changePct: 2.68, up: 90, down: 40, asOf, observedAt, timestampSource: "upstream" },
        { key: "bank", name: "银行", boardCode: "BK0475", boardName: "银行Ⅱ", changePct: 1.42, up: 30, down: 12, asOf, observedAt, timestampSource: "upstream" },
        // Not quoted: a resolver miss must read as "no quote", never as "flat".
        { key: "pvb", name: "光伏", boardCode: null, boardName: null, changePct: null, up: null, down: null, asOf, observedAt, timestampSource: "upstream" },
      ],
      observedAt,
      asOf,
      { meta: { themes: 3, resolved: 2, quoted: 2 } },
    ),
    fundFlows: section(
      [
        { name: "银行", changePct: 1.42, netInflowYi: 12.26, asOf, observedAt, timestampSource: "upstream" },
        { name: "光伏设备", changePct: -5.63, netInflowYi: -31.42, asOf, observedAt, timestampSource: "upstream" },
      ],
      observedAt,
      asOf,
      { meta: { boardType: 2 } },
    ),
    // No upstream stamp on this pool — the tape's own `timestampSource: "fetch"`
    // path, which must not be allowed to define the page's market clock.
    limitPool: {
      asOf: observedAt,
      observedAt,
      timestampSource: "fetch" as const,
      records: [
        { code: "001358", name: "兴欣新材", changePct: 9.99, boards: 2, industry: "化学制品", asOf: observedAt, observedAt, timestampSource: "fetch" as const },
      ],
      meta: { upstream: "push2ex", tradeDate: "2026-11-16", limitUp: 44, limitDown: 7 },
    },
    ...over,
  } as unknown as TapeSnapshot;
  return base;
}

/** One unavailable section, for the "gap, not a zero" case. */
function snapshotWithGap(): TapeSnapshot {
  const s = snapshot();
  (s as unknown as Record<string, unknown>).themes = {
    asOf: s.observedAt,
    observedAt: s.observedAt,
    timestampSource: "fetch",
    unavailable: true,
    reason: "no board quote available for any theme",
    records: [],
  };
  return s;
}

function story(over: Partial<StoryRecord> = {}): StoryRecord {
  const first = clock(CAPTURE);
  const later = clock(new Date(CAPTURE.getTime() + 6 * 3_600_000));
  const base: StoryRecord = {
    id: "st_fixture01",
    cluster: "entity:pboc",
    title: "央行开展 5000 亿元 MLF 操作",
    url: "https://example.com/a1",
    firstSeenAt: first,
    firstEdition: "2026-11-16/13",
    firstSourceId: "caixin",
    publishedAt: null,
    publishLagMinutes: null,
    lastSeenAt: later,
    lastEdition: "2026-11-16/19",
    topic: "global-markets",
    lane: "zh",
    domestic: true,
    entities: ["pboc"],
    sources: ["caixin", "reuters-zh"],
    sightings: [
      {
        sourceId: "reuters-zh",
        observedAt: later,
        title: "央行开展 5000 亿元 MLF 操作，利率持平",
        url: "https://example.com/a1-2",
        edition: "2026-11-16/19",
      },
    ],
    headlineRevisions: [
      {
        at: later,
        sourceId: "reuters-zh",
        edition: "2026-11-16/19",
        url: "https://example.com/a1-2",
        from: "央行开展 5000 亿元 MLF 操作",
        to: "央行开展 5000 亿元 MLF 操作，利率持平",
      },
    ],
    firstMover: {
      sourceId: "caixin",
      observedAt: first,
      tied: false,
      coFirstSourceIds: ["caixin"],
      runnerUpSourceId: "reuters-zh",
      runnerUpObservedAt: later,
      leadMinutes: 360,
    },
    ...over,
  };
  return base;
}

function payload(): StoriesPayload {
  const stories = [story()];
  return {
    version: 1,
    timezone: TZ,
    retentionDays: 30,
    maxStories: 2000,
    updatedAt: clock(CAPTURE),
    stories,
    generatedAt: clock(CAPTURE),
    counts: {
      stories: 1,
      sightings: 1,
      multiSightingStories: 1,
      storiesWithRevisions: 1,
      skippedRecords: 0,
      editions: 2,
      articles: 12,
      duplicates: 0,
    },
    firstMover: {
      windowDays: 30,
      from: "2026-10-17",
      to: "2026-11-16",
      storiesInWindow: 1,
      soleFirstStories: 1,
      contestedStories: 1,
      tiedFirstStories: 0,
      leadBasis: "observed",
      wires: [
        {
          sourceId: "caixin",
          soleFirsts: 1,
          contestedFirsts: 1,
          coFirsts: 0,
          stories: 1,
          leadSamples: 1,
          medianLeadMinutes: 360,
        },
      ],
    },
    revisionTrail: {
      storiesWithRevisions: 1,
      totalRevisions: 1,
      items: [],
    },
  };
}

const NAMES = { caixin: "财新", "reuters-zh": "路透中文" };

function buildPages(over: { snapshot?: TapeSnapshot; payload?: StoriesPayload | null } = {}) {
  const snap = over.snapshot ?? snapshot();
  const reading: SlotReading = buildSlotReading(snap);
  const readings = new Map<string, SlotReading>([
    [`${snap.date}/${snap.slot}`, reading],
  ]);
  const day: TapeDayView = {
    date: snap.date,
    slots: TAPE_SLOTS.map((time) => ({
      time,
      snapshot: time === snap.slot ? snap : null,
      revision: 0,
      gap: time === snap.slot ? null : "missing",
    })),
    missing: TAPE_SLOTS.filter((t) => t !== snap.slot),
  };
  const hour = renderHourPage({
    days: [day],
    readings,
    timezone: TZ,
    expectedSlots: TAPE_SLOTS,
    empty: false,
  });
  const storiesHtml = renderStoriesPage({
    payload: over.payload === undefined ? payload() : over.payload,
    sourceNames: NAMES,
  });
  return { hour, storiesHtml, reading, snap };
}

test("golden: /hour.html leads with sentences, every figure traceable", async (t) => {
  const { hour, reading } = buildPages();

  await t.test("index sentence carries the real price and tone words", () => {
    assert.ok(
      hour.includes("上证指数收于 3512.44 点，明显上涨 +0.62%"),
      "index sentence must open with the price and a threshold-derived tone",
    );
    assert.ok(hour.includes("深证成指明显上涨 +1.34%"));
    assert.ok(hour.includes("创业板指涨势剧烈 +2.41%"));
  });

  await t.test("breadth sentence counts the fixture's 10 boards exactly", () => {
    // 3 up (1.42, 0.31, 2.68), 6 down, 1 flat — and a 30% advance share. The
    // breadth bands are ≥80% broad strength, ≥60% leaning stronger, ≤20% broad
    // weakness, ≤40% leaning weaker, so 30% reads 偏弱 — three boards in ten
    // advancing is a weaker tape and the sentence should say so.
    assert.ok(
      hour.includes("行业层面 10 个板块中 3 个上涨、6 个下跌、1 个基本走平，上涨家数占比 30%"),
      "breadth must be counted, not asserted",
    );
    assert.ok(hour.includes("——偏弱"), "30% advance share leans weaker");
    assert.equal(reading.breadth?.total, 10);
  });

  await t.test("extremes name the real best/worst board and the 2% tallies", () => {
    assert.ok(hour.includes("领涨的是人工智能（+2.68%）"));
    assert.ok(hour.includes("领跌的是光伏设备（-5.63%）"));
    // Above +2%: 人工智能 2.68. Below −2%: 半导体, 能源金属, 光伏设备 — 3, and
    // 医疗服务 at −1.9% is inside the band, so it is not counted.
    assert.ok(
      hour.includes("涨幅超过 2% 的板块 1 个，跌幅超过 2% 的 3 个"),
      "the 2% tallies must be counted off the fixture",
    );
  });

  await t.test("the severe tail is its own sentence, and only when non-zero", () => {
    assert.ok(hour.includes("其中涨逾 5% 的 0 个、跌逾 5% 的 1 个"));
  });

  await t.test("an unquoted theme is excluded, not counted as flat", () => {
    // 3 themes, 2 quoted, both advancing.
    assert.ok(hour.includes("3 个主题板块中 2 个拿到报价、2 个上涨"));
    assert.equal(reading.themes?.quoted, 2);
    assert.equal(reading.themes?.total, 3);
  });

  await t.test("fund flows and limit pool come from their own fields", () => {
    assert.ok(hour.includes("银行 净流入 +12.26 亿"));
    assert.ok(hour.includes("光伏设备 净流出 -31.42 亿"));
    assert.ok(hour.includes("全市场涨停 44 家、跌停 7 家"));
  });

  await t.test("no sentence invents a figure the snapshot does not hold", () => {
    for (const phantom of ["+99.99", "暴跌 99", "NaN", "undefined", "null%", "Infinity"]) {
      assert.ok(!hour.includes(phantom), `rendered page contains ${phantom}`);
    }
  });
});

test("golden: /hour.html shows both clocks and calls out the drift", async (t) => {
  const { hour } = buildPages();

  await t.test("the clock line names asOf and observedAt with their instants", () => {
    assert.ok(hour.includes("两个时钟：行情时间 asOf 2026-11-16 13:04:29 +08:00"));
    assert.ok(hour.includes("观察时间 observedAt 2026-11-16 13:05:12 +08:00"));
    assert.ok(hour.includes('data-asof="2026-11-16T13:04:29+08:00"'));
    assert.ok(hour.includes('data-observed-at="2026-11-16T13:05:12+08:00"'));
  });

  await t.test("a 43-second gap reads as agreement, not as a material difference", () => {
    assert.ok(hour.includes("两者基本重合"));
    assert.ok(!hour.includes("这一档的数字描述的是更早的市场状态"));
  });

  await t.test("a stale quote is called out in minutes", () => {
    // Every upstream-stamped section has to be stale for the headline clock to
    // move: the page reports the NEWEST market stamp it holds, which is the
    // honest choice when sections are fetched seconds apart. Making only one
    // section stale would (correctly) leave the headline clock alone.
    const staleAt = clock(new Date(CAPTURE.getTime() - 11 * 3_600_000));
    const stale = snapshot();
    const raw = stale as unknown as Record<string, Record<string, unknown>>;
    for (const name of ["indices", "industries", "themes", "fundFlows"]) {
      raw[name] = { ...raw[name], asOf: staleAt };
    }
    const { hour: staleHtml, reading } = buildPages({ snapshot: stale });
    assert.ok(reading.asOf.startsWith("2026-11-16T02:05"), `asOf=${reading.asOf}`);
    assert.ok(
      staleHtml.includes("两者相差 660 分钟——这一档的数字描述的是更早的市场状态"),
      "stale quotes must be disclosed, not smoothed",
    );
  });

  await t.test("the fetch-only limit pool cannot define the market clock", () => {
    // Its asOf == observedAt; if it won the max, asOf and observedAt would be
    // equal and the page would claim the market was fresh.
    const { reading } = buildPages();
    assert.notEqual(reading.asOf, reading.observedAt);
  });
});

test("golden: /hour.html renders named gaps, never an empty table", async (t) => {
  const { hour } = buildPages({ snapshot: snapshotWithGap() });

  await t.test("an unavailable section is a named gap with its reason", () => {
    assert.ok(hour.includes('data-gap-section="themes"'));
    assert.ok(hour.includes("缺：主题板块（no board quote available for any theme）"));
  });

  await t.test("the gap does not become a zero-valued sentence", () => {
    assert.ok(!hour.includes("24 个主题板块中 0 个拿到报价"));
    assert.ok(!hour.includes("0 个拿到报价、0 个上涨"));
  });

  await t.test("the missing slots of the day are named once, with a count", () => {
    assert.ok(hour.includes('data-gap="slot"'), "each empty slot panel carries its own gap block");
    assert.ok(hour.includes('data-missing-slots="9"'), "the day names how many slots are missing");
    assert.ok(hour.includes("这一天共 10 个盘面时点，缺 9 个：09:35 · 10:05"), "and which ones");
  });

  await t.test("the default slot is the newest one that has a capture", () => {
    // Landing on an empty 09:35 while 13:05 holds real prose would tell the
    // reader "nothing happened" about the only thing the page has.
    assert.ok(
      hour.includes('class="slot-panel active" data-slot-panel="13:05"'),
      "the captured slot must be the one shown by default",
    );
    assert.ok(!hour.includes('class="slot-chip chip has-data active" data-slot="09:35"'));
  });

  await t.test("every session slot has a nav chip, present or not", () => {
    for (const slot of TAPE_SLOTS) {
      assert.ok(hour.includes(`data-slot="${slot}"`), `missing slot chip ${slot}`);
    }
    assert.ok(hour.includes('class="slot-chip chip is-empty"') || hour.includes("chip is-empty"));
  });
});

test("golden: /hour.html empty state says what it is waiting for", async (t) => {
  const html = renderHourPage({
    days: [],
    readings: new Map(),
    timezone: TZ,
    expectedSlots: TAPE_SLOTS,
    empty: true,
  });

  await t.test("the page renders and names the first expected snapshot", () => {
    assert.ok(html.includes('data-empty-state="tape"'));
    assert.ok(html.includes("还没有盘中快照"));
    assert.ok(html.includes("2026-11-16"));
    assert.ok(html.includes("09:35"));
    assert.ok(html.includes("Asia/Shanghai"));
  });

  await t.test("it explains rather than looking broken", () => {
    assert.ok(html.includes("不是坏了，是在等开盘"));
    assert.ok(!html.includes('class="day-panel'), "no day panels when there is no tape");
    assert.ok(!html.includes('data-slot-reading='), "no slot readings when there is no tape");
  });

  await t.test("the yardsticks block still ships, so the reader knows the rules", () => {
    assert.ok(html.includes("口径"));
    assert.ok(html.includes("2%"));
    assert.ok(html.includes("5%"));
  });
});

test("golden: /stories.html renders threads with the first-mover column", async (t) => {
  const { storiesHtml: html } = buildPages();

  await t.test("the headline, first-seen and wire timestamps are present", () => {
    assert.ok(html.includes("央行开展 5000 亿元 MLF 操作"));
    assert.ok(html.includes("2026-11-16 13:05:12 +08:00"));
    assert.ok(html.includes('data-story-id="st_fixture01"'));
  });

  await t.test("every sighting lists its source and observation time", () => {
    assert.ok(html.includes('data-sightings="1"'));
    assert.ok(html.includes("路透中文"));
    assert.ok(html.includes("11-16 19:05"));
  });

  await t.test("the revision trail keeps both versions, in order", () => {
    assert.ok(html.includes('data-revisions="1"'));
    assert.ok(html.includes("央行开展 5000 亿元 MLF 操作，利率持平"));
    assert.ok(html.includes("rev-from"));
    assert.ok(html.includes("rev-to"));
  });

  await t.test("the first-mover column credits the earliest wire and its lead", () => {
    assert.ok(html.includes('data-first-mover="caixin"'));
    assert.ok(html.includes("首发 财新，领先 360 分钟于 路透中文"));
  });

  await t.test("the lead is labelled as observed granularity, not latency", () => {
    assert.ok(html.includes("观测粒度 · 非反应速度"));
    assert.ok(html.includes('data-lead-basis="observed"'));
    assert.ok(html.includes("不是反应速度"));
    assert.ok(html.includes("早报就拿到了、对手晚报才出现"));
  });

  await t.test("ranking is on contested firsts and says so", () => {
    assert.ok(html.includes('data-rank-basis="contested"'));
    assert.ok(html.includes("有争议首发"));
    assert.ok(html.includes("只被一家报道的故事不计入"));
  });
});

test("golden: /stories.html empty state names the gap", async (t) => {
  const html = renderStoriesPage({ payload: null, reason: "stories.json not present yet" });

  await t.test("it renders and says what it is waiting for", () => {
    assert.ok(html.includes('data-gap="ledger"'));
    assert.ok(html.includes("stories.json not present yet"));
    assert.ok(html.includes("故事账本还是空的"));
    assert.ok(html.includes("第一份版次 sidecar"));
  });

  await t.test("no thread markup leaks into the empty page", () => {
    assert.ok(!html.includes('data-story-id='));
    assert.ok(!html.includes('data-rank-basis='));
  });
});

test("golden: tape loading is fail-open over a real tree", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tape-reading-"));
  const dayDir = path.join(tmp, "2026-11-16");

  await t.test("a missing tape root is zero days, not an exception", () => {
    assert.deepEqual(readTapeDays(path.join(tmp, "nope")), []);
  });

  await t.test("a slot with a corrupt file becomes a named gap, not a crash", () => {
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(path.join(dayDir, "1305.json"), "{ not json", "utf8");
    const days = readTapeDays(tmp);
    assert.equal(days.length, 1);
    const slot = days[0].slots.find((s) => s.time === "13:05");
    assert.ok(slot);
    assert.equal(slot?.snapshot, null);
    assert.equal(slot?.gap, "unreadable");
    assert.equal(dayHasTape(days[0]), false);
  });

  await t.test("a valid snapshot is read and the day counts as having tape", () => {
    fs.writeFileSync(path.join(dayDir, "1305.json"), JSON.stringify(snapshot()), "utf8");
    const days = readTapeDays(tmp);
    assert.equal(dayHasTape(days[0]), true);
    assert.equal(days[0].slots.filter((s) => s.gap === "missing").length, TAPE_SLOTS.length - 1);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("golden: /hour.html attributes same-window stories to their source", async (t) => {
  const snap = snapshot();
  const reading = buildSlotReading(snap, {
    stories: {
      stories: [
        story(),
        // 3 hours before the capture: outside the 30-minute window.
        story({
          id: "st_old",
          title: "更早的一条",
          firstSeenAt: clock(new Date(CAPTURE.getTime() - 3 * 3_600_000)),
          sources: ["caixin"],
          sightings: [],
          headlineRevisions: [],
          firstMover: {
            sourceId: "caixin",
            observedAt: clock(new Date(CAPTURE.getTime() - 3 * 3_600_000)),
            tied: false,
            coFirstSourceIds: ["caixin"],
            runnerUpSourceId: null,
            runnerUpObservedAt: null,
            leadMinutes: null,
          },
        }),
      ],
      sourceNames: NAMES,
    },
  });

  await t.test("a story inside the window gets a sentence with source and time", () => {
    assert.ok(reading.stories?.inWindow.length === 1);
    const html = renderHourPage({
      days: [
        {
          date: snap.date,
          slots: TAPE_SLOTS.map((time) => ({
            time,
            snapshot: time === snap.slot ? snap : null,
            revision: 0,
            gap: time === snap.slot ? null : "missing",
          })),
          missing: [],
        },
      ],
      readings: new Map([[`${snap.date}/${snap.slot}`, reading]]),
      timezone: TZ,
      expectedSlots: TAPE_SLOTS,
      empty: false,
    });
    assert.ok(
      html.includes("同一时间窗（前 30 分钟）里，账本新收录 1 条故事，最早一条来自 财新"),
      "the story sentence must name the source and count",
    );
    assert.ok(html.includes("13:05:12"), "the observation time must be in the sentence");
  });

  await t.test("an out-of-window story is shown as earlier context, not as this slot", () => {
    assert.equal(reading.stories?.earlier[0]?.id, "st_old");
    assert.ok(reading.stories?.inWindow.every((s) => s.id !== "st_old"));
  });

  await t.test("a missing ledger is a named gap, not an empty column", () => {
    const withGap = buildSlotReading(snap, {
      stories: { stories: null, reason: "stories.json not present yet" },
    });
    assert.equal(withGap.stories?.unavailable, "stories.json not present yet");
    const html = renderHourPage({
      days: [
        {
          date: snap.date,
          slots: [{ time: snap.slot, snapshot: snap, revision: 0, gap: null }],
          missing: TAPE_SLOTS.filter((t) => t !== snap.slot),
        },
      ],
      readings: new Map([[`${snap.date}/${snap.slot}`, withGap]]),
      timezone: TZ,
      expectedSlots: TAPE_SLOTS,
      empty: false,
    });
    assert.ok(html.includes('data-gap="ledger"'));
    assert.ok(html.includes("故事账本不可用（stories.json not present yet）"));
  });

  await t.test("story links point at the article, never at a search engine", () => {
    const hit = reading.stories?.inWindow[0];
    assert.equal(hit?.url, "https://example.com/a1");
  });
});

test("golden: /stories.html renders the revision trail", async (t) => {
  const p = payload();
  p.revisionTrail = {
    storiesWithRevisions: 1,
    totalRevisions: 1,
    items: [
      {
        id: "st_fixture01",
        title: "央行开展 5000 亿元 MLF 操作",
        topic: "global-markets",
        revisions: 1,
        steps: [
          {
            at: clock(new Date(CAPTURE.getTime() + 6 * 3_600_000)),
            from: "央行开展 5000 亿元 MLF 操作",
            to: "央行开展 5000 亿元 MLF 操作，利率持平",
            removed: [],
            added: ["利率", "持平"],
          },
        ],
      },
    ],
  };
  const html = renderStoriesPage({ payload: p, sourceNames: NAMES });

  await t.test("the trail names the story and both versions", () => {
    assert.ok(html.includes('data-trail-story="st_fixture01"'));
    assert.ok(html.includes('data-trail-total="1"'));
    assert.ok(html.includes("原 · 央行开展 5000 亿元 MLF 操作"));
    assert.ok(html.includes("改 · 央行开展 5000 亿元 MLF 操作，利率持平"));
  });

  await t.test("the token delta is shown so a rewrite is visible as a diff", () => {
    assert.ok(html.includes("+利率 持平"));
  });

  await t.test("an empty side of the delta is omitted, not a bare sign", () => {
    const onlyRemoved = renderStoriesPage({
      payload: {
        ...p,
        revisionTrail: {
          storiesWithRevisions: 1,
          totalRevisions: 1,
          items: [
            {
              id: "st_fixture01",
              title: "t",
              topic: "global-markets",
              revisions: 1,
              steps: [
                {
                  at: clock(CAPTURE),
                  from: "a b",
                  to: "a",
                  removed: ["b"],
                  added: [],
                },
              ],
            },
          ],
        },
      },
      sourceNames: NAMES,
    });
    assert.ok(onlyRemoved.includes("−b"));
    assert.ok(!/>−</.test(onlyRemoved), "a bare minus with no tokens must not render");
  });

  await t.test("the headline counts distinguish revised stories from revisions", () => {
    assert.ok(html.includes("1 条故事含标题修订（共 1 次修订）"));
  });
});

test("golden: /stories.html normalizes wire timestamps into the ledger zone", async (t) => {
  const p = payload();
  // A feed stamp arrives as bare UTC; printing it raw beside +08:00 clocks
  // makes one page look like it mixes two conventions.
  p.stories = [{ ...story(), publishedAt: "2026-11-16T05:00:00.000Z" }];
  const html = renderStoriesPage({ payload: p, sourceNames: NAMES });
  assert.ok(!html.includes(".000Z"), "raw UTC stamps must not reach the page");
  assert.ok(html.includes("2026-11-16 13:00:00 +08:00"), "the wire stamp renders in the ledger zone");
});

test("golden: a slot whose label disagrees with its content is flagged", async (t) => {
  await t.test("an ordinary session slot classifies ok", () => {
    const r = classifySlot(
      { date: "2026-11-13", slot: "14:35", observedAt: clock(new Date("2026-11-13T06:35:30Z")), timezone: TZ },
      clock(new Date("2026-11-13T06:35:10Z")),
    );
    assert.equal(r.kind, "ok");
    assert.ok(Math.abs(r.marketLagMinutes ?? 999) < 5);
  });

  await t.test("a weekend forced capture is market-closed, not a defect", () => {
    // This is the shape of `TAPE_SLOT=1435 npm run tape:bake` on a Saturday:
    // the capture is honest about describing Friday's close, and flagging it as
    // an error would condemn every weekend and holiday run for being correct.
    const r = classifySlot(
      {
        date: "2026-11-13",
        slot: "14:35",
        observedAt: clock(new Date("2026-11-14T03:40:32Z")),
        timezone: TZ,
      },
      clock(new Date("2026-11-13T08:11:57Z")),
    );
    assert.equal(r.kind, "market-closed");
    assert.ok(r.reason.includes("market was closed"));
  });

  await t.test("a quote older than 90 minutes inside the session is flagged", () => {
    // Captured at 14:40 on a trading day, content struck at 09:58 — the file
    // does not describe its slot.
    const r = classifySlot(
      {
        date: "2026-11-13",
        slot: "14:35",
        observedAt: clock(new Date("2026-11-13T06:40:00Z")),
        timezone: TZ,
      },
      clock(new Date("2026-11-13T01:58:00Z")),
    );
    assert.equal(r.kind, "mislabelled");
    assert.ok(Math.abs(r.marketLagMinutes ?? 0) > MAX_LABEL_LAG_MINUTES);
  });

  await t.test("a market clock after the file's own date is flagged even on a weekend", () => {
    // The hole this closes: a backfill run on a Saturday writes today's quotes
    // into a past date's folder, and the capture instant alone would read as
    // "market closed". Content dated after the file cannot be a closed market.
    const r = classifySlot(
      {
        date: "2026-11-08",
        slot: "09:35",
        observedAt: clock(new Date("2026-11-14T03:00:00Z")),
        timezone: TZ,
      },
      clock(new Date("2026-11-14T02:55:00Z")),
    );
    assert.equal(r.kind, "mislabelled");
    assert.ok(r.reason.includes("after the file's own date"));
  });

  await t.test("the tolerance is 90 minutes and is exported", () => {
    assert.equal(MAX_LABEL_LAG_MINUTES, 90);
  });
});

test("golden: the hour page renders a label mismatch as an error, not a reading", async (t) => {
  const bad = snapshot();
  // Re-date the fixture: a capture taken during Monday trading but filed under
  // the previous Friday's 13:05 slot.
  const raw = bad as unknown as Record<string, unknown>;
  raw.date = "2026-11-13";
  raw.observedAt = clock(new Date("2026-11-16T05:10:00Z"));
  for (const name of ["indices", "industries", "themes", "fundFlows"]) {
    raw[name] = { ...(raw[name] as Record<string, unknown>), observedAt: clock(new Date("2026-11-16T05:10:00Z")) };
  }
  const reading = buildSlotReading(bad);
  assert.equal(reading.integrity.kind, "mislabelled");

  const html = renderHourPage({
    days: [
      {
        date: "2026-11-13",
        slots: TAPE_SLOTS.map((time) => ({
          time,
          snapshot: time === "13:05" ? bad : null,
          revision: 0,
          gap: time === "13:05" ? null : "missing",
        })),
        missing: [],
      },
    ],
    readings: new Map([["2026-11-13/13:05", reading]]),
    timezone: TZ,
    expectedSlots: TAPE_SLOTS,
    empty: false,
  });

  await t.test("the banner names the defect and the gap in minutes", () => {
    assert.ok(html.includes('data-integrity="mislabelled"'));
    assert.ok(html.includes("标签不符"));
    assert.ok(html.includes("这一档的标签与内容对不上"));
    assert.ok(html.includes("不应该当成正常盘中读数来读"));
  });

  await t.test("the prose is de-emphasised but not deleted", () => {
    assert.ok(html.includes("prose-flagged"), "flagged slots must look different");
    // The numbers stay: hiding a bad file would be worse than labelling it.
    assert.ok(html.includes("上证指数收于"));
  });

  await t.test("the slot's nav chip carries the flag before it is opened", () => {
    assert.ok(html.includes("is-flagged"));
    assert.ok(html.includes('title="标签不符"'));
  });
});

test("golden: a closed-market capture is labelled without being called a defect", async (t) => {
  const weekend = snapshot();
  const raw = weekend as unknown as Record<string, unknown>;
  // Captured Saturday 03:40 SH; market clock is Friday's close.
  raw.observedAt = clock(new Date("2026-11-13T19:40:32Z"));
  for (const name of ["indices", "industries", "themes", "fundFlows"]) {
    raw[name] = { ...(raw[name] as Record<string, unknown>), observedAt: clock(new Date("2026-11-13T19:40:32Z")) };
  }
  const reading = buildSlotReading(weekend);
  assert.equal(reading.integrity.kind, "market-closed");

  const html = renderHourPage({
    days: [
      {
        date: "2026-11-13",
        slots: [{ time: "13:05", snapshot: weekend, revision: 0, gap: null }],
        missing: TAPE_SLOTS.filter((s) => s !== "13:05"),
      },
    ],
    readings: new Map([["2026-11-13/13:05", reading]]),
    timezone: TZ,
    expectedSlots: TAPE_SLOTS,
    empty: false,
  });

  await t.test("it says the market was closed and what the number describes", () => {
    assert.ok(html.includes('data-integrity="market-closed"'));
    assert.ok(html.includes("休市抓取"));
    assert.ok(html.includes("这一档描述的是最近一次收盘"));
    assert.ok(html.includes("这不是缺陷"));
  });

  await t.test("it does not use the error styling or the error wording", () => {
    assert.ok(!html.includes('data-integrity="mislabelled"'));
    assert.ok(!html.includes("标签不符"));
    assert.ok(!html.includes("不应该当成正常盘中读数来读"));
  });
});

test("golden: thresholds are declared once and printed to the reader", async (t) => {
  await t.test("board and index yardsticks are distinct and ordered", () => {
    assert.ok(MOVE_THRESHOLDS.board.big < MOVE_THRESHOLDS.board.severe);
    assert.ok(MOVE_THRESHOLDS.index.big < MOVE_THRESHOLDS.index.severe);
  });

  await t.test("the rendered page states the same numbers the code uses", () => {
    const { hour } = buildPages();
    assert.ok(hour.includes(`${MOVE_THRESHOLDS.board.big}%`));
    assert.ok(hour.includes(`${MOVE_THRESHOLDS.board.severe}%`));
    assert.ok(hour.includes(`${Math.round(MOVE_THRESHOLDS.breadth.strong * 100)}%`));
  });
});
