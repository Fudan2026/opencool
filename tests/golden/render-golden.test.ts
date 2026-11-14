import test from "node:test";
import assert from "node:assert/strict";

import { renderHtml, THIN_SECTION_ITEMS } from "../../lib/output/render";
import { MIN_SECTION_ITEMS } from "../../lib/topics/routing";
import {
  article,
  rawNews,
  reportFixture,
} from "./helpers";

/**
 * GOLDEN: the shipped report page structure. These assertions protect
 * every surface shipped in waves 1-4 and the IA increment 2 news block —
 * breaking one fails CI (quality gate) before anything reaches gh-pages.
 */
test("golden: report page structure", async (t) => {
  const html = renderHtml(reportFixture(), rawNews(), "2026-10-27", {
    editionHour: "06",
    siblingHours: ["06", "13", "19"],
    sentimentContext: {
      trendScores: [-10, -30, -45, -91],
      trendAccumulated: 4,
      trendNeeded: 20,
      review: null,
    },
  });

  await t.test("all shipped tabs present", () => {
    // The two news lanes replace the old category tabs as entry points;
    // trading/community/tech remain conditional on data presence.
    for (const tab of [
      "zh",
      "external",
      "review",
      "sentiment",
      "techread",
      "personas",
      "risk",
      "school",
      "knowledge",
      "mcp",
    ]) {
      assert.ok(
        html.includes(`data-tab="${tab}"`),
        `tab ${tab} missing`,
      );
    }
  });

  await t.test("topic sections render in the locked order, per lane", () => {
    const order = ["全球市场", "国际时政", "科技AI", "政策政务", "公司公告", "观点解读"];

    // Chinese lane: all six topics.
    const zhPanel = html.slice(html.indexOf('data-panel="zh"'), html.indexOf('data-panel="external"'));
    const zhHeadings = [...zhPanel.matchAll(/class="topic-heading">([^<]+)/g)].map((m) => m[1]);
    assert.deepEqual(zhHeadings, order);

    // External lane: only the three topics the fixture supplies.
    const extPanel = html.slice(html.indexOf('data-panel="external"'));
    const extHeadings = [...extPanel.matchAll(/class="topic-heading">([^<]+)/g)].map((m) => m[1]);
    assert.deepEqual(extHeadings, order.slice(0, 3));
  });

  await t.test("empty topic sections are omitted, never rendered as shells", () => {
    // The external lane has no policy/filings/opinion sections in this fixture.
    const extPanel = html.slice(html.indexOf('data-panel="external"'));
    assert.ok(!extPanel.includes('data-topic="policy"'));
    assert.ok(!extPanel.includes('data-topic="filings"'));
    assert.ok(!extPanel.includes('data-topic="opinion"'));
    // And no empty-category placeholder text anywhere in the news block.
    assert.ok(!html.includes("该分类今日无内容。"));
  });

  await t.test("section composition is readable from the markup", () => {
    const sections = [...html.matchAll(/data-topic="([a-z-]+)" data-lane="([a-z]+)" data-available="(\d+)" data-rendered="(\d+)"/g)];
    assert.ok(sections.length >= 9, `expected >=9 sections, got ${sections.length}`);
    for (const [, topic, laneName, available, rendered] of sections) {
      assert.ok(Number(rendered) > 0, `${laneName}/${topic} rendered empty`);
      assert.ok(Number(available) >= Number(rendered));
      assert.ok(Number(rendered) <= 8, `${laneName}/${topic} exceeded the section cap`);
    }
  });

  await t.test("the 按来源 escape hatch is present and compact", () => {
    assert.ok(html.includes('data-view="topic"'));
    assert.ok(html.includes('data-view="source"'));
    assert.ok(html.includes('class="lane-view lane-view-topic active"'));
    // Source view rows are headline-only; the topic view holds the excerpts.
    assert.ok(html.includes("article-compact"));
  });

  await t.test("morning brief card renders in hero", () => {
    assert.ok(html.includes('class="lead-badge"'));
    assert.ok(html.includes("编辑定调 · DW 中文"));
    assert.ok(html.includes('class="hero-morning"'));
    assert.ok(html.includes("2026-10-26/19"));
    assert.ok(html.includes("+8"));
    assert.ok(html.includes("MLF"));
    assert.ok(html.includes("茅台发布增持公告"));
    assert.ok(html.includes("盘前要闻"));
    assert.ok(html.includes("产业链企业回应"));
    assert.ok(html.includes("资金动向"));
    assert.ok(html.includes("银行 +12.3亿"));
    assert.ok(html.includes("题材热点"));
    assert.ok(html.includes("龙虎榜"));
    assert.ok(html.includes("银之杰"));
    assert.ok(html.includes("净买 4.64亿"));
  });

  await t.test("sentiment panel: gauge, trend, sectors, percentile", () => {
    assert.ok(html.includes("senti-bar"));
    assert.ok(html.includes("senti-trend"));
    assert.ok(html.includes("senti-marker"));
    assert.ok(html.includes("情绪驱动词"));
    assert.ok(html.includes("板块情绪"));
    assert.ok(html.includes("A 股蓝筹"));
    assert.ok(html.includes("大盘综合"));
    assert.ok(html.includes("第 <b>12</b> 百分位"));
  });

  await t.test("briefs render with source labels", () => {
    assert.ok(html.includes("央行开展 5000 亿元 MLF 操作"));
    assert.ok(html.includes("测试源"));
  });

  await t.test("reading depth toggle present, deep default unchanged", () => {
    assert.ok(html.includes('data-depth="quick"'));
    assert.ok(html.includes('data-depth="deep"'));
    assert.ok(html.includes('opencool-read-depth'));
    assert.ok(html.includes('body.read-quick .panel[data-panel="school"]'));
    assert.ok(!html.includes('class="read-quick"'));
  });

  await t.test("edition nav (sibling hours) present", () => {
    assert.ok(html.includes("06:00"));
    assert.ok(html.includes("19:00"));
  });
});

test("golden: backfilled edition is labelled, normal edition is not", async (t) => {
  const opts = { editionHour: "19", siblingHours: ["06", "13", "19"] };
  const normal = renderHtml(reportFixture(), rawNews(), "2026-11-11", opts);
  const backfill = renderHtml(reportFixture(), rawNews(), "2026-11-11", {
    ...opts,
    backfilled: true,
  });

  await t.test("a normal edition carries no backfill badge", () => {
    // The token also appears in the inlined stylesheet, so assert on the
    // badge markup, not the bare class name.
    assert.ok(!normal.includes('class="ed-badge ed-backfill"'));
  });

  await t.test("a backfilled edition is visibly marked", () => {
    assert.ok(backfill.includes('class="ed-badge ed-backfill"'));
    assert.ok(backfill.includes("补发"));
  });
});

/**
 * Backward compatibility: an OLD sidecar-shaped report (no sentiment,
 * no morning_brief, no quant/trading — pre-wave-2 shape) must render
 * without throwing and without the new panels' content.
 */
test("golden: legacy report renders (no new fields)", async (t) => {
  const legacy = reportFixture({
    sentiment: undefined,
    morning_brief: undefined,
    editorial_lead: undefined,
  });
  const html = renderHtml(legacy, rawNews(), "2026-10-26", {
    editionHour: "19",
    siblingHours: ["06", "13", "19"],
  });
  assert.ok(html.includes("data-tab=\"zh\""));
  assert.ok(!html.includes("class=\"hero-morning\""));
  assert.ok(html.includes("市场情绪计尚未生成。") || html.includes("sentiment"));
});

/**
 * Section floor 3 -> 2 (owner decision OC-18): a 2-item section renders and is
 * visibly marked thin; a full 3-item section carries no marker. The marker is
 * the honesty mechanism that replaces withholding — the reader must be able to
 * tell a thin section from a full one at a glance.
 */
test("golden: thin sections are visibly marked, full sections are not", async (t) => {
  const raw = rawNews();
  const zhLane = raw.lanes.find((l) => l.lane === "zh")!;
  const filings = zhLane.sections.find((s) => s.topic === "filings")!;
  filings.items = filings.items.slice(0, 2);
  filings.available = 2;
  zhLane.count = zhLane.sections.reduce((n, s) => n + s.items.length, 0);

  const html = renderHtml(reportFixture(), raw, "2026-11-14", {
    editionHour: "06",
    siblingHours: ["06", "13", "19"],
  });

  await t.test("the 2-item section carries the thin marker and data attribute", () => {
    const panel = html.slice(html.indexOf('data-topic="filings"'), html.indexOf('data-topic="opinion"'));
    assert.ok(panel.includes('data-thin="true"'), "missing data-thin attribute");
    assert.ok(panel.includes('class="thin-mark"'), "missing the thin badge");
    assert.ok(panel.includes("内容较少"), "missing the localized thin copy");
    assert.ok(
      panel.includes(`title="${"该栏目今日内容较少，低于 3 条的常规版面标准。"}"`),
      "missing the localized tooltip",
    );
  });

  await t.test("the 3-item sections carry no thin marker", () => {
    const markets = html.slice(html.indexOf('data-topic="global-markets"'), html.indexOf('data-topic="world"'));
    assert.ok(!markets.includes("thin-mark"));
    assert.ok(!markets.includes('data-thin="true"'));
    // Exactly one thin section in this fixture.
    assert.equal((html.match(/class="thin-mark"/g) ?? []).length, 1);
  });

  await t.test("the thin threshold sits above the render floor", () => {
    // If THIN_SECTION_ITEMS ever drops to the floor, every rendered section
    // would be "thin" (or none could be) and the marker would stop meaning
    // anything.
    assert.ok(THIN_SECTION_ITEMS > MIN_SECTION_ITEMS);
  });
});
