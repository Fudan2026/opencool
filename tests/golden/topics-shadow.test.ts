import test from "node:test";
import assert from "node:assert/strict";

import { classifyAll } from "../../lib/topics/classify";
import { TOPIC_KEYS } from "../../lib/topics/taxonomy";
import { groupRaw, renderHtml } from "../../lib/output/render";
import type { ArticleInput } from "../../lib/ai/pipeline";
import type { SourceDef } from "../../lib/sources/types";
import { article, rawByCategory, reportFixture } from "./helpers";

/**
 * GOLDEN: increment 1 of the topic redesign is *shadow mode*. Two promises
 * are load-bearing here:
 *
 *  1. The articles sidecar gains exactly `topic` + `topicConfidence` and
 *     nothing else — no existing field moves, changes type, or disappears.
 *  2. Rendering is byte-identical with and without those fields, because
 *     `groupRaw` never reads them. If a future increment starts routing on
 *     `topic`, this test is the thing that must change deliberately.
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
];

type Tagged = ArticleInput & { topic: string; topicConfidence: number };

function tagAll(list: ArticleInput[]): Tagged[] {
  const sub = new Map(REGISTRY.map((s) => [s.id, s.subcategory]));
  return classifyAll(list, (a) => sub.get(a.sourceId)) as Tagged[];
}

test("golden: topic tagging is additive on the articles sidecar", async (t) => {
  const tagged = tagAll(ARTICLES);

  await t.test("exactly two new keys per article", () => {
    for (let i = 0; i < ARTICLES.length; i++) {
      const before = new Set(Object.keys(ARTICLES[i]));
      const added = Object.keys(tagged[i]).filter((k) => !before.has(k));
      const removed = [...before].filter((k) => !(k in tagged[i]));
      assert.deepEqual(added.sort(), ["topic", "topicConfidence"]);
      assert.deepEqual(removed, []);
    }
  });

  await t.test("every pre-existing field is identical after a JSON roundtrip", () => {
    // Compare both sides through JSON so `Date` vs ISO string is not a diff.
    const plain = JSON.parse(JSON.stringify(ARTICLES)) as Array<Record<string, unknown>>;
    for (let i = 0; i < ARTICLES.length; i++) {
      const { topic, topicConfidence, ...rest } = tagged[i];
      assert.ok(topic && typeof topicConfidence === "number");
      assert.deepEqual(JSON.parse(JSON.stringify(rest)), plain[i]);
    }
  });

  await t.test("topic is always one of the seven keys", () => {
    for (const a of tagged) {
      assert.ok(
        (TOPIC_KEYS as string[]).includes(a.topic),
        `unexpected topic: ${a.topic}`,
      );
    }
  });

  await t.test("topicConfidence stays within 0..1 and survives JSON", () => {
    for (const a of tagged) {
      assert.ok(a.topicConfidence >= 0 && a.topicConfidence <= 1);
    }
    // Only the topic fields need to survive serialisation unchanged; other
    // fields legitimately change shape (Date → ISO string).
    const round = JSON.parse(JSON.stringify(tagged)) as Tagged[];
    for (let i = 0; i < tagged.length; i++) {
      assert.equal(round[i].topic, tagged[i].topic);
      assert.equal(round[i].topicConfidence, tagged[i].topicConfidence);
    }
  });

  await t.test("routes the three fixture headlines as expected", () => {
    assert.equal(tagged[0].topic, "cn-finance");
    assert.equal(tagged[1].topic, "tech-ai");
    assert.equal(tagged[2].topic, "world");
  });
});

test("golden: render output is unchanged by shadow tagging", async (t) => {
  const tagged = tagAll(ARTICLES);
  const opts = { editionHour: "06", siblingHours: ["06", "13", "19"] };

  await t.test("renderHtml ignores topic/topicConfidence", () => {
    const plain = renderHtml(reportFixture(), groupRaw(ARTICLES, REGISTRY), "2026-11-13", opts);
    const shadow = renderHtml(reportFixture(), groupRaw(tagged, REGISTRY), "2026-11-13", opts);
    assert.equal(shadow, plain, "shadow tagging must not change a single byte of HTML");
  });

  await t.test("groupRaw buckets identically with and without topic fields", () => {
    // Stripping the two fields must reproduce the exact same grouping, which
    // is what proves classification never reaches the render path.
    const plain = groupRaw(ARTICLES, REGISTRY);
    const shadow = groupRaw(tagged, REGISTRY);
    const shadowStripped = JSON.parse(
      JSON.stringify(shadow, (k, v) =>
        k === "topic" || k === "topicConfidence" ? undefined : v,
      ),
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
