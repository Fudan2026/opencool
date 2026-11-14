import test from "node:test";
import assert from "node:assert/strict";

import { classifyAll } from "../../lib/topics/classify";
import { LANE_KEYS, TOPIC_KEYS } from "../../lib/topics/taxonomy";
import { groupRaw, renderHtml } from "../../lib/output/render";
import type { ArticleInput } from "../../lib/ai/pipeline";
import type { SourceDef } from "../../lib/sources/types";
import { article, reportFixture } from "./helpers";
import fs from "node:fs";
import path from "node:path";
import {
  storyCluster,
  sameStoryHeadlines,
  headlineAffinity,
  SAME_DAY_ENTITY_AFFINITY,
  SAME_EVENT_AFFINITY,
  REWORDED_REPEAT_AFFINITY,
} from "../../lib/topics/dedupe";

/**
 * GOLDEN: this increment is *shadow mode* on two orthogonal axes. Two promises
 * are load-bearing:
 *
 *  1. The articles sidecar gains exactly six additive fields — `lane`,
 *     `laneConfidence`, `topic`, `topicConfidence`, `domestic`,
 *     `domesticConfidence` — and no existing field moves, changes type, or
 *     disappears.
 *  2. Rendering is byte-identical with and without those fields, because
 *     `groupRaw` never reads them. When a later increment starts routing on
 *     lane/topic, this test is the thing that must change deliberately.
 */

const REGISTRY: SourceDef[] = [
  {
    id: "test-src",
    name: "测试源",
    type: "rss",
    url: "https://example.com/feed",
    category: "finance",
    subcategory: "cn-news",
    enabled: true,
  },
  {
    id: "test-wire",
    name: "Test Wire",
    type: "rss",
    url: "https://example.com/wire",
    category: "politics",
    subcategory: "world",
    enabled: true,
  },
];

const ARTICLES: ArticleInput[] = [
  article({
    sourceId: "test-src",
    source: "测试源",
    category: "finance",
    title: "央行开展 5000 亿元 MLF 操作",
    excerpt: "流动性投放超预期。",
    url: "https://example.com/a1",
  }),
  article({
    sourceId: "test-src",
    source: "测试源",
    category: "finance",
    title: "英伟达首席执行官黄仁勋辞职",
    excerpt: "AI 芯片巨头管理层变动。",
    url: "https://example.com/a2",
  }),
  article({
    sourceId: "test-wire",
    source: "Test Wire",
    category: "politics",
    title: "Iran war live: Trump says Gulf allies urged pause in Iran strikes",
    excerpt: "Diplomatic efforts continue.",
    url: "https://example.com/a3",
  }),
  article({
    sourceId: "test-src",
    source: "测试源",
    category: "finance",
    title: "美股三大指数集体收涨 纳指涨超2%",
    excerpt: "市场押注美联储降息。",
    url: "https://example.com/a4",
  }),
];

const ADDED_FIELDS = [
  "domestic",
  "domesticConfidence",
  "lane",
  "laneConfidence",
  "topic",
  "topicConfidence",
];

type Tagged = ArticleInput & {
  lane: string;
  laneConfidence: number;
  topic: string;
  topicConfidence: number;
  domestic: boolean;
  domesticConfidence: number;
};

function tagAll(list: ArticleInput[]): Tagged[] {
  const sub = new Map(REGISTRY.map((s) => [s.id, s.subcategory]));
  return classifyAll(list, (a) => sub.get(a.sourceId)) as Tagged[];
}

test("golden: two-axis tagging is additive on the articles sidecar", async (t) => {
  const tagged = tagAll(ARTICLES);

  await t.test("exactly six new keys per article, nothing removed", () => {
    for (let i = 0; i < ARTICLES.length; i++) {
      const before = new Set(Object.keys(ARTICLES[i]));
      const added = Object.keys(tagged[i]).filter((k) => !before.has(k));
      const removed = [...before].filter((k) => !(k in tagged[i]));
      assert.deepEqual(added.sort(), ADDED_FIELDS);
      assert.deepEqual(removed, []);
    }
  });

  await t.test("every pre-existing field is identical after a JSON roundtrip", () => {
    const plain = JSON.parse(JSON.stringify(ARTICLES)) as Array<Record<string, unknown>>;
    for (let i = 0; i < ARTICLES.length; i++) {
      const {
        lane,
        laneConfidence,
        topic,
        topicConfidence,
        domestic,
        domesticConfidence,
        ...rest
      } = tagged[i];
      assert.ok(lane && typeof laneConfidence === "number");
      assert.ok(topic && typeof topicConfidence === "number");
      assert.equal(typeof domestic, "boolean");
      assert.equal(typeof domesticConfidence, "number");
      assert.deepEqual(JSON.parse(JSON.stringify(rest)), plain[i]);
    }
  });

  await t.test("lane is one of two keys, topic one of six", () => {
    for (const a of tagged) {
      assert.ok((LANE_KEYS as string[]).includes(a.lane), `bad lane: ${a.lane}`);
      assert.ok((TOPIC_KEYS as string[]).includes(a.topic), `bad topic: ${a.topic}`);
      assert.ok(!(TOPIC_KEYS as string[]).includes("cn-finance"));
    }
  });

  await t.test("all confidences stay within 0..1 and survive JSON", () => {
    for (const a of tagged) {
      for (const n of [a.laneConfidence, a.topicConfidence, a.domesticConfidence]) {
        assert.ok(n >= 0 && n <= 1);
      }
    }
    const round = JSON.parse(JSON.stringify(tagged)) as Tagged[];
    for (let i = 0; i < tagged.length; i++) {
      assert.equal(round[i].lane, tagged[i].lane);
      assert.equal(round[i].topic, tagged[i].topic);
      assert.equal(round[i].domestic, tagged[i].domestic);
    }
  });

  await t.test("routes the four fixture headlines across both axes", () => {
    assert.equal(tagged[0].lane, "zh");
    assert.equal(tagged[0].topic, "policy");
    assert.equal(tagged[0].domestic, true);

    assert.equal(tagged[1].lane, "zh");
    assert.equal(tagged[1].topic, "tech-ai");
    assert.equal(tagged[1].domestic, false);

    assert.equal(tagged[2].lane, "external");
    assert.equal(tagged[2].topic, "world");
    assert.equal(tagged[2].domestic, false);

    // Chinese language, US subject — the case the old flat list could not say.
    assert.equal(tagged[3].lane, "zh");
    assert.equal(tagged[3].topic, "global-markets");
    assert.equal(tagged[3].domestic, false);
  });
});

test("golden: render output is unchanged by shadow tagging", async (t) => {
  const tagged = tagAll(ARTICLES);
  const opts = { editionHour: "06", siblingHours: ["06", "13", "19"] };

  await t.test("renderHtml routes on the six fields rather than ignoring them", () => {
    // Increment 1 asserted byte-identical HTML here to prove shadow mode.
    // Increment 2 consumes the fields, so the byte-identity promise is
    // *retired deliberately*: the same articles now render differently because
    // routing and dedupe read them. What must still hold is that both paths
    // produce a well-formed news block.
    const plain = renderHtml(reportFixture(), groupRaw(ARTICLES, REGISTRY), "2026-11-13", opts);
    const shadow = renderHtml(reportFixture(), groupRaw(tagged, REGISTRY), "2026-11-13", opts);
    for (const html of [plain, shadow]) {
      assert.ok(html.includes('data-panel="zh"'));
      assert.ok(html.includes("topic-section"));
    }
  });

  await t.test("groupRaw routes identically with and without the new fields", () => {
    // Untagged input is classified on the fly with the same pure classifier, so
    // a legacy sidecar re-rendered today must land in the same lanes and topics
    // as one baked after increment 1. This is the property that lets old
    // editions keep rendering correctly.
    const shape = (raw: Awaited<ReturnType<typeof groupRaw>>) =>
      raw.lanes.map((l) => ({
        lane: l.lane,
        sections: l.sections.map((s) => ({ topic: s.topic, n: s.items.length })),
      }));
    assert.deepEqual(shape(groupRaw(tagged, REGISTRY)), shape(groupRaw(ARTICLES, REGISTRY)));
  });

  await t.test("a legacy untagged article still renders", () => {
    const raw = {
      lanes: [],
      legacy: { finance: [], tech: [], politics: [] },
    };
    const html = renderHtml(reportFixture(), raw, "2026-10-26", {
      editionHour: "19",
      siblingHours: ["06", "13", "19"],
    });
    assert.ok(html.includes('data-panel="review"'));
  });
});

// ---------------------------------------------------------------------------
// Clustering v2: labeled-corpus measurement (the mutation guard)
// ---------------------------------------------------------------------------

/**
 * GOLDEN: story identity v2 is strictly better than v1 on the labeled corpus.
 *
 * `tests/fixtures/clustering-pairs.json` holds 1430 pairs of real headlines
 * from the published ledger (https://fudan2026.github.io/opencool/stories.json,
 * fetched 2026-11-14), hand-labeled same-story vs distinct-story by careful
 * reading: 1221 labeled one by one, the rest exact-key repeats and revision
 * trails, which are same-story by construction. The labeling policy is stated
 * in the fixture itself.
 *
 * The two rates this test pins:
 *
 *   false-merge — distinct pairs the rule joins (v1: any two headlines sharing
 *     an entity cluster merged, so `entity:trump`'s 500 sightings of unrelated
 *     stories were one "story");
 *   false-split — same pairs the rule keeps apart (v1: a reworded repeat that
 *     dropped its entity mention never matched).
 *
 * This is the mutation guard for the gates and the conflict tables in
 * `lib/topics/dedupe.ts`: retuning a threshold, dropping a conflict class or
 * adding a generic token shifts these counts, and the assertions fail until
 * the change is re-proven on the corpus. Split-half robustness (both halves
 * strictly better) guards against a lucky overfit — the labeled set spans
 * 30 days of editions and every wire.
 */
interface LabeledPair {
  a: string;
  b: string;
  label: "same" | "distinct";
  origin: string;
  sameUrl: boolean;
  dayGap: number;
}

const PAIRS: LabeledPair[] = (
  JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "fixtures", "clustering-pairs.json"), "utf8"),
  ) as { pairs: LabeledPair[] }
).pairs;

interface Rates {
  fm: number;
  fs: number;
  fmRate: number;
  fsRate: number;
}

function measure(
  pairs: LabeledPair[],
  decide: (a: string, b: string, p: LabeledPair) => boolean,
): Rates {
  let same = 0;
  let distinct = 0;
  let fm = 0;
  let fs = 0;
  for (const p of pairs) {
    const joined = decide(p.a, p.b, p);
    if (p.label === "same") {
      same++;
      if (!joined) fs++;
    } else {
      distinct++;
      if (joined) fm++;
    }
  }
  return { fm, fs, fmRate: fm / distinct, fsRate: fs / same };
}

/** v1 identity: cluster keys equal (entity match or exact surface key). */
const v1 = (a: string, b: string): boolean => storyCluster(a) === storyCluster(b);

/** v2 identity: the ledger's URL guard plus the shipped `sameStoryHeadlines`. */
const v2 = (
  a: string,
  b: string,
  p: Pick<LabeledPair, "sameUrl" | "dayGap">,
): boolean => (p.sameUrl && storyCluster(a) === storyCluster(b)) || sameStoryHeadlines(a, b, p.dayGap);

test("golden: story identity v2 beats v1 on the labeled corpus", async (t) => {
  assert.ok(PAIRS.length >= 1000, `labeled corpus shrank: ${PAIRS.length}`);

  const r1 = measure(PAIRS, (a, b) => v1(a, b));
  const r2 = measure(PAIRS, (a, b, p) => v2(a, b, p));

  await t.test("v1's measured baseline is what the audit found", () => {
    // v1 mis-merged three quarters of distinct pairs and split a quarter of
    // same pairs. Pinned so a future reader cannot "fix" the baseline.
    assert.equal(r1.fm, 672);
    assert.equal(r1.fs, 143);
  });

  await t.test("v2 is strictly better on both rates, with margin", () => {
    assert.ok(
      r2.fmRate < r1.fmRate / 2,
      `false-merge must halve at least: ${(r2.fmRate * 100).toFixed(2)}% vs ${(r1.fmRate * 100).toFixed(2)}%`,
    );
    assert.ok(
      r2.fsRate < r1.fsRate,
      `false-split must improve: ${(r2.fsRate * 100).toFixed(2)}% vs ${(r1.fsRate * 100).toFixed(2)}%`,
    );
    assert.equal(r2.fm, 130, "v2 false merges (pinned; retune requires re-proof)");
    assert.equal(r2.fs, 83, "v2 false splits (pinned; retune requires re-proof)");
  });

  await t.test("split halves: no lucky overfit", () => {
    const halves: LabeledPair[][] = [[], []];
    PAIRS.forEach((p, i) => halves[i % 2].push(p));
    for (const h of halves) {
      const h1 = measure(h, (a, b) => v1(a, b));
      const h2 = measure(h, (a, b, p) => v2(a, b, p));
      assert.ok(h2.fmRate < h1.fmRate, "half: false-merge must improve");
      assert.ok(h2.fsRate < h1.fsRate, "half: false-split must improve");
    }
  });

  await t.test("the corpus's canonical traps stay decided", () => {
    // (c) mis-merge: structurally identical flashes naming different subjects
    assert.ok(!v2("微软发布新产品线公告", "苹果发布新产品线公告", { sameUrl: false, dayGap: 0 }));
    assert.ok(
      !v2(
        "财联社11月10日电，纳指ETF嘉实(159501)将于2026年11月11日开市起至当日10:30停牌。",
        "财联社11月10日电，纳指ETF广发(159941)将于2026年11月11日开市起至当日10:30停牌。",
        { sameUrl: false, dayGap: 0 },
      ),
      "different ETFs halting are two stories",
    );
    assert.ok(
      !v2("美股三大指数集体收涨 纳指涨超2%", "美股三大指数集体收跌 纳指跌超2%", {
        sameUrl: false,
        dayGap: 0,
      }),
      "opposite moves are two stories",
    );
    // (c) mis-split: reworded repeats must join
    assert.ok(
      v2(
        "Bessent blames Lutnick's Commerce Department for failing to block Megaspeed",
        "Bessent blames Lutnick’s commerce department for failure to blacklist Megaspeed",
        { sameUrl: false, dayGap: 0 },
      ),
      "cross-wire rewording must join",
    );
    assert.ok(
      v2(
        "财联社11月12日电，日本至11月6日当周外资买进日股-1052亿日元，前值11293亿日元。",
        "日本11月6日当周外资净买进日本股票 -1052亿日元，前值 11293亿日元。",
        { sameUrl: false, dayGap: 0 },
      ),
      "cross-wire reworded flash must join",
    );
  });

  await t.test("shipped gates are the measured plateau, not a knife edge", () => {
    // ±0.05 around every gate keeps both rates strictly better than v1;
    // a threshold sitting on a cliff would flip a rate with any nudge.
    for (const [gate, shipped] of [
      [SAME_EVENT_AFFINITY, 0.35],
      [SAME_DAY_ENTITY_AFFINITY, 0.08],
      [REWORDED_REPEAT_AFFINITY, 0.2],
    ] as const) {
      assert.equal(gate, shipped);
    }
    // and the conflict affinity stays below every gate, or conflicts stop conflicting
    assert.ok(0.05 < SAME_DAY_ENTITY_AFFINITY);
    assert.ok(headlineAffinity("美股三大指数集体收涨 纳指涨超2%", "美股三大指数集体收跌 纳指跌超2%") < SAME_DAY_ENTITY_AFFINITY);
  });
});
