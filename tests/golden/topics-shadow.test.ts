import test from "node:test";
import assert from "node:assert/strict";

import { classifyAll } from "../../lib/topics/classify";
import { LANE_KEYS, TOPIC_KEYS } from "../../lib/topics/taxonomy";
import { groupRaw, renderHtml } from "../../lib/output/render";
import type { ArticleInput } from "../../lib/ai/pipeline";
import type { SourceDef } from "../../lib/sources/types";
import { article, rawByCategory, reportFixture } from "./helpers";

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

  await t.test("renderHtml ignores the six new fields", () => {
    const plain = renderHtml(reportFixture(), groupRaw(ARTICLES, REGISTRY), "2026-11-13", opts);
    const shadow = renderHtml(reportFixture(), groupRaw(tagged, REGISTRY), "2026-11-13", opts);
    assert.equal(shadow, plain, "shadow tagging must not change a single byte of HTML");
  });

  await t.test("groupRaw buckets identically with and without the new fields", () => {
    // Stripping the six fields must reproduce the exact same grouping, which is
    // what proves classification never reaches the render path.
    const plain = groupRaw(ARTICLES, REGISTRY);
    const shadow = groupRaw(tagged, REGISTRY);
    const shadowStripped = JSON.parse(
      JSON.stringify(shadow, (k, v) => (ADDED_FIELDS.includes(k) ? undefined : v)),
    );
    assert.deepEqual(shadowStripped, JSON.parse(JSON.stringify(plain)));
  });

  await t.test("a legacy untagged article still renders", () => {
    const html = renderHtml(reportFixture(), rawByCategory(), "2026-10-26", {
      editionHour: "19",
      siblingHours: ["06", "13", "19"],
    });
    assert.ok(html.includes('data-tab="finance"'));
    assert.ok(html.includes("央行开展 5000 亿元 MLF 操作"));
  });
});
