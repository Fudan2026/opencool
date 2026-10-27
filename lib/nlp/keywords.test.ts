import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanKeyword,
  cleanKeywords,
  aggregateKeywords,
} from "./keywords";

test("keyword cleaning", async (t) => {
  await t.test("drops stopwords, fragments, digits, lone CJK", () => {
    assert.equal(cleanKeyword("to"), null);
    assert.equal(cleanKeyword("po"), null);
    assert.equal(cleanKeyword("The"), null);
    assert.equal(cleanKeyword("2026"), null);
    assert.equal(cleanKeyword("50%"), null);
    assert.equal(cleanKeyword("市"), null);
    assert.equal(cleanKeyword("量化交易"), "量化交易");
    assert.equal(cleanKeyword("polymarket"), "polymarket");
    assert.equal(cleanKeyword("MLF"), "MLF");
  });

  await t.test("cleanKeywords dedupes and preserves order", () => {
    assert.deepEqual(
      cleanKeywords(["MLF", "to", "量化", "MLF", "po", "降准"]),
      ["MLF", "量化", "降准"],
    );
    assert.deepEqual(cleanKeywords(undefined), []);
  });

  await t.test("aggregate counts editions and tracks first/last seen", () => {
    const agg = aggregateKeywords(
      [
        { date: "2026-10-25", hour: "19", keywords: ["MLF", "降准"] },
        { date: "2026-10-26", hour: "06", keywords: ["MLF"] },
        { date: "2026-10-26", hour: "13", keywords: ["to", "polymarket"] },
      ],
      7,
    );
    const mlf = agg.items.find((i) => i.term === "MLF")!;
    assert.equal(mlf.count, 2);
    assert.equal(mlf.firstSeen, "2026-10-25");
    assert.equal(mlf.lastSeen, "2026-10-26");
    const poly = agg.items.find((i) => i.term === "polymarket")!;
    assert.equal(poly.count, 1);
    assert.ok(!agg.items.some((i) => i.term === "to"));
    assert.equal(agg.editions, 3);
    assert.equal(agg.windowDays, 7);
  });
});
