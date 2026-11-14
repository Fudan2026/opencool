import test from "node:test";
import assert from "node:assert/strict";

import { scoreSentiment, matchText } from "./sentiment";
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
      art("指数止跌，延续盘整"),
    ]);
    // Every 下跌 occurrence is prefix-negated → raw 0 → neutral.
    assert.equal(negated.label, "中性");
    assert.ok(Math.abs(negated.score) < 18);
  });

  await t.test("v2: negation also guards bullish terms", () => {
    const negated = scoreSentiment([
      art("销量不再上涨"),
      art("利润未超预期"),
      art("项目难以回暖"),
      art("盘面没有走高"),
      art("股价失去上涨动力"),
    ]);
    assert.equal(negated.label, "中性");
    assert.equal(negated.raw, 0);
  });

  await t.test("v2: negated compound absorbs its bare component (no 跌 leak)", () => {
    const m = matchText("物价不再下跌");
    assert.deepEqual(m, []);
  });

  await t.test("v2: recovery compounds read positive, not merely un-negative", () => {
    const s = scoreSentiment([
      art("指数止跌回稳"),
      art("地产销售企稳回升"),
      art("消费复苏"),
      art("外贸回暖"),
      art("政策宽松"),
    ]);
    assert.ok(s.score > 18, `止跌/企稳 should read positive, got ${s.score}`);
    assert.ok(s.label.includes("偏多"));
  });

  await t.test("sector buckets: watchlist hits land in groups", () => {
    const s = scoreSentiment([
      art("贵州茅台获大单增持", "白酒龙头利好"),
      art("茅台批价回暖"),
      art("宁德时代中标储能项目"),
      art("外盘：market selloff on default risk"),
      art("上证指数走弱，大盘下跌"),
      art(" totally unrelated general news without any tickers "),
    ]);
    const keys = s.sectors.map((x) => x.key);
    assert.ok(keys.includes("china-ashare"), `got ${keys}`);
    const ashare = s.sectors.find((x) => x.key === "china-ashare")!;
    assert.ok(ashare.articles >= 3);
    assert.ok(ashare.topDrivers.length > 0);
    // overall fields unchanged (backward compatible shape)
    assert.equal(typeof s.score, "number");
    assert.ok(Array.isArray(s.drivers));
  });

  await t.test("general bucket catches articles with no watchlist hit", () => {
    const s = scoreSentiment([
      art("央行发布新规利好债市"),
      art("外资加仓中国资产，市场回暖"),
      art("政策超预期，市场大涨"),
      art("某行业订单获批复苏"),
      art("关注产业链提价"),
    ]);
    const general = s.sectors.find((x) => x.key === "general");
    assert.ok(general);
    assert.equal(general.articles, 5);
    assert.ok(general.score > 0);
  });

  await t.test("percentile is null without history floor", () => {
    assert.equal(scoreSentiment([art("大涨")]).percentile, null);
    const history = Array.from({ length: 19 }, (_, i) => i - 9);
    const s19 = scoreSentiment([art("市场回暖"), art("反弹持续"), art("利好落地"), art("普涨"), art("走强")], history);
    assert.equal(s19.percentile, null);
    const history20 = [...history, 0];
    const s20 = scoreSentiment([art("市场回暖"), art("反弹持续"), art("利好落地"), art("普涨"), art("走强")], history20);
    assert.ok(s20.percentile !== null);
    assert.equal(s20.percentile, 100); // above every sample
  });

  await t.test("anti-pinning: dense bearish corpus stays above -100", () => {
    // 30 articles, each title carrying 大跌(-2) + 担忧(-1), title x2 →
    // per-article raw = -6, total -180. The additive scale would pin at
    // -100 (|raw| ≫ 30); mean-tone lands at -96 with headroom left.
    const arts = Array.from({ length: 30 }, (_, i) =>
      art(`市场大跌引发担忧 ${i}`),
    );
    const s = scoreSentiment(arts);
    assert.ok(s.score > -100, `pinned at ${s.score}`);
    assert.ok(s.score < -30, `should be strongly bearish, got ${s.score}`);
    assert.ok(s.label.includes("强偏空"));
    assert.equal(s.raw, -180);
  });

  await t.test("monotonicity: adding bearish articles never raises score", () => {
    const base = [
      art("板块普涨 市场回暖"),
      art("公司中标 获批大单"),
      art("外资增持 回购活跃"),
      art("行业景气 复苏提速"),
      art("政策利好 预期上调"),
    ];
    const moreNegative = [
      ...base,
      art("指数大跌 市场暴跌"),
      art("个股跳水 违约风险"),
    ];
    assert.ok(
      scoreSentiment(moreNegative).score <= scoreSentiment(base).score,
    );
  });

  await t.test("quiet realistic mix lands in neutral band", () => {
    // Production-like density: most headlines carry no lexicon terms.
    const arts = [
      art("某公司发布公告"),
      art("央行开展公开市场操作"),
      art("指数小幅波动 成交持平"),
      art("上市公司披露年报"),
      art("机构调研热度上升"),
      art("发改委印发方案"),
      art("港股通标的调整"),
    ];
    const s = scoreSentiment(arts);
    assert.equal(s.label, "中性");
    assert.ok(Math.abs(s.score) < 8);
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

  await t.test("v2: latin terms match as whole words only", () => {
    // "surgeon" must not fire "surge"; a true market surge must.
    assert.deepEqual(matchText("surgeon saved officer's life"), []);
    assert.ok(matchText("stocks surge after beat").some((m) => m.term === "surge"));
    assert.ok(matchText("record high").some((m) => m.term === "record high"));
  });

  await t.test("v2: english negation guards both polarities", () => {
    const m = matchText("deepseek won't sink u.s. ai titans");
    assert.deepEqual(m, [], "won't sink should be damped");
    assert.ok(
      !matchText("why barclays cut gartner despite a 27% rally in its shares").some(
        (m2) => m2.term === "rally",
      ),
      "despite-guarded rally should be damped",
    );
  });

  await t.test("v2: hedge 或 damps a maybe-move", () => {
    assert.deepEqual(matchText("PPI或见顶"), []);
    assert.deepEqual(matchText("油价或上涨"), [], "油价或上涨 should be damped");
    assert.ok(
      matchText("油价上涨").some((m) => m.term === "上涨"),
      "油价上涨 without hedge still fires",
    );
  });

  await t.test("v2: absorbers block component false-fires", () => {
    // 减速机/减速器 are gearboxes, not slowdowns.
    assert.deepEqual(
      matchText("产品覆盖rv减速机、谐波减速器、行星减速器").filter((m) => m.weight !== 0),
      [],
    );
    assert.ok(matchText("出口增速减速").some((m) => m.term === "减速"));
  });

  await t.test("v2: context-flip compounds beat their component words", () => {
    const cost = matchText("存储成本飙升，成本飙升加剧压力");
    assert.ok(cost.some((m) => m.term === "成本飙升" && m.weight < 0));
    assert.ok(!cost.some((m) => m.term === "飙升"), "飙升 must be absorbed inside 成本飙升");
    const cpi = matchText("美国通胀回落，物价回落缓解压力");
    assert.ok(cpi.some((m) => m.term === "通胀回落" && m.weight > 0));
  });
});
