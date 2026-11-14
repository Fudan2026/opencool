/**
 * GOLDEN: the news→practice funnel chains (supro.si).
 *
 * One scheme, one link builder (lib/output/supro.ts) and a mirrored copy in
 * scripts/build-site.mjs for the pages node bakes. These assertions pin the
 * TS-rendered surfaces: the edition page (nav + review-panel contexts),
 * /hour.html (per-slot + page-level), /stories.html (per-story + page-level).
 * The build-site surfaces (supro.html landing, archive/status, edition CTA
 * strip, integrity.html) are covered by `bake-golden.test.ts`, which runs the
 * real publisher over a synthetic tree.
 *
 * Every entry point must carry the shared UTM scheme and its OWN
 * `utm_content`, so supro.si can attribute traffic per surface — an entry
 * point that silently shares another's value is unmeasurable, which is the
 * same as missing.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { renderHtml } from "../../lib/output/render";
import { renderHourPage } from "../../lib/output/hour-page";
import { renderStoriesPage } from "../../lib/output/stories-page";
import { SUPRO_UTM, suproUrl } from "../../lib/output/supro";
import { buildSlotReading, type TapeDayView } from "../../lib/tape/reading";
import { TAPE_SLOTS } from "../../lib/tape/schedule";
import type { TapeSnapshot } from "../../lib/tape/store";
import type { StoriesPayload, StoryRecord } from "../../lib/stories/ledger";
import { isoWithOffset } from "../../lib/stories/time";
import { reportFixture, rawNews } from "./helpers";
import type { DailyReport } from "../../lib/ai/pipeline";

const TZ = "Asia/Shanghai";
/** 2026-11-16 13:05 Asia/Shanghai — the first real Monday session. */
const CAPTURE = new Date("2026-11-16T05:05:12Z");

function clock(at: Date): string {
  return isoWithOffset(at, TZ);
}

/** Every outbound supro.si URL on a page must carry the shared scheme. */
function assertSchemeOn(html: string, label: string): void {
  const urls = [...html.matchAll(/https:\/\/supro\.si[^"'\s<>]+/g)].map((m) => m[0]);
  assert.ok(urls.length > 0, `${label}: no supro.si link found`);
  for (const u of urls) {
    assert.ok(u.includes(SUPRO_UTM), `${label}: link without the shared UTM scheme: ${u}`);
  }
}

// ---------------------------------------------------------------------------
// Edition page (renderHtml)
// ---------------------------------------------------------------------------

test("golden: funnel — edition page nav + review-panel contexts", async (t) => {
  process.env.WEB_MODE = "true";
  let html = "";
  try {
    // The contextual strip is context-matched: the themes line needs theme
    // hits, the flows line needs sector fund flows. The base fixture carries
    // themes but no flows, so both entry points are exercised only when the
    // fixture has both.
    const report = reportFixture({
      quant: {
        ...reportFixture().quant!,
        fundFlows: {
          sectors: [
            { name: "银行", changePct: 1.42, netInflowYi: 12.26 },
            { name: "光伏设备", changePct: -5.63, netInflowYi: -31.42 },
          ],
          note: "fixture flow note",
        },
      },
    } as Partial<DailyReport>);
    html = renderHtml(report, rawNews(), "2026-11-16", {
      editionHour: "19",
      siblingHours: ["06", "13", "19"],
    });
  } finally {
    delete process.env.WEB_MODE;
  }

  await t.test("the site nav links the sister-project landing", () => {
    assert.ok(html.includes('data-nav="supro"'), "nav entry missing");
    assert.ok(html.includes('href="../supro.html"'), "landing link missing");
  });

  await t.test("review panel carries one contextual strip with two entry points", () => {
    assert.equal(
      html.split('data-funnel="supro-context"').length - 1,
      1,
      "the contextual strip must appear exactly once",
    );
    // Themes context → per-day signals; fund-flow context → paper.
    assert.ok(html.includes("https://supro.si/signals?"), "signals link missing");
    assert.ok(html.includes("utm_content=edition-themes"), "themes entry point missing");
    assert.ok(html.includes("https://supro.si/paper?"), "paper link missing");
    assert.ok(html.includes("utm_content=edition-flows"), "flows entry point missing");
  });

  await t.test("every outbound link carries the shared UTM scheme", () => {
    assertSchemeOn(html, "edition");
  });

  await t.test("the build-site CTA strip's data-funnel marker is not pre-empted", () => {
    // build-site injects the one `data-funnel="supro"` CTA strip after render;
    // the renderer itself must not ship that marker or the injection would
    // silently double.
    assert.equal(html.includes('data-funnel="supro"'), false);
  });
});

// ---------------------------------------------------------------------------
// /hour.html
// ---------------------------------------------------------------------------

/** One complete-enough snapshot: both clocks live, all five sections present. */
function snapshot(): TapeSnapshot {
  const observedAt = clock(CAPTURE);
  const asOf = clock(new Date(CAPTURE.getTime() - 43_000));
  const section = (records: unknown[]) => ({
    asOf,
    observedAt,
    timestampSource: "upstream" as const,
    records,
  });
  return {
    schemaVersion: 1,
    date: "2026-11-16",
    slot: "13:05",
    slotKey: "1305",
    revision: 0,
    observedAt,
    timezone: TZ,
    registry: "live",
    indices: section([
      { code: "000001", name: "上证指数", price: 3512.44, changePct: 0.62, asOf, observedAt, timestampSource: "upstream" },
      { code: "399001", name: "深证成指", price: 10688.1, changePct: 1.34, asOf, observedAt, timestampSource: "upstream" },
      { code: "399006", name: "创业板指", price: 2301.77, changePct: 2.41, asOf, observedAt, timestampSource: "upstream" },
    ]),
    industries: section([
      { code: "BK0475", name: "银行Ⅱ", secid: "90.BK0475", changePct: 1.42, up: 30, down: 12, asOf, observedAt, timestampSource: "upstream" },
      { code: "BK0800", name: "人工智能", secid: "90.BK0800", changePct: 2.68, up: 90, down: 40, asOf, observedAt, timestampSource: "upstream" },
      { code: "BK1036", name: "半导体", secid: "90.BK1036", changePct: -2.11, up: 14, down: 173, asOf, observedAt, timestampSource: "upstream" },
    ]),
    themes: section([
      { key: "ai", name: "人工智能", boardCode: "BK0800", boardName: "人工智能", changePct: 2.68, up: 90, down: 40, asOf, observedAt, timestampSource: "upstream" },
    ]),
    fundFlows: section([
      { name: "银行", changePct: 1.42, netInflowYi: 12.26, asOf, observedAt, timestampSource: "upstream" },
    ]),
    limitPool: {
      asOf: observedAt,
      observedAt,
      timestampSource: "fetch" as const,
      records: [
        { code: "001358", name: "兴欣新材", changePct: 9.99, boards: 2, industry: "化学制品", asOf: observedAt, observedAt, timestampSource: "fetch" as const },
      ],
      meta: { upstream: "push2ex", tradeDate: "2026-11-16", limitUp: 44, limitDown: 7 },
    },
  } as unknown as TapeSnapshot;
}

test("golden: funnel — /hour.html tape contexts", async (t) => {
  const snap = snapshot();
  const reading = buildSlotReading(snap);
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
  const html = renderHourPage({
    days: [day],
    readings: new Map([[`${snap.date}/${snap.slot}`, reading]]),
    timezone: TZ,
    expectedSlots: TAPE_SLOTS,
    empty: false,
  });

  await t.test("every captured slot carries the paper entry point", () => {
    assert.equal(
      html.split('data-funnel="supro-hour"').length - 1,
      1,
      "one per-slot link per captured slot",
    );
    assert.ok(html.includes("https://supro.si/paper?"));
    assert.ok(html.includes("utm_content=hour-tape"));
  });

  await t.test("the page-level timing entry point exists", () => {
    assert.equal(html.split('data-funnel="supro-hour-page"').length - 1, 1);
    assert.ok(html.includes("https://supro.si/timing/broad/?"));
    assert.ok(html.includes("utm_content=hour-timing"));
  });

  await t.test("footer wires the siblings + landing", () => {
    assert.ok(html.includes('href="./stories.html"'));
    assert.ok(html.includes('href="./integrity.html"'));
    assert.ok(html.includes('href="./supro.html"'));
  });

  await t.test("every outbound link carries the shared UTM scheme", () => {
    assertSchemeOn(html, "hour");
  });

  await t.test("empty tape keeps the page-level entry, drops the per-slot one", () => {
    const emptyHtml = renderHourPage({
      days: [],
      readings: new Map(),
      timezone: TZ,
      expectedSlots: TAPE_SLOTS,
      empty: true,
    });
    assert.ok(emptyHtml.includes("utm_content=hour-timing"), "page-level guidance is state-independent");
    assert.ok(!emptyHtml.includes("utm_content=hour-tape"), "no per-slot link without a slot");
  });
});

// ---------------------------------------------------------------------------
// /stories.html
// ---------------------------------------------------------------------------

function story(): StoryRecord {
  const first = clock(CAPTURE);
  const later = clock(new Date(CAPTURE.getTime() + 6 * 3_600_000));
  return {
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
    sources: ["caixin"],
    sightings: [
      {
        sourceId: "caixin",
        observedAt: first,
        title: "央行开展 5000 亿元 MLF 操作",
        url: "https://example.com/a1",
        edition: "2026-11-16/13",
      },
    ],
    headlineRevisions: [],
    firstMover: {
      sourceId: "caixin",
      observedAt: first,
      tied: false,
      coFirstSourceIds: ["caixin"],
      runnerUpSourceId: null,
      runnerUpObservedAt: null,
      leadMinutes: null,
    },
  };
}

function payload(): StoriesPayload {
  return {
    version: 1,
    timezone: TZ,
    retentionDays: 30,
    maxStories: 2000,
    updatedAt: clock(CAPTURE),
    stories: [story()],
    generatedAt: clock(CAPTURE),
    counts: {
      stories: 1,
      sightings: 1,
      multiSightingStories: 0,
      storiesWithRevisions: 0,
      skippedRecords: 0,
      editions: 1,
      articles: 1,
      duplicates: 0,
    },
    firstMover: {
      windowDays: 30,
      from: "2026-10-17",
      to: "2026-11-16",
      storiesInWindow: 1,
      soleFirstStories: 1,
      contestedStories: 0,
      tiedFirstStories: 0,
      leadBasis: "observed",
      wires: [
        {
          sourceId: "caixin",
          soleFirsts: 1,
          contestedFirsts: 0,
          coFirsts: 0,
          stories: 1,
          leadSamples: 0,
          medianLeadMinutes: null,
        },
      ],
    },
    revisionTrail: {
      storiesWithRevisions: 0,
      totalRevisions: 0,
      items: [],
    },
  } as unknown as StoriesPayload;
}

test("golden: funnel — /stories.html per-story act links", async (t) => {
  const html = renderStoriesPage({
    payload: payload(),
    sourceNames: { caixin: "财新" },
  });

  await t.test("every story thread carries the act-on-this entry point", () => {
    assert.equal(
      html.split('data-funnel="supro-story"').length - 1,
      1,
      "one act link per rendered thread",
    );
    assert.ok(html.includes("https://supro.si/paper?"));
    assert.ok(html.includes("utm_content=story-act"));
  });

  await t.test("the page-level signals entry point exists", () => {
    assert.equal(html.split('data-funnel="supro-stories-page"').length - 1, 1);
    assert.ok(html.includes("https://supro.si/signals?"));
    assert.ok(html.includes("utm_content=story-signals"));
  });

  await t.test("footer wires the siblings + landing", () => {
    assert.ok(html.includes('href="./hour.html"'));
    assert.ok(html.includes('href="./integrity.html"'));
    assert.ok(html.includes('href="./supro.html"'));
  });

  await t.test("every outbound link carries the shared UTM scheme", () => {
    assertSchemeOn(html, "stories");
  });

  await t.test("the gap state keeps the footer wiring, drops per-story links", () => {
    const gapHtml = renderStoriesPage({ payload: null, reason: "stories.json not present yet" });
    assert.ok(gapHtml.includes('href="./supro.html"'));
    assert.ok(!gapHtml.includes("utm_content=story-act"), "no act link without a story");
  });
});

// ---------------------------------------------------------------------------
// The scheme itself
// ---------------------------------------------------------------------------

test("golden: the UTM scheme and destinations are locked", () => {
  assert.equal(
    SUPRO_UTM,
    "utm_source=opencool&utm_medium=brief&utm_campaign=news_to_practice",
  );
  // Destinations never wander off the known supro.si paths.
  assert.equal(suproUrl("home", "x"), "https://supro.si/?utm_source=opencool&utm_medium=brief&utm_campaign=news_to_practice&utm_content=x");
  assert.equal(suproUrl("timing", "hour-timing").startsWith("https://supro.si/timing/broad/?"), true);
  assert.equal(suproUrl("signals", "y").startsWith("https://supro.si/signals?"), true);
  assert.equal(suproUrl("paper", "z").startsWith("https://supro.si/paper?"), true);
});
