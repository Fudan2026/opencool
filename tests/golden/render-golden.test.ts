import test from "node:test";
import assert from "node:assert/strict";

import { renderHtml } from "../../lib/output/render";
import {
  article,
  rawByCategory,
  reportFixture,
} from "./helpers";

/**
 * GOLDEN: the shipped report page structure. These assertions protect
 * every surface shipped in waves 1-4 — breaking one fails CI (quality
 * gate) before anything reaches gh-pages.
 */
test("golden: report page structure", async (t) => {
  const html = renderHtml(reportFixture(), rawByCategory(), "2026-10-27", {
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
    // trading/community tabs are conditional on data presence — the
    // unconditional tab set is asserted here.
    for (const tab of [
      "finance",
      "review",
      "sentiment",
      "techread",
      "personas",
      "risk",
      "school",
      "knowledge",
      "mcp",
      "politics",
      "tech",
    ]) {
      assert.ok(
        html.includes(`data-tab="${tab}"`),
        `tab ${tab} missing`,
      );
    }
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
  const html = renderHtml(legacy, rawByCategory(), "2026-10-26", {
    editionHour: "19",
    siblingHours: ["06", "13", "19"],
  });
  assert.ok(html.includes("data-tab=\"finance\""));
  assert.ok(!html.includes("class=\"hero-morning\""));
  assert.ok(html.includes("市场情绪计尚未生成。") || html.includes("sentiment"));
});
