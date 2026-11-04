import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * GOLDEN: build-site end-to-end over a synthetic tree (spawn the real
 * script — no refactor for testability). Protects the bake behaviors
 * shipped in waves 2-4: status truth matrix, feed purity, llms data
 * products, archive pruning.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function dayOffset(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function makeSidecar(dir: string, date: string, hour: string, opts: { caixinFail?: boolean } = {}) {
  fs.mkdirSync(path.join(dir, date), { recursive: true });
  const report = {
    hero_headline: `${date} ${hour} 头条`,
    daily_overview: "概览",
    tech_briefs: [],
    finance_briefs: [],
    politics_briefs: [],
    editor_note: "",
    keywords: ["MLF", "央行"],
    sentiment: { score: -30, label: "偏空", posHits: 1, negHits: 2, scanned: 10, percentile: null },
    fetch_health: {
      generated_at: new Date().toISOString(),
      entries: [
        { id: "healthy-src", ms: 100, ok: true, count: 5 },
        {
          id: "caixin",
          ms: 1000,
          ok: opts.caixinFail !== true,
          count: opts.caixinFail === true ? 0 : 2,
          ...(opts.caixinFail === true ? { error: "fixture" } : {}),
        },
      ],
    },
  };
  fs.writeFileSync(
    path.join(dir, date, `${hour}.json`),
    JSON.stringify(report),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, date, `${hour}.html`),
    `<html><h1>${date} ${hour}</h1></html>`,
    "utf8",
  );
}

function makePlaceholder(dir: string, date: string, hour: string) {
  fs.mkdirSync(path.join(dir, date), { recursive: true });
  fs.writeFileSync(
    path.join(dir, date, `${hour}.html`),
    `<html><h1>晚报尚未更新</h1></html>`,
    "utf8",
  );
}

function bake(fixture: string, env: Record<string, string> = {}): void {
  execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts", "build-site.mjs")], {
    cwd: fixture,
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
}

test("golden: build-site end-to-end", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bake-golden-"));
  const R = path.join(tmp, "daily_reports");
  const today = dayOffset(0);
  const yesterday = dayOffset(1);
  const d2 = dayOffset(2);
  const d3 = dayOffset(3);
  const d4 = dayOffset(4);
  const old = dayOffset(40); // beyond PRUNE_ARTICLES_DAYS=30

  // today: both slots real; yesterday: 19 real + 06 placeholder;
  // d2-d4: one slot each (crosses the weekly MIN_DAYS=5 floor);
  // caixin fails on every sidecar → 7-day streak → overlay E2E;
  // 40 days ago: real edition with a prunable articles sidecar
  for (const [d, h] of [
    [today, "06"],
    [today, "19"],
    [yesterday, "19"],
    [d2, "06"],
    [d3, "06"],
    [d4, "06"],
    [old, "06"],
  ] as const) {
    makeSidecar(R, d, h, { caixinFail: true });
  }
  makePlaceholder(R, yesterday, "06");
  fs.writeFileSync(
    path.join(R, old, "06-articles.json"),
    JSON.stringify({ articles: [] }),
    "utf8",
  );

  bake(tmp);

  // keywords + weekly bakes run AFTER build-site in CI; exercise them on
  // the same fixture via the real scripts (tsx binary, tmp cwd).
  const tsxBin = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
  for (const script of ["bake-keywords.ts", "build-weekly.ts"]) {
    execFileSync(tsxBin, [path.join(REPO_ROOT, "scripts", script)], {
      cwd: tmp,
      stdio: "pipe",
    });
  }

  const read = (f: string) => fs.readFileSync(path.join(R, f), "utf8");

  await t.test("index points at newest real edition", () => {
    assert.ok(read("index.html").includes(`${today} 19`));
  });

  await t.test("status matrix: real vs placeholder vs missing", () => {
    const status = read("status.html");
    // today 06/19 published (green)
    assert.ok(status.includes("#15803d"));
    // yesterday 06 placeholder (amber)
    assert.ok(status.includes("#d97706"));
    // yesterday 19 present too
    assert.ok(status.includes(`${yesterday}`));
  });

  await t.test("feed.xml: real editions only, placeholders never leak", () => {
    const feed = read("feed.xml");
    assert.ok(feed.includes("<item>"));
    assert.ok(!feed.includes("尚未更新"));
    assert.ok(feed.includes(`${yesterday}/19.html`));
    assert.ok(!feed.includes(`${yesterday}/06.html`));
  });

  await t.test("llms.txt registers data products", () => {
    const llms = read("llms.txt");
    for (const p of [
      "sentiment-history.json",
      "keywords.json",
      "feed.xml",
      "status.html",
    ]) {
      assert.ok(llms.includes(p), `llms.txt missing ${p}`);
    }
  });

  await t.test("sentiment-history.json: chronological, placeholders excluded", () => {
    const h = JSON.parse(read("sentiment-history.json"));
    // 7 real sidecars: old-06 + d4/d3/d2-06 + yesterday-19 + today-06/19
    // (the yesterday-06 placeholder has no JSON and must not appear)
    assert.equal(h.count, 7);
    const keys = h.items.map((i: { date: string; hour: string }) => `${i.date} ${i.hour}`);
    assert.deepEqual(keys, [
      `${old} 06`,
      `${d4} 06`,
      `${d3} 06`,
      `${d2} 06`,
      `${yesterday} 19`,
      `${today} 06`,
      `${today} 19`,
    ]);
  });

  await t.test("prune: 40d-old articles sidecar gone, report JSON kept", () => {
    assert.ok(!fs.existsSync(path.join(R, old, "06-articles.json")));
    assert.ok(fs.existsSync(path.join(R, old, "06.json")));
    assert.ok(fs.existsSync(path.join(R, old, "06.html")));
  });

  await t.test("source health: 7-day caixin streak lands in the overlay", () => {
    // caixin fails every edition across 7 fixture days → streak ≥ 3 →
    // build-site writes source-overlay.json disabling it (E2E lifecycle).
    const overlay = JSON.parse(read("source-overlay.json"));
    assert.ok(
      overlay.disabled.some((d: { id: string }) => d.id === "caixin"),
      `caixin not disabled: ${JSON.stringify(overlay.disabled)}`,
    );
    assert.ok(
      !overlay.disabled.some((d: { id: string }) => d.id === "healthy-src"),
    );
    const status = read("status.html");
    assert.ok(status.includes("源健康"));
    assert.ok(status.includes("已入 overlay 禁用"));
  });

  await t.test("keywords.json: bake aggregates the fixture window", () => {
    const k = JSON.parse(read("keywords.json"));
    assert.equal(k.windowDays, 7);
    // 6 in-window editions (40d-old is outside the 7-day cutoff)
    assert.equal(k.editions, 6);
    assert.ok(k.items.some((i: { term: string }) => i.term === "MLF"));
    assert.ok(k.items.some((i: { term: string }) => i.term === "央行"));
  });

  await t.test("weekly.json: 5 fixture days cross MIN_DAYS", () => {
    const w = JSON.parse(read("weekly.json"));
    assert.equal(w.daysCovered, 5);
    // today has two slots (06+19) → 6 editions across 5 days
    assert.equal(w.editions, 6);
    assert.ok(Array.isArray(w.sectorAvg));
    assert.ok(Array.isArray(w.topEvents));
  });

  fs.rmSync(tmp, { recursive: true, force: true });
});
