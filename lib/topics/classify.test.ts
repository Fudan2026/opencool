import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyArticle,
  classifyAll,
  normalizeTitle,
  LOW_CONFIDENCE,
} from "../../lib/topics/classify";
import {
  TOPIC_KEYS,
  TOPICS,
  isTopicKey,
  topicLabel,
  FALLBACK_TOPIC_BY_SUBCATEGORY,
} from "../../lib/topics/taxonomy";

/**
 * TOPICS: the shadow-mode router. Every real headline below was taken from a
 * published edition sidecar (2026-11-13 06:00 / 13:00) or is a canonical
 * shape from the IA audit §4.2, so a regression here means a routing change
 * that would reach readers in increment 2.
 */

interface Case {
  name: string;
  title: string;
  excerpt?: string;
  category?: "tech" | "finance" | "politics";
  subcategory?: string;
  expect: string;
}

const CASES: Case[] = [
  // — 国内财经 —
  {
    name: "A-share index move",
    title: "A股三大指数集体收涨 沪指涨1.2% 成交额破万亿",
    expect: "cn-finance",
  },
  {
    name: "PBOC reverse repo (audit §4.1 example)",
    title: "央行将开展1万亿元买断式逆回购操作",
    expect: "cn-finance",
  },
  {
    name: "domestic money-market plumbing",
    title: "券商互换便利建仓持续推进 第三批整体规模更大、参与机构更多",
    expect: "cn-finance",
  },
  {
    name: "onshore rescue measures",
    title: "中国加大股市救市力度",
    expect: "cn-finance",
  },
  {
    name: "HK listing suspension",
    title: "财联社11月13日电，新世界发展在香港暂停交易。",
    expect: "cn-finance",
  },
  // — 全球市场 —
  {
    name: "KOSDAQ must not fall into cn-finance (audit acceptance case)",
    title: "李在明：韩国决心实现资产和资本市场的正常化",
    expect: "global-markets",
  },
  {
    name: "KOSDAO + explicit market noun",
    title: "韩国总统李在明：韩国需要改革KOSDAQ市场。",
    expect: "global-markets",
  },
  {
    name: "JGB yield (audit §4.1 example)",
    title: "日本10年期国债收益率上升7个基点至2.86%",
    expect: "global-markets",
  },
  {
    name: "US Treasury yields / Fed",
    title: "Treasury yields rise as traders strengthen Fed rate hike bets",
    expect: "global-markets",
  },
  {
    name: "offshore banks without a domestic anchor",
    title: "意大利银行业抨击梅洛尼政府最新增税计划",
    expect: "global-markets",
  },
  {
    name: "US home sales",
    title: "US home sales fall to lowest level since 2010 as mortgage rates soar",
    expect: "global-markets",
  },
  {
    name: "commodity squeeze",
    title: "托克大举建仓LME铝多头，市场陷入数十年来最严峻逼仓局面",
    expect: "global-markets",
  },
  {
    name: "crypto venue",
    title: "币安宣布完成63亿美元被盗资产全额赔付",
    expect: "global-markets",
  },
  // — 政策政务 —
  {
    name: "NDRC plan (audit §4.1 example)",
    title: "发改委印发《“十五五”新型储能实施方案》",
    expect: "policy",
  },
  {
    name: "regulator enforcement",
    title: "证监会拟对财务造假公司从重处罚 并约谈相关中介机构",
    expect: "policy",
  },
  {
    name: "personnel appointment",
    title: "人事观察｜中国工程院院士柏连阳升任西北农大校长",
    expect: "policy",
  },
  {
    name: "housing code revision",
    title: "层高不低于3米！新规范如何让住宅更“宜居”？",
    expect: "policy",
  },
  {
    name: "tax enforcement",
    title: "中国将严厉惩处离岸信托收益偷逃税者",
    expect: "policy",
  },
  // — 科技AI —
  {
    name: "Nvidia CEO resignation (audit §4.2)",
    title: "英伟达首席执行官黄仁勋辞职",
    expect: "tech-ai",
  },
  {
    name: "US AI capex, English",
    title: "Cerebras surges 17% after beating on quarterly revenue and announcing Microsoft deal",
    expect: "tech-ai",
  },
  {
    name: "model release",
    title: "不用Flash命名，谷歌发布Gemini 4 Hydrogen：幻觉减少5倍，速度翻倍",
    expect: "tech-ai",
  },
  {
    name: "AI infrastructure build-out",
    title: "SpaceX计划投资740亿美元，在亚利桑那州和德克萨斯州建设数据中心",
    expect: "tech-ai",
  },
  {
    name: "chipmaker scandal, English",
    title: "Scandal-hit Nvidia CEO Jensen Huang quits, plunging AI chipmaking giant into turmoil",
    expect: "tech-ai",
  },
  // — 公司公告 —
  {
    name: "issuer-prefixed buyback (audit §4.1 example)",
    title: "沪电股份：取得9亿元回购专项贷款承诺函",
    expect: "filings",
  },
  {
    name: "stock code + filing verb",
    title: "600519 贵州茅台关于回购股份的公告",
    expect: "filings",
  },
  {
    name: "guidance raise",
    title: "Cisco beats on earnings, says AI infrastructure revenue will double this fiscal year",
    expect: "filings",
  },
  {
    name: "issuer prefix + earnings",
    title: "思科预计全年调整后每股收益（EPS）为5.47-5.53美元，公司原本预计预期5.05-5.11美元",
    expect: "filings",
  },
  {
    name: "takeover bid",
    title: "京东22亿欧元收购德国Ceconomy交易获批",
    expect: "filings",
  },
  // — 观点解读 —
  {
    name: "broker note (audit §4.1 example)",
    title: "中信证券：英伟达高管变局如何影响中国科技资产",
    expect: "opinion",
  },
  {
    name: "interview",
    title: "对话林肯贾鸣镝：传统豪车等来了反击的机会",
    expect: "opinion",
  },
  {
    name: "research-house stance",
    title: "广发证券郑峰：红利和科技是天然的互补组合",
    expect: "opinion",
  },
  {
    name: "Economist essay shape with no other signal",
    title: "The future of Trumponomics: compromise or failure",
    expect: "opinion",
  },
  {
    // Audit precedence puts the tech lexicon (rule 4) above opinion shape
    // (rule 6), so a column *about* Nvidia keeps the tech subject. Recorded
    // here so a future reordering is a deliberate decision, not a drift.
    name: "analysis column about a tech subject stays tech (rule 4 > rule 6)",
    title: "Analysis: Nvidia’s leadership crisis tests the chipmaker’s role as the ‘central bank of AI’",
    expect: "tech-ai",
  },
  {
    // Likewise a fund-industry column is market copy before it is analysis.
    name: "hedge-fund column is market copy (rule 3 > rule 6)",
    title: "Lessons from a miserable month for hedge funds",
    expect: "global-markets",
  },
  // — 国际时政 —
  {
    name: "Iran war live (audit §4.1 example)",
    title: "Iran war live: Trump says Gulf allies urged pause in Iran strikes",
    expect: "world",
  },
  {
    name: "ceasefire diplomacy",
    title: "U.S. envoys meet with Putin in the Kremlin after Ukraine talks in Abu Dhabi",
    expect: "world",
  },
  {
    name: "election result",
    title: "Mississippi elects first black senator in nearly 150 years",
    expect: "world",
  },
  {
    name: "humanitarian crisis",
    title: "Aid groups call on Israel to allow shelters in Gaza amid a humanitarian emergency",
    expect: "world",
  },
  {
    name: "geopolitical analysis, zh",
    title: "“雅尔塔2.0”？中美俄可能的三方峰会引发担忧",
    expect: "world",
  },
  {
    // `stake` alone fired on the idiom "at stake" and pushed a sovereignty
    // dispute into 公司公告; the term now requires a stake-sale shape.
    name: "regression: the idiom 'at stake' is not a corporate stake",
    title: "What’s at stake in the renewed tensions over the Falkland Islands?",
    excerpt: "Argentina and the UK are in a legal battle over an offshore oil-drilling project.",
    expect: "world",
  },
  // — ambiguous / weak evidence —
  {
    // 美股 outranks the person: this is a market-outlook question, so the
    // asset vocabulary decides even though the subject is a tech CEO.
    name: "ambiguous: market-outlook question resolves to markets",
    title: "黄仁勋走了 会不会带崩美股？",
    expect: "global-markets",
  },
  {
    name: "ambiguous: weather copy is world, not finance",
    title: "南方大范围降雨持续部分地区有暴雨 明起两股冷空气接连来袭",
    expect: "world",
  },
  {
    name: "ambiguous: no lexical signal falls back to source subcategory",
    title: "Dev Deep Dive: Expedition - Phase 1",
    category: "finance",
    subcategory: "x-mirror",
    expect: "tech-ai",
  },
];

test("topics: taxonomy is well-formed and bilingual", async (t) => {
  await t.test("seven topics, unique keys, both labels non-empty", () => {
    assert.equal(TOPICS.length, 7);
    assert.equal(new Set(TOPIC_KEYS).size, 7);
    for (const def of TOPICS) {
      assert.equal(typeof def.zh, "string");
      assert.equal(typeof def.en, "string");
      assert.ok(def.zh.length > 0, `${def.key} missing zh label`);
      assert.ok(def.en.length > 0, `${def.key} missing en label`);
      // Bilingual means visibly different labels, not the zh string reused.
      assert.notEqual(def.en, def.zh, `${def.key} en label duplicates zh`);
    }
  });

  await t.test("keys match the audit's taxonomy exactly", () => {
    assert.deepEqual([...TOPIC_KEYS].sort(), [
      "cn-finance",
      "filings",
      "global-markets",
      "opinion",
      "policy",
      "tech-ai",
      "world",
    ]);
  });

  await t.test("topicLabel honours the locale argument", () => {
    assert.equal(topicLabel("cn-finance", "zh"), "国内财经");
    assert.equal(topicLabel("cn-finance", "en"), "China Finance");
    assert.equal(topicLabel("policy", "zh"), "政策政务");
    assert.equal(topicLabel("policy", "en"), "Policy");
  });

  await t.test("isTopicKey rejects unknown keys", () => {
    assert.equal(isTopicKey("cn-finance"), true);
    assert.equal(isTopicKey("cn-market"), false);
    assert.equal(isTopicKey(null), false);
  });

  await t.test("subcategory fallback map only names real topics", () => {
    for (const [sub, topic] of Object.entries(FALLBACK_TOPIC_BY_SUBCATEGORY)) {
      assert.ok(isTopicKey(topic), `${sub} → unknown topic ${topic}`);
    }
  });
});

test("topics: representative headlines route stably", async (t) => {
  for (const c of CASES) {
    await t.test(`${c.expect} ← ${c.name}`, () => {
      const r = classifyArticle({
        title: c.title,
        excerpt: c.excerpt,
        category: c.category,
        subcategory: c.subcategory,
      });
      assert.equal(r.topic, c.expect, `${c.title}\n  matched: ${r.matched.join(", ")}`);
      assert.ok(isTopicKey(r.topic));
      assert.ok(r.confidence > 0 && r.confidence <= 1);
    });
  }
});

test("topics: every article gets exactly one topic, never null", () => {
  for (const c of CASES) {
    const r = classifyArticle({ title: c.title });
    assert.equal(typeof r.topic, "string");
    assert.ok(isTopicKey(r.topic));
  }
  // Degenerate inputs must not throw or produce an undefined topic.
  for (const title of ["", "   ", "!!!", "a", "1234567890"]) {
    const r = classifyArticle({ title });
    assert.ok(isTopicKey(r.topic), `no topic for ${JSON.stringify(title)}`);
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
  }
});

test("topics: 财联社 / 金十 date prefixes are stripped before matching", async (t) => {
  await t.test("strips 【财联社11月13日电】 bracket form", () => {
    assert.equal(
      normalizeTitle("【财联社11月13日电】央行开展逆回购"),
      "央行开展逆回购",
    );
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
    // A date in the middle of a headline is untouched.
    assert.equal(normalizeTitle("10月社融数据超预期"), "10月社融数据超预期");
  });

  await t.test("leaves an already-clean title alone", () => {
    assert.equal(normalizeTitle("发改委印发实施方案"), "发改委印发实施方案");
  });

  await t.test("prefix stripping changes the route, proving it matters", () => {
    const raw = classifyArticle({
      title: "【财联社11月13日电】新世界发展在香港暂停交易。",
    });
    assert.equal(raw.topic, "cn-finance");
    assert.ok(
      raw.matched.some((m) => m === "暂停交易"),
      `expected 暂停交易 to match, got: ${raw.matched.join(", ")}`,
    );
  });
});

test("topics: KOSDAQ is offshore, not domestic", () => {
  // The audit's explicit acceptance case: a Korean market story that the
  // current pipeline files under 中文财经 because 财联社 carries the wire.
  const zh = classifyArticle({
    title: "李在明：韩国决心实现资产和资本市场的正常化",
    category: "finance",
    subcategory: "cn-news",
  });
  assert.equal(zh.topic, "global-markets");

  const tagged = classifyArticle({
    title: "韩国总统李在明：韩国需要改革KOSDAQ市场。",
    category: "finance",
    subcategory: "cn-news",
  });
  assert.equal(tagged.topic, "global-markets");
  assert.ok(tagged.matched.includes("KOSDAQ"));
});

test("topics: foreign wire copy is damped out of cn-finance", () => {
  // Same domestic lexicon (银行/保险/房贷) but an offshore venue.
  const offshore = classifyArticle({
    title: "Italian banks may cut sovereign debt holdings in tax battle, warns Intesa chief",
    category: "finance",
    subcategory: "cn-news",
  });
  assert.notEqual(offshore.topic, "cn-finance");

  // The same sentence with a domestic anchor stays domestic.
  const onshore = classifyArticle({
    title: "A股银行板块走强 沪指收涨",
    category: "finance",
    subcategory: "cn-news",
  });
  assert.equal(onshore.topic, "cn-finance");
});

test("topics: filing shape outranks a stray tech term", () => {
  const r = classifyArticle({ title: "英伟达概念股沪电股份：回购 9 亿元" });
  assert.equal(r.topic, "filings");
});

test("topics: broker prefix outranks the subject it discusses", () => {
  const r = classifyArticle({ title: "中信证券：英伟达高管变局如何影响中国科技资产" });
  assert.equal(r.topic, "opinion");
  assert.ok(r.confidence > LOW_CONFIDENCE);
});

test("topics: fallback is transparently flagged and low-confidence", () => {
  const r = classifyArticle({
    title: "Zzz",
    category: "politics",
    subcategory: "world",
  });
  assert.equal(r.topic, "world");
  assert.equal(r.fallback, true);
  assert.ok(r.confidence <= LOW_CONFIDENCE);

  // A confident route is never flagged as a fallback.
  const confident = classifyArticle({ title: "发改委印发新型储能实施方案" });
  assert.equal(confident.fallback, false);
  assert.ok(confident.confidence > LOW_CONFIDENCE);
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
    // Original fields survive untouched.
    assert.equal(out[i].title, input[i].title);
    assert.equal(out[i].category, input[i].category);
    // Topic fields are additive.
    assert.ok(isTopicKey(out[i].topic));
    assert.equal(typeof out[i].topicConfidence, "number");
  }
  assert.equal(out[0].topic, "tech-ai");
  assert.equal(out[1].topic, "cn-finance");
});

test("topics: classifier is deterministic", () => {
  for (const c of CASES) {
    const a = classifyArticle({ title: c.title });

    const b = classifyArticle({ title: c.title });
    assert.deepEqual(a, b, `non-deterministic route for ${c.title}`);
  }
});

test("topics: hostile input never throws and always yields a topic", async (t) => {
  await t.test("classifyArticle survives null/undefined/wrong-typed titles", () => {
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
      assert.ok(isTopicKey(r.topic));
      assert.ok(r.confidence >= 0 && r.confidence <= 1);
    }
  });

  await t.test("classifyArticle survives a throwing getter", () => {
    const hostile = {
      get title(): string {
        throw new Error("boom");
      },
      category: "tech" as const,
    };
    const r = classifyArticle(hostile);
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
    assert.equal(out[0].topic, "cn-finance");
    assert.ok(isTopicKey(out[1].topic), "hostile item must still carry a topic");
    // The unreadable field degrades to the documented fallback confidence.
    assert.ok(out[1].topicConfidence <= LOW_CONFIDENCE);
  });
});

test("topics: classifyAll output stays additive (no resolver fields leak)", () => {
  const input = [{ title: "央行开展逆回购", category: "finance" as const, sourceId: "cls-telegraph" }];
  const out = classifyAll(input, () => "cn-news");
  const before = new Set(Object.keys(input[0]));
  const added = Object.keys(out[0]).filter((k) => !before.has(k));
  assert.deepEqual(added.sort(), ["topic", "topicConfidence"]);
  assert.ok(!("subcategory" in out[0]), "resolver value must not appear on the article");
  assert.equal(out[0].sourceId, "cls-telegraph");
});

test("topics: summary is preferred over excerpt, both are weaker than title", () => {
  const titleOnly = classifyArticle({ title: "市场综述" });
  const withBody = classifyArticle({
    title: "市场综述",
    excerpt: "发改委印发新型储能实施方案，财政部同步表态。",
  });
  assert.equal(withBody.topic, "policy");
  assert.ok(
    withBody.confidence > titleOnly.confidence,
    "excerpt evidence should raise confidence",
  );
  assert.ok(withBody.matched.length > 0);
});
