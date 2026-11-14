import test from "node:test";
import assert from "node:assert/strict";

import {
  exactStoryKey,
  storyCluster,
  dedupeStories,
  headlineAffinity,
  profileHeadline,
  sameStoryHeadlines,
  NEAR_DUPLICATE_THRESHOLD,
  GENERIC_HEADLINE_TOKENS,
  GENERIC_TOKEN_WEIGHT,
  NUMERIC_TOKEN_WEIGHT,
  IDENTITY_CONFLICT_AFFINITY,
  SAME_DAY_ENTITY_AFFINITY,
  SAME_EVENT_AFFINITY,
  REWORDED_REPEAT_AFFINITY,
  TEMPLATE_MATCH_AFFINITY,
} from "../../lib/topics/dedupe";

/**
 * v2 identity primitives, measured on the real corpus. Every fixture below
 * is a real failure class found in the published ledger (see
 * `tests/fixtures/clustering-pairs.json`); the labeled-set measurement that
 * proves the rates lives in `tests/golden/topics-shadow.test.ts`.
 */

test("dedupe: weighted tokenizer keeps numbers whole and dates generic", () => {
  // The leading wire date (`财联社11月13日电`) is stripped by normalizeTitle
  // before anything else; an *interior* date must fold into one generic token.
  const d = profileHeadline("美国11月13日当周石油钻井数 463，前值 463。");
  assert.ok(d.tokens.has("date:11月13日"), "interior date phrase folded");
  assert.equal(d.tokens.get("date:11月13日"), GENERIC_TOKEN_WEIGHT);

  const p = profileHeadline("日本5年期国债收益率上升7个基点至2.265%。");
  // the tenor is an instrument token, not a quantity
  assert.ok(p.tenors.has("5年期"));
  // quantities stay whole (decimals intact) and carry numeric weight
  assert.equal(p.tokens.get("2.265"), NUMERIC_TOKEN_WEIGHT);
  assert.ok(p.tokens.get("7"), "the 7 基点 count survived");
  assert.ok(p.quantities.has("2.265"));
  assert.ok(!p.quantities.has("5年期"), "tenors are not quantities");
  // thousands commas fold into the number, not into junk tokens
  const c = profileHeadline("和硕10月销售额1,880.8亿元台币");
  assert.ok(c.quantities.has("1880.8"), "comma thousands folded");

  const q = profileHeadline("纳指ETF嘉实(159501)将于2026年11月11日开市起至当日10:30停牌。");
  assert.ok(q.ids.has("159501"), "bracketed fund code lifted as identifier");
  assert.ok(q.ids.has("2026年11月11日") === false, "dates are not identifiers");
  assert.ok(q.quantities.has("10") && q.quantities.has("30"), "times are quantities");
});

test("dedupe: generic beat vocabulary is down-weighted", () => {
  const p = profileHeadline("美股三大指数收涨 纳指涨超2%");
  assert.equal(p.tokens.get("美股"), GENERIC_TOKEN_WEIGHT);
  assert.equal(p.tokens.get("指数"), GENERIC_TOKEN_WEIGHT);
  // direction words are NOT generic — they are the identity
  assert.equal(p.tokens.get("收涨"), 1);
  assert.ok(GENERIC_HEADLINE_TOKENS.includes("markets"));
});

test("dedupe: identity conflicts collapse affinity below every gate", () => {
  const conflict = (a: string, b: string) => headlineAffinity(a, b) <= IDENTITY_CONFLICT_AFFINITY;

  // different fund codes inside an otherwise identical halt notice
  assert.ok(
    conflict(
      "财联社11月10日电，纳指ETF嘉实(159501)将于2026年11月11日开市起至当日10:30停牌。",
      "财联社11月10日电，纳指ETF广发(159941)将于2026年11月11日开市起至当日10:30停牌。",
    ),
    "different fund codes",
  );
  // different tenors of the same yield move
  assert.ok(
    conflict(
      "财联社11月13日电，日本10年期国债收益率上升7个基点至2.86%。",
      "财联社11月13日电，日本5年期国债收益率上升7个基点至2.265%。",
    ),
    "different tenors",
  );
  // opposite directions on an identical template
  assert.ok(conflict("美股三大指数集体收涨 纳指涨超2%", "美股三大指数集体收跌 纳指跌超2%"));
  assert.ok(conflict("Gold rallies on Fed cut bets", "Gold falls on Fed cut bets"));
  // opposite asset classes in an identical flow template
  assert.ok(
    conflict(
      "日本11月6日当周外资净买进日本股票 -1052亿日元，前值 11293亿日元。",
      "日本11月6日当周外资净买进日本债券 13711亿日元，前值 14817亿日元。",
    ),
    "equity flow vs debt flow",
  );
  // different tracked entities on an identical template
  assert.ok(conflict("微软发布新产品线公告", "苹果发布新产品线公告"));
  // same template, different datapoint number
  assert.ok(conflict("国内黄金克价跌破890元", "国内黄金克价跌破860元"));
  assert.ok(
    conflict(
      "某上市公司第0号自愿性信息披露公告发布",
      "某上市公司第1号自愿性信息披露公告发布",
    ),
  );
});

test("dedupe: identity conflicts do not fire on genuine reworded repeats", () => {
  // intraday update moved the number but reworded the verb — same debut story
  assert.ok(
    headlineAffinity(
      "Swiss Respiratory Biotech Windward Soars 68% in US Trading Debut",
      "Swiss Respiratory Biotech Windward Up 7.9% in US Trading Debut",
    ) > REWORDED_REPEAT_AFFINITY,
    "same-event number drift stays mergeable",
  );
  // cross-wire rewording keeps its numbers, so no quantity disagreement
  assert.ok(
    headlineAffinity(
      "财联社11月12日电，日本至11月6日当周外资买进日股-1052亿日元，前值11293亿日元。",
      "日本11月6日当周外资净买进日本股票 -1052亿日元，前值 11293亿日元。",
    ) > REWORDED_REPEAT_AFFINITY,
  );
  assert.ok(headlineAffinity("某上市公司第1号自愿性信息披露公告发布", "某上市公司第1号公告（更新）") > 0);
});

test("dedupe: sameStoryHeadlines applies the three gates", async (t) => {
  await t.test("exact surface key is the true repeat", () => {
    assert.ok(sameStoryHeadlines("新世界发展在香港暂停交易", "新世界发展在香港暂停交易。"));
    assert.ok(sameStoryHeadlines("财联社11月13日电，新世界发展在香港暂停交易。", "新世界发展在香港暂停交易。"));
  });

  await t.test("same entity, same day: temporal corroboration lowers the gate", () => {
    // the ledger spec's own pair — 0.089 affinity, same day, same entity
    assert.ok(
      sameStoryHeadlines(
        "Nvidia board weighs replacing Jensen Huang",
        "Nvidia stock falls as succession talk swirls",
        0,
      ),
    );
  });

  await t.test("same entity, different days: the full gate applies", () => {
    // 华为's ten days of distinct stories must not merge
    assert.ok(
      !sameStoryHeadlines("华为智驾之外，车企给出Plan B", "华为云即将于本月中旬更新上线盘古模型开源版本", 1),
    );
    // a genuine cross-day continuation with shared distinctive vocabulary merges
    assert.ok(
      sameStoryHeadlines(
        "中芯国际：前三季度归母净利润73.14亿元，同比增长91.6%",
        "中芯国际：前三季度归母净利73.14亿元 同比增长91.6%",
        1,
      ),
    );
  });

  await t.test("cross-cluster reworded repeats merge at the fuzzy gate", () => {
    assert.ok(
      sameStoryHeadlines(
        "Bessent blames Lutnick's Commerce Department for failing to block Megaspeed",
        "Bessent blames Lutnick’s commerce department for failure to blacklist Megaspeed",
      ),
    );
    assert.ok(
      sameStoryHeadlines(
        "Man United sack head coach Michael Carrick after dismal run of results",
        "Manchester United sack Michael Carrick as manager",
      ),
    );
  });

  await t.test("cross-language same-entity same-day relay merges", () => {
    assert.ok(sameStoryHeadlines("英伟达财报超预期，盘后大涨", "Nvidia earnings beat estimates, shares jump", 0));
  });

  await t.test("different entities never merge, however similar the template", () => {
    assert.ok(!sameStoryHeadlines("微软发布新产品线公告", "苹果发布新产品线公告", 0));
    assert.ok(!sameStoryHeadlines("英伟达股价大涨", "特斯拉股价大涨", 0));
  });
});

test("dedupe: shipped gates are the documented constants", () => {
  // Pinned so a retune is a deliberate act: the labeled-set golden test in
  // tests/golden/topics-shadow.test.ts fails if these move without proof.
  assert.equal(NEAR_DUPLICATE_THRESHOLD, 0.65);
  assert.equal(SAME_DAY_ENTITY_AFFINITY, 0.08);
  assert.equal(SAME_EVENT_AFFINITY, 0.35);
  assert.equal(REWORDED_REPEAT_AFFINITY, 0.2);
  assert.equal(TEMPLATE_MATCH_AFFINITY, 0.85);
  assert.equal(GENERIC_TOKEN_WEIGHT, 0.25);
  assert.equal(NUMERIC_TOKEN_WEIGHT, 2);
  assert.equal(IDENTITY_CONFLICT_AFFINITY, 0.05);
});

test("dedupe: panel duck suppression under the weighted affinity", async (t) => {
  await t.test("direction flips on an identical template are never ducks", () => {
    const { kept } = dedupeStories([
      { title: "美股三大指数集体收涨 纳指涨超2%", sourceId: "a" },
      { title: "美股三大指数集体收跌 纳指跌超2%", sourceId: "b" },
    ]);
    assert.equal(kept.length, 2, "opposite moves are two stories");
  });

  await t.test("same-template different-digit flashes are never ducks", () => {
    const { kept } = dedupeStories([
      { title: "季度观察1号观察", sourceId: "a" },
      { title: "季度追踪1号观察", sourceId: "b" },
    ]);
    assert.equal(kept.length, 2);
  });

  await t.test("true reprints still collapse", () => {
    const { kept } = dedupeStories([
      { title: "波罗的海干散货指数跌1.32%，至2980点。", sourceId: "a" },
      { title: "财联社11月13日电，波罗的海干散货运价指数跌1.32%，至2980点。", sourceId: "b" },
    ]);
    assert.equal(kept.length, 1);
  });

  await t.test("truncation/extension of the same sentence collapses", () => {
    const { kept } = dedupeStories([
      { title: "吴清：进一步深化市场稳定长效机制研究", sourceId: "a" },
      { title: "吴清：进一步深化市场稳定长效机制研究 防范市场异常波动", sourceId: "b" },
    ]);
    assert.equal(kept.length, 1);
  });
});
