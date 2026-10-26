import "./_env";

import fs from "node:fs";
import path from "node:path";

import { sources, REPORT_LOCALE } from "../lib/sources/registry";
import { fetchSource } from "../lib/sources/dispatch";
import {
  generateDailyReport,
  type ArticleInput,
  type FetchHealth,
} from "../lib/ai/pipeline";
import { generateHeuristicReport } from "../lib/ai/heuristic-digest";
import { isLlmOff } from "../lib/ai/llm-mode";
import { getModelTag, validateBackendCredentials } from "../lib/ai/llm";
import {
  enrichFinanceNewsSummaries,
  enrichGithubTrendingSummaries,
  enrichTrendingPapersSummaries,
  enrichXViralSummaries,
} from "../lib/ai/enrich";
import {
  groupRaw,
  isSportsArticle,
  MERGED_SUBGROUP_LIMITS,
  renderHtml,
  renderMarkdown,
} from "../lib/output/render";
import { analyzeWatchlist } from "../lib/trading/runner";
import { fetchCryptoFearGreed } from "../lib/trading/fear-greed";
import { fetchCryptoGlobal } from "../lib/trading/coingecko";
import { generateTradingCommentary } from "../lib/ai/trading-commentary";
import type { TradingSection } from "../lib/ai/pipeline";
import { todayKey, editionHourKey, parseReportHours } from "../lib/utils";
import { buildQuantSection } from "../lib/invest/quant";
import { scoreSentiment, MIN_HISTORY_SAMPLES } from "../lib/nlp/sentiment";
import type { QuantSection } from "../lib/invest/types";

const OUTPUT_DIR = "daily_reports";

// Hard deadline: a hung fetch (black-holed socket, slow-drip response)
// must fail the run fast so the hourly gh-pages catchup can retry the
// slot, instead of silently burning the whole CI job timeout.
const deadlineRaw = Number(process.env.PIPELINE_DEADLINE_MIN || 20);
const PIPELINE_DEADLINE_MIN =
  Number.isFinite(deadlineRaw) && deadlineRaw > 0 ? deadlineRaw : 20;
const pipelineT0 = Date.now();
const stageMarks: string[] = [];
let currentStage = "init";
function stage(name: string) {
  stageMarks.push(`${name}+${((Date.now() - pipelineT0) / 1000).toFixed(0)}s`);
  currentStage = name;
}
const watchdog = setTimeout(() => {
  console.error(
    `\n[daily] PIPELINE DEADLINE of ${PIPELINE_DEADLINE_MIN}min exceeded at stage "${currentStage}" — aborting`,
  );
  console.error(`[daily] stages so far: ${stageMarks.join(" | ") || "(none)"}`);
  process.exit(1);
}, PIPELINE_DEADLINE_MIN * 60_000);

async function fetchAll(): Promise<{
  articles: ArticleInput[];
  health: FetchHealth;
}> {
  const articles: ArticleInput[] = [];
  const health: FetchHealth = {
    generated_at: new Date().toISOString(),
    entries: [],
  };
  const enabled = sources.filter((s) => s.enabled !== false);
  const CONCURRENCY = 6;
  let cursor = 0;

  async function worker() {
    while (cursor < enabled.length) {
      const idx = cursor++;
      const source = enabled[idx];
      const t0 = Date.now();
      try {
        const items = await fetchSource(source);
        console.log(`  ${source.id.padEnd(20)} ${items.length}`);
        articles.push(...items.map((it) => ({ ...it, source: source.name })));
        health.entries.push({
          id: source.id,
          ms: Date.now() - t0,
          ok: true,
          count: items.length,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  ${source.id.padEnd(20)} FAILED — ${msg}`);
        health.entries.push({
          id: source.id,
          ms: Date.now() - t0,
          ok: false,
          count: 0,
          error: msg.slice(0, 200),
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, enabled.length) }, () =>
      worker(),
    ),
  );
  return { articles, health };
}

function logFetchHealth(health: FetchHealth) {
  const ok = health.entries.filter((e) => e.ok).length;
  const failed = health.entries.filter((e) => !e.ok);
  const slowest = [...health.entries]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3)
    .map((e) => `${e.id}(${(e.ms / 1000).toFixed(1)}s)`)
    .join(", ");
  console.log(
    `[daily] fetch health: ok=${ok}/${health.entries.length}` +
      (failed.length
        ? ` failed=[${failed.map((e) => e.id).join(",")}]`
        : "") +
      ` slowest: ${slowest}`,
  );
}

async function enrichGhTrending(articles: ArticleInput[]): Promise<void> {
  const gh = articles.filter((a) => a.sourceId === "github-trending");
  if (gh.length === 0) return;
  console.log(
    `[daily] enriching ${gh.length} GitHub Trending repos with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichGithubTrendingSummaries(gh);
  for (const a of gh) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${gh.length}`,
  );
}

/**
 * finance:news is rendered as a merged time-sorted list (see
 * MERGED_SUBGROUP_LIMITS in render.ts). Enrich exactly the items that
 * will be displayed: take all enabled finance:news articles, sort by
 * publishedAt desc, slice to the merge limit, ask Sonnet for Chinese
 * factual summaries.
 */
async function enrichFinanceNews(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "finance", "news");
}

async function enrichPolitics(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "politics", "world");
}

async function enrichAiNews(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "tech", "ai-news");
}

/**
 * X 热帖 enrichment is different from merged subgroups — we preserve the
 * AttentionVC API's heat-rank order (do NOT sort by date) and cap to the
 * displayed limit (matches SOURCE_DISPLAY_LIMITS["tech:x-viral"]).
 *
 * The Sonnet prompt also differs (XVIRAL_SYSTEM_PROMPT in enrich.ts) — X
 * tweet titles are clickbait, the previewText holds the actual claim.
 */
async function enrichXViral(articles: ArticleInput[]): Promise<void> {
  const xPosts = articles
    .filter((a) => a.sourceId === "attentionvc-ai")
    .slice(0, 20);
  if (xPosts.length === 0) return;
  console.log(`[daily] enriching ${xPosts.length} X posts with ${REPORT_LOCALE} summaries…`);
  const t0 = Date.now();
  // Author handle is encoded in the URL (https://x.com/{handle}/status/{id})
  // — extract it to help the model identify whose claim it is.
  const summaries = await enrichXViralSummaries(
    xPosts.map((a) => ({
      url: a.url,
      title: a.title,
      excerpt: a.excerpt,
      author: a.url.match(/x\.com\/([^/]+)\//)?.[1] ?? "",
    })),
  );
  for (const a of xPosts) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${xPosts.length}`,
  );
}

/**
 * Trending papers enrichment — preserves the fetcher's upvote-desc order
 * (huggingface-papers is in PRESERVE_FETCH_ORDER_SOURCES) and caps to the
 * displayed limit (matches SOURCE_DISPLAY_LIMITS["tech:trending-papers"]).
 */
async function enrichTrendingPapers(articles: ArticleInput[]): Promise<void> {
  const papers = articles
    .filter((a) => a.sourceId === "huggingface-papers")
    .slice(0, 20);
  if (papers.length === 0) return;
  console.log(
    `[daily] enriching ${papers.length} trending papers with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichTrendingPapersSummaries(
    papers.map((a) => ({ url: a.url, title: a.title, excerpt: a.excerpt })),
  );
  for (const a of papers) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${papers.length}`,
  );
}

/**
 * Shared implementation for "merged subgroup" enrichment: collect all
 * enabled articles in (category, subcategory), sort by date desc, take
 * the display cap (from MERGED_SUBGROUP_LIMITS), and ask the LLM to
 * summarize them into REPORT_LOCALE in a single batch. Symmetric to the
 * merge logic in render.ts groupRaw, so display and enrichment stay aligned.
 *
 * Sources whose `lang` already matches REPORT_LOCALE are skipped — no
 * point translating English to English (en mode) or Chinese to Chinese
 * (zh mode).
 */
async function enrichMergedSubgroup(
  articles: ArticleInput[],
  category: "tech" | "finance" | "politics",
  subcategory: string,
): Promise<void> {
  const subSources = sources.filter(
    (s) =>
      s.category === category &&
      s.subcategory === subcategory &&
      s.enabled !== false,
  );
  const enabledIds = new Set(subSources.map((s) => s.id));
  const sameLocaleIds = new Set(
    subSources.filter((s) => (s.lang ?? "en") === REPORT_LOCALE).map((s) => s.id),
  );
  const limit = MERGED_SUBGROUP_LIMITS[`${category}:${subcategory}`] ?? 12;
  // Top-N respects all enabled sources (so we don't reshape the merged
  // timeline). Enrichment only targets items NOT already in the target
  // language within that slice.
  const top = articles
    .filter((a) => enabledIds.has(a.sourceId))
    .filter((a) => category !== "politics" || !isSportsArticle(a.title))
    .sort(
      (a, b) =>
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    )
    .slice(0, limit);
  const toEnrich = top.filter((a) => !sameLocaleIds.has(a.sourceId));
  if (toEnrich.length === 0) return;
  console.log(
    `[daily] enriching ${toEnrich.length}/${top.length} ${category}:${subcategory} items with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichFinanceNewsSummaries(toEnrich);
  for (const a of toEnrich) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${toEnrich.length}`,
  );
}

/**
 * Pull daily OHLCV from Yahoo for every ticker in the watchlist, compute
 * indicators + signals, then ask Sonnet for a market overview + a
 * picks-to-watch list. Returns null if no ticker came back.
 */
async function runTrading(llmOff: boolean): Promise<TradingSection | null> {
  console.log(`[daily] analyzing watchlist + crypto context (EM/Yahoo / alt.me / CoinGecko)…`);
  const t0 = Date.now();
  const [tickers, cryptoFearGreed, cryptoGlobal] = await Promise.all([
    analyzeWatchlist(),
    fetchCryptoFearGreed(),
    fetchCryptoGlobal(),
  ]);
  console.log(
    `[daily] indicators ready in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${tickers.length} tickers` +
      (cryptoFearGreed ? `, F&G ${cryptoFearGreed.value}` : ", F&G ✗") +
      (cryptoGlobal
        ? `, BTC dom ${cryptoGlobal.btcDominance.toFixed(1)}%`
        : ", CG ✗"),
  );
  if (tickers.length === 0) return null;

  if (llmOff) {
    console.log(`[daily] LLM_MODE=off — skipping trading commentary`);
    return {
      market_overview:
        REPORT_LOCALE === "en"
          ? "Markets panel shows indicators only (LLM commentary disabled)."
          : "行情面板仅展示技术指标（LLM_MODE=off，未生成文字点评）。",
      watchlist: [],
      risk_caveat:
        REPORT_LOCALE === "en"
          ? "Past performance is not indicative of future results. For technical reference only."
          : "过去走势不代表未来表现；仅供技术指标解读参考。",
      tickers,
      crypto_fear_greed: cryptoFearGreed ?? undefined,
      crypto_global: cryptoGlobal ?? undefined,
      generated_at: new Date().toISOString(),
    };
  }

  console.log(`[daily] generating trading commentary with ${getModelTag()}…`);
  const t1 = Date.now();
  const commentary = await generateTradingCommentary({
    tickers,
    cryptoFearGreed: cryptoFearGreed ?? undefined,
    cryptoGlobal: cryptoGlobal ?? undefined,
  });
  console.log(
    `[daily] trading commentary ready in ${((Date.now() - t1) / 1000).toFixed(1)}s`,
  );
  return {
    ...commentary,
    tickers,
    crypto_fear_greed: cryptoFearGreed ?? undefined,
    crypto_global: cryptoGlobal ?? undefined,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Recent sentiment scores from restored sidecars (newest last). The
 * gh-pages restore step runs before `npm run daily` in CI, so yesterday's
 * editions are on disk; locally this simply reads what exists. Bounded
 * reads: newest 30 editions only.
 */
function loadSentimentHistory(): number[] {
  const out: number[] = [];
  try {
    const days = fs
      .readdirSync(OUTPUT_DIR)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    for (let i = days.length - 1; i >= 0 && out.length < 40; i--) {
      const dir = path.join(OUTPUT_DIR, days[i]);
      const files = fs
        .readdirSync(dir)
        .filter((f) => /^\d{2}\.json$/.test(f))
        .sort()
        .reverse();
      for (const f of files) {
        if (out.length >= 40) break;
        try {
          const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          if (typeof r?.sentiment?.score === "number") {
            out.push(r.sentiment.score);
          }
        } catch {
          // unreadable sidecar — skip, never fail the run for telemetry
        }
      }
    }
  } catch {
    // no daily_reports yet — empty history
  }
  // newest-first collection → chronological order for percentile
  return out.reverse().slice(-30);
}

async function main() {
  const llmOff = isLlmOff();
  if (llmOff) {
    console.log(`[daily] LLM off — heuristic digest, no API key required`);
  } else {
    console.log(`[daily] LLM on — backend ${getModelTag()}`);
    // Fail fast on misconfigured backend before we spend 30s fetching
    // 500+ articles only to discover the LLM has no credentials.
    validateBackendCredentials();
  }

  const date = todayKey();
  const hour = editionHourKey();
  const siblingHours = parseReportHours().map((h) => String(h).padStart(2, "0"));
  console.log(`[daily] ${date} edition ${hour} — fetching sources…\n`);
  stage("sources");
  const { articles, health } = await fetchAll();
  console.log(`\n[daily] total articles: ${articles.length}`);
  logFetchHealth(health);
  if (articles.length === 0) {
    throw new Error("no articles fetched — aborting");
  }

  if (!llmOff) {
    // Enrich GH Trending, papers, finance news, and politics with summaries.
    stage("enrichment");
    await enrichGhTrending(articles);
    await enrichTrendingPapers(articles);
    await enrichFinanceNews(articles);
    await enrichPolitics(articles);
    await enrichAiNews(articles);
    await enrichXViral(articles);
  } else {
    console.log(`[daily] skipping LLM enrichment`);
  }

  // Trading signals: Yahoo fetch + indicators + commentary. Non-fatal —
  // if it errors, we still ship the news digest.
  let trading: TradingSection | null = null;
  try {
    stage("trading");
    trading = await runTrading(llmOff);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[daily] trading section failed: ${msg}`);
  }

  let quant: QuantSection | null = null;
  try {
    stage("quant");
    console.log(`[daily] building retail quant extras…`);
    quant = await buildQuantSection(trading?.tickers ?? [], articles);
    console.log(
      `[daily] quant: indices=${quant.market?.indices.length ?? 0} events=${quant.events.length} flows=${quant.fundFlows?.sectors.length ?? 0} toyBT=${quant.toyBacktests.length} personaScores=${quant.personas.length}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[daily] quant section failed: ${msg}`);
  }

  stage("digest");
  console.log(
    llmOff
      ? `[daily] generating heuristic digest…`
      : `[daily] generating digest with ${getModelTag()}…`,
  );
  const t0 = Date.now();
  const { report } = llmOff
    ? { report: generateHeuristicReport(articles) }
    : await generateDailyReport(articles);
  if (trading) report.trading = trading;
  if (quant) report.quant = quant;
  const sentimentHistory = loadSentimentHistory();
  report.sentiment = scoreSentiment(articles, sentimentHistory);
  console.log(
    `[daily] sentiment: ${report.sentiment.label} (${report.sentiment.score}, +${report.sentiment.posHits}/−${report.sentiment.negHits} over ${report.sentiment.scanned} finance items` +
      (report.sentiment.percentile !== null
        ? `, percentile ${report.sentiment.percentile}`
        : `, history ${sentimentHistory.length}/${MIN_HISTORY_SAMPLES}`) +
      `)`,
  );
  report.fetch_health = health;
  console.log(`[daily] digest ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  stage("write");
  const dateDir = path.join(OUTPUT_DIR, date);
  fs.mkdirSync(dateDir, { recursive: true });
  const base = path.join(dateDir, hour);
  const raw = groupRaw(articles, sources);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(
    `${base}-articles.json`,
    JSON.stringify({ date, hour, articles }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    `${base}.html`,
    renderHtml(report, raw, date, { editionHour: hour, siblingHours }),
    "utf8",
  );
  if (process.env.OUTPUT_MARKDOWN === "true") {
    fs.writeFileSync(`${base}.md`, renderMarkdown(report, date), "utf8");
    console.log(`[daily] wrote ${base}.{json,html,md,articles.json}`);
  } else {
    console.log(`[daily] wrote ${base}.{json,html,articles.json}`);
  }

  clearTimeout(watchdog);
  console.log(`[daily] done.`);
}

main().catch((e) => {
  console.error(`[daily] FAILED:`, e);
  process.exit(1);
});
