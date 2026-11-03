import test from "node:test";
import assert from "node:assert/strict";

import { resolveFeedOrder } from "./rss";

test("resolveFeedOrder", async (t) => {
  await t.test("primary first, mirrors in order", () => {
    assert.deepEqual(
      resolveFeedOrder("https://a/feed", ["https://b/feed", "https://c/feed"]),
      ["https://a/feed", "https://b/feed", "https://c/feed"],
    );
  });

  await t.test("no mirrors -> single-element list", () => {
    assert.deepEqual(resolveFeedOrder("https://a/feed"), ["https://a/feed"]);
    assert.deepEqual(resolveFeedOrder("https://a/feed", undefined), ["https://a/feed"]);
    assert.deepEqual(resolveFeedOrder("https://a/feed", []), ["https://a/feed"]);
  });

  await t.test("dedupes and drops empty entries", () => {
    assert.deepEqual(
      resolveFeedOrder("https://a/feed", ["https://a/feed", "", "https://b/feed"]),
      ["https://a/feed", "https://b/feed"],
    );
  });
});
