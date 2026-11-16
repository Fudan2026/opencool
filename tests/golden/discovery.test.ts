/**
 * GOLDEN: structured discovery (roadmap §2-#1, §2-#3, §2-#4).
 *
 * Covers the tsx-rendered half of the increment: the og:/twitter card +
 * JSON-LD blocks on the edition page and the reading pages, and the
 * /reactions.html renderer — including the honest pending/insufficient states
 * and the per-horizon funnel entry points. The build-site half (static pages,
 * sitemap, robots, feeds, presence stripping) is covered by
 * `bake-golden.test.ts`, which runs the real publisher end to end.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { renderHtml } from "../../lib/output/render";
import { renderHourPage } from "../../lib/output/hour-page";
import { renderStoriesPage } from "../../lib/output/stories-page";
import { renderReactionsPage } from "../../lib/output/reactions-page";
import { SUPRO_UTM } from "../../lib/output/supro";
import { SITE_URL, slotInstantIso } from "../../lib/output/meta";
import type { ReactionsPayload, StoryReaction } from "../../lib/reactions/types";
import { TAPE_SLOTS } from "../../lib/tape/schedule";
import { reportFixture, rawNews } from "./helpers";
import type { DailyReport } from "../../lib/ai/pipeline";

const TZ = "Asia/Shanghai";

/** Every outbound supro.si URL on a page must carry the shared scheme. */
function assertSchemeOn(html: string, label: string): void {
  const urls = [...html.matchAll(/https:\/\/supro\.si[^"'\s<>]+/g)].map((m) => m[0]);
  for (const u of urls) {
    assert.ok(u.includes(SUPRO_UTM), `${label}: link without the shared UTM scheme: ${u}`);
  }
}

/** The single JSON-LD block of a page, parsed. */
function parseLdJson(html: string, label: string): Record<string, unknown> {
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, `${label}: no JSON-LD block`);
  return JSON.parse(m[1]) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Edition page: og card + NewsArticle JSON-LD
// ---------------------------------------------------------------------------

test("golden: edition page carries og card + NewsArticle JSON-LD", async (t) => {
  process.env.REPORT_TZ = TZ;
  let html = "";
  try {
    html = renderHtml(reportFixture(), rawNews(), "2026-11-16", {
      editionHour: "19",
      siblingHours: ["06", "13", "19"],
    });
  } finally {
    delete process.env.REPORT_TZ;
  }

  await t.test("og card: article type, absolute URL, Shanghai slot instant", () => {
    assert.ok(html.includes('<meta property="og:title" content="OpenCool · 晚报 · 2026-11-16">'));
    assert.ok(
      html.includes(`<meta property="og:url" content="${SITE_URL}/2026-11-16/19.html">`),
      "og:url must be the absolute page URL",
    );
    assert.ok(html.includes('<meta property="og:type" content="article">'));
    assert.ok(
      html.includes('<meta property="article:published_time" content="2026-11-16T19:00:00+08:00">'),
      "published_time is the slot instant in the report timezone, ISO 8601 with offset",
    );
    assert.ok(html.includes('<meta name="twitter:card" content="summary">'));
    assert.ok(html.includes('<meta name="twitter:title" content="'));
  });

  await t.test("JSON-LD: one NewsArticle with both dates offset-qualified", () => {
    const ld = parseLdJson(html, "edition");
    assert.equal(ld["@type"], "NewsArticle");
    assert.equal(ld["datePublished"], "2026-11-16T19:00:00+08:00");
    assert.match(String(ld["dateModified"]), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+\d{2}:\d{2}$/);
    assert.equal(ld["isAccessibleForFree"], true);
    const publisher = ld["publisher"] as Record<string, unknown>;
    assert.equal(publisher["@type"], "Organization");
    assert.equal(publisher["name"], "OpenCool");
    const main = ld["mainEntityOfPage"] as Record<string, unknown>;
    assert.equal(main["@id"], `${SITE_URL}/2026-11-16/19.html`);
  });

  await t.test("the description never invents copy: overview first, tagline last", () => {
    const desc = /<meta property="og:description" content="([^"]*)">/.exec(html)?.[1] ?? "";
    const fx = reportFixture();
    assert.equal(desc, fx.daily_overview);
    assert.ok(desc.length > 0);
  });
});

test("golden: slotInstantIso honors REPORT_TZ, never a hardcoded offset", () => {
  process.env.REPORT_TZ = TZ;
  try {
    assert.equal(slotInstantIso("2026-11-16", "06"), "2026-11-16T06:00:00+08:00");
  } finally {
    process.env.REPORT_TZ = "UTC";
    try {
      assert.equal(slotInstantIso("2026-11-16", "06"), "2026-11-16T06:00:00+00:00");
    } finally {
      delete process.env.REPORT_TZ;
    }
  }
});

// ---------------------------------------------------------------------------
// Reading pages: og card + fitting JSON-LD
// ---------------------------------------------------------------------------

test("golden: hour and stories pages carry og cards and fitting JSON-LD", async (t) => {
  const hour = renderHourPage({
    days: [],
    readings: new Map(),
    timezone: TZ,
    expectedSlots: TAPE_SLOTS,
    empty: true,
  });
  const stories = renderStoriesPage({
    payload: null,
    reason: "stories.json not present yet",
    sourceNames: {},
  });

  await t.test("hour.html: WebPage JSON-LD + og card", () => {
    assert.ok(hour.includes(`<meta property="og:url" content="${SITE_URL}/hour.html">`));
    const ld = parseLdJson(hour, "hour");
    assert.equal(ld["@type"], "WebPage");
  });

  await t.test("stories.html: CollectionPage JSON-LD (a listing, not an article)", () => {
    assert.ok(stories.includes(`<meta property="og:url" content="${SITE_URL}/stories.html">`));
    const ld = parseLdJson(stories, "stories");
    assert.equal(ld["@type"], "CollectionPage");
  });
});

// ---------------------------------------------------------------------------
// /reactions.html: the honest table
// ---------------------------------------------------------------------------

function fixturePayload(): ReactionsPayload {
  const horizon = (
    status: "ok" | "pending" | "gap",
    over: Record<string, unknown> = {},
  ) => ({ status, ...over });
  const okObs: StoryReaction = {
    id: "st_fixture01",
    firstSeenAt: "2026-11-16T13:05:12+08:00",
    firstEdition: "2026-11-16/13",
    topic: "global-markets",
    target: "theme:ai-compute",
    targetLabel: "算力",
    attribution: "entity",
    entity: "nvidia",
    attributionReason: "entity nvidia -> theme ai-compute",
    horizons: {
      "1h": horizon("ok", {
        entry: { ms: 1, asOf: "2026-11-16T13:35:00+08:00", date: "2026-11-16", slot: "13:35" },
        exit: { ms: 2, asOf: "2026-11-16T14:35:00+08:00", date: "2026-11-16", slot: "14:05" },
        windowMinutes: 60,
        entryOvershootMinutes: 30,
        overshootMinutes: 0,
        rawReturnPct: 2.1,
        trailingDriftPct: null,
        sectorExcessPct: null,
        marketMeanPct: 0.87,
        marketExcessPct: 1.23,
        marketUniverse: 63,
      }),
      "1d": horizon("pending", { reason: "no snapshot at/after firstSeenAt + horizon" }),
      "5d": horizon("gap", { reason: "window spans a missing close" }),
    },
  };
  const pendingObs: StoryReaction = {
    id: "st_fixture02",
    firstSeenAt: "2026-11-16T14:10:00+08:00",
    firstEdition: "2026-11-16/13",
    topic: "policy",
    target: null,
    targetLabel: null,
    attribution: "pending",
    entity: null,
    attributionPending: true,
    attributionReason: "tape has not started",
    horizons: {
      "1h": horizon("pending", { reason: "no snapshot at/after firstSeenAt + horizon" }),
      "1d": horizon("pending", { reason: "no snapshot at/after firstSeenAt + horizon" }),
      "5d": horizon("pending", { reason: "no snapshot at/after firstSeenAt + horizon" }),
    },
  };
  return {
    schemaVersion: 1,
    dataThrough: "2026-11-16T14:35:00+08:00",
    timezone: TZ,
    headlineMetric: "marketExcessPct",
    headlineReason: "cross-sectional excess is the headline",
    method: {},
    tape: { days: 1, snapshots: 10, from: "2026-11-16T09:35:00+08:00", to: "2026-11-16T14:35:00+08:00", slots: ["09:35"] },
    ledger: {
      stories: 5,
      withFirstSeen: 5,
      maxStories: 2000,
      retentionDays: 30,
      updatedAt: "2026-11-16T14:35:00+08:00",
      retainedFrom: "2026-11-16",
      retainedTo: "2026-11-16",
      capBinding: false,
    },
    counts: {
      stories: 5,
      attributed: { entity: 1, topic: 1, market: 1, pending: 1, unmapped: 1 },
      horizons: {
        "1h": { ok: 1, pending: 1, gap: 0 },
        "1d": { ok: 0, pending: 2, gap: 0 },
        "5d": { ok: 0, pending: 1, gap: 1 },
      },
      aggregates: { byTopic: 1, byEntity: 0 },
      observationsTotal: 2,
      observationsPublished: 2,
    },
    aggregates: {
      byTopic: [
        {
          key: "global-markets",
          label: "全球市场",
          expectedSign: null,
          horizons: {
            "1h": { n: 3, status: "insufficient", excluded: { pending: 1, gap: 0 } },
            "1d": {
              n: 25,
              status: "ok",
              mean: 1.2,
              median: 1.0,
              p25: 0.5,
              p75: 2.0,
              hitRate: 0.64,
              hitRateBasis: "marketExcessPct > 0",
              meanRawReturnPct: 2.1,
              meanSectorExcessPct: null,
              excluded: { pending: 1, gap: 2 },
            },
            "5d": { n: 0, status: "insufficient", excluded: { pending: 0, gap: 0 } },
          },
        },
      ],
      byEntity: [],
    },
    observations: [okObs, pendingObs],
    observationsTruncated: false,
    gaps: [{ kind: "attribution-pending", detail: "tape has not started", count: 1 }],
  } as unknown as ReactionsPayload;
}

test("golden: /reactions.html keeps every state visible, one funnel entry per horizon", async (t) => {
  const html = renderReactionsPage({ payload: fixturePayload(), reason: "" });

  await t.test("ok horizon shows the headline metric and its raw window", () => {
    assert.ok(html.includes("+1.23%"), "marketExcessPct must be the visible headline");
    assert.ok(html.includes("原始 +2.10%"), "the raw return is published alongside");
    assert.ok(html.includes("窗口 60 分钟"));
  });

  await t.test("pending and gap are rendered as states, never folded away", () => {
    assert.ok(html.includes("待定"));
    assert.ok(html.includes("缺口"));
    assert.ok(html.includes("no snapshot at/after firstSeenAt + horizon"));
    assert.ok(html.includes("window spans a missing close"));
  });

  await t.test("insufficient aggregates publish n and nothing that looks like a mean", () => {
    assert.ok(html.includes("样本不足（n=3，需 ≥20）"));
    const insuffCell = html.split("样本不足")[1]?.slice(0, 200) ?? "";
    assert.ok(!insuffCell.includes("均值"), "an insufficient row must not carry a mean");
  });

  await t.test("each horizon cell carries its own utm_content", () => {
    for (const key of ["reactions-1h", "reactions-1d", "reactions-5d"]) {
      assert.ok(html.includes(`utm_content=${key}"`), `missing ${key}`);
      // once per observation row
      assert.equal(html.split(`utm_content=${key}"`).length - 1, 2, `${key} once per row`);
    }
    assert.ok(html.includes("https://supro.si/paper?"));
  });

  await t.test("the five attribution buckets are visibly distinct", () => {
    assert.ok(html.includes('class="attr-chip attr-entity"'));
    assert.ok(html.includes('class="attr-chip attr-pending"'));
    assert.ok(html.includes("实体 1"));
    assert.ok(html.includes("待定 1"));
  });

  await t.test("every outbound link carries the shared UTM scheme", () => {
    assertSchemeOn(html, "reactions");
  });

  await t.test("no template placeholder leaks into the page", () => {
    const leaked = [...html.matchAll(/\{(?:[a-z][A-Za-z0-9_]*)\}/g)].map((m) => m[0]);
    assert.deepEqual(leaked, []);
  });
});

test("golden: /reactions.html gap state names the gap, drops per-row links", () => {
  const html = renderReactionsPage({
    payload: null,
    reason: "reactions.json is not a valid ReactionsPayload",
  });
  assert.ok(html.includes('data-gap="reactions"'));
  assert.ok(html.includes("reactions.json is not a valid ReactionsPayload"));
  assert.ok(!html.includes("utm_content=reactions-1h"), "no per-horizon entry without a row");
  assertSchemeOn(html, "gap state");
});
