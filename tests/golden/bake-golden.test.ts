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
  const old = dayOffset(40); // beyond PRUNE_ARTICLES_DAYS=30

  // today: both slots real; yesterday: 19 real + 06 placeholder;
  // 40 days ago: real edition with a prunable articles sidecar
  makeSidecar(R, today, "06");
  makeSidecar(R, today, "19");
  makeSidecar(R, yesterday, "19");
  makePlaceholder(R, yesterday, "06");
  makeSidecar(R, old, "06");
  fs.writeFileSync(
    path.join(R, old, "06-articles.json"),
    JSON.stringify({ articles: [] }),
    "utf8",
  );

  bake(tmp);

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
    // 4 real sidecars: 40d-ago 06 + yesterday 19 + today 06/19 (the
    // yesterday-06 placeholder has no JSON and must not appear)
    assert.equal(h.count, 4);
    const dates = h.items.map((i: { date: string }) => i.date);
    assert.deepEqual(dates, [old, yesterday, today, today]);
    assert.deepEqual(h.items.map((i: { hour: string }) => i.hour), ["06", "19", "06", "19"]);
  });

  await t.test("prune: 40d-old articles sidecar gone, report JSON kept", () => {
    assert.ok(!fs.existsSync(path.join(R, old, "06-articles.json")));
    assert.ok(fs.existsSync(path.join(R, old, "06.json")));
    assert.ok(fs.existsSync(path.join(R, old, "06.html")));
  });

  await t.test("source health: streak logic sees the 3-day fixture only when real", () => {
    // single day fixture → no 3-day streak → no overlay file
    assert.ok(!fs.existsSync(path.join(R, "source-overlay.json")));
    const status = read("status.html");
    assert.ok(status.includes("源健康"));
    assert.ok(status.includes("healthy-src"));
  });

  fs.rmSync(tmp, { recursive: true, force: true });
});
