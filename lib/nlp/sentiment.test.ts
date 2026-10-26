import test from "node:test";
import assert from "node:assert/strict";

import { scoreSentiment } from "./sentiment";
import type { ArticleInput } from "../ai/pipeline";

function art(title: string, excerpt = ""): ArticleInput {
  return {
    sourceId: "test",
    title,
    excerpt,
    url: "https://example.com",
    category: "finance",
    source: "test",
  } as ArticleInput;
}

test("sentiment gauge", async (t) => {
  await t.test("bullish headlines score positive", () => {
    const s = scoreSentiment([
      art("三大指数集体反弹，沪指大涨2%"),
      art("宁德时代中标海外大单，股价涨停"),
      art("消费复苏提速，白酒板块普涨"),
      art("央行发声利好市场预期"),
      art("北向资金增持金融股"),
      art("外盘：stocks surge after record high"),
    ]);
    assert.ok(s.score > 18, `score should be bullish, got ${s.score}`);
    assert.ok(s.label.includes("偏多"));
    assert.ok(s.posHits > 0);
    assert.equal(s.scanned, 6);
  });

  await t.test("bearish headlines score negative", () => {
    const s = scoreSentiment([
      art("某公司业绩爆雷，股价跌停"),
      art("外围市场暴跌，A股走低"),
      art("减持公告密集发布"),
      art("监管处罚落地"),
      art("行业增速失速担忧升温"),
      art("US futures slump on default risk"),
    ]);
    assert.ok(s.score < -18, `score should be bearish, got ${s.score}`);
    assert.ok(s.label.includes("偏空"));
    assert.ok(s.negHits > 0);
  });

  await t.test("tiny sample reads neutral with note", () => {
    const s = scoreSentiment([art("大涨")]);
    assert.equal(s.label, "中性");
    assert.ok(s.note.includes("样本不足"));
  });

  await t.test("negation guard skips prefix-negated bearish terms", () => {
    const negated = scoreSentiment([
      art("物价不再下跌"),
      art("出口未下跌"),
      art("基金难下跌"),
      art("盘面无下跌"),
      art("指数止跌回稳"),
    ]);
    // Every 下跌 occurrence is prefix-negated → raw 0 → neutral.
    assert.equal(negated.label, "中性");
    assert.ok(Math.abs(negated.score) < 18);
  });

  await t.test("longest term wins: 创历史新高 over 新高", () => {
    const s = scoreSentiment([
      art("沪指创历史新高"),
      art("创业板创新高"),
      art("成交额创历史新高"),
      art("多指数创新高"),
      art("两融余额创新高"),
    ]);
    assert.ok(s.score > 0);
    const drivers = s.drivers.map((d) => d.term);
    assert.ok(drivers.includes("创历史新高"));
    assert.ok(drivers.includes("创新高"));
    assert.ok(!drivers.includes("新高"), "新高 should be absorbed by longer terms");
  });
});
