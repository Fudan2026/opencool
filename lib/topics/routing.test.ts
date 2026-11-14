import test from "node:test";
import assert from "node:assert/strict";

import {
  exactStoryKey,
  dedupeStories,
  storyCluster,
  firstStoryEntity,
  NEAR_DUPLICATE_THRESHOLD,
} from "../../lib/topics/dedupe";
import {
  routeEdition,
  SECTION_ORDER,
  SECTION_LIMITS,
  CLUSTER_CAP_PER_SECTION,
  CLUSTER_CAP_PER_EDITION,
  MIN_SECTION_ITEMS,
  editionStats,
  sectionsBelowFloor,
  type RoutedEdition,
} from "../../lib/topics/routing";
import { TOPIC_KEYS } from "../../lib/topics/taxonomy";
import type { ArticleInput } from "../../lib/ai/pipeline";

function art(over: Partial<ArticleInput> & { title: string }): ArticleInput {
  return {
    sourceId: "src-a",
    source: "源A",
    url: `https://example.com/${encodeURIComponent(over.title)}`,
    category: "finance",
    publishedAt: new Date("2026-11-13T02:00:00Z"),
    ...over,
  } as ArticleInput;
}

/** Build `n` articles for one source with distinct, entity-free titles. */
function spread(sourceId: string, n: number, prefix = "公司季报要点"): ArticleInput[] {
  return Array.from({ length: n }, (_, i) =>
    art({
      sourceId,
      source: sourceId,
      // The CJK suffix keeps these in the zh lane; pass an English prefix to
      // stay in 外电原文 instead.
      title: `${prefix}${i + 1}${/[\u4e00-\u9fff]/.test(prefix) ? "号观察" : ""}`,
      url: `https://example.com/${sourceId}/${i}`,
      publishedAt: new Date(Date.parse("2026-11-13T02:00:00Z") + i * 60_000),
    }),
  );
}

test("dedupe: exact cross-source duplicates collapse to one survivor", async (t) => {
  await t.test("same headline, two wires, different wire prefixes", () => {
    const items = [
      art({ sourceId: "cls", title: "财联社11月13日电，香港将2026年经济增长预测上调至4.8%" }),
      art({ sourceId: "wscn", title: "香港将2026年经济增长预测上调至4.8%" }),
    ];
    const { kept, dropped } = dedupeStories(items);
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 1);
    assert.deepEqual(exactStoryKey(kept[0].title), exactStoryKey(dropped[0].title));
  });

  await t.test("survivor is the more informative title", () => {
    // The truncated flash must not displace the fuller sentence.
    const short = art({ sourceId: "a", title: "波罗的海干散货指数跌1.32%，至2980点。" });
    const long = art({
      sourceId: "b",
      title: "财联社11月13日电，波罗的海干散货运价指数跌1.32%，至2980点。",
    });
    const { kept } = dedupeStories([short, long]);
    assert.equal(kept.length, 1);
    assert.ok(kept[0].title.includes("运价"));
  });

  await t.test("distinct stories are never merged", () => {
    const items = [
      art({ sourceId: "a", title: "央行开展 5000 亿元 MLF 操作" }),
      art({ sourceId: "b", title: "发改委印发新型储能实施方案" }),
      art({ sourceId: "c", title: "沪电股份取得 9 亿元回购专项贷款承诺函" }),
    ];
    assert.equal(dedupeStories(items).kept.length, 3);
  });

  await t.test("deterministic across input orders and repeated runs", () => {
    const items = [
      art({ sourceId: "a", title: "香港将2026年经济增长预测上调至4.8%" }),
      art({ sourceId: "b", title: "香港将2026年经济增长预测上调至4.8%" }),
      art({ sourceId: "c", title: "德州候任总检察长称将严格审查特斯拉与SpaceX的潜在合并交易" }),
      art({ sourceId: "d", title: "德州候任总检察长称将严格审查特斯拉与SpaceX的潜在合并交易" }),
    ];
    const a = dedupeStories(items).kept.map((x) => x.sourceId).sort();
    const b = dedupeStories([...items].reverse()).kept.map((x) => x.sourceId).sort();
    assert.deepEqual(a, b);
  });

  await t.test("threshold is the documented constant", () => {
    assert.equal(NEAR_DUPLICATE_THRESHOLD, 0.6);
  });
});

test("dedupe: story clustering groups one event across rewrites", async (t) => {
  await t.test("Nvidia headlines with different wording share one cluster", () => {
    const titles = [
      "Jensen Huang's Nvidia exit casts shadow over Wall Street's $500 billion AI bet",
      "Who will replace Jensen Huang? Our early thoughts on Nvidia's next CEO",
      "Value Nvidia, not Huang",
      "英伟达风波引发芯片出口限制担忧，中国AI企业股价大跌",
    ];
    const keys = new Set(titles.map((title) => storyCluster(title)));
    assert.equal(keys.size, 1);
    assert.equal([...keys][0], "entity:nvidia");
  });

  await t.test("cluster identity is language-independent", () => {
    assert.equal(storyCluster("英伟达股价大跌"), storyCluster("Nvidia shares tumble"));
  });

  await t.test("entity-free headlines fall back to their own story key", () => {
    const k1 = storyCluster("某地暴雨持续 部分地区有暴雨");
    const k2 = storyCluster("某地暴雨持续 部分地区有暴雨");
    const k3 = storyCluster("另一则完全不同的新闻标题");
    assert.equal(k1, k2);
    assert.notEqual(k1, k3);
    assert.ok(k1.startsWith("title:"));
  });

  await t.test("word boundaries keep lookalike ASCII aliases honest", () => {
    // `meta` must not fire inside `metadata`, `huang` not inside `shanghai`.
    assert.equal(firstStoryEntity("Metadata standards for archives"), null);
    assert.equal(firstStoryEntity("Shanghai port throughput rises"), null);
    assert.equal(firstStoryEntity("Meta platforms beats estimates"), "meta");
  });

  await t.test("first declared entity wins when several are named", () => {
    // Nvidia is declared before Lutnick appears anywhere, so an article about
    // the testimony clusters on the company, not the official.
    assert.equal(firstStoryEntity("Nvidia scandal draws in Commerce Secretary Lutnick"), "nvidia");
  });
});

test("routing: sections are capped, ordered and never empty", async (t) => {
  const articles = [
    ...spread("s-talk", 40, "季报要点"),
    ...spread("s-two", 12, "季度观察"),
    ...spread("s-three", 12, "季度追踪"),
    ...spread("s-four", 12, "季度扫描"),
  ];
  const edition = routeEdition(articles);

  await t.test("only non-empty sections appear", () => {
    for (const lane of edition.lanes) {
      for (const section of lane.sections) {
        assert.ok(section.items.length > 0, `${lane.lane}/${section.topic} rendered empty`);
      }
    }
  });

  await t.test("sections respect their cap and the item floor", () => {
    for (const section of edition.lanes.flatMap((l) => l.sections)) {
      assert.ok(section.items.length <= SECTION_LIMITS[section.topic].cap);
      assert.ok(section.items.length >= MIN_SECTION_ITEMS);
    }
  });

  await t.test("section order is the locked taxonomy order", () => {
    for (const lane of edition.lanes) {
      const idx = lane.sections.map((s) => SECTION_ORDER.indexOf(s.topic));
      assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
    }
  });

  await t.test("a dominant source cannot exceed its share of a section", () => {
    for (const stat of editionStats(edition)) {
      if (stat.rendered < 3) continue;
      assert.ok(
        stat.maxSourceShare <= SECTION_LIMITS[stat.topic].sourceShare + 1e-9,
        `${stat.lane}/${stat.topic}: ${stat.maxSourceId} holds ${(stat.maxSourceShare * 100).toFixed(0)}%`,
      );
    }
  });

  await t.test("a flood source cannot fill a section", () => {
    // 40 of 76 items come from one source; it must not own the section.
    const biggest = [...editionStats(edition)].sort((a, b) => b.rendered - a.rendered)[0];
    assert.ok(biggest.maxSourceShare < 0.5, `dominant source still at ${biggest.maxSourceShare}`);
  });

  await t.test("no cluster exceeds the per-section cap", () => {
    for (const stat of editionStats(edition)) {
      assert.ok(
        stat.maxCluster <= CLUSTER_CAP_PER_SECTION,
        `${stat.lane}/${stat.topic}: cluster ${stat.maxClusterKey} × ${stat.maxCluster}`,
      );
    }
  });

  await t.test("no cluster exceeds the per-edition cap", () => {
    const counts = new Map<string, number>();
    for (const lane of edition.lanes) {
      for (const section of lane.sections) {
        for (const item of section.items) {
          const k = storyCluster(item.title);
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
      }
    }
    for (const [k, n] of counts) {
      assert.ok(n <= CLUSTER_CAP_PER_EDITION, `${k} appears ${n} times in one edition`);
    }
  });
});

test("routing: the Nvidia-style story cannot take a section", async (t) => {
  // 15 Nvidia headlines from 8 different sources, exactly the shape the audit
  // measured (79 fetched articles, 15 rendered slots).
  const nvidiaTitles = [
    "Nvidia has shed nearly $500 billion in market value",
    "Microsoft Outage Hits Businesses, Nvidia Scandal Deepens",
    "What's ahead for AI financing after Nvidia CEO Jensen Huang departs",
    "Nvidia will be a harder test for founder transitions",
    "Why Nvidia stock drop isn't a big deal for ETF investors",
    "Nvidia's turmoil is prompting a rotation across chip stocks",
    "Nvidia scandal draws in Commerce Secretary Lutnick",
    "Who will replace Jensen Huang?",
    "How the Jensen Huang affair changes U.S.-China relations",
    "Nvidia brings in ex-prosecutor Joon Kim",
    "Nvidia's leadership crisis tests its role as the central bank of AI",
    "Why Singapore keeps turning up in the fight over Nvidia chips",
    "Jensen Huang's exit raises questions about the future of AI",
    "Jensen Huang's Nvidia exit casts shadow over $500 billion",
    "Value Nvidia, not Huang",
  ];
  const sources = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"];
  const flood = nvidiaTitles.map((title, i) =>
    art({
      sourceId: sources[i % sources.length],
      source: sources[i % sources.length],
      title,
      url: `https://example.com/nv/${i}`,
      publishedAt: new Date(Date.parse("2026-11-13T03:00:00Z") + i * 60_000),
    }),
  );
  // Plus unrelated tech copy so the section has real alternatives. These are
  // English so they share the flood's (external) lane — `spread()` emits
  // Chinese titles, which route to the zh lane.
  const other = [
    ...spread("s8", 6, "Open-weight model releases, part "),
    ...spread("s9", 6, "Cloud vendors cut GPU prices, part "),
  ];
  const edition = routeEdition([...flood, ...other]);

  const externalTech = () =>
    edition.lanes
      .find((l) => l.lane === "external")
      ?.sections.find((s) => s.topic === "tech-ai");

  await t.test("the flood occupies at most two slots in its section", () => {
    const section = externalTech();
    assert.ok(section, "no external tech-ai section");
    const nvidia = section.items.filter((i) => storyCluster(i.title) === "entity:nvidia");
    assert.ok(nvidia.length <= CLUSTER_CAP_PER_SECTION, `nvidia slots: ${nvidia.length}`);
  });

  await t.test("the edition cannot spend 15 slots on one story", () => {
    const n = edition.lanes
      .flatMap((l) => l.sections)
      .flatMap((s) => s.items)
      .filter((i) => storyCluster(i.title) === "entity:nvidia").length;
    assert.ok(n <= CLUSTER_CAP_PER_EDITION, `edition spent ${n} slots on Nvidia`);
    assert.ok(n < 15, `must be strictly fewer than the 15 slots measured before`);
  });

  await t.test("other tech copy still gets a turn", () => {
    const section = externalTech()!;
    const others = section.items.filter((i) => storyCluster(i.title) !== "entity:nvidia");
    assert.ok(others.length >= 2, `only ${others.length} non-Nvidia items`);
  });
});

test("routing: duplicates never reach a section", async (t) => {
  const dup = "香港将2026年经济增长预测上调至4.8%";
  const articles = [
    art({ sourceId: "a", title: dup, url: "https://example.com/dup1" }),
    art({ sourceId: "b", title: `财联社11月13日电，${dup}`, url: "https://example.com/dup2" }),
    ...spread("c", 4, "行业观察"),
    ...spread("d", 4, "公司动向"),
  ];
  const edition = routeEdition(articles);
  const titles = edition.lanes.flatMap((l) => l.sections).flatMap((s) => s.items).map((i) => exactStoryKey(i.title));
  const keys = new Set(titles);
  assert.equal(keys.size, titles.length, "a duplicate story reached the rendered block");
  assert.ok(edition.duplicates >= 1);
});

test("routing: empty topics are omitted, not rendered as shells", async (t) => {
  // Only filings-shaped headlines: no markets, no world, no tech, no policy.
  const articles = [
    art({ sourceId: "a", title: "沪电股份：取得 9 亿元回购专项贷款承诺函" }),
    art({ sourceId: "b", title: "TCL中环：拟购买中环领先65.8%股份 股票11月16日复牌" }),
    art({ sourceId: "c", title: "侨银股份：侨银转债可能存在不能按期足额兑付本息的重大风险" }),
    art({ sourceId: "d", title: "某公司：业绩预告显示净利润同比增长" }),
  ];
  const edition = routeEdition(articles);
  const topics = edition.lanes.flatMap((l) => l.sections.map((s) => s.topic));
  assert.ok(topics.includes("filings"));
  assert.ok(!topics.includes("global-markets"));
  assert.ok(!topics.includes("world"));
  assert.ok(!topics.includes("opinion"));
});

test("routing: a 2-item section renders (floor 2) and its thinness is reported, not hidden", async (t) => {
  // Owner decision OC-18 lowered the section floor 3 -> 2: a 2-item section is
  // real news and renders, visibly marked thin at render time. What the 40%
  // share rule cannot satisfy is *reported* (sectionsBelowFloor), never
  // silently rendered non-compliant and never withheld either.
  const articles = [
    art({ sourceId: "only", title: "商务部回应汽车行业「内卷」问题", url: "https://example.com/p1" }),
    art({ sourceId: "only", title: "发改委印发新型储能实施方案", url: "https://example.com/p2" }),
    ...spread("x", 4, "市场观察"),
    ...spread("y", 4, "盘面追踪"),
  ];
  const edition = routeEdition(articles);

  await t.test("the one-source 2-item policy section renders with exactly 2 items", () => {
    const policy = edition.lanes.flatMap((l) => l.sections).find((s) => s.topic === "policy");
    assert.ok(policy, "a 2-item section must render under the floor-2 rule");
    assert.equal(policy.items.length, 2);
  });

  await t.test("a 1-item section is still below the floor and is omitted", () => {
    const singles = routeEdition([
      art({ sourceId: "solo", title: "商务部回应汽车行业「内卷」问题", url: "https://example.com/p1" }),
      ...spread("x", 4, "市场观察"),
      ...spread("y", 4, "盘面追踪"),
    ]);
    const policy = singles.lanes.flatMap((l) => l.sections).find((s) => s.topic === "policy");
    assert.equal(policy, undefined, "a 1-item section must not render");
    assert.ok(
      singles.lanes.flatMap((l) => l.omitted).some((o) => o.topic === "policy"),
      "the withheld 1-item topic must be recorded in omitted",
    );
  });

  await t.test("the 100%-one-source section is reported by sectionsBelowFloor", () => {
    const reported = sectionsBelowFloor(edition);
    const policy = reported.find((r) => r.topic === "policy");
    assert.ok(policy, "the one-source thin section must be reported, not faked");
    assert.equal(policy.sources, 1);
    assert.equal(policy.rendered, 2);
  });

  await t.test("omitted no longer swallows 2-item topics", () => {
    const omitted = edition.lanes.flatMap((l) => l.omitted);
    assert.ok(!omitted.some((o) => o.topic === "policy"));
  });
});

test("routing: legacy untagged sidecars route via the live classifier", async (t) => {
  const articles = [
    art({ title: "央行开展 5000 亿元 MLF 操作" }),
    art({ title: "英伟达首席执行官黄仁勋辞职", sourceId: "b" }),
    art({ title: "Iran war live: Trump says Gulf allies urged pause in Iran strikes", sourceId: "c" }),
    art({ title: "美股三大指数集体收涨 纳指涨超2%", sourceId: "d" }),
  ];
  const edition = routeEdition(articles);
  const zh = edition.lanes.find((l) => l.lane === "zh")!;
  const external = edition.lanes.find((l) => l.lane === "external")!;
  // Two Chinese items and ... all four may land in zh; the point is that lane
  // assignment came from script, not from the source's category.
  assert.ok(zh.pool.length >= 3);
  assert.ok(external.pool.every((a) => !/[\u4e00-\u9fff]/.test(a.title)));
});

test("routing: every topic key in the taxonomy is reachable", async (t) => {
  // Guards against a taxonomy addition that the router silently never asks for.
  const sampled: Record<string, string> = {
    "global-markets": "美股三大指数集体收涨 纳指涨超2%",
    world: "伊朗称击落美军无人机 中东局势升级",
    "tech-ai": "英伟达发布新一代 GPU 芯片",
    policy: "央行开展 5000 亿元 MLF 操作",
    filings: "沪电股份：取得 9 亿元回购专项贷款承诺函",
    opinion: "中信证券：看好半导体板块估值修复",
  };
  for (const key of TOPIC_KEYS) {
    const edition = routeEdition([
      art({ sourceId: "a", title: sampled[key] }),
      art({ sourceId: "b", title: sampled[key] + "（续）", url: "https://example.com/2" }),
      ...spread("x", 4, "观察"),
    ]);
    const seen = new Set(edition.lanes.flatMap((l) => [...l.pool.map(() => ""), ...l.omitted.map((o) => o.topic)]));
    const routed = edition.lanes.some((l) => l.sections.some((s) => s.topic === key) || l.omitted.some((o) => o.topic === key));
    assert.ok(routed, `taxonomy topic ${key} never routed with sample "${sampled[key]}" (${seen.size})`);
  }
});

test("routing: cost is linear enough for a 550-article edition", async (t) => {
  const articles: ArticleInput[] = [];
  for (let s = 0; s < 26; s++) articles.push(...spread(`src-${s}`, 21, `批次${s}观察`));
  assert.equal(articles.length, 546);
  const t0 = Date.now();
  const edition: RoutedEdition = routeEdition(articles);
  const ms = Date.now() - t0;
  assert.ok(edition.total > 0);
  assert.ok(ms < 4000, `routing took ${ms}ms for 546 articles`);
});
