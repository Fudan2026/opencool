import test from "node:test";
import assert from "node:assert/strict";

import {
  weekStartOf,
  bucketByIsoWeek,
  bucketByMonth,
  deltaChain,
  type PeriodEdition,
} from "./periods";

function row(date: string, score: number | null, extra: Partial<PeriodEdition> = {}): PeriodEdition {
  return { date, score, pos: 1, neg: 2, themes: [], idxPct: null, ...extra };
}

test("periods bucketing", async (t) => {
  await t.test("weekStartOf snaps to Monday across month boundary", () => {
    // 2026-11-01 is a Sunday → week starts 2026-10-26
    assert.equal(weekStartOf("2026-11-01"), "2026-10-26");
    // 2026-11-02 is a Monday → itself
    assert.equal(weekStartOf("2026-11-02"), "2026-11-02");
    // 2026-10-31 Saturday → Monday 2026-10-26
    assert.equal(weekStartOf("2026-10-31"), "2026-10-26");
  });

  await t.test("bucketByIsoWeek groups and skips empty weeks", () => {
    const buckets = bucketByIsoWeek([
      row("2026-10-27", -5),
      row("2026-10-28", -7, { themes: [{ name: "半导体", hits: 3 }] }),
      // skip a week entirely (2026-11-02..08 empty)
      row("2026-11-09", -2, { idxPct: 0.5 }),
    ]);
    assert.deepEqual(buckets.map((b) => b.key), ["2026-10-26", "2026-11-09"]);
    assert.equal(buckets[0].editions, 2);
    assert.equal(buckets[0].avgSentiment, -6);
    assert.deepEqual(buckets[0].topThemes, [{ name: "半导体", hits: 3 }]);
    assert.equal(buckets[1].avgIndexChangePct, 0.5);
    // end label of a middle bucket = next bucket's start (continuity)
    assert.equal(buckets[0].end, "2026-11-09");
  });

  await t.test("bucketByMonth splits on YYYY-MM", () => {
    const buckets = bucketByMonth([
      row("2026-10-31", -10),
      row("2026-11-01", 0, { pos: 3, neg: 1 }),
    ]);
    assert.deepEqual(buckets.map((b) => b.key), ["2026-10", "2026-11"]);
    assert.equal(buckets[1].posNegRatio, 0.75);
  });

  await t.test("deltaChain: null first, then rounded deltas", () => {
    const buckets = deltaChain([
      { key: "w1", end: "e1", editions: 2, avgSentiment: -10, posNegRatio: 0.4, topThemes: [], avgIndexChangePct: null },
      { key: "w2", end: "e2", editions: 2, avgSentiment: -3.5, posNegRatio: 0.6, topThemes: [], avgIndexChangePct: null },
      { key: "w3", end: "e3", editions: 1, avgSentiment: null, posNegRatio: null, topThemes: [], avgIndexChangePct: null },
    ]);
    assert.equal(buckets[0].deltaVsPrev, null);
    assert.equal(buckets[1].deltaVsPrev, 6.5);
    assert.equal(buckets[2].deltaVsPrev, null); // null neighbor breaks the chain honestly
  });
});
