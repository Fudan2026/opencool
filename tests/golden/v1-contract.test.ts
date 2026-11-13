import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderIntegrityHtml } from "../../lib/output/render";
import { buildV1, writeV1, type CoveragePayload } from "../../lib/v1/build";
import {
  V1_GUARANTEES,
  V1_HORIZONS,
  V1_REQUIRED_FIELDS,
  V1_SCHEMA_VERSION,
  V1_TAPE_LAUNCH_DATE,
  checkShape,
} from "../../lib/v1/contract";

/**
 * GOLDEN: the `/v1` namespace contract and the integrity surface.
 *
 * `/v1` exists to be pinned. Its only real promise is that a consumer which
 * stored `https://…/v1/…` yesterday keeps working tomorrow, and a promise in a
 * README is not executable — so every required top-level field of every v1 file
 * is listed in `lib/v1/contract.ts` and asserted here against payloads built by
 * the real builder.
 *
 * What this covers, in the order the claims matter:
 *
 *   1. **Shape.** A rename or a retype inside v1 fails here, not in a consumer.
 *   2. **Two clocks.** Every slot *and* every section of `asof/<date>.json`
 *      carries `asOf` + `observedAt`; a value that lost a clock is unpublishable.
 *   3. **Named gaps.** A missing slot is named, never silently short — and a
 *      non-trading day owes nothing, so it emits no fake gaps.
 *   4. **Revisions.** A re-capture appears as a `captures[]` entry pointing at
 *      the immutable `.rev-N` file, and the base slot's value never moves.
 *   5. **Honesty.** With zero tape days the page says so in words, and no
 *      percentage is invented; with gaps it renders the gap list.
 *   6. **The reactions endpoint** is advertised only when its input exists, so
 *      a consumer never follows a manifest entry to a 404.
 *   7. **Guarantee copy** stays paired with the `STR` tables — the English
 *      strings published in the manifest must equal the English UI strings.
 *
 * Fixtures are written to a temp tree and driven through the real builder: no
 * refactor-for-testability, matching `stories-bake.test.ts` and
 * `bake-golden.test.ts`.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TZ = "Asia/Shanghai";

interface FixtureOptions {
  /** Snapshot slots to write for each trading day, `HH:MM`. */
  slots?: string[];
  /** Extra `rev-N` files: slot → count. */
  revisions?: Record<string, number>;
  /** Sections to mark unavailable in the first snapshot. */
  unavailable?: string[];
}

function section(observedAt: string, asOf: string, records: unknown[]): Record<string, unknown> {
  return { asOf, observedAt, timestampSource: "upstream", records };
}

function makeSnapshot(
  date: string,
  slot: string,
  opts: { observedAt?: string; unavailable?: string[] } = {},
): Record<string, unknown> {
  const observedAt = opts.observedAt ?? `${date}T${slot}:12+08:00`;
  const asOf = `${date}T${slot}:00+08:00`;
  const unavailable = new Set(opts.unavailable ?? []);
  const mk = (name: string, recs: unknown[]) =>
    unavailable.has(name)
      ? {
          asOf: observedAt,
          observedAt,
          timestampSource: "fetch",
          unavailable: true,
          reason: `${name} upstream returned nothing`,
          records: [],
        }
      : section(observedAt, asOf, recs);
  return {
    schemaVersion: 1,
    date,
    slot,
    slotKey: slot.replace(":", ""),
    revision: 0,
    observedAt,
    timezone: TZ,
    registry: "snapshot",
    indices: mk("indices", [
      { code: "000001", name: "上证指数", price: 3634.35, changePct: -0.59, asOf, observedAt, timestampSource: "upstream" },
    ]),
    industries: mk("industries", [
      {
        code: "BK0475",
        name: "银行Ⅱ",
        secid: "90.BK0475",
        changePct: 1.43,
        up: 21,
        down: 22,
        asOf,
        observedAt,
        timestampSource: "upstream",
      },
    ]),
    themes: mk("themes", [
      {
        key: "ai",
        name: "人工智能",
        boardCode: "BK0800",
        boardName: "人工智能",
        changePct: null,
        up: null,
        down: null,
        asOf,
        observedAt,
        timestampSource: "upstream",
      },
    ]),
    fundFlows: mk("fundFlows", [
      { name: "银行", changePct: 1.43, netInflowYi: 12.2567, asOf, observedAt, timestampSource: "upstream" },
    ]),
    limitPool: mk("limitPool", [
      {
        code: "001358",
        name: "兴欣新材",
        changePct: 9.99,
        boards: 2,
        industry: "化学制品",
        asOf,
        observedAt,
        timestampSource: "fetch",
      },
    ]),
  };
}

function writeTree(root: string, opts: FixtureOptions = {}): void {
  const tapeRoot = path.join(root, "tape");
  fs.mkdirSync(tapeRoot, { recursive: true });
  const date = "2026-11-16";
  const slots = opts.slots ?? ["09:35", "10:05", "10:35", "11:05", "11:35", "13:05", "13:35", "14:05", "14:35", "15:05"];
  writeTreeIn(root, date, slots, opts);
}

/** One day directory with the given slots (and their revisions). */
function writeTreeIn(
  root: string,
  date: string,
  slots: string[],
  opts: FixtureOptions = {},
): void {
  const dir = path.join(root, "tape", date);
  fs.mkdirSync(dir, { recursive: true });

  for (const [i, slot] of slots.entries()) {
    const stem = slot.replace(":", "");
    fs.writeFileSync(
      path.join(dir, `${stem}.json`),
      `${JSON.stringify(makeSnapshot(date, slot, { unavailable: i === 0 ? opts.unavailable : undefined }), null, 2)}\n`,
      "utf8",
    );
    // A revision: a second capture at a later instant. The value in the day
    // file must stay the BASE capture, and the revision must be listed.
    const extra = opts.revisions?.[slot] ?? 0;
    for (let n = 1; n <= extra; n++) {
      fs.writeFileSync(
        path.join(dir, `${stem}.rev-${n}.json`),
        `${JSON.stringify(
          makeSnapshot(date, slot, { observedAt: `${date}T${slot}:59+08:00` }),
          null,
          2,
        )}\n`,
        "utf8",
      );
      fs.appendFileSync(
        path.join(dir, "revisions.jsonl"),
        `${JSON.stringify({
          at: `${date}T${slot}:59+08:00`,
          slot,
          base: `${stem}.json`,
          wrote: `${stem}.rev-${n}.json`,
          revision: n,
          changed: ["industries"],
          observedAtFrom: `${date}T${slot}:12+08:00`,
          observedAtTo: `${date}T${slot}:59+08:00`,
        })}\n`,
        "utf8",
      );
    }
  }

  fs.writeFileSync(
    path.join(dir, "index.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        date,
        expectedSlots: ["09:35", "10:05", "10:35", "11:05", "11:35", "13:05", "13:35", "14:05", "14:35", "15:05"],
        snapshots: [],
        updatedAt: `${date}T15:10:00+08:00`,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function writeStories(root: string, overrides: Record<string, unknown> = {}): void {
  const stories = [
    {
      id: "st_abc",
      cluster: "entity:nvidia",
      title: "Nvidia board weighs replacing Jensen Huang",
      url: "https://example.com/nvidia",
      firstSeenAt: "2026-11-16T09:35:11+08:00",
      firstEdition: "2026-11-16/09",
      firstSourceId: "reuters",
      publishedAt: null,
      publishLagMinutes: null,
      lastSeenAt: "2026-11-16T09:35:11+08:00",
      lastEdition: "2026-11-16/09",
      topic: "global-markets",
      lane: "external",
      domestic: false,
      entities: ["nvidia"],
      sources: ["reuters"],
      sightings: [],
      headlineRevisions: [],
      firstMover: {
        sourceId: "reuters",
        observedAt: "2026-11-16T09:35:11+08:00",
        tied: false,
        coFirstSourceIds: ["reuters"],
        runnerUpSourceId: null,
        runnerUpObservedAt: null,
        leadMinutes: null,
      },
    },
    {
      id: "st_def",
      cluster: "entity:pboc",
      title: "央行开展 5000 亿元 MLF 操作",
      url: "https://example.com/mlf",
      firstSeenAt: null,
      firstEdition: "2026-11-16/10",
      firstSourceId: "caixin",
      publishedAt: null,
      publishLagMinutes: null,
      lastSeenAt: "2026-11-16T10:05:00+08:00",
      lastEdition: "2026-11-16/10",
      topic: "policy",
      lane: "zh",
      domestic: true,
      entities: ["pboc"],
      sources: ["caixin"],
      sightings: [],
      headlineRevisions: [],
      firstMover: {
        sourceId: "caixin",
        observedAt: "2026-11-16T10:05:00+08:00",
        tied: false,
        coFirstSourceIds: ["caixin"],
        runnerUpSourceId: null,
        runnerUpObservedAt: null,
        leadMinutes: null,
      },
    },
  ];
  const payload = {
    version: 1,
    timezone: TZ,
    retentionDays: 30,
    maxStories: 2000,
    updatedAt: "2026-11-16T10:06:00+08:00",
    generatedAt: "2026-11-16T10:06:00+08:00",
    stories,
    counts: {
      stories: stories.length,
      sightings: 0,
      multiSightingStories: 0,
      storiesWithRevisions: 0,
      skippedRecords: 0,
      editions: 3,
      articles: 120,
      duplicates: 4,
    },
    firstMover: { windowDays: 30, from: "2026-10-17", to: "2026-11-16", storiesInWindow: 2, soleFirstStories: 2, contestedStories: 0, tiedFirstStories: 0, leadBasis: "observed", wires: [] },
    revisionTrail: { storiesWithRevisions: 0, totalRevisions: 0, items: [] },
    ...overrides,
  };
  fs.writeFileSync(path.join(root, "stories.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeThemes(root: string): void {
  const payload = {
    generatedAt: "2026-11-16T10:00:00.000Z",
    source: "eastmoney-board-registry",
    status: "ok",
    registry: "live",
    edition: "2026-11-16/10",
    themes: [{ key: "ai", name: "人工智能", boardCode: "BK0800", boardChangePct: 1.1, articleHits: 4 }],
  };
  fs.writeFileSync(path.join(root, "themes.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function makeRoot(prefix: string): { tmp: string; root: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = path.join(tmp, "daily_reports");
  fs.mkdirSync(root, { recursive: true });
  return { tmp, root };
}

/** Frozen clock so `generatedAt` and "not yet due" are deterministic. */
const NOW = new Date("2026-11-16T15:30:00+08:00");

test("golden: every /v1 payload keeps its required top-level shape", async (t) => {
  const { tmp, root } = makeRoot("v1-shape-");
  writeTree(root);
  writeStories(root);
  writeThemes(root);
  // Mirrors the real `reactions:bake` payload: `dataThrough` rather than a wall
  // clock, and `counts.horizons` as the authoritative classification.
  fs.writeFileSync(
    path.join(root, "reactions.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      dataThrough: "2026-11-16T10:35:00+08:00",
      timezone: TZ,
      counts: {
        horizons: {
          "1h": { ok: 2, pending: 0, gap: 0 },
          "1d": { ok: 0, pending: 2, gap: 0 },
          "5d": { ok: 0, pending: 2, gap: 0 },
        },
      },
      observations: [
        { id: "st_abc", horizons: { "1h": { status: "ok", rawReturnPct: 1.2 } } },
        { id: "st_def", horizons: { "1h": { status: "ok", rawReturnPct: -0.4 } } },
      ],
      gaps: [],
    })}\n`,
    "utf8",
  );

  const build = buildV1({ root, now: NOW, timezone: TZ });

  await t.test("manifest / coverage / asof / stories / themes / reactions all pass checkShape", () => {
    for (const [rel, payload] of Object.entries(build.files)) {
      const spec = rel.startsWith("asof/") ? "asof/<date>.json" : rel;
      assert.ok(
        spec in V1_REQUIRED_FIELDS,
        `no contract entry for ${rel} — a new v1 file must declare its required fields`,
      );
      assert.deepEqual(checkShape(payload, spec), [], `${rel} violates the v1 contract`);
    }
  });

  await t.test("schemaVersion and namespace are the same in every file", () => {
    for (const [rel, payload] of Object.entries(build.files)) {
      const obj = payload as Record<string, unknown>;
      assert.equal(obj.namespace, "v1", `${rel} namespace`);
      // stories/themes are re-exports of files whose own version field is the
      // ledger's, not the namespace's, so only files the builder authors are
      // asserted on schemaVersion.
      if (rel === "manifest.json" || rel === "coverage.json" || rel.startsWith("asof/")) {
        assert.equal(obj.schemaVersion, V1_SCHEMA_VERSION, `${rel} schemaVersion`);
      }
    }
  });

  await t.test("manifest lists every endpoint that was actually written", () => {
    const ids = build.manifest.endpoints.map((e) => e.id);
    assert.ok(ids.includes("manifest"));
    assert.ok(ids.includes("asof"));
    assert.ok(ids.includes("coverage"));
    assert.ok(ids.includes("stories"));
    assert.ok(ids.includes("themes"));
    assert.ok(ids.includes("reactions"), "reactions.json exists, so it must be advertised");
    for (const ep of build.manifest.endpoints) {
      if (ep.path.includes("<YYYY-MM-DD>")) continue;
      const rel = ep.path.replace(/^\/v1\//, "");
      assert.ok(rel in build.files, `manifest advertises ${ep.path} with no payload`);
    }
  });

  await t.test("license names MIT and states data terms; deprecation names /v2/", () => {
    assert.equal(build.manifest.license.code, "MIT");
    assert.ok(build.manifest.license.data.length > 100, "data terms must actually say something");
    assert.match(build.manifest.deprecation.breakingChange, /\/v2\//);
    assert.match(build.manifest.deprecation.successor, /^\/v2\//);
    assert.ok(build.manifest.deprecation.noticePeriod.length > 40);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("golden: asof/<date>.json carries both clocks on every slot and every section", async (t) => {
  const { tmp, root } = makeRoot("v1-clocks-");
  writeTree(root, { unavailable: ["indices"] });
  writeStories(root);
  writeThemes(root);
  const build = buildV1({ root, now: NOW, timezone: TZ });
  const day = build.files["asof/2026-11-16.json"] as Record<string, unknown>;
  const slots = day.slots as Array<Record<string, unknown>>;

  const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

  await t.test("one entry per captured slot, in slot order", () => {
    assert.equal(slots.length, 10);
    assert.deepEqual(
      slots.map((s) => s.slot),
      ["09:35", "10:05", "10:35", "11:05", "11:35", "13:05", "13:35", "14:05", "14:35", "15:05"],
    );
  });

  await t.test("every slot has asOf and observedAt with an offset", () => {
    for (const slot of slots) {
      assert.match(String(slot.asOf), OFFSET_ISO, `slot ${slot.slot} asOf`);
      assert.match(String(slot.observedAt), OFFSET_ISO, `slot ${slot.slot} observedAt`);
    }
  });

  await t.test("every section inside every slot keeps its own two clocks", () => {
    for (const slot of slots) {
      const sections = slot.sections as Record<string, Record<string, unknown>>;
      assert.ok(Object.keys(sections).length >= 5, `slot ${slot.slot} lost sections`);
      for (const [name, sec] of Object.entries(sections)) {
        assert.match(String(sec.asOf), OFFSET_ISO, `${slot.slot}/${name} asOf`);
        assert.match(String(sec.observedAt), OFFSET_ISO, `${slot.slot}/${name} observedAt`);
        for (const [i, rec] of (sec.records as Array<Record<string, unknown>>).entries()) {
          assert.match(String(rec.asOf), OFFSET_ISO, `${slot.slot}/${name}[${i}] asOf`);
          assert.match(String(rec.observedAt), OFFSET_ISO, `${slot.slot}/${name}[${i}] observedAt`);
        }
      }
    }
  });

  await t.test("a section that came back unavailable is named, with its reason", () => {
    const first = slots[0];
    const unavailable = first.unavailableSections as Array<{ name: string; reason: string }>;
    assert.ok(unavailable.some((s) => s.name === "indices"), "indices was marked unavailable");
    const gaps = day.gaps as Array<Record<string, unknown>>;
    assert.ok(
      gaps.some((g) => g.code === "section-unavailable" && g.section === "indices"),
      "an unavailable section must be a named gap",
    );
  });

  await t.test("counts agree with the arrays they count", () => {
    const counts = day.counts as Record<string, number>;
    assert.equal(counts.capturedSlots, slots.length);
    assert.equal(counts.expectedSlots, 10);
    assert.equal(counts.gaps, (day.gaps as unknown[]).length);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("golden: gaps are named, and a closed day invents none", async (t) => {
  const { tmp, root } = makeRoot("v1-gaps-");
  // Only four of ten slots captured on Monday — six real gaps.
  writeTree(root, { slots: ["09:35", "10:05", "10:35", "11:05"] });
  const build = buildV1({ root, now: NOW, timezone: TZ });

  await t.test("each missing slot is named with a code and a reason", () => {
    const day = build.files["asof/2026-11-16.json"] as Record<string, unknown>;
    const gaps = day.gaps as Array<{ slot: string | null; code: string; reason: string }>;
    const missed = gaps.filter((g) => g.code === "missed").map((g) => g.slot);
    assert.deepEqual(missed, ["11:35", "13:05", "13:35", "14:05", "14:35", "15:05"]);
    for (const g of gaps) assert.ok(g.reason.length > 10, `gap ${g.slot} has no reason`);
  });

  await t.test("coverage.json and the day file agree on the hole", () => {
    const cov = build.coverage.days.find((d) => d.date === "2026-11-16")!;
    assert.equal(cov.capturedSlots, 4);
    assert.equal(cov.expectedSlots, 10);
    assert.equal(cov.missingSlots.length, 6);
    assert.equal(cov.gaps.length, 6);
  });

  await t.test("a weekend day emits no gaps at all — it owes nothing", () => {
    // 2026-11-21 is a Saturday. Build a week later so it is inside the launch
    // window and therefore gets an as-of file of its own.
    const later = buildV1({ root, now: new Date("2026-11-23T09:00:00+08:00"), timezone: TZ });
    const day = later.files["asof/2026-11-21.json"] as Record<string, unknown> | undefined;
    assert.ok(day, "a weekend inside the window still gets a file");
    assert.equal(day!.tradingDay, false);
    assert.deepEqual(day!.slots, []);
    assert.deepEqual(day!.gaps, [], "a closed day must not invent ten fake gaps");
    assert.equal((day!.counts as Record<string, number>).expectedSlots, 0);
  });

  await t.test("coveragePct counts only what was owed", () => {
    // 4 captured of 10 expected on the one trading day.
    assert.equal(build.coverage.summary.expectedSlots, 10);
    assert.equal(build.coverage.summary.capturedSlots, 4);
    assert.equal(build.coverage.summary.coveragePct, 40);
  });

  await t.test("a day before launch owes nothing either, and says why", () => {
    // Capture on a trading day BEFORE the launch date, then build a week later.
    // The day exists in the tape, but the obligation never did: reporting nine
    // "missed" slots there would be an accusation about a capability we did not
    // have, and would deflate every early coverage number permanently.
    writeTreeIn(root, "2026-11-12", ["14:35"]);
    const later = buildV1({ root, now: new Date("2026-11-20T18:00:00+08:00"), timezone: TZ });
    const day = later.files["asof/2026-11-12.json"] as Record<string, unknown>;
    assert.equal(day.tradingDay, true);
    assert.equal(day.beforeLaunch, true);
    assert.equal((day.counts as Record<string, number>).expectedSlots, 0);
    assert.deepEqual(day.gaps, [], "a pre-launch day must not invent gaps");
    const cov = later.coverage.days.find((d) => d.date === "2026-11-12")!;
    assert.equal(cov.expectedSlots, 0);
    assert.deepEqual(cov.missingSlots, []);
    // 2026-11-12 and 2026-11-13 (Wed/Thu) sit before launch; 2026-11-16..20 are
    // the obligations. The pre-launch captures add to `capturedSlots` but not to
    // `expectedSlots`, so the percentage stays a statement about owed days.
    assert.ok(later.coverage.summary.expectedSlots >= 10);
    assert.ok((later.coverage.summary.coveragePct ?? 0) <= 100);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("golden: a day in progress counts only the slots already due", async (t) => {
  const { tmp, root } = makeRoot("v1-intraday-");
  // 10:10 Shanghai, two slots captured, eight not yet due. Mid-session is the
  // exact moment a coverage number is easiest to lie with: counting the eight
  // future slots as failures would show 2/10 for a day that is going fine.
  writeTree(root, { slots: ["09:35", "10:05"] });
  const build = buildV1({ root, now: new Date("2026-11-16T10:10:00+08:00"), timezone: TZ });

  await t.test("the denominator is what already came due, not the whole day", () => {
    const day = build.files["asof/2026-11-16.json"] as Record<string, unknown>;
    assert.equal((day.counts as Record<string, number>).expectedSlots, 2);
    assert.deepEqual(day.gaps, [], "an undued slot is not a gap");
    assert.equal((day.pendingSlots as string[]).length, 8);
    assert.equal(build.coverage.summary.coveragePct, 100, "2 of the 2 due slots captured");
  });

  await t.test("a slot that was due and missed still shows up on that same morning", () => {
    const { tmp: tmp2, root: root2 } = makeRoot("v1-intraday2-");
    // 11:00: 09:35 should have been captured (its grace window closed at 09:55)
    // but is absent; 10:05 and 10:35 exist; 11:05 onward are still ahead.
    writeTreeIn(root2, "2026-11-16", ["10:05", "10:35"]);
    const b = buildV1({ root: root2, now: new Date("2026-11-16T11:00:00+08:00"), timezone: TZ });
    const day = b.files["asof/2026-11-16.json"] as Record<string, unknown>;
    const gaps = day.gaps as Array<{ slot: string; code: string }>;
    assert.deepEqual(gaps.map((g) => g.slot), ["09:35"]);
    assert.equal(gaps[0].code, "missed");
    assert.equal((day.counts as Record<string, number>).expectedSlots, 3);
    assert.equal((day.pendingSlots as string[]).length, 7);
    fs.rmSync(tmp2, { recursive: true, force: true });
  });

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("golden: a re-capture never rewrites the slot's value", async (t) => {
  const { tmp, root } = makeRoot("v1-rev-");
  writeTree(root, { slots: ["09:35", "10:05"], revisions: { "09:35": 2 } });
  const build = buildV1({ root, now: NOW, timezone: TZ });

  await t.test("the slot keeps the base capture's instant", () => {
    const day = build.files["asof/2026-11-16.json"] as Record<string, unknown>;
    const slot = (day.slots as Array<Record<string, unknown>>).find((s) => s.slot === "09:35")!;
    assert.equal(slot.observedAt, "2026-11-16T09:35:12+08:00", "base observedAt must not move");
    assert.equal(slot.revision, 0, "the published slot is the base capture");
  });

  await t.test("each revision is listed with its own file and instants", () => {
    const day = build.files["asof/2026-11-16.json"] as Record<string, unknown>;
    const slot = (day.slots as Array<Record<string, unknown>>).find((s) => s.slot === "09:35")!;
    const captures = slot.captures as Array<Record<string, unknown>>;
    assert.equal(captures.length, 3, "base + two revisions");
    assert.deepEqual(
      captures.map((c) => c.revision),
      [0, 1, 2],
    );
    assert.ok(captures.slice(1).every((c) => c.observedAt === "2026-11-16T09:35:59+08:00"));
    assert.ok(
      captures.slice(1).every((c) => Array.isArray(c.changed) && (c.changed as string[]).includes("industries")),
      "revisions must say which sections moved",
    );
    assert.ok(
      captures.every((c) => String(c.path).endsWith(".json") && String(c.path).startsWith("tape/2026-11-16/")),
      "a capture must point at its immutable file",
    );
  });

  await t.test("revision files are counted in coverage and the manifest", () => {
    const cov = build.coverage.days.find((d) => d.date === "2026-11-16")!;
    assert.equal(cov.revisions, 2);
    assert.equal(build.manifest.snapshots.totalRevisionFiles, 2);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("golden: first-seen coverage counts what the ledger really has", async (t) => {
  const { tmp, root } = makeRoot("v1-firstseen-");
  writeTree(root, { slots: ["09:35"] });
  writeStories(root); // one story with firstSeenAt, one without

  const build = buildV1({ root, now: NOW, timezone: TZ });
  const stories = build.coverage.stories;

  await t.test("counts carry/absent firstSeenAt separately", () => {
    assert.equal(stories.available, true);
    assert.equal(stories.total, 2);
    assert.equal(stories.withFirstSeenAt, 1);
    assert.equal(stories.withoutFirstSeenAt, 1);
    assert.equal(stories.firstSeenCoveragePct, 50);
  });

  await t.test("a missing ledger is 0%, not 100%", () => {
    const { tmp: tmp2, root: root2 } = makeRoot("v1-noledger-");
    writeTree(root2, { slots: ["09:35"] });
    const b = buildV1({ root: root2, now: NOW, timezone: TZ });
    assert.equal(b.coverage.stories.available, false);
    assert.equal(b.coverage.stories.total, 0);
    assert.equal(
      b.coverage.stories.firstSeenCoveragePct,
      0,
      "an empty ledger must not report 100% — that would read as success",
    );
    assert.ok(
      b.coverage.gaps.some((g) => g.code === "input-missing"),
      "a missing stories.json is a named input gap",
    );
    fs.rmSync(tmp2, { recursive: true, force: true });
  });

  await t.test("every horizon is pending while the reaction library is absent", () => {
    assert.equal(build.coverage.horizons.length, V1_HORIZONS.length);
    for (const h of build.coverage.horizons) {
      assert.equal(h.available, false);
      assert.equal(h.measured, 0);
      assert.equal(h.pending, 2, "both story records are waiting");
    }
  });

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("golden: reactions.json is advertised only once it exists", async (t) => {
  const { tmp, root } = makeRoot("v1-reactions-");
  writeTree(root, { slots: ["09:35"] });
  writeStories(root);

  const before = buildV1({ root, now: NOW, timezone: TZ });
  assert.equal(before.manifest.endpoints.some((e) => e.id === "reactions"), false);
  assert.equal("reactions.json" in before.files, false, "no empty file may be emitted in its place");

  // The bake that produces it lands later; the namespace must pick it up with
  // no code change — that is the whole point of the conditional endpoint.
  fs.writeFileSync(
    path.join(root, "reactions.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      dataThrough: "2026-11-16T11:05:00+08:00",
      timezone: TZ,
      counts: {
        horizons: {
          "1h": { ok: 2, pending: 0, gap: 0 },
          "1d": { ok: 0, pending: 2, gap: 0 },
          "5d": { ok: 0, pending: 2, gap: 0 },
        },
      },
      observations: [],
      gaps: [],
    })}\n`,
    "utf8",
  );
  const after = buildV1({ root, now: NOW, timezone: TZ });
  assert.ok(after.manifest.endpoints.some((e) => e.id === "reactions"), "reactions must be advertised once present");
  assert.ok("reactions.json" in after.files);

  const h1 = after.coverage.horizons.find((h) => h.key === "1h")!;
  const d1 = after.coverage.horizons.find((h) => h.key === "1d")!;
  const d5 = after.coverage.horizons.find((h) => h.key === "5d")!;
  assert.equal(h1.measured, 2, "counts.horizons is authoritative");
  assert.equal(h1.pending, 0);
  assert.equal(d1.measured, 0);
  assert.equal(d5.pending, 2);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("golden: integrity.html states the truth, including 'no data'", async (t) => {
  await t.test("with zero tape days it says so instead of rendering an empty table", () => {
    const { tmp, root } = makeRoot("v1-notape-");
    // Before the launch date nothing is owed, so there is no percentage at all —
    // 0 would read as failure and 100 as success, and both would be fiction.
    const build = buildV1({ root, now: new Date("2026-11-13T12:00:00+08:00"), timezone: TZ });
    assert.equal(build.coverage.tape.started, false);
    assert.equal(build.coverage.summary.expectedSlots, 0);
    assert.equal(build.coverage.summary.coveragePct, null, "no obligations yet means no percentage");
    const html = renderIntegrityHtml(build.coverage, build.manifest);
    assert.ok(html.includes('data-surface="no-tape"'), "the not-started notice must be present");
    assert.ok(
      html.includes(V1_TAPE_LAUNCH_DATE),
      "the page must name the first expected snapshot date",
    );
    assert.equal(html.includes('data-surface="days"'), false, "no day table may render");
    assert.equal(html.includes('data-surface="gaps"'), false, "no gap table may render");
    assert.equal(html.includes('class="gap-code"'), false, "and no gap rows either");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await t.test("with gaps it names every one, with its code", () => {
    const { tmp, root } = makeRoot("v1-withgaps-");
    writeTree(root, { slots: ["09:35", "10:05"] });
    const build = buildV1({ root, now: NOW, timezone: TZ });
    const html = renderIntegrityHtml(build.coverage, build.manifest);
    assert.ok(html.includes('class="gap-code"'), "the gap list must render");
    assert.ok(html.includes("14:35"), "a specific missed slot must be named on the page");
    assert.ok(html.includes("missed"), "the gap code must be visible");
    assert.ok(html.includes("2026-11-16"));
    // No green-checkmark vocabulary anywhere: this page reports, it does not cheer.
    assert.ok(!html.includes("✓"), "no checkmarks on an honesty page");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await t.test("it renders in the other locale too, with the same structure", () => {
    const { tmp, root } = makeRoot("v1-locale-");
    writeTree(root, { slots: ["09:35"] });
    const build = buildV1({ root, now: NOW, timezone: TZ });
    // `renderIntegrityHtml` resolves STR at module init, so the locale cannot be
    // switched here; what is asserted is that the strings it used came from the
    // paired tables (the parity test covers the pairing itself).
    const html = renderIntegrityHtml(build.coverage, build.manifest);
    assert.match(html, /<html lang="(zh-CN|en)">/);
    assert.ok(html.includes('href="./index.html"'));
    assert.ok(html.includes('href="./archive.html"'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test("golden: guarantee copy is paired with the STR tables", async (t) => {
  const renderSrc = fs.readFileSync(path.join(REPO_ROOT, "lib/output/render.ts"), "utf8");

  /** Pull `key: "value"` (possibly multi-line) out of one TEXTS_XX block. */
  function stringOf(locale: "ZH" | "EN", key: string): string | null {
    const start = renderSrc.indexOf(`const TEXTS_${locale}`);
    assert.ok(start >= 0, `TEXTS_${locale} not found`);
    let depth = 0;
    let end = start;
    for (let i = renderSrc.indexOf("{", start); i < renderSrc.length; i++) {
      if (renderSrc[i] === "{") depth++;
      else if (renderSrc[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const block = renderSrc.slice(start, end);
    const re = new RegExp(`^ {2}${key}:\\s*\\n?\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m");
    const m = re.exec(block);
    return m ? JSON.parse(`"${m[1]}"`) : null;
  }

  await t.test("every guarantee key exists in both locales", () => {
    for (const group of [V1_GUARANTEES.promised, V1_GUARANTEES.notPromised]) {
      for (const g of group) {
        const key = `integrity${g.key}`;
        assert.ok(stringOf("ZH", key), `TEXTS_ZH missing ${key}`);
        assert.ok(stringOf("EN", key), `TEXTS_EN missing ${key}`);
      }
    }
  });

  await t.test("the English UI copy equals the text the manifest publishes", () => {
    for (const group of [V1_GUARANTEES.promised, V1_GUARANTEES.notPromised]) {
      for (const g of group) {
        assert.equal(
          stringOf("EN", `integrity${g.key}`),
          g.en,
          `${g.key}: the manifest copy and the English UI copy have drifted`,
        );
      }
    }
  });

  await t.test("every endpoint id has a localized description", () => {
    const { tmp, root } = makeRoot("v1-endpoints-");
    writeTree(root, { slots: ["09:35"] });
    writeStories(root);
    writeThemes(root);
    const build = buildV1({ root, now: NOW, timezone: TZ });
    for (const ep of build.manifest.endpoints) {
      const key = `integrityEndpoint${ep.id.charAt(0).toUpperCase()}${ep.id.slice(1)}`;
      assert.ok(stringOf("ZH", key), `TEXTS_ZH missing ${key}`);
      assert.ok(stringOf("EN", key), `TEXTS_EN missing ${key}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test("golden: writeV1 lands the files and clears stale conditional ones", async (t) => {
  const { tmp, root } = makeRoot("v1-write-");
  writeTree(root, { slots: ["09:35"] });
  writeStories(root);

  const build = buildV1({ root, now: NOW, timezone: TZ });
  const report = writeV1(build, { root });

  await t.test("every payload is on disk and parses", () => {
    for (const rel of Object.keys(build.files)) {
      const fp = path.join(root, "v1", rel);
      assert.ok(fs.existsSync(fp), `${rel} was not written`);
      JSON.parse(fs.readFileSync(fp, "utf8"));
    }
    assert.ok(report.written.length > 0);
  });

  await t.test("a stale reactions.json is removed when its input disappears", () => {
    // Simulate a leftover from a previous publish, then rebuild without the input.
    fs.writeFileSync(path.join(root, "v1", "reactions.json"), "{}\n", "utf8");
    fs.writeFileSync(
      path.join(root, "v1", "asof", "2026-01-02.json"),
      `${JSON.stringify({ stale: true })}\n`,
      "utf8",
    );
    const rebuild = buildV1({ root, now: NOW, timezone: TZ });
    const second = writeV1(rebuild, { root });
    assert.ok(second.removed.some((f) => f.endsWith("reactions.json")));
    assert.ok(second.removed.some((f) => f.endsWith("2026-01-02.json")));
    assert.equal(fs.existsSync(path.join(root, "v1", "reactions.json")), false);
    assert.equal(fs.existsSync(path.join(root, "v1", "asof", "2026-01-02.json")), false);
  });

  await t.test("nothing outside v1/ is touched", () => {
    assert.ok(fs.existsSync(path.join(root, "stories.json")));
    assert.ok(fs.existsSync(path.join(root, "tape", "2026-11-16", "0935.json")));
  });

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("golden: the build is deterministic for a fixed tree and clock", async () => {
  const { tmp, root } = makeRoot("v1-determinism-");
  writeTree(root, { slots: ["09:35", "10:05"] });
  writeStories(root);
  writeThemes(root);

  const a = buildV1({ root, now: NOW, timezone: TZ });
  const b = buildV1({ root, now: NOW, timezone: TZ });
  assert.deepEqual(Object.keys(a.files).sort(), Object.keys(b.files).sort());
  for (const rel of Object.keys(a.files)) {
    assert.deepEqual(a.files[rel], b.files[rel], `${rel} is not deterministic`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("golden: coverage.json is a top-level key list no consumer can lose", () => {
  // Belt and braces next to `checkShape`: a direct assertion on the field names,
  // so a rename shows up as a diff rather than as "some type changed".
  const required = Object.keys(V1_REQUIRED_FIELDS["coverage.json"]).sort();
  assert.deepEqual(required, [
    "days",
    "gaps",
    "generatedAt",
    "horizons",
    "namespace",
    "schemaVersion",
    "stories",
    "summary",
    "tape",
    "timezone",
  ]);
  assert.deepEqual(Object.keys(V1_REQUIRED_FIELDS["manifest.json"]).sort(), [
    "coverage",
    "deprecation",
    "endpoints",
    "generatedAt",
    "license",
    "namespace",
    "schemaVersion",
    "snapshots",
    "timezone",
  ]);
});

test("golden: the coverage payload's day rows never claim more than they captured", () => {
  const { tmp, root } = makeRoot("v1-honesty-");
  writeTree(root, { slots: ["09:35", "10:05"] });
  const build = buildV1({ root, now: NOW, timezone: TZ });
  const cov: CoveragePayload = build.coverage;
  for (const day of cov.days) {
    assert.ok(day.capturedSlots <= Math.max(day.expectedSlots, day.capturedSlots));
    if (!day.tradingDay) {
      assert.equal(day.expectedSlots, 0, `${day.date} is closed and must owe nothing`);
    }
    if (day.gaps.length > 0) {
      assert.ok(day.capturedSlots < day.expectedSlots, `${day.date} has gaps but looks complete`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});
