import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPayload,
  canonicalUrl,
  emptyLedger,
  firstMoverRanking,
  ingestEdition,
  pruneLedger,
  recomputeDerived,
  revisionTrail,
  reviveLedger,
  sortStories,
  type EditionInput,
  type StoryArticle,
  type StoryLedger,
  type StoryRecord,
} from "./ledger";
import { isoWithOffset, offsetMinutes, parseInstant, shiftDateKey } from "./time";
import { storyEntities } from "../topics/dedupe";

/**
 * The story ledger's two load-bearing promises, and the five behaviours the
 * point-in-time plan calls out explicitly:
 *
 *   (a) different headlines about one entity share one cluster and one id;
 *   (b) a later run keeps that id and does not move `firstSeenAt`;
 *   (c) a rewritten headline keeps BOTH versions, in order;
 *   (d) the earliest distinct wire ranks first, with a sane lead in minutes;
 *   (e) `firstSeenAt` is OUR observation time, never the feed's `pubDate`.
 *
 * Plus the properties those imply: idempotent re-ingest (CI rebuilds slots),
 * deterministic pruning, and fail-open revival.
 */

const TZ = "Asia/Shanghai";

// `isoWithOffset` reads `REPORT_TZ` at call time (same as the pipeline), so the
// assertions below describe what a real Shanghaied run writes. node:test gives
// each file its own process, so this cannot leak into another suite.
process.env.REPORT_TZ = TZ;

function art(over: Partial<StoryArticle> & { sourceId: string; title: string }): StoryArticle {
  return {
    url: `https://example.com/${encodeURIComponent(over.sourceId)}/${encodeURIComponent(over.title).slice(0, 24)}`,
    ...over,
  };
}

function edition(
  date: string,
  hour: string,
  observedAt: string,
  articles: StoryArticle[],
): EditionInput {
  return { date, hour, observedAt: new Date(observedAt), articles };
}

function findByTitle(ledger: StoryLedger, needle: string): StoryRecord {
  const story = ledger.stories.find((s) => s.title.includes(needle));
  assert.ok(story, `no story whose lead headline contains "${needle}"`);
  return story;
}

function ingestAll(ledger: StoryLedger, editions: EditionInput[]): StoryLedger {
  for (const e of editions) ingestEdition(ledger, e);
  return ledger;
}

test("story ledger: clustering and identity", async (t) => {
  await t.test("(a) different headlines about one entity share one cluster and one id", () => {
    const ledger = emptyLedger();
    ingestEdition(
      ledger,
      edition("2026-11-13", "13", "2026-11-13T05:04:00Z", [
        art({ sourceId: "cnbc-topnews", title: "Nvidia stock falls 8% as investors await Jensen Huang's fate" }),
        art({ sourceId: "reuters", title: "Who will replace Jensen Huang at Nvidia?" }),
      ]),
    );

    assert.equal(ledger.stories.length, 1, "two headline shapes, one entity → one story");
    const story = ledger.stories[0];
    assert.equal(story.cluster, "entity:nvidia");
    assert.ok(story.id.startsWith("st_"));
    assert.equal(story.sightings.length, 1, "the second wire is a sighting, not a new story");
    assert.deepEqual(story.entities, ["nvidia"]);
  });

  await t.test("unrelated entities never merge into one story", () => {
    const ledger = emptyLedger();
    ingestEdition(
      ledger,
      edition("2026-11-13", "13", "2026-11-13T05:04:00Z", [
        art({ sourceId: "a", title: "英伟达发布新一代 GPU" }),
        art({ sourceId: "b", title: "央行开展 5000 亿元 MLF 操作" }),
      ]),
    );
    assert.equal(ledger.stories.length, 2);
    assert.notEqual(ledger.stories[0].id, ledger.stories[1].id);
  });

  await t.test("entity extraction is shared with the router, not re-implemented", () => {
    // Same function `storyCluster` uses, so the ledger and the density cap can
    // never disagree about what a story is about.
    assert.deepEqual(storyEntities("英伟达与台积电据悉洽谈产能合作"), ["nvidia", "tsmc"]);
    assert.deepEqual(storyEntities("no tracked entity here"), []);
  });

  await t.test("cross-language headlines about one entity collapse to one story", () => {
    const ledger = emptyLedger();
    ingestEdition(
      ledger,
      edition("2026-11-13", "19", "2026-11-13T11:04:00Z", [
        art({ sourceId: "wallstreetcn", title: "英伟达财报超预期，盘后大涨" }),
        art({ sourceId: "bloomberg", title: "Nvidia earnings beat estimates, shares jump" }),
      ]),
    );
    assert.equal(ledger.stories.length, 1);
    assert.deepEqual(ledger.stories[0].sources, ["bloomberg", "wallstreetcn"]);
  });
});

test("story ledger: point-in-time identity", async (t) => {
  await t.test("(b) a later run keeps the id and does not move firstSeenAt", () => {
    const ledger = emptyLedger();
    ingestAll(ledger, [
      edition("2026-11-13", "06", "2026-11-12T22:44:11Z", [
        art({ sourceId: "reuters", title: "Nvidia board weighs replacing Jensen Huang" }),
      ]),
      edition("2026-11-13", "13", "2026-11-13T05:04:00Z", [
        art({ sourceId: "cnbc-topnews", title: "Nvidia stock falls as Huang succession talk swirls" }),
        art({ sourceId: "bloomberg", title: "Nvidia investors weigh a future without Jensen Huang" }),
      ]),
    ]);

    assert.equal(ledger.stories.length, 1);
    const story = ledger.stories[0];
    assert.equal(story.sightings.length, 2);
    assert.equal(story.sources.length, 3);

    // firstSeenAt is the 06:00 observation, still, after the 13:00 edition.
    assert.equal(story.firstSeenAt, isoWithOffset(new Date("2026-11-12T22:44:11Z"), TZ));
    assert.equal(story.firstEdition, "2026-11-13/06");
    assert.equal(story.firstSourceId, "reuters");
    assert.equal(story.lastEdition, "2026-11-13/13");
  });

  await t.test("re-ingesting an edition is idempotent (CI rebuilds a slot)", () => {
    const ledger = emptyLedger();
    const e = edition("2026-11-13", "13", "2026-11-13T05:04:00Z", [
      art({ sourceId: "reuters", title: "Nvidia board weighs replacing Jensen Huang" }),
      art({ sourceId: "cnbc-topnews", title: "Nvidia stock falls on succession talk" }),
    ]);
    ingestEdition(ledger, e);
    const first = JSON.stringify(ledger.stories);
    const stats = ingestEdition(ledger, e);
    assert.equal(stats.created, 0);
    assert.equal(stats.attached, 0);
    assert.equal(stats.revisions, 0);
    assert.equal(JSON.stringify(ledger.stories), first, "a rebuild must not mutate history");
  });

  await t.test("an out-of-order backfill cannot move firstSeenAt backwards", () => {
    const ledger = emptyLedger();
    ingestAll(ledger, [
      edition("2026-11-13", "13", "2026-11-13T05:04:00Z", [
        art({ sourceId: "reuters", title: "Nvidia board weighs replacing Jensen Huang" }),
      ]),
      // Gate recovers the 06:00 slot hours later; its observation time is now.
      edition("2026-11-13", "06", "2026-11-13T07:20:00Z", [
        art({ sourceId: "bloomberg", title: "Nvidia succession question unsettles investors" }),
      ]),
    ]);
    const story = ledger.stories[0];
    assert.equal(story.firstSeenAt, isoWithOffset(new Date("2026-11-13T05:04:00Z"), TZ));
    assert.equal(story.firstEdition, "2026-11-13/13");
    // The late sighting is still recorded — history is added to, never rewritten.
    assert.equal(story.sightings.length, 1);
    assert.equal(story.sightings[0].edition, "2026-11-13/06");
  });

  await t.test("a ledger survives a JSON roundtrip with every field intact", () => {
    const ledger = emptyLedger();
    ingestAll(ledger, [
      edition("2026-11-13", "06", "2026-11-12T22:44:11Z", [
        art({ sourceId: "reuters", title: "Nvidia board weighs replacing Jensen Huang", publishedAt: "2026-11-12T21:00:00Z" }),
      ]),
      edition("2026-11-13", "13", "2026-11-13T05:04:00Z", [
        art({ sourceId: "cnbc-topnews", title: "Nvidia stock falls on succession talk" }),
        art({ sourceId: "wsj-markets", title: "Nvidia's next act: who follows Jensen Huang" }),
      ]),
    ]);
    const round = reviveLedger(JSON.parse(JSON.stringify(ledger)));
    assert.equal(round.skipped, 0);
    assert.deepEqual(
      JSON.parse(JSON.stringify(round.ledger.stories)),
      JSON.parse(JSON.stringify(ledger.stories)),
    );
    const story = round.ledger.stories[0];
    assert.equal(story.firstMover.sourceId, "reuters");
    assert.equal(story.sightings.length, 2);
    assert.equal(typeof story.publishLagMinutes, "number");
  });
});

test("story ledger: headline revisions", async (t) => {
  await t.test("(c) a rewritten headline keeps both versions, in order", () => {
    const ledger = emptyLedger();
    const url = "https://www.bloomberg.com/news/articles/2026-11-12/nvidia-markets-wrap";
    ingestAll(ledger, [
      edition("2026-11-13", "06", "2026-11-12T22:44:11Z", [
        art({ sourceId: "bloomberg", title: "Nvidia Shares Gain After Shakeup", url }),
      ]),
      edition("2026-11-13", "13", "2026-11-13T05:04:00Z", [
        art({ sourceId: "bloomberg", title: "Nvidia Stock Drifts Before Inflation Test", url }),
      ]),
      edition("2026-11-13", "19", "2026-11-13T11:04:00Z", [
        art({ sourceId: "bloomberg", title: "Nvidia Falls as Chip Rout Outweighs Inflation Data", url }),
      ]),
    ]);

    const story = ledger.stories[0];
    assert.equal(story.headlineRevisions.length, 2, "two rewrites → two revision entries");

    const [first, second] = story.headlineRevisions;
    assert.equal(first.from, "Nvidia Shares Gain After Shakeup");
    assert.equal(first.to, "Nvidia Stock Drifts Before Inflation Test");
    assert.equal(second.from, "Nvidia Stock Drifts Before Inflation Test");
    assert.equal(second.to, "Nvidia Falls as Chip Rout Outweighs Inflation Data");

    // Ordered, and each revision follows the sighting it replaces.
    const times = story.headlineRevisions.map((r) => parseInstant(r.at)!.getTime());
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
    assert.ok(times[0]! < times[1]!);
    assert.equal(first.sourceId, "bloomberg");
    assert.notEqual(first.from, first.to, "a revision must actually change the text");

    // The trail publishes a diff per step, not just both strings.
    const trail = revisionTrail(ledger);
    assert.equal(trail.storiesWithRevisions, 1);
    assert.equal(trail.totalRevisions, 2);
    const step = trail.items[0].steps[0];
    assert.ok(step.added.length > 0 || step.removed.length > 0);
  });

  await t.test("a rolling url that switches story is a new record, not a revision", () => {
    // FirstFT / "Markets Wrap" keep one address while the lead story changes.
    // Treating that as a rewrite would file "Oil price falls" as a revision of
    // an Nvidia headline — the failure this rule exists to prevent.
    const ledger = emptyLedger();
    const url = "https://www.ft.com/content/firstft-rolling";
    ingestAll(ledger, [
      edition("2026-11-13", "06", "2026-11-12T22:44:11Z", [
        art({ sourceId: "ft-companies", title: "FirstFT: Nvidia board weighs Huang's future", url }),
      ]),
      edition("2026-11-13", "13", "2026-11-13T05:04:00Z", [
        art({ sourceId: "ft-companies", title: "FirstFT: Oil price falls below $90 a barrel", url }),
      ]),
    ]);
    assert.equal(ledger.stories.length, 2, "different cluster on the same url → different story");
    for (const story of ledger.stories) {
      assert.equal(story.headlineRevisions.length, 0);
    }
  });

  await t.test("a different wire saying it differently is a sighting, not a revision", () => {
    const ledger = emptyLedger();
    ingestAll(ledger, [
      edition("2026-11-13", "06", "2026-11-12T22:44:11Z", [
        art({ sourceId: "reuters", title: "Nvidia board weighs replacing Jensen Huang" }),
      ]),
      edition("2026-11-13", "13", "2026-11-13T05:04:00Z", [
        art({ sourceId: "cnbc-topnews", title: "Who could replace Jensen Huang at Nvidia?" }),
      ]),
    ]);
    assert.equal(ledger.stories[0].headlineRevisions.length, 0);
    assert.equal(ledger.stories[0].sightings.length, 1);
  });

  await t.test("re-ingesting a rewrite adds exactly one revision", () => {
    const ledger = emptyLedger();
    const url = "https://example.com/nvidia-wrap";
    ingestEdition(
      ledger,
      edition("2026-11-13", "06", "2026-11-12T22:44:11Z", [
        art({ sourceId: "bloomberg", title: "Nvidia Shares Gain: Markets Wrap", url }),
      ]),
    );
    const rewrite = edition("2026-11-13", "13", "2026-11-13T05:04:00Z", [
      art({ sourceId: "bloomberg", title: "Nvidia Drifts Before Inflation Test", url }),
    ]);
    ingestEdition(ledger, rewrite);
    ingestEdition(ledger, rewrite);
    assert.equal(ledger.stories[0].headlineRevisions.length, 1);
  });

  await t.test("url identity ignores tracking params so a reprint is not a new story", () => {
    assert.equal(
      canonicalUrl("https://www.wsj.com/articles/x?mod=rss_markets_main"),
      canonicalUrl("https://www.wsj.com/articles/x"),
    );
    const ledger = emptyLedger();
    ingestAll(ledger, [
      edition("2026-11-13", "06", "2026-11-12T22:44:11Z", [
        art({ sourceId: "wsj-markets", title: "Fed signals patience", url: "https://www.wsj.com/x?mod=rss_markets_main" }),
      ]),
      edition("2026-11-13", "13", "2026-11-13T05:04:00Z", [
        art({ sourceId: "wsj-markets", title: "Fed signals patience", url: "https://www.wsj.com/x?mod=rss" }),
      ]),
    ]);
    assert.equal(ledger.stories.length, 1);
    assert.equal(ledger.stories[0].sightings.length, 0, "same wire, same url → no new sighting");
  });
});

test("story ledger: first-mover ranking", async (t) => {
  await t.test("(d) the earliest distinct wire ranks first with a sane lead", () => {
    const ledger = emptyLedger();
    ingestAll(ledger, [
      edition("2026-11-13", "06", "2026-11-12T22:00:00Z", [
        art({ sourceId: "reuters", title: "Nvidia board weighs replacing Jensen Huang" }),
      ]),
      edition("2026-11-13", "13", "2026-11-12T22:07:30Z", [
        art({ sourceId: "cnbc-topnews", title: "Nvidia stock falls on succession talk" }),
      ]),
      edition("2026-11-13", "19", "2026-11-12T23:15:00Z", [
        art({ sourceId: "bloomberg", title: "Nvidia investors weigh a future without Huang" }),
      ]),
    ]);

    const story = ledger.stories[0];
    assert.equal(story.firstMover.sourceId, "reuters");
    assert.equal(story.firstMover.tied, false);
    assert.equal(story.firstMover.leadMinutes, 7.5, "7m30s lead over the runner-up");
    assert.equal(story.firstMover.runnerUpSourceId, "cnbc-topnews");

    const ranking = firstMoverRanking(ledger, { now: new Date("2026-11-13T12:00:00Z") });
    assert.equal(ranking.wires[0].sourceId, "reuters");
    assert.equal(ranking.wires[0].soleFirsts, 1);
    assert.equal(ranking.wires[0].contestedFirsts, 1, "someone had to catch up");
    assert.equal(ranking.wires[0].medianLeadMinutes, 7.5);
    assert.equal(ranking.wires[0].leadSamples, 1);
    assert.equal(ranking.soleFirstStories, 1);
    assert.equal(ranking.contestedStories, 1);
    assert.equal(ranking.tiedFirstStories, 0);

    // The later wires never claim a first.
    for (const w of ranking.wires.slice(1)) assert.equal(w.soleFirsts, 0);
  });

  await t.test("a same-fetch crowd is recorded as a tie, not an alphabetical win", () => {
    const ledger = emptyLedger();
    ingestEdition(
      ledger,
      edition("2026-11-13", "06", "2026-11-12T22:00:00Z", [
        art({ sourceId: "reuters", title: "Nvidia board weighs replacing Jensen Huang" }),
        art({ sourceId: "cnbc-topnews", title: "Nvidia succession talk rattles investors" }),
        art({ sourceId: "bloomberg", title: "Nvidia's future without Jensen Huang" }),
      ]),
    );
    const story = ledger.stories[0];
    assert.equal(story.firstMover.tied, true);
    assert.equal(story.firstMover.sourceId, null, "nobody is credited with a lead they do not have");
    assert.deepEqual(story.firstMover.coFirstSourceIds, ["bloomberg", "cnbc-topnews", "reuters"]);
    assert.equal(story.firstMover.leadMinutes, null);

    const ranking = firstMoverRanking(ledger);
    assert.equal(ranking.tiedFirstStories, 1);
    assert.equal(ranking.soleFirstStories, 0);
    for (const w of ranking.wires) {
      assert.equal(w.coFirsts, 1);
      assert.equal(w.soleFirsts, 0);
    }
  });

  await t.test("a single-wire story counts as a first but never as contested", () => {
    const ledger = emptyLedger();
    ingestEdition(
      ledger,
      edition("2026-11-13", "06", "2026-11-12T22:00:00Z", [
        art({ sourceId: "economist-finance", title: "Nvidia board weighs replacing Jensen Huang" }),
      ]),
    );
    const ranking = firstMoverRanking(ledger, { now: new Date("2026-11-13T12:00:00Z") });
    const row = ranking.wires[0];
    assert.equal(row.sourceId, "economist-finance");
    assert.equal(row.soleFirsts, 1);
    assert.equal(row.contestedFirsts, 0, "nobody raced it, so no lead exists to claim");
    assert.equal(row.medianLeadMinutes, null);
    assert.equal(ranking.contestedStories, 0);
    assert.equal(ranking.soleFirstStories, 1);
  });

  await t.test("ranking sorts by contested firsts ahead of raw volume", () => {
    const ledger = emptyLedger();
    // "volume-heavy" breaks 20 single-wire stories and one contested one;
    // "scoop" breaks three contested ones and no single-wire stories.
    const editions: EditionInput[] = [];
    for (let i = 0; i < 20; i++) {
      editions.push(
        edition("2026-11-12", "06", `2026-11-11T22:${String(i).padStart(2, "0")}:00Z`, [
          art({
            sourceId: "volume-heavy",
            // No tracked entity and a distinct key, so each is its own story.
            title: `某上市公司第${i}号自愿性信息披露公告发布`,
            url: `https://example.com/filing/${i}`,
          }),
        ]),
      );
    }
    editions.push(
      edition("2026-11-12", "13", "2026-11-11T22:30:00Z", [
        art({ sourceId: "volume-heavy", title: "Tesla recalls Cybertruck over brake fault" }),
      ]),
      edition("2026-11-12", "19", "2026-11-11T23:30:00Z", [
        art({ sourceId: "bloomberg", title: "Tesla recall hits Cybertruck deliveries" }),
      ]),
    );
    for (const [i, name] of ["苹果", "微软", "台积电"].entries()) {
      editions.push(
        edition("2026-11-13", `0${i + 6}`.slice(-2), `2026-11-12T22:0${i}:00Z`, [
          art({ sourceId: "scoop", title: `${name}发布新产品线公告` }),
        ]),
        edition("2026-11-13", `1${i}`.slice(-2), `2026-11-12T23:0${i}:00Z`, [
          art({ sourceId: "follower", title: `${name}新产品线引发行业关注` }),
        ]),
      );
    }
    ingestAll(ledger, editions);
    sortStories(ledger);

    const ranking = firstMoverRanking(ledger, { now: new Date("2026-11-13T12:00:00Z") });
    assert.equal(ranking.wires[0].sourceId, "scoop");
    assert.equal(ranking.wires[0].contestedFirsts, 3);
    const heavy = ranking.wires.find((w) => w.sourceId === "volume-heavy")!;
    assert.equal(heavy.soleFirsts, 21, "volume still shows, but below the scoop");
    assert.equal(heavy.contestedFirsts, 1);
  });

  await t.test("median lead aggregates across stories and ignores the window edge", () => {
    const ledger = emptyLedger();
    // Story 1: reuters leads by 10 minutes.
    ingestAll(ledger, [
      edition("2026-11-10", "06", "2026-11-09T22:00:00Z", [
        art({ sourceId: "reuters", title: "Nvidia board weighs replacing Jensen Huang" }),
      ]),
      edition("2026-11-10", "13", "2026-11-09T22:10:00Z", [
        art({ sourceId: "cnbc-topnews", title: "Nvidia succession talk rattles investors" }),
      ]),
    ]);
    // Story 2: reuters leads by 20 minutes.
    ingestAll(ledger, [
      edition("2026-11-11", "06", "2026-11-10T22:00:00Z", [
        art({ sourceId: "reuters", title: "Tesla recalls Cybertruck over brake fault" }),
      ]),
      edition("2026-11-11", "13", "2026-11-10T22:20:00Z", [
        art({ sourceId: "bloomberg", title: "Tesla recall hits Cybertruck deliveries" }),
      ]),
    ]);

    const ranking = firstMoverRanking(ledger, { now: new Date("2026-11-13T01:00:00Z"), windowDays: 30 });
    const row = ranking.wires.find((w) => w.sourceId === "reuters")!;
    assert.equal(row.soleFirsts, 2);
    assert.equal(row.medianLeadMinutes, 15, "median of 10 and 20");
    assert.equal(row.leadSamples, 2);
    assert.equal(row.stories, 2);

    // A 1-day window ending 11-13 excludes both 11-10 and 11-11 stories.
    const narrow = firstMoverRanking(ledger, { now: new Date("2026-11-13T01:00:00Z"), windowDays: 1 });
    assert.equal(narrow.storiesInWindow, 0);
    assert.deepEqual(narrow.wires, []);
  });
});

test("story ledger: observed time beats pubDate", async (t) => {
  await t.test("(e) firstSeenAt is our observation time, not the feed timestamp", () => {
    const ledger = emptyLedger();
    // The feed claims 18:00 the previous day; we did not look until 06:00 today
    // (22:44Z the day before) — five hours of unknowability that the ledger
    // must not paper over by adopting the wire's clock.
    ingestEdition(
      ledger,
      edition("2026-11-13", "06", "2026-11-12T22:44:11Z", [
        art({
          sourceId: "reuters",
          title: "Nvidia board weighs replacing Jensen Huang",
          publishedAt: "2026-11-12T12:00:00Z",
        }),
      ]),
    );

    const story = ledger.stories[0];
    const observed = new Date("2026-11-12T22:44:11Z");
    assert.equal(story.firstSeenAt, isoWithOffset(observed, TZ));
    assert.notEqual(story.firstSeenAt, isoWithOffset(new Date("2026-11-12T12:00:00Z"), TZ));

    // Both clocks are kept, and the gap between them is exposed.
    assert.equal(story.publishedAt, "2026-11-12T12:00:00.000Z");
    assert.equal(story.publishLagMinutes, 644.2, "10h44m11s after the wire's own stamp");
    assert.equal(story.sightings.length, 0, "the first observation lives on the record itself");
  });

  await t.test("firstSeenAt is an ISO instant with a +08:00 offset", () => {
    const d = new Date("2026-11-13T11:04:00Z");
    assert.equal(isoWithOffset(d, "Asia/Shanghai"), "2026-11-13T19:04:00+08:00");
    assert.equal(offsetMinutes(d, "Asia/Shanghai"), 480);
    assert.match(isoWithOffset(d), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  await t.test("a wire claiming it published after we fetched yields a negative lag", () => {
    const ledger = emptyLedger();
    ingestEdition(
      ledger,
      edition("2026-11-13", "13", "2026-11-13T05:04:00Z", [
        art({
          sourceId: "misclocked-wire",
          title: "Nvidia board weighs replacing Jensen Huang",
          publishedAt: "2026-11-13T09:00:00Z",
        }),
      ]),
    );
    const story = ledger.stories[0];
    assert.ok(
      (story.publishLagMinutes ?? 0) < 0,
      `expected a negative lag, got ${story.publishLagMinutes}`,
    );
  });

  await t.test("an article with no feed timestamp yields a null lag, not a fake one", () => {
    const ledger = emptyLedger();
    ingestEdition(
      ledger,
      edition("2026-11-13", "13", "2026-11-13T05:04:00Z", [
        art({ sourceId: "reuters", title: "Nvidia board weighs replacing Jensen Huang" }),
      ]),
    );
    assert.equal(ledger.stories[0].publishedAt, null);
    assert.equal(ledger.stories[0].publishLagMinutes, null);
  });
});

test("story ledger: retention, pruning and fail-open revival", async (t) => {
  await t.test("pruning is deterministic and drops only out-of-window stories", () => {
    const build = (): StoryLedger => {
      const ledger = emptyLedger({ retentionDays: 30 });
      ingestAll(ledger, [
        edition("2026-10-01", "06", "2026-09-30T22:00:00Z", [
          art({ sourceId: "reuters", title: "Nvidia board weighs replacing Jensen Huang" }),
        ]),
        edition("2026-11-13", "06", "2026-11-12T22:00:00Z", [
          art({ sourceId: "reuters", title: "Tesla recalls Cybertruck over brake fault" }),
        ]),
      ]);
      return ledger;
    };
    const a = build();
    const b = build();
    const now = new Date("2026-11-13T12:00:00Z");
    assert.equal(pruneLedger(a, now), 1);
    assert.equal(pruneLedger(b, now), 1);
    assert.deepEqual(a.stories.map((s) => s.id), b.stories.map((s) => s.id));
    assert.equal(a.stories.length, 1, "the November story is retained");
  });

  await t.test("the story cap keeps the newest records, ties broken by id", () => {
    const ledger = emptyLedger({ maxStories: 2 });
    ingestAll(ledger, [
      edition("2026-11-11", "06", "2026-11-10T22:00:00Z", [art({ sourceId: "a", title: "Nvidia board weighs replacing Huang" })]),
      edition("2026-11-12", "06", "2026-11-11T22:00:00Z", [art({ sourceId: "b", title: "Tesla recalls Cybertruck over brakes" })]),
      edition("2026-11-13", "06", "2026-11-12T22:00:00Z", [art({ sourceId: "c", title: "央行开展 5000 亿元 MLF 操作" })]),
    ]);
    pruneLedger(ledger, new Date("2026-11-13T12:00:00Z"));
    assert.equal(ledger.stories.length, 2);
    const editions = ledger.stories.map((s) => s.firstEdition).sort();
    assert.deepEqual(editions, ["2026-11-12/06", "2026-11-13/06"]);
  });

  await t.test("an unparseable record is skipped and counted, never fatal", () => {
    const good = emptyLedger();
    ingestEdition(
      good,
      edition("2026-11-13", "06", "2026-11-12T22:00:00Z", [
        art({ sourceId: "reuters", title: "Nvidia board weighs replacing Jensen Huang" }),
      ]),
    );
    const corrupt = {
      ...JSON.parse(JSON.stringify(good)),
      stories: [
        ...JSON.parse(JSON.stringify(good.stories)),
        { id: "broken" },                       // no firstSeenAt / firstSourceId
        { firstSeenAt: "nonsense" },            // no id, unparseable instant
        null,                                    // not an object
        "garbage",                               // not an object
      ],
    };
    const revived = reviveLedger(corrupt);
    assert.equal(revived.ledger.stories.length, 1, "the healthy record survives");
    assert.equal(revived.skipped, 4);
  });

  await t.test("a totally corrupt file revives to an empty ledger rather than throwing", () => {
    for (const raw of [null, undefined, "nope", 42, { stories: "not an array" }]) {
      const revived = reviveLedger(raw);
      assert.equal(revived.ledger.stories.length, 0);
      assert.equal(revived.skipped, 0);
    }
  });

  await t.test("derived fields are recomputed, so a stale firstMover cannot survive", () => {
    const ledger = emptyLedger();
    ingestAll(ledger, [
      edition("2026-11-13", "06", "2026-11-12T22:00:00Z", [
        art({ sourceId: "reuters", title: "Nvidia board weighs replacing Jensen Huang" }),
      ]),
      edition("2026-11-13", "13", "2026-11-12T22:30:00Z", [
        art({ sourceId: "cnbc-topnews", title: "Nvidia succession talk rattles investors" }),
      ]),
    ]);
    const tampered = JSON.parse(JSON.stringify(ledger.stories[0])) as StoryRecord;
    tampered.firstMover.sourceId = "cnbc-topnews"; // pretend the follower was first
    tampered.sources = ["cnbc-topnews"];           // and that it was alone
    const fixed = recomputeDerived(tampered);
    assert.equal(fixed.firstMover.sourceId, "reuters");
    assert.deepEqual(fixed.sources, ["reuters", "cnbc-topnews"]);
    assert.equal(fixed.firstMover.leadMinutes, 30);
  });
});

test("story ledger: published payload", async (t) => {
  await t.test("counts, first-mover table and revision trail are all present", () => {
    const ledger = emptyLedger();
    const url = "https://www.bloomberg.com/news/articles/apple-wrap";
    ingestAll(ledger, [
      edition("2026-11-13", "06", "2026-11-12T22:00:00Z", [
        art({ sourceId: "reuters", title: "Nvidia board weighs replacing Jensen Huang" }),
        art({ sourceId: "bloomberg", title: "苹果发布会前瞻：新品定价", url }),
      ]),
      edition("2026-11-13", "13", "2026-11-12T22:05:00Z", [
        art({ sourceId: "cnbc-topnews", title: "Nvidia succession talk rattles investors" }),
        art({ sourceId: "bloomberg", title: "苹果发布会前瞻：新品与定价策略", url }),
      ]),
    ]);
    sortStories(ledger);

    const payload = buildPayload(
      ledger,
      { editions: 2, articles: 4, duplicates: 0, skippedRecords: 1 },
      { now: new Date("2026-11-13T12:00:00Z") },
    );
    assert.equal(payload.counts.stories, 2);
    // Both stories gained a second observation at 13:00 — the Nvidia story from
    // a second wire, the Apple story from its own wire after a rewrite.
    assert.equal(payload.counts.multiSightingStories, 2);
    assert.equal(payload.counts.storiesWithRevisions, 1);
    assert.equal(payload.counts.skippedRecords, 1);
    assert.equal(payload.counts.editions, 2);
    assert.ok(payload.firstMover.wires.length >= 3);
    assert.equal(payload.revisionTrail.totalRevisions, 1);
    // Survives JSON exactly — the published file is the ledger plus artifacts.
    const round = JSON.parse(JSON.stringify(payload));
    assert.equal(round.stories.length, 2);
    assert.equal(round.firstMover.wires[0].sourceId, "reuters");
  });

  await t.test("story order is stable across rebuilds (git diffs stay readable)", () => {
    const ledger = emptyLedger();
    ingestAll(ledger, [
      edition("2026-11-13", "06", "2026-11-12T22:00:00Z", [
        art({ sourceId: "reuters", title: "Nvidia board weighs replacing Jensen Huang" }),
        art({ sourceId: "reuters", title: "Tesla recalls Cybertruck over brake fault" }),
        art({ sourceId: "reuters", title: "央行开展 5000 亿元 MLF 操作" }),
      ]),
    ]);
    sortStories(ledger);
    const once = ledger.stories.map((s) => s.id);
    ledger.stories.reverse();
    sortStories(ledger);
    assert.deepEqual(ledger.stories.map((s) => s.id), once);
  });
});

test("story ledger: report timezone is structural", async (t) => {
  await t.test("the timezone is never the literal 'system'", () => {
    // The first published ledger shipped `timezone: "system"` and every
    // firstSeenAt at `+00:00`, because the CI bake step had no REPORT_TZ. The
    // run stayed green, so only an assert (and this test) could catch it.
    const saved = process.env.REPORT_TZ;
    delete process.env.REPORT_TZ;
    try {
      const ledger = emptyLedger();
      assert.notEqual(ledger.timezone, "system");
      assert.ok(ledger.timezone.length > 0, "timezone must name a zone");
      assert.match(
        ledger.timezone,
        /^[A-Za-z][A-Za-z0-9_+\-/]*$/,
        `expected an IANA zone name, got "${ledger.timezone}"`,
      );
    } finally {
      if (saved === undefined) delete process.env.REPORT_TZ;
      else process.env.REPORT_TZ = saved;
    }
  });

  await t.test("a revived ledger is re-stamped into the active timezone", () => {
    // The CI warm path, and the self-heal for the one file that shipped with
    // `+00:00` offsets: the restored ledger names one zone, this run renders
    // under another. Both the declared zone and every instant must follow.
    const ledger = emptyLedger();
    ingestEdition(
      ledger,
      edition("2026-11-13", "06", "2026-11-12T22:00:00Z", [
        art({ sourceId: "reuters", title: "Nvidia board weighs replacing Jensen Huang" }),
      ]),
    );
    const stale = JSON.parse(JSON.stringify(ledger)) as Record<string, unknown>;
    stale.timezone = "system";
    const raw = (stale.stories as Array<Record<string, unknown>>)[0];
    raw.firstSeenAt = "2026-11-12T22:00:00+00:00";
    raw.lastSeenAt = "2026-11-12T22:00:00+00:00";

    const revived = reviveLedger(stale, { now: new Date("2026-11-13T12:00:00Z") });
    assert.equal(revived.skipped, 0);
    assert.notEqual(revived.ledger.timezone, "system");
    assert.equal(revived.ledger.timezone, TZ);
    // The instant is the same moment, re-rendered in the report timezone.
    assert.equal(revived.ledger.stories[0].firstSeenAt, "2026-11-13T06:00:00+08:00");
    assert.equal(
      parseInstant(revived.ledger.stories[0].firstSeenAt)?.toISOString(),
      "2026-11-12T22:00:00.000Z",
      "re-stamping must not move the moment",
    );
  });
});

test("story ledger: time helpers", async (t) => {
  await t.test("offsetMinutes handles west-of-UTC offsets too", () => {
    const d = new Date("2026-11-13T12:00:00Z");
    assert.equal(offsetMinutes(d, "America/New_York"), -300);
    assert.equal(isoWithOffset(d, "America/New_York"), "2026-11-13T07:00:00-05:00");
    assert.equal(isoWithOffset(d, "UTC"), "2026-11-13T12:00:00+00:00");
  });

  await t.test("shiftDateKey crosses month and year boundaries", () => {
    assert.equal(shiftDateKey("2026-11-01", -1), "2026-11-01".replace("11-01", "10-31"));
    assert.equal(shiftDateKey("2026-01-01", -1), "2025-12-31");
    assert.equal(shiftDateKey("2026-02-28", 1), "2026-03-01");
  });

  await t.test("parseInstant rejects junk and accepts the three real shapes", () => {
    assert.equal(parseInstant("not a date"), null);
    assert.equal(parseInstant(""), null);
    assert.equal(parseInstant(undefined), null);
    assert.equal(parseInstant(new Date("nope")), null);
    assert.equal(parseInstant("2026-11-13T19:04:00+08:00")?.toISOString(), "2026-11-13T11:04:00.000Z");
    assert.equal(parseInstant(new Date("2026-11-13T11:04:00Z"))?.toISOString(), "2026-11-13T11:04:00.000Z");
    assert.equal(parseInstant(Date.UTC(2026, 10, 13, 11, 4))?.toISOString(), "2026-11-13T11:04:00.000Z");
  });

  await t.test("findByTitle sanity check on the fixture helper", () => {
    const ledger = emptyLedger();
    ingestEdition(
      ledger,
      edition("2026-11-13", "06", "2026-11-12T22:00:00Z", [
        art({ sourceId: "reuters", title: "Nvidia board weighs replacing Jensen Huang" }),
      ]),
    );
    assert.equal(findByTitle(ledger, "Jensen Huang").firstSourceId, "reuters");
  });
});
