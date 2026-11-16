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
  opts: { caixinFail?: boolean; generatedAt?: string; extraFinanceBriefs?: Array<{ title: string; url: string; source: string; summary: string; importance: number }> } = {},
) {
  fs.mkdirSync(path.join(dir, date), { recursive: true });
  const report = {
    hero_headline: `${date} ${hour} 头条`,
    daily_overview: "概览",
    tech_briefs: [],
    finance_briefs: opts.extraFinanceBriefs ?? [],
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
    // exercised over the same anchor shapes the real pages carry. The head
    // mirrors render.ts's discovery block the same way, so the homepage's
    // og:url rewrite and WebSite injection run against realistic markup.
    `<html><head><title>t</title>` +
      `<meta property="og:url" content="https://fudan2026.github.io/opencool/${date}/${hour}.html">` +
      `<script type="application/ld+json">{"@context": "https://schema.org","@type": "NewsArticle"}</script>` +
      `</head><body><main><h1>${date} ${hour}</h1>` +
      `<nav class="site-nav">` +
      `<a href="../archive.html">历史归档</a>` +
      `<a href="../hour.html">盘中逐时报</a>` +
      `<a href="../stories.html">故事线</a>` +
      `<a data-nav="reactions" href="../reactions.html">反应窗</a>` +
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
      // One ai-theme brief on the newest edition, so the per-theme feed has a
      // deterministic item to assert on.
      extraFinanceBriefs:
        d === today && h === "19"
          ? [
              {
                title: "人工智能大模型发布会",
                url: "https://example.com/ai",
                source: "测试源",
                summary: "大模型 算力需求继续爆发",
                importance: 3,
              },
            ]
          : undefined,
    });
  }
  makePlaceholder(R, yesterday, "06");
  fs.writeFileSync(
    path.join(R, old, "06-articles.json"),
    JSON.stringify({ articles: [] }),
    "utf8",
  );

  // themes.json fixture for the per-theme feeds: `ai` exists in the committed
  // catalog (so its aliases match the brief above); `gold` does not, so its
  // channel must still exist — one feed per theme in themes.json — and be
  // honestly empty.
  fs.writeFileSync(
    path.join(R, "themes.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      status: "ok",
      registry: "live",
      edition: `${today}/19`,
      themes: [
        { key: "ai", name: "人工智能", boardCode: "BK0800", articleHits: 2, matchedAliases: ["人工智能"], constituents: [] },
        { key: "gold", name: "黄金", boardCode: null, articleHits: 0, matchedAliases: [], constituents: [] },
      ],
    }),
    "utf8",
  );

  // reactions.json fixture: one measurable +1h window, one pending story, one
  // insufficient aggregate — the exact states the public page must keep visible.
  fs.writeFileSync(
    path.join(R, "reactions.json"),
    JSON.stringify({
      schemaVersion: 1,
      dataThrough: `${today}T19:21:00+08:00`,
      timezone: "Asia/Shanghai",
      headlineMetric: "marketExcessPct",
      headlineReason: "cross-sectional excess is the headline",
      method: {},
      tape: { days: 1, snapshots: 2, from: `${today}T09:35:00+08:00`, to: `${today}T14:35:00+08:00`, slots: ["09:35"] },
      ledger: { stories: 2, withFirstSeen: 2, maxStories: 2000, retentionDays: 30, updatedAt: `${today}T19:21:00+08:00`, retainedFrom: today, retainedTo: today, capBinding: false },
      counts: {
        stories: 2,
        attributed: { entity: 1, topic: 0, market: 0, pending: 1, unmapped: 0 },
        horizons: { "1h": { ok: 1, pending: 1, gap: 0 }, "1d": { ok: 0, pending: 2, gap: 0 }, "5d": { ok: 0, pending: 2, gap: 0 } },
        aggregates: { byTopic: 1, byEntity: 0 },
        observationsTotal: 2,
        observationsPublished: 2,
      },
      aggregates: {
        byTopic: [
          {
            key: "global-markets",
            label: "全球市场",
            expectedSign: null,
            horizons: {
              "1h": { n: 3, status: "insufficient", excluded: { pending: 1, gap: 0 } },
              "1d": { n: 0, status: "insufficient", excluded: { pending: 0, gap: 0 } },
              "5d": { n: 0, status: "insufficient", excluded: { pending: 0, gap: 0 } },
            },
          },
        ],
        byEntity: [],
      },
      observations: [
        {
          id: "st_fix01",
          firstSeenAt: `${today}T13:05:12+08:00`,
          firstEdition: `${today}/13`,
          topic: "global-markets",
          target: "theme:ai",
          targetLabel: "人工智能",
          attribution: "entity",
          entity: "nvidia",
          attributionReason: "entity nvidia -> theme ai",
          horizons: {
            "1h": { status: "ok", windowMinutes: 60, rawReturnPct: 2.1, marketExcessPct: 1.23, marketMeanPct: 0.87 },
            "1d": { status: "pending", reason: "no snapshot at/after firstSeenAt + horizon" },
            "5d": { status: "pending", reason: "no snapshot at/after firstSeenAt + horizon" },
          },
        },
        {
          id: "st_fix02",
          firstSeenAt: `${today}T14:10:00+08:00`,
          firstEdition: `${today}/13`,
          topic: "policy",
          target: null,
          targetLabel: null,
          attribution: "pending",
          attributionPending: true,
          entity: null,
          attributionReason: "tape has not started",
          horizons: {
            "1h": { status: "pending", reason: "no snapshot at/after firstSeenAt + horizon" },
            "1d": { status: "pending", reason: "no snapshot at/after firstSeenAt + horizon" },
            "5d": { status: "pending", reason: "no snapshot at/after firstSeenAt + horizon" },
          },
        },
      ],
      observationsTruncated: false,
      gaps: [{ kind: "attribution-pending", detail: "tape has not started", count: 1 }],
    }),
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
  // Per-theme feeds + the reactions page: the two presence-gated products
  // this increment adds. Spawned the same way (real scripts, synthetic tree).
  execFileSync(tsxBin, [path.join(REPO_ROOT, "scripts", "bake-feeds.ts")], {
    cwd: tmp,
    stdio: "pipe",
  });
  execFileSync(
    tsxBin,
    [path.join(REPO_ROOT, "scripts", "build-reading-pages.ts"), "--only=reactions"],
    { cwd: tmp, stdio: "pipe" },
  );

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

  await t.test("feeds: one channel per theme, UTM per item, placeholders excluded", () => {
    const feeds = fs.readdirSync(path.join(R, "feed")).filter((f) => f.endsWith(".xml"));
    assert.deepEqual(feeds, ["ai.xml", "gold.xml"]);
    const ai = read("feed/ai.xml");
    // The only edition whose briefs match the ai aliases is today/19.
    assert.ok(ai.includes(`<link>https://fudan2026.github.io/opencool/${today}/19.html?`));
    // ampersands are XML-escaped; assert the scheme parts, not the raw & chain.
    assert.ok(ai.includes("utm_source=opencool"));
    assert.ok(ai.includes("utm_campaign=news_to_practice"));
    assert.ok(
      ai.includes("utm_content=rss-ai"),
      "the item link carries the theme's own UTM value",
    );
    assert.ok(
      ai.includes(`<guid isPermaLink="true">https://fudan2026.github.io/opencool/${today}/19.html</guid>`),
      "the guid is the bare permalink, not the tracked link",
    );
    assert.equal(ai.split("<item>").length - 1, 1, "no other edition matched");
    assert.ok(!ai.includes("尚未更新"), "placeholders never leak into a channel");
    // A theme outside the catalog still gets its channel — one feed per theme
    // in themes.json — and it is honestly empty.
    const gold = read("feed/gold.xml");
    assert.equal(gold.split("<item>").length - 1, 0);
  });

  await t.test("sitemap.xml: root pages + real editions, placeholders excluded", () => {
    const sitemap = read("sitemap.xml");
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    for (const page of [
      "index.html",
      "archive.html",
      "status.html",
      "supro.html",
      "subscribe.html",
      "ai-instructions.html",
      "heatmap.html",
      "periods.html",
      "reactions.html",
    ]) {
      assert.ok(
        locs.includes(`https://fudan2026.github.io/opencool/${page}`),
        `sitemap missing root page ${page}`,
      );
    }
    assert.ok(
      locs.includes(`https://fudan2026.github.io/opencool/${today}/19.html`),
      "real editions are listed",
    );
    assert.equal(
      locs.some((l) => l.endsWith(`${yesterday}/06.html`)),
      false,
      "placeholder pages are never listed",
    );
    // lastmod for an edition is the sidecar's own generated_at, not the mtime.
    assert.ok(
      sitemap.includes(`<loc>https://fudan2026.github.io/opencool/${today}/06.html</loc>\n    <lastmod>${today}T06:26:00+08:00</lastmod>`),
      "edition lastmod comes from fetch_health.generated_at",
    );
    // Every edition in the tree is covered: 7 real sidecars + legacy = 7 here.
    assert.equal(locs.filter((l) => /\/\d{4}-\d{2}-\d{2}\//.test(l)).length, 7);
  });

  await t.test("robots.txt names the sitemap", () => {
    const robots = read("robots.txt");
    assert.ok(robots.includes("User-agent: *"));
    assert.ok(robots.includes("Sitemap: https://fudan2026.github.io/opencool/sitemap.xml"));
  });

  await t.test("og cards: build-site pages carry the card block", () => {
    const arch = read("archive.html");
    assert.ok(arch.includes('<meta property="og:title" content="OpenCool 归档">'));
    assert.ok(arch.includes('<meta name="twitter:card" content="summary">'));
    assert.ok(arch.includes('"@type": "CollectionPage"'));
    const status = read("status.html");
    assert.ok(status.includes('<meta property="og:url" content="https://fudan2026.github.io/opencool/status.html">'));
    assert.ok(status.includes('"@type": "WebPage"'));
    // The placeholder page carries the card too — it is a public page. The
    // fixture's yesterday/06.html is hand-written (not a build-site
    // placeholder), so assert on the placeholder build-site itself writes
    // for the latest day's missing slot: today/13.html.
    const ph = read(`${today}/13.html`);
    assert.ok(ph.includes('<meta property="og:type" content="website">'));
    // The homepage: og:url rewritten to the root + WebSite JSON-LD added on top
    // of the NewsArticle the edition template emitted.
    const home = read("index.html");
    assert.ok(home.includes('<meta property="og:url" content="https://fudan2026.github.io/opencool/">'));
    assert.ok(home.includes('"@type": "WebSite"'));
    assert.equal(home.includes('"@type": "NewsArticle"'), true, "the edition article is still described");
  });

  await t.test("reactions: presence-gated page is wired into the tree it exists in", () => {
    const html = read("reactions.html");
    assert.ok(html.includes('data-table="observations"'), "the observations table rendered");
    assert.ok(read("archive.html").includes('href="./reactions.html"'));
    assert.ok(read("status.html").includes('href="./reactions.html"'));
    assert.ok(read("supro.html").includes('href="./reactions.html"'));
    // The homepage copy rewrote the edition nav's `../` link...
    assert.ok(read("index.html").includes('href="./reactions.html"'));
    // ...and the page's own footer drops the siblings this fixture never built
    // (hour/stories), keeping the one that exists (integrity).
    assert.ok(!html.includes('href="./hour.html"'));
    assert.ok(!html.includes('href="./stories.html"'));
    assert.ok(html.includes('href="./integrity.html"'));
  });

  await t.test("reactions: honest states stay visible, one funnel entry per horizon", () => {
    const html = read("reactions.html");
    assert.ok(html.includes("+1.23%"), "the measurable window's headline is shown");
    assert.ok(html.includes("待定"), "pending stays pending");
    assert.ok(html.includes("样本不足"), "insufficient aggregates are named");
    for (const key of ["reactions-1h", "reactions-1d", "reactions-5d"]) {
      assert.ok(html.includes(`utm_content=${key}"`), `missing funnel entry ${key}`);
    }
    assert.ok(html.includes("https://supro.si/paper?"));
  });

  await t.test("llms.txt registers the discovery surfaces", () => {
    const llms = read("llms.txt");
    assert.ok(llms.includes("Reaction windows page: /reactions.html"), "reactions row missing");
    assert.ok(llms.includes("Per-theme RSS: /feed/<theme-key>.xml"), "feeds row missing");
    assert.ok(llms.includes("- Discovery: /sitemap.xml"), "sitemap/robots row missing");
    assert.ok(llms.includes("rss-<theme-key> (per-theme RSS items)"), "funnel utm list not extended");
    assert.ok(llms.includes("reactions-1h/reactions-1d/reactions-5d (/reactions.html)"));
  });

  fs.rmSync(tmp, { recursive: true, force: true });
});
