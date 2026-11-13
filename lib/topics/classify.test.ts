import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyArticle,
  classifyAll,
  normalizeTitle,
  LOW_CONFIDENCE,
} from "../../lib/topics/classify";
import {
  LANES,
  LANE_KEYS,
  LEGACY_TOPIC_MIGRATION,
  TOPIC_KEYS,
  TOPICS,
  isLaneKey,
  isTopicKey,
  laneLabel,
  topicLabel,
  FALLBACK_TOPIC_BY_CATEGORY,
  FALLBACK_TOPIC_BY_SUBCATEGORY,
} from "../../lib/topics/taxonomy";

/**
 * TOPICS: the shadow-mode router, now on two orthogonal axes.
 *
 *   lane    "zh" | "external"  — the *language* of the content
 *   topic   one of six         — venue-independent subject
 *   domestic boolean           — China-orientation tag on top of both
 *
 * Headlines come from published edition sidecars (2026-11-13 06:00 / 13:00) or
 * from the IA audit's canonical shapes, so a regression here means a routing
 * change a reader would eventually see in increment 2.
 */

interface Case {
  name: string;
  title: string;
  excerpt?: string;
  category?: "tech" | "finance" | "politics";
  subcategory?: string;
  expectLane: string;
  /** Omit to assert only the lane axis. */
  expectTopic?: string;
  /** Omit to skip the domestic assertion for genuinely ambiguous items. */
  expectDomestic?: boolean;
}

const CASES: Case[] = [
  // ── The owner's three named acceptance cases ────────────────────────────
  {
    // Chinese language, offshore subject: the lane is zh *and* the topic is
    // global-markets. This is the case the old flat taxonomy could not express.
    name: "owner case A: Chinese-language story about US markets",
    title: "美股三大指数集体收涨 纳指涨超2% 市场押注美联储降息",
    expectLane: "zh",
    expectTopic: "global-markets",
    expectDomestic: false,
  },
  {
    // Chinese language, Chinese policy subject: lane zh, topic policy, domestic.
    name: "owner case B: 央行逆回购 is policy and domestic",
    title: "央行开展 5000 亿元买断式逆回购操作",
    expectLane: "zh",
    expectTopic: "policy",
    expectDomestic: true,
  },
  {
    // English language, Chinese subject: lane external, topic global-markets.
    // The source's country of interest must not decide the lane.
    name: "owner case C: Bloomberg story on China is external lane",
    title: "China Stocks Rally as PBOC Signals More Stimulus for A-Shares",
    excerpt: "The Shanghai Composite rose 2.1% as the central bank eased policy.",
    expectLane: "external",
    expectTopic: "global-markets",
    expectDomestic: true,
  },

  // ── Lane axis, independently of topic ───────────────────────────────────
  {
    name: "lane: Chinese wire copy about Japan is still zh",
    title: "日本10年期国债收益率上升7个基点至2.86%",
    expectLane: "zh",
    expectTopic: "global-markets",
    expectDomestic: false,
  },
  {
    name: "lane: Chinese copy about Korean markets is still zh",
    title: "韩国总统李在明：韩国需要改革KOSDAQ市场。",
    expectLane: "zh",
    expectTopic: "global-markets",
    expectDomestic: false,
  },
  {
    name: "lane: English copy about a Chinese tech firm is external",
    title: "Nvidia rival Huawei unveils new AI chip for data centers",
    expectLane: "external",
    expectTopic: "tech-ai",
    expectDomestic: true,
  },
  {
    name: "lane: English wire copy of a global story is external",
    title: "Iran war live: Trump says Gulf allies urged pause in Iran strikes",
    expectLane: "external",
    expectTopic: "world",
    expectDomestic: false,
  },
  {
    name: "lane: mixed title with CJK decides zh",
    title: "T早报｜黄仁勋辞职；新加坡公布Megaspeed调查始末",
    expectLane: "zh",
  },

  // ── Topic axis, per topic, both languages ───────────────────────────────
  {
    name: "global-markets: A-share index print, domestic",
    title: "A股三大指数集体收涨 沪指涨1.2% 成交额破万亿",
    expectLane: "zh",
    expectTopic: "global-markets",
    expectDomestic: true,
  },
  {
    name: "global-markets: US Treasury yields",
    title: "Treasury yields rise as traders strengthen Fed rate hike bets",
    expectLane: "external",
    expectTopic: "global-markets",
    expectDomestic: false,
  },
  {
    name: "global-markets: commodity squeeze",
    title: "托克大举建仓LME铝多头，市场陷入数十年来最严峻逼仓局面",
    expectLane: "zh",
    expectTopic: "global-markets",
    expectDomestic: false,
  },
  {
    name: "policy: NDRC plan",
    title: "发改委印发《“十五五”新型储能实施方案》",
    expectLane: "zh",
    expectTopic: "policy",
    expectDomestic: true,
  },
  {
    name: "policy: central-bank instrument is policy, not markets",
    title: "央行宣布下调存款准备金率 0.5 个百分点",
    expectLane: "zh",
    expectTopic: "policy",
    expectDomestic: true,
  },
  {
    name: "policy: regulator enforcement",
    title: "证监会拟对财务造假公司从重处罚 并约谈相关中介机构",
    expectLane: "zh",
    expectTopic: "policy",
    expectDomestic: true,
  },
  {
    name: "tech-ai: Nvidia CEO resignation",
    title: "英伟达首席执行官黄仁勋辞职",
    expectLane: "zh",
    expectTopic: "tech-ai",
    expectDomestic: false,
  },
  {
    name: "tech-ai: US AI capex, English",
    title: "Cerebras surges 17% after beating on quarterly revenue and announcing Microsoft deal",
    expectLane: "external",
    expectTopic: "tech-ai",
    expectDomestic: false,
  },
  {
    name: "tech-ai: model release",
    title: "不用Flash命名，谷歌发布Gemini 4 Hydrogen：幻觉减少5倍，速度翻倍",
    expectLane: "zh",
    expectTopic: "tech-ai",
    expectDomestic: false,
  },
  {
    name: "filings: issuer-prefixed buyback",
    title: "沪电股份：取得9亿元回购专项贷款承诺函",
    expectLane: "zh",
    expectTopic: "filings",
    expectDomestic: true,
  },
  {
    name: "filings: stock code + filing verb",
    title: "600519 贵州茅台关于回购股份的公告",
    expectLane: "zh",
    expectTopic: "filings",
    expectDomestic: true,
  },
  {
    name: "filings: cross-border deal stays filings and is domestic",
    title: "京东22亿欧元收购德国Ceconomy交易获批",
    expectLane: "zh",
    expectTopic: "filings",
    expectDomestic: true,
  },
  {
    name: "filings: English earnings beat",
    title: "Cisco beats on earnings, says AI infrastructure revenue will double this fiscal year",
    expectLane: "external",
    expectTopic: "filings",
    expectDomestic: false,
  },
  {
    name: "opinion: broker note",
    title: "中信证券：英伟达高管变局如何影响中国科技资产",
    expectLane: "zh",
    expectTopic: "opinion",
    expectDomestic: true,
  },
  {
    name: "opinion: interview",
    title: "对话林肯贾鸣镝：传统豪车等来了反击的机会",
    expectLane: "zh",
    expectTopic: "opinion",
  },
  {
    name: "opinion: Economist essay shape",
    title: "The future of Trumponomics: compromise or failure",
    expectLane: "external",
    expectTopic: "opinion",
    expectDomestic: false,
  },
  {
    name: "world: ceasefire diplomacy",
    title: "U.S. envoys meet with Putin in the Kremlin after Ukraine talks in Abu Dhabi",
    expectLane: "external",
    expectTopic: "world",
    expectDomestic: false,
  },
  {
    name: "world: Chinese-language geopolitics",
    title: "“雅尔塔2.0”？中美俄可能的三方峰会引发担忧",
    expectLane: "zh",
    expectTopic: "world",
  },
  {
    name: "world: election result",
    title: "Mississippi elects first black senator in nearly 150 years",
    expectLane: "external",
    expectTopic: "world",
    expectDomestic: false,
  },

  // ── Documented precedence decisions ─────────────────────────────────────
  {
    // Tech lexicon (rule 4) outranks opinion shape (rule 6).
    name: "precedence: analysis column about a tech subject stays tech",
    title: "Analysis: Nvidia’s leadership crisis tests the chipmaker’s role as the ‘central bank of AI’",
    expectLane: "external",
    expectTopic: "tech-ai",
  },
  {
    // Market noun (rule 3) outranks opinion shape (rule 6).
    name: "precedence: hedge-fund column is market copy",
    title: "Lessons from a miserable month for hedge funds",
    expectLane: "external",
    expectTopic: "global-markets",
  },
  {
    name: "precedence: filing shape outranks a stray tech term",
    title: "英伟达概念股沪电股份：回购 9 亿元",
    expectLane: "zh",
    expectTopic: "filings",
    expectDomestic: true,
  },
  {
    // `stake` alone fired on the idiom "at stake" in an earlier revision.
    name: "regression: the idiom 'at stake' is not a corporate stake",
    title: "What’s at stake in the renewed tensions over the Falkland Islands?",
    excerpt: "Argentina and the UK are in a legal battle over an offshore oil-drilling project.",
    expectLane: "external",
    expectTopic: "world",
    expectDomestic: false,
  },

  // ── Ambiguous / weak evidence ───────────────────────────────────────────
  {
    name: "ambiguous: market-outlook question resolves to markets",
    title: "黄仁勋走了 会不会带崩美股？",
    expectLane: "zh",
    expectTopic: "global-markets",
  },
  {
    name: "ambiguous: weather copy is world, not finance",
    title: "南方大范围降雨持续部分地区有暴雨 明起两股冷空气接连来袭",
    expectLane: "zh",
    expectTopic: "world",
    expectDomestic: true,
  },
  {
    name: "ambiguous: no lexical signal falls back to source subcategory",
    title: "Dev Deep Dive: Expedition - Phase 1",
    category: "finance",
    subcategory: "x-mirror",
    expectLane: "external",
    expectTopic: "tech-ai",
  },
];

test("topics: taxonomy is well-formed on both axes", async (t) => {
  await t.test("two lanes, six topics, unique keys, bilingual labels", () => {
    assert.equal(LANES.length, 2);
    assert.deepEqual([...LANE_KEYS].sort(), ["external", "zh"]);
    assert.equal(TOPICS.length, 6);
    assert.equal(new Set(TOPIC_KEYS).size, 6);

    for (const def of LANES) {
      assert.ok(def.zh.length > 0, `${def.key} missing zh label`);
      assert.ok(def.en.length > 0, `${def.key} missing en label`);
      assert.notEqual(def.en, def.zh, `${def.key} en label duplicates zh`);
    }
    for (const def of TOPICS) {
      assert.ok(def.zh.length > 0, `${def.key} missing zh label`);
      assert.ok(def.en.length > 0, `${def.key} missing en label`);
      assert.notEqual(def.en, def.zh, `${def.key} en label duplicates zh`);
    }
  });

  await t.test("topics match the corrected taxonomy exactly", () => {
    assert.deepEqual([...TOPIC_KEYS].sort(), [
      "filings",
      "global-markets",
      "opinion",
      "policy",
      "tech-ai",
      "world",
    ]);
  });

  await t.test("cn-finance is retired from the topic axis", () => {
    assert.equal(isTopicKey("cn-finance"), false);
    // …but a persisted value still translates, so consumers are not stranded.
    assert.deepEqual(LEGACY_TOPIC_MIGRATION["cn-finance"], {
      lane: "zh",
      topic: "global-markets",
      domestic: true,
    });
  });

  await t.test("every legacy key migrates to a live lane and topic", () => {
    for (const [legacy, mapped] of Object.entries(LEGACY_TOPIC_MIGRATION)) {
      assert.ok(isLaneKey(mapped.lane), `${legacy} → bad lane`);
      assert.ok(isTopicKey(mapped.topic), `${legacy} → bad topic`);
      assert.equal(typeof mapped.domestic, "boolean");
    }
  });

  await t.test("lanes and topics are independent (no key appears in both)", () => {
    for (const lane of LANE_KEYS) {
      assert.equal(isTopicKey(lane), false, `${lane} leaked into topics`);
    }
    for (const topic of TOPIC_KEYS) {
      assert.equal(isLaneKey(topic), false, `${topic} leaked into lanes`);
    }
  });

  await t.test("labels honour the locale argument", () => {
    assert.equal(laneLabel("zh", "zh"), "中文财经");
    assert.equal(laneLabel("zh", "en"), "Chinese-Language");
    assert.equal(laneLabel("external", "zh"), "外电原文");
    assert.equal(laneLabel("external", "en"), "External Wire");
    assert.equal(topicLabel("global-markets", "zh"), "全球市场");
    assert.equal(topicLabel("global-markets", "en"), "Global Markets");
    assert.equal(topicLabel("world", "zh"), "国际时政");
  });

  await t.test("fallback maps only name live topics", () => {
    for (const topic of Object.values(FALLBACK_TOPIC_BY_CATEGORY)) {
      assert.ok(isTopicKey(topic), `category fallback → ${topic}`);
    }
    for (const [sub, topic] of Object.entries(FALLBACK_TOPIC_BY_SUBCATEGORY)) {
      assert.ok(isTopicKey(topic), `${sub} → ${topic}`);
    }
  });
});

test("topics: representative headlines route stably on both axes", async (t) => {
  for (const c of CASES) {
    await t.test(`${c.expectLane}/${c.expectTopic} ← ${c.name}`, () => {
      const r = classifyArticle({
        title: c.title,
        excerpt: c.excerpt,
        category: c.category,
        subcategory: c.subcategory,
      });
      assert.equal(r.lane, c.expectLane, `lane for: ${c.title}`);
      if (c.expectTopic !== undefined) {
        assert.equal(
          r.topic,
          c.expectTopic,
          `topic for: ${c.title}\n  matched: ${r.matched.join(", ")}`,
        );
      }
      assert.ok(isLaneKey(r.lane));
      assert.ok(isTopicKey(r.topic));
      assert.ok(r.laneConfidence > 0 && r.laneConfidence <= 1);
      if (c.expectDomestic !== undefined) {
        assert.equal(
          r.domestic,
          c.expectDomestic,
          `domestic for: ${c.title}\n  matched: ${r.matched.join(", ")}`,
        );
      }
    });
  }
});

test("topics: the three owner acceptance cases, stated explicitly", async (t) => {
  await t.test("Chinese-language story about US markets → zh + global-markets", () => {
    const r = classifyArticle({
      title: "美股三大指数集体收涨 纳指涨超2% 市场押注美联储降息",
      excerpt: "道指与标普500同步走高，美元指数回落。",
    });
    assert.equal(r.lane, "zh");
    assert.equal(r.topic, "global-markets");
    assert.equal(r.domestic, false, "a US-markets story is not China-oriented");
  });

  await t.test("央行逆回购 → zh + policy + domestic", () => {
    const r = classifyArticle({ title: "央行开展 5000 亿元买断式逆回购操作" });
    assert.equal(r.lane, "zh");
    assert.equal(r.topic, "policy");
    assert.equal(r.domestic, true);
  });

  await t.test("Bloomberg on China → external + global-markets", () => {
    const r = classifyArticle({
      title: "China Stocks Rally as PBOC Signals More Stimulus for A-Shares",
      excerpt: "The Shanghai Composite rose as the central bank eased policy.",
    });
    assert.equal(r.lane, "external");
    assert.equal(r.topic, "global-markets");
    assert.equal(r.domestic, true);
  });
});

test("topics: lane is language, not venue", async (t) => {
  await t.test("Chinese copy about every offshore venue stays zh", () => {
    const titles = [
      "日本10年期国债收益率上升7个基点至2.86%",
      "美股盘前：英伟达跌约7%，存储芯片股普跌",
      "欧洲央行宣布维持利率不变",
      "韩国总统李在明：韩国需要改革KOSDAQ市场。",
      "特朗普再次出手打伊朗",
    ];
    for (const title of titles) {
      assert.equal(classifyArticle({ title }).lane, "zh", title);
    }
  });

  await t.test("English copy about China stays external", () => {
    const titles = [
      "China Stocks Rally as PBOC Signals More Stimulus",
      "Indebted tycoons haunt China's banking system",
      "Yuan May Double Global Payment Share as Usage Climbs, HSBC Says",
    ];
    for (const title of titles) {
      assert.equal(classifyArticle({ title }).lane, "external", title);
    }
  });

  await t.test("source lang is only a hint when there is no text", () => {
    assert.equal(classifyArticle({ title: "", lang: "zh" }).lane, "zh");
    assert.equal(classifyArticle({ title: "", lang: "en" }).lane, "external");
    // Readable text always outranks the hint.
    assert.equal(
      classifyArticle({ title: "美股收涨", lang: "en" }).lane,
      "zh",
      "text must outrank the source hint",
    );
  });
});

test("topics: domestic is a tag on top of the topic, not a topic", async (t) => {
  await t.test("same topic, different domestic values", () => {
    const cn = classifyArticle({ title: "A股三大指数集体收涨 沪指涨1.2%" });
    const us = classifyArticle({ title: "US stocks close higher as S&P 500 hits record" });
    assert.equal(cn.topic, "global-markets");
    assert.equal(us.topic, "global-markets");
    assert.equal(cn.domestic, true);
    assert.equal(us.domestic, false);
  });

  await t.test("domestic implies no particular topic", () => {
    const seen = new Set<string>();
    for (const title of [
      "央行开展 5000 亿元逆回购操作",
      "发改委印发《“十五五”新型储能实施方案》",
      "沪电股份：取得9亿元回购专项贷款承诺函",
      "A股三大指数集体收涨",
    ]) {
      const r = classifyArticle({ title });
      assert.equal(r.domestic, true, title);
      seen.add(r.topic);
    }
    assert.ok(seen.size >= 3, `expected varied topics, saw ${[...seen].join(",")}`);
  });

  await t.test("no geographic evidence falls back to the lane default", () => {
    const zh = classifyArticle({ title: "涨停", excerpt: "涨停" });
    assert.equal(zh.lane, "zh");
    assert.equal(zh.domesticFallback || zh.domestic === true, true);

    const en = classifyArticle({ title: "Earnings", excerpt: "Quarterly results" });
    assert.equal(en.lane, "external");
  });
});

test("topics: every article gets exactly one lane and one topic, never null", () => {
  for (const c of CASES) {
    const r = classifyArticle({ title: c.title });
    assert.ok(isLaneKey(r.lane), `lane for ${c.title}`);
    assert.ok(isTopicKey(r.topic), `topic for ${c.title}`);
    assert.equal(typeof r.domestic, "boolean");
  }
  for (const title of ["", "   ", "!!!", "a", "1234567890"]) {
    const r = classifyArticle({ title });
    assert.ok(isLaneKey(r.lane));
    assert.ok(isTopicKey(r.topic));
    assert.equal(typeof r.domestic, "boolean");
    assert.ok(r.laneConfidence >= 0 && r.laneConfidence <= 1);
    assert.ok(r.topicConfidence >= 0 && r.topicConfidence <= 1);
  }
});

test("topics: 财联社 / 金十 date prefixes are stripped before matching", async (t) => {
  await t.test("strips 【财联社11月13日电】 bracket form", () => {
    assert.equal(normalizeTitle("【财联社11月13日电】央行开展逆回购"), "央行开展逆回购");
  });

  await t.test("strips 财联社N月N日电， form", () => {
    assert.equal(
      normalizeTitle("财联社11月13日电，新世界发展在香港暂停交易。"),
      "新世界发展在香港暂停交易。",
    );
  });

  await t.test("strips 金十数据 prefix", () => {
    assert.equal(normalizeTitle("金十数据 美联储维持利率不变"), "美联储维持利率不变");
  });

  await t.test("strips a bare leading date only", () => {
    assert.equal(normalizeTitle("11月13日 A股收涨"), "A股收涨");
    assert.equal(normalizeTitle("10月社融数据超预期"), "10月社融数据超预期");
  });

  await t.test("leaves an already-clean title alone", () => {
    assert.equal(normalizeTitle("发改委印发实施方案"), "发改委印发实施方案");
  });

  await t.test("prefix stripping still lets the body route", () => {
    const raw = classifyArticle({ title: "【财联社11月13日电】新世界发展在香港暂停交易。" });
    assert.equal(raw.lane, "zh");
    assert.ok(
      raw.matched.some((m) => m === "暂停交易"),
      `expected 暂停交易 to match, got: ${raw.matched.join(", ")}`,
    );
  });
});

test("topics: fallback is transparently flagged and low-confidence", () => {
  const r = classifyArticle({ title: "Zzz", category: "politics", subcategory: "world" });
  assert.equal(r.topic, "world");
  assert.equal(r.fallback, true);
  assert.ok(r.topicConfidence <= LOW_CONFIDENCE);

  const confident = classifyArticle({ title: "发改委印发新型储能实施方案" });
  assert.equal(confident.fallback, false);
  assert.ok(confident.topicConfidence > LOW_CONFIDENCE);
});

test("topics: classifyAll is additive and never throws", () => {
  const input = [
    { title: "英伟达首席执行官黄仁勋辞职", category: "finance" as const },
    { title: "A股三大指数集体收涨", category: "finance" as const },
    { title: "", category: "tech" as const },
  ];
  const out = classifyAll(input);
  assert.equal(out.length, input.length);
  for (let i = 0; i < out.length; i++) {
    assert.equal(out[i].title, input[i].title);
    assert.equal(out[i].category, input[i].category);
    assert.ok(isLaneKey(out[i].lane));
    assert.ok(isTopicKey(out[i].topic));
    assert.equal(typeof out[i].domestic, "boolean");
    assert.equal(typeof out[i].laneConfidence, "number");
    assert.equal(typeof out[i].topicConfidence, "number");
    assert.equal(typeof out[i].domesticConfidence, "number");
  }
  assert.equal(out[0].topic, "tech-ai");
  assert.equal(out[1].topic, "global-markets");
});

test("topics: classifier is deterministic", () => {
  for (const c of CASES) {
    const a = classifyArticle({ title: c.title });
    const b = classifyArticle({ title: c.title });
    assert.deepEqual(a, b, `non-deterministic route for ${c.title}`);
  }
});

test("topics: hostile input never throws and always yields both axes", async (t) => {
  await t.test("survives null/undefined/wrong-typed titles", () => {
    const inputs = [
      { title: "" },
      { title: "   " },
      { title: null as unknown as string },
      { title: undefined as unknown as string },
      { title: 123 as unknown as string },
      {} as { title: string },
    ];
    for (const input of inputs) {
      const r = classifyArticle(input);
      assert.ok(isLaneKey(r.lane));
      assert.ok(isTopicKey(r.topic));
      assert.equal(typeof r.domestic, "boolean");
    }
  });

  await t.test("survives a throwing getter", () => {
    const hostile = {
      get title(): string {
        throw new Error("boom");
      },
      category: "tech" as const,
    };
    const r = classifyArticle(hostile);
    assert.ok(isLaneKey(r.lane));
    assert.ok(isTopicKey(r.topic));
    assert.equal(r.fallback, true);
  });

  await t.test("classifyAll keeps every article when some are hostile", () => {
    const list = [
      { title: "A股三大指数收涨", category: "finance" as const },
      {
        get title(): string {
          throw new Error("boom");
        },
        category: "politics" as const,
      },
    ];
    const out = classifyAll(list as Array<{ title: string }>, () => "cn-news");
    assert.equal(out.length, 2);
    assert.equal(out[0].topic, "global-markets");
    assert.ok(isLaneKey(out[1].lane));
    assert.ok(isTopicKey(out[1].topic));
    assert.ok(out[1].topicConfidence <= LOW_CONFIDENCE);
  });
});

test("topics: classifyAll output stays additive (no resolver fields leak)", () => {
  const input = [
    { title: "央行开展逆回购", category: "finance" as const, sourceId: "cls-telegraph" },
  ];
  const out = classifyAll(input, () => "cn-news");
  const before = new Set(Object.keys(input[0]));
  const added = Object.keys(out[0]).filter((k) => !before.has(k));
  assert.deepEqual(added.sort(), [
    "domestic",
    "domesticConfidence",
    "lane",
    "laneConfidence",
    "topic",
    "topicConfidence",
  ]);
  assert.ok(!("subcategory" in out[0]), "resolver value must not appear on the article");
  assert.equal(out[0].sourceId, "cls-telegraph");
});

test("topics: summary is preferred over excerpt, both weaker than title", () => {
  const titleOnly = classifyArticle({ title: "市场综述" });
  const withBody = classifyArticle({
    title: "市场综述",
    excerpt: "发改委印发新型储能实施方案，财政部同步表态。",
  });
  assert.equal(withBody.topic, "policy");
  assert.ok(
    withBody.topicConfidence > titleOnly.topicConfidence,
    "excerpt evidence should raise confidence",
  );
  assert.ok(withBody.matched.length > 0);
});
