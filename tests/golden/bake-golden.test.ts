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

function makeSidecar(
  dir: string,
  date: string,
  hour: string,
  opts: { caixinFail?: boolean; generatedAt?: string } = {},
) {
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
    trading: {
      tickers: [
        { symbol: "600519.SS", displayName: "贵州茅台", group: "china-ashare", pct1Day: 2.1 },
        { symbol: "BTC-USD", displayName: "比特币", group: "crypto", pct1Day: -1.4 },
      ],
    },
    fetch_health: {
      // Deterministic instants let the publish-lag table assert verdicts that
      // do not depend on when the test run happens to execute.
      generated_at: opts.generatedAt ?? new Date().toISOString(),
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
    // The synthetic edition mirrors the WEB_MODE nav row render.ts emits, so
    // build-site's ../ → ./ rewrites and its missing-page stripping are
    // exercised over the same anchor shapes the real pages carry.
    `<html><head><title>t</title></head><body><main><h1>${date} ${hour}</h1>` +
      `<nav class="site-nav">` +
      `<a href="../archive.html">历史归档</a>` +
      `<a href="../hour.html">盘中逐时报</a>` +
      `<a href="../stories.html">故事线</a>` +
      `<a data-nav="integrity" href="../integrity.html">数据完整性</a>` +
      `<a data-nav="supro" href="../supro.html">量化实操·SuPro</a>` +
      `</nav></main><footer>f</footer></body></html>`,
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
  // 40 days ago: real edition with a prunable articles sidecar.
  // generatedAt pins the publish-lag verdicts the integrity assertions below
  // rely on: 26m late, 21m late, 10m early, 5m late (on time).
  for (const [d, h, gen] of [
    [today, "06", `${today}T06:26:00+08:00`],
    [today, "19", `${today}T19:21:00+08:00`],
    [yesterday, "19", null],
    [d2, "06", `${d2}T05:50:00+08:00`],
    [d3, "06", `${d3}T06:05:00+08:00`],
    [d4, "06", null],
    [old, "06", null],
  ] as const) {
    makeSidecar(R, d, h, {
      caixinFail: true,
      generatedAt: gen ?? undefined,
    });
  }
  makePlaceholder(R, yesterday, "06");
  fs.writeFileSync(
    path.join(R, old, "06-articles.json"),
    JSON.stringify({ articles: [] }),
    "utf8",
  );

  // Bakes run BEFORE build-site in CI (their artifacts feed it:
  // keywords/periods.json gate page emission) — same order here.
  const tsxBin = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
  for (const script of [
    "bake-keywords.ts",
    "build-weekly.ts",
    "bake-periods.ts",
    "bake-v1.ts",
  ]) {
    execFileSync(tsxBin, [path.join(REPO_ROOT, "scripts", script)], {
      cwd: tmp,
      stdio: "pipe",
    });
  }

  bake(tmp);

  const read = (f: string) => fs.readFileSync(path.join(R, f), "utf8");

  await t.test("index points at newest real edition", () => {
    assert.ok(read("index.html").includes(`${today} 19`));
  });

  await t.test("funnel: every real edition carries the SuPro CTA once", () => {
    const todayHtml = read(`${today}/19.html`);
    assert.ok(todayHtml.includes('data-funnel="supro"'));
    assert.equal(todayHtml.split('data-funnel="supro"').length - 1, 1);
    assert.ok(todayHtml.includes("utm_source=opencool&utm_medium=brief"));
    assert.ok(todayHtml.includes("utm_campaign=news_to_practice"));
    for (const content of ["home", "timing", "signals", "paper", "news"]) {
      assert.ok(
        todayHtml.includes(`utm_content=${content}`),
        `edition CTA missing utm_content=${content}`,
      );
    }
    assert.ok(todayHtml.includes("https://supro.si/timing/broad/?"));
    assert.ok(todayHtml.includes("https://supro.si/signals?"));
    // placeholders are never decorated
    assert.ok(!read(`${yesterday}/06.html`).includes('data-funnel="supro"'));
  });

  await t.test("funnel: supro.html landing + homepage badge use the UTM scheme", () => {
    const supro = read("supro.html");
    assert.ok(supro.includes("utm_content=landing"));
    assert.ok(supro.includes("https://supro.si/timing/broad/?"));
    assert.ok(supro.includes("https://supro.si/paper?"));
    const home = read("index.html");
    assert.ok(home.includes("utm_content=badge"));
    assert.ok(home.includes("量化实操·苏坡"));
  });

  await t.test("funnel: supro.html landing wires the siblings this tree carries", () => {
    const supro = read("supro.html");
    // The v1 bake ran in this fixture, so the integrity link must be present…
    assert.ok(supro.includes('href="./integrity.html"'));
    // …while hour/stories were NOT built (no reading:pages pass), so the landing
    // must strip those links rather than ship 404s off the funnel page itself.
    assert.ok(!supro.includes('href="./hour.html"'));
    assert.ok(!supro.includes('href="./stories.html"'));
    // Same 404 rule for the (not-baked) mcp desk.
    assert.ok(!supro.includes('href="./mcp-desk.html"'));
  });

  await t.test("funnel: archive + status carry distinct SuPro entry points", () => {
    const arch = read("archive.html");
    // The archive keeps its internal landing link AND gains a direct, separately
    // measurable entry (utm_content=archive) for the returning-reader surface.
    assert.ok(arch.includes('href="./supro.html"'));
    assert.ok(arch.includes("https://supro.si/?"));
    assert.ok(arch.includes('utm_content=archive"'));
    const status = read("status.html");
    assert.ok(status.includes('href="./supro.html"'));
  });

  await t.test("funnel: the edition nav keeps the supro link (index rewrite)", () => {
    const home = read("index.html");
    // render.ts emits ../supro.html; build-site rewrites it for the root copy.
    assert.ok(home.includes('href="./supro.html"'));
    assert.ok(!home.includes('href="../supro.html"'));
  });

  await t.test("funnel: integrity page carries the contextual SuPro chain", () => {
    const html = read("integrity.html");
    assert.ok(html.includes("https://supro.si/paper?"));
    assert.ok(html.includes('utm_content=integrity"'));
    // The honesty page links the sibling surfaces it shares a tree with…
    assert.ok(html.includes('href="./supro.html"'));
    // …and strips the reading pages this fixture never built.
    assert.ok(!html.includes('href="./hour.html"'));
    assert.ok(!html.includes('href="./stories.html"'));
  });

  await t.test("llms.txt documents the shared funnel UTM scheme", () => {
    const llms = read("llms.txt");
    assert.ok(llms.includes("utm_campaign=news_to_practice"));
    // one value per entry point is the measurability contract; the phrases are
    // anchored to their neighbours so a value cannot half-mutate and survive.
    for (const phrase of [
      "landing (supro.html)",
      "badge (homepage pill)",
      "archive (archive nav)",
      "edition-themes/edition-flows (review panel)",
      "hour-tape/hour-timing (/hour.html)",
      "story-act/story-signals (/stories.html)",
      "integrity (/integrity.html)",
    ]) {
      assert.ok(llms.includes(phrase), `llms.txt missing funnel entry ${phrase}`);
    }
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

  await t.test("subscribe.html is local-only by default", () => {
    const html = read("subscribe.html");
    assert.ok(html.includes('type="email"'));
    assert.ok(html.includes("opencool-subscription-intent"));
    assert.ok(html.includes("不发送邮件、不上传任何信息"));
    assert.ok(html.includes('data-endpoint=""'));
  });

  await t.test("llms.txt registers data products", () => {
    const llms = read("llms.txt");
    for (const p of [
      "sentiment-history.json",
      "keywords.json",
      "feed.xml",
      "status.html",
      "/hour.html",
      "/stories.html",
    ]) {
      assert.ok(llms.includes(p), `llms.txt missing ${p}`);
    }
  });

  await t.test("llms.txt states targets, not clock promises", () => {
    const llms = read("llms.txt");
    // The intro reframes the slot times as targets and names where the
    // measured record lives — an agent must not be told we publish on a clock.
    assert.ok(
      llms.includes("Edition slots target 06:00/13:00/19:00 Asia/Shanghai"),
      "llms.txt intro must frame slots as targets",
    );
    assert.ok(
      llms.includes("published at /integrity.html rather than promised"),
      "llms.txt must point at the measured publish record",
    );
    assert.ok(
      llms.includes("- Publish punctuality: /integrity.html — 14-day measured publish-lag table,"),
      "the publish-punctuality row must be advertised when integrity.html exists",
    );
  });

  await t.test("v1 namespace: manifest + coverage are published inside the tree", () => {
    const manifest = JSON.parse(read("v1/manifest.json"));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.namespace, "v1");
    // Only endpoints with a file behind them are advertised. This fixture has
    // no tape directory, so `asof` is correctly absent — the same rule that keeps
    // /v1/reactions.json out of the manifest until its bake has run.
    const ids = manifest.endpoints.map((e: { id: string }) => e.id);
    assert.ok(ids.includes("manifest"), "the manifest must list itself");
    assert.ok(ids.includes("coverage"), "coverage.json was written, so it is advertised");
    assert.equal(ids.includes("asof"), false, "no day file exists, so asof is not advertised");
    const cov = JSON.parse(read("v1/coverage.json"));
    assert.equal(cov.namespace, "v1");
    assert.ok(Array.isArray(cov.days));
    // This fixture tree has no tape directory at all, so the namespace must
    // report "not started" rather than a clean 100%.
    assert.equal(cov.tape.started, false);
    assert.equal(cov.summary.coveragePct, null);
  });

  await t.test("v1 endpoints are advertised in tools.json and llms.txt", () => {
    const tools = JSON.parse(read("tools.json"));
    const names = tools.tools.map((t: { name: string }) => t.name);
    for (const n of ["asof_snapshot", "coverage_report", "pinned_stories", "pinned_themes"]) {
      assert.ok(names.includes(n), `tools.json missing ${n}`);
    }
    assert.ok(read("llms.txt").includes("/v1/manifest.json"));
  });

  await t.test("the site nav drops links to pages this build did not produce", () => {
    // The edition template emits ../hour.html, ../stories.html and
    // ../integrity.html unconditionally; only the bakes decide which exist. A
    // nav link that 404s — especially on the honesty page's own site — is the
    // defect this stripping exists to prevent.
    const home = read("index.html");
    for (const rel of ["./hour.html", "./stories.html"]) {
      // This fixture never runs reading:pages, so neither page exists.
      assert.equal(
        home.includes(`<a href="${rel}">`),
        false,
        `index.html still links ${rel}, which was not built`,
      );
    }
  });

  await t.test("integrity.html exists and states that capture has not started", () => {
    const html = read("integrity.html");
    assert.ok(html.includes('data-surface="no-tape"'), "the not-started notice must be present");
    assert.equal(html.includes('data-surface="days"'), false, "no empty day table");
    // Reachable from the existing surfaces, not an orphan page.
    assert.ok(read("archive.html").includes('href="./integrity.html"'));
    assert.ok(read("status.html").includes('href="./integrity.html"'));
    assert.ok(read("index.html").includes('href="./integrity.html"'));
  });

  await t.test("integrity.html carries the 14-day measured publish-lag table", () => {
    const html = read("integrity.html");
    assert.ok(html.includes('data-surface="publish-lag"'), "the lag table must render");
    assert.ok(html.includes("不是承诺"), "the intro must frame the slot times as targets");
    const tbl = html.split('data-surface="publish-lag"')[1].split("</table>")[0];
    // 14 calendar days x 3 slots, plus the header row — a missing slot is a
    // row, never an omission.
    assert.equal(tbl.split("<tr").length - 1, 43, "14 days x 3 slots + thead row");
    // Verdicts are measured from the sidecar's own fetch_health.generated_at.
    assert.ok(
      tbl.includes(`<tr><td>${today}</td><td>06:00</td><td>${today} 06:26</td><td class="n">26</td><td>迟到 26 分钟</td></tr>`),
      "today's 06 slot must show its measured 26-minute lateness",
    );
    assert.ok(tbl.includes(`<td>${d2} 05:50</td><td class="n">-10</td><td>提前 10 分钟</td></tr>`), "an early build is named early");
    assert.ok(tbl.includes(`<td>${d3} 06:05</td><td class="n">5</td><td>准时</td></tr>`), "a within-limit slot is on time");
    assert.ok(
      tbl.includes(`<tr><td>${yesterday}</td><td>06:00</td><td>—</td><td class="n">—</td><td>缺失</td></tr>`),
      "a placeholder-only slot must be named missing, never omitted",
    );
    assert.ok(tbl.includes(`<td>${today}</td><td>13:00</td>`), "an absent not-yet-due slot still has its row");
  });

  await t.test("heatmap: baked from sidecar trading.tickers", () => {
    const hm = read("heatmap.html");
    assert.ok(hm.includes("热力图"));
    assert.ok(hm.includes("贵州茅台"));
    assert.ok(hm.includes("比特币"));
    assert.ok(hm.includes("+2.1%"));
    assert.ok(hm.includes("-1.4%"));
    // nav wiring follows emission (fixture now carries trading data)
    assert.ok(read("status.html").includes('href="./heatmap.html"'));
    assert.ok(read("archive.html").includes('href="./heatmap.html"'));
    assert.ok(
      read("llms.txt").includes(
        "- Sector heatmap: /heatmap.html — watchlist tiles colored by pct1Day (latest edition)",
      ),
    );
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

  await t.test("periods.json + periods.html: WoW buckets with delta chain", () => {
    const per = JSON.parse(read("periods.json"));
    assert.ok(per.weeks.length >= 2, `weeks=${per.weeks.length}`);
    assert.equal(per.weeks[0].deltaVsPrev, null);
    assert.ok(per.weeks[per.weeks.length - 1].deltaVsPrev !== null);
    assert.ok(Array.isArray(per.months) && per.months.length >= 1);
    const html = read("periods.html");
    assert.ok(html.includes("周度趋势"));
    assert.ok(html.includes("月度趋势"));
    assert.ok(!html.includes("position:fixed"), "periods page must stay iframe-safe");
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
