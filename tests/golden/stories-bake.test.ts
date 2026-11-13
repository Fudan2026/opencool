import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * GOLDEN: `scripts/bake-stories.ts` end-to-end over a synthetic tree.
 *
 * Spawns the real script — no refactor for testability, matching
 * `bake-golden.test.ts`. What is asserted is the contract the published
 * `stories.json` has to keep:
 *
 *   - it is written even when a sidecar is corrupt (fail-open, exit 0);
 *   - `firstSeenAt` comes from `fetch_health.generated_at` (our fetch), not
 *     from the feed's `pubDate` and not from the nominal slot time;
 *   - re-baking the same tree is byte-identical apart from the timestamps
 *     (the CI rebuild path: a slot gets rebuilt on retry);
 *   - the ledger survives and grows across editions, keeping ids stable.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

function writeSidecar(
  root: string,
  date: string,
  hour: string,
  opts: {
    generatedAt?: string;
    articles: Array<{ sourceId: string; title: string; url: string; publishedAt?: string }>;
  },
): void {
  fs.mkdirSync(path.join(root, date), { recursive: true });
  const report = {
    hero_headline: `${date} ${hour}`,
    daily_overview: "概览",
    tech_briefs: [],
    finance_briefs: [],
    politics_briefs: [],
    editor_note: "",
    keywords: [],
    sentiment: { score: 0, label: "中性" },
    ...(opts.generatedAt
      ? { fetch_health: { generated_at: opts.generatedAt, entries: [] } }
      : {}),
  };
  fs.writeFileSync(path.join(root, date, `${hour}.json`), JSON.stringify(report), "utf8");
  fs.writeFileSync(
    path.join(root, date, `${hour}-articles.json`),
    JSON.stringify({ date, hour, articles: opts.articles }),
    "utf8",
  );
}

function bake(root: string, env: Record<string, string> = {}): string {
  // The script reports to stdout for the summary and stderr for warnings
  // (unreadable sidecars, observation-time fallbacks); a test that asserts on
  // either needs both, so capture them together.
  const r = spawnSync(TSX, [path.join(REPO_ROOT, "scripts", "bake-stories.ts")], {
    cwd: root,
    env: { ...process.env, REPORT_TZ: "Asia/Shanghai", ...env },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `bake-stories exited ${r.status}: ${r.stderr}`);
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

function readLedger(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, "daily_reports", "stories.json"), "utf8"));
}

test("golden: bake-stories writes a point-in-time ledger", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stories-bake-"));
  const R = path.join(tmp, "daily_reports");

  // 06:00 edition: we fetched at 22:44Z (06:44 Shanghai). The wire's own
  // pubDate is five hours earlier — the ledger must not adopt it.
  writeSidecar(R, "2026-11-13", "06", {
    generatedAt: "2026-11-12T22:44:11Z",
    articles: [
      {
        sourceId: "reuters",
        title: "Nvidia board weighs replacing Jensen Huang",
        url: "https://example.com/nvidia-board",
        publishedAt: "2026-11-12T17:44:11.000Z",
      },
      {
        sourceId: "ft-companies",
        title: "央行开展 5000 亿元 MLF 操作",
        url: "https://example.com/pboc-mlf",
      },
    ],
  });

  // 13:00 edition: a second wire joins the Nvidia story; the FT wire rewrites
  // its own MLF headline at the same url.
  writeSidecar(R, "2026-11-13", "13", {
    generatedAt: "2026-11-13T05:04:00Z",
    articles: [
      {
        sourceId: "cnbc-topnews",
        title: "Nvidia stock falls as succession talk swirls",
        url: "https://example.com/cnbc-nvidia",
      },
      {
        sourceId: "ft-companies",
        title: "央行开展 6000 亿元 MLF 操作（更新）",
        url: "https://example.com/pboc-mlf",
      },
    ],
  });

  // An unreadable sidecar must not fail the bake.
  fs.writeFileSync(path.join(R, "2026-11-13", "19-articles.json"), "{ not json", "utf8");
  fs.writeFileSync(path.join(R, "2026-11-13", "19.json"), "{ not json", "utf8");

  const out = bake(tmp);
  assert.match(out, /\[stories:bake\] wrote/);

  const ledger = readLedger(tmp) as {
    version: number;
    timezone: string;
    counts: Record<string, number>;
    stories: Array<{
      id: string;
      firstSeenAt: string;
      firstSourceId: string;
      publishedAt: string | null;
      publishLagMinutes: number | null;
      sightings: unknown[];
      headlineRevisions: Array<{ from: string; to: string; at: string }>;
      firstMover: { sourceId: string | null; leadMinutes: number | null; tied: boolean };
      entities: string[];
    }>;
    firstMover: { leadBasis: string; wires: Array<{ sourceId: string; contestedFirsts: number }> };
    revisionTrail: { totalRevisions: number; items: unknown[] };
  };

  await t.test("writes a versioned, timezone-stamped file", () => {
    assert.equal(ledger.version, 1);
    assert.equal(ledger.timezone, "Asia/Shanghai");
    assert.ok(fs.existsSync(path.join(R, "stories.json")));
  });

  await t.test("an unreadable sidecar is skipped, not fatal", () => {
    assert.equal(ledger.counts.editions, 2, "only the two readable editions were folded in");
    assert.equal(ledger.counts.articles, 4);
  });

  await t.test("firstSeenAt is our fetch instant with a +08:00 offset", () => {
    const nvidia = ledger.stories.find((s) => s.entities.includes("nvidia"))!;
    assert.ok(nvidia, "no nvidia story");
    assert.equal(nvidia.firstSeenAt, "2026-11-13T06:44:11+08:00");
    assert.equal(nvidia.firstSourceId, "reuters");
    // The wire's own stamp is kept, and the gap is the observation lag.
    assert.equal(nvidia.publishedAt, "2026-11-12T17:44:11.000Z");
    assert.equal(nvidia.publishLagMinutes, 300);
  });

  await t.test("the second wire is a sighting, and it keeps its own clock", () => {
    const nvidia = ledger.stories.find((s) => s.entities.includes("nvidia"))!;
    assert.equal(nvidia.sightings.length, 1);
    assert.equal(nvidia.firstMover.sourceId, "reuters");
    assert.equal(nvidia.firstMover.tied, false);
    assert.equal(nvidia.firstMover.leadMinutes, 379.8, "06:44:11 → 13:04:00 Shanghai");
  });

  await t.test("the rewrite keeps both versions with ordered timestamps", () => {
    const mlf = ledger.stories.find((s) => s.headlineRevisions.length > 0)!;
    assert.ok(mlf, "no story with a revision");
    assert.equal(mlf.headlineRevisions.length, 1);
    const rev = mlf.headlineRevisions[0];
    assert.equal(rev.from, "央行开展 5000 亿元 MLF 操作");
    assert.equal(rev.to, "央行开展 6000 亿元 MLF 操作（更新）");
    assert.equal(rev.at, "2026-11-13T13:04:00+08:00");
    assert.equal(ledger.revisionTrail.totalRevisions, 1);
  });

  await t.test("the first-mover table states how leads were measured", () => {
    assert.equal(ledger.firstMover.leadBasis, "observed");
    const reuters = ledger.firstMover.wires.find((w) => w.sourceId === "reuters")!;
    assert.equal(reuters.contestedFirsts, 1);
  });

  await t.test("re-baking the same tree is idempotent", () => {
    const before = JSON.parse(JSON.stringify(ledger));
    bake(tmp);
    const after = readLedger(tmp) as Record<string, unknown>;
    for (const k of ["generatedAt", "updatedAt"]) {
      delete (before as Record<string, unknown>)[k];
      delete (after as Record<string, unknown>)[k];
    }
    for (const k of ["generatedAt", "updatedAt"]) delete before[k];
    assert.deepEqual(after.stories, before.stories, "a rebuild must not change history");
    assert.deepEqual(after.counts, before.counts);
  });

  await t.test("the ledger accumulates across editions with stable ids", () => {
    const before = (readLedger(tmp) as { stories: Array<{ id: string }> }).stories
      .map((s) => s.id)
      .sort();

    writeSidecar(R, "2026-11-14", "06", {
      generatedAt: "2026-11-13T22:40:00Z",
      articles: [
        {
          sourceId: "bloomberg",
          title: "Nvidia investors weigh a future without Huang",
          url: "https://example.com/bb-nvidia",
        },
      ],
    });
    bake(tmp);

    const after = readLedger(tmp) as {
      stories: Array<{ id: string; sightings: unknown[]; firstSeenAt: string }>;
      counts: Record<string, number>;
    };
    assert.equal(after.counts.editions, 3, "the new edition joined the existing ledger");
    for (const id of before) {
      assert.ok(after.stories.some((s) => s.id === id), `id ${id} disappeared`);
    }
    const nvidia = after.stories.find((s) => s.sightings.length > 0)!;
    assert.equal(nvidia.firstSeenAt, "2026-11-13T06:44:11+08:00", "firstSeenAt did not move");
  });

  await t.test("a corrupt ledger falls back to replaying the sidecars", () => {
    fs.writeFileSync(path.join(R, "stories.json"), "{ definitely not json", "utf8");
    const log = bake(tmp);
    assert.match(log, /unreadable .*rebuilding from sidecars/);
    const rebuilt = readLedger(tmp) as { counts: Record<string, number> };
    assert.equal(rebuilt.counts.editions, 3, "all retained sidecars were replayed");
  });

  fs.rmSync(tmp, { recursive: true, force: true });
});
