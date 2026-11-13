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
import { groupRaw, renderHtml, renderMarkdown } from "../lib/output/render";
import { analyzeWatchlist } from "../lib/trading/runner";
import { fetchCryptoFearGreed } from "../lib/trading/fear-greed";
import { fetchCryptoGlobal } from "../lib/trading/coingecko";
import { generateTradingCommentary } from "../lib/ai/trading-commentary";
import type { TradingSection } from "../lib/ai/pipeline";
import { todayKey, naturalTodayKey, editionHourKey, parseReportHours, editionKind } from "../lib/utils";
import { buildQuantSection } from "../lib/invest/quant";
import { scoreSentiment, MIN_HISTORY_SAMPLES } from "../lib/nlp/sentiment";
import { cleanKeywords } from "../lib/nlp/keywords";
import { loadLeadConfig, applyLead } from "../lib/editorial/lead";
import { THEME_CATALOG, themeArticleHits } from "../lib/themes/catalog";
import { classifyAll, type TopicTag } from "../lib/topics/classify";
import { routeEdition } from "../lib/topics/routing";
import type { SourceDef } from "../lib/sources/types";
import type { MorningBrief } from "../lib/ai/pipeline";
import type { QuantSection } from "../lib/invest/types";

const OUTPUT_DIR = "daily_reports";

/**
 * Attach two-axis tags to the articles written to the sidecar.
 *
 * Increment 1 shipped this in shadow mode (additive only, HTML byte-identical).
 * Increment 2 makes the tags load-bearing: `groupRaw` routes on them, so the
 * same values persisted here are what the page is built from. The classifier
 * remains pure and total, so a bad article degrades to a source-tier topic
 * rather than failing the run.
 *
 * Ordering note: this runs at the sidecar write site, *after* the digest, so an
 * LLM failure cannot affect routing and a routing surprise cannot affect the
 * digest.
 */
function withTopics(
  articles: ArticleInput[],
  registry: SourceDef[],
): Array<ArticleInput & Partial<TopicTag>> {
  try {
    const subcategoryOf = new Map(registry.map((s) => [s.id, s.subcategory]));
    const tagged = classifyAll(articles, (a) => subcategoryOf.get(a.sourceId));
    const lanes = { zh: 0, external: 0 };
    const topics = new Map<string, number>();
    let domestic = 0;
    let fallback = 0;
    for (const a of tagged) {
      lanes[a.lane] += 1;
      topics.set(a.topic, (topics.get(a.topic) ?? 0) + 1);
      if (a.domestic) domestic += 1;
      if (a.topicConfidence === 0) fallback += 1;
    }
    const topicSummary = [...topics.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}×${n}`)
      .join(", ");
    console.log(
      `[daily] topics: zh×${lanes.zh} external×${lanes.external} | ` +
        `${topicSummary} | domestic×${domestic} fallback×${fallback}`,
    );
    return tagged;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[daily] topic classification skipped (non-fatal): ${msg}`);
    return articles;
  }
}

/**
 * Log what the router did, in the one place an operator looks.
 *
 * Two numbers matter operationally: how many duplicate stories were suppressed
 * (should be small and non-zero) and whether any section had to be withheld
 * because it could not field three balanced items. Both are non-fatal by
 * design, so the log is the only signal that an edition was shaped rather than
 * reported.
 */
function logRoutingHealth(raw: ReturnType<typeof groupRaw>) {
  try {
    const parts: string[] = [];
    let dupes = 0;
    for (const lane of raw.lanes) {
      const sections = lane.sections
        .map((s) => `${s.topic}×${s.items.length}`)
        .join(" ");
      parts.push(`${lane.lane}[${sections || "—"}]`);
      for (const s of lane.sections) dupes += Math.max(0, s.available - s.items.length);
      for (const o of lane.omitted) {
        parts.push(`${lane.lane}:${o.topic}=withheld(${o.available})`);
      }
    }
    console.log(`[daily] routed: ${parts.join(" | ")} | capped×${dupes}`);
  } catch {
    // logging must never be the thing that fails a publish
  }
}

// Hard deadline: a hung fetch (black-holed socket, slow-drip response)// must fail the run fast so the hourly gh-pages catchup can retry the
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
 * Enrich exactly the items the reader will see.
 *
 * Before routing, this function was three calls keyed on merged-subgroup names
 * (`finance:news`, `politics:world`, `tech:ai-news`), two of which no longer
 * exist as subcategories — so the LLM was spending most of its budget on a
 * timeline that no longer matched the page. Routing makes the target set
 * computable: run the same `routeEdition` the renderer runs, collect the
 * selected URLs, and enrich those.
 *
 * Same-locale sources are still skipped (no point writing a Chinese summary of
 * Chinese copy), and the whole step stays non-fatal — `enrichFinanceNewsSummaries`
 * already swallows failures and returns an empty map.
 */
async function enrichRoutedSelection(
  articles: ArticleInput[],
  tagged: ArticleInput[],
): Promise<void> {
  const subcategories: Record<string, string | undefined> = {};
  for (const s of sources) subcategories[s.id] = s.subcategory;
  const rendered = new Set<string>();
  for (const lane of routeEdition(tagged, subcategories).lanes) {
    for (const section of lane.sections) {
      for (const item of section.items) rendered.add(item.url);
    }
  }

  const sameLocaleIds = new Set(
    sources.filter((s) => (s.lang ?? "en") === REPORT_LOCALE).map((s) => s.id),
  );
  const toEnrich = articles.filter(
    (a) => rendered.has(a.url) && !sameLocaleIds.has(a.sourceId) && !a.summary,
  );
  if (toEnrich.length === 0) return;
  console.log(
    `[daily] enriching ${toEnrich.length}/${rendered.size} routed items with ${REPORT_LOCALE} summaries…`,
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
export interface SentimentTrendPoint {
  date: string;
  hour: string;
  score: number;
}

function loadSentimentTrend(): SentimentTrendPoint[] {
  const out: SentimentTrendPoint[] = [];
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
            out.push({
              date: days[i],
              hour: f.replace(/\.json$/, ""),
              score: r.sentiment.score,
            });
          }
        } catch {
          // unreadable sidecar — skip, never fail the run for telemetry
        }
      }
    }
  } catch {
    // no daily_reports yet — empty history
  }
  // newest-first collection → chronological order
  return out.reverse().slice(-30);
}

const REVIEW_SAMPLE_FLOOR = 10;

/** 龙虎榜 rows from the lhb bake (06:00 editions). */
function loadLhb(): Array<{ code: string; name: string; changePct: number; netAmtYi: number; tradeDate: string }> {
  try {
    const fp = path.join(OUTPUT_DIR, "lhb.json");
    if (!fs.existsSync(fp)) return [];
    const j = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (j?.status !== "ok" || !Array.isArray(j.rows)) return [];
    return j.rows.slice(0, 6);
  } catch {
    return [];
  }
}

/** Today's pre-market tips from the calendar bake (06:00 editions). */
function loadPremarketTips(today: string): Array<{ time: string; title: string; summary: string; url: string }> {
  try {
    const fp = path.join(OUTPUT_DIR, "calendar.json");
    if (!fs.existsSync(fp)) return [];
    const j = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (j?.status !== "ok" || !Array.isArray(j.items)) return [];
    void today;
    return j.items.slice(0, 6);
  } catch {
    return [];
  }
}

/** Full previous-day sidecar (last slot of the newest day < today). */
function loadYesterdayEdition(today: string):
  | { date: string; hour: string; report: Record<string, unknown> }
  | null {
  try {
    const days = fs
      .readdirSync(OUTPUT_DIR)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < today)
      .sort();
    for (let i = days.length - 1; i >= 0; i--) {
      const dir = path.join(OUTPUT_DIR, days[i]);
      const files = fs
        .readdirSync(dir)
        .filter((f) => /^\d{2}\.json$/.test(f))
        .sort()
        .reverse();
      for (const f of files) {
        try {
          const report = JSON.parse(
            fs.readFileSync(path.join(dir, f), "utf8"),
          ) as Record<string, unknown>;
          return { date: days[i], hour: f.replace(/\.json$/, ""), report };
        } catch {
          // unreadable — try the next slot
        }
      }
    }
  } catch {
    // no daily_reports yet
  }
  return null;
}

/**
 * Morning brief: pure-arithmetic overnight digest for the 06:00 edition.
 * Deliberately avoids "A-share index change overnight" (both 19:00 and
 * 06:00 snapshots are post-close, delta ≈ 0) — the real overnight action
 * is US/crypto/commodity tickers captured right after the US close.
 */
function buildMorningBrief(
  base: { date: string; hour: string; report: Record<string, unknown> },
  today: { sentimentScore: number | null; keywords: string[]; eventUrls: Set<string>; events: Array<{ symbol: string; displayName: string; title: string; url: string }>; tickers: Array<{ symbol: string; displayName: string; group: string; pct1Day: number }> | undefined; premarketTips: Array<{ time: string; title: string; summary: string; url: string }>; lhbRows: Array<{ code: string; name: string; changePct: number; netAmtYi: number; tradeDate: string }>; flowLine: string | null },
  reportKeywords: string[],
): MorningBrief {
  const baseSent = (base.report as { sentiment?: { score?: number } }).sentiment;
  const baseKeywords = cleanKeywords(
    (base.report as { keywords?: string[] }).keywords,
  );
  const todayClean = cleanKeywords(reportKeywords);
  const newKeywords = todayClean.filter((k) => !baseKeywords.includes(k));

  const baseEventUrls = new Set(
    (
      (base.report as { quant?: { events?: Array<{ url?: string }> } }).quant
        ?.events ?? []
    )
      .map((e) => e.url)
      .filter((u): u is string => !!u),
  );
  const newEvents = today.events.filter(
    (e) => e.url && !baseEventUrls.has(e.url),
  );

  const overnightGroups = new Set([
    "us-equity",
    "crypto",
    "commodity-fx",
    "china-equity",
  ]);
  const overnight = (today.tickers ?? [])
    .filter((t) => overnightGroups.has(t.group))
    .map((t) => ({
      symbol: t.symbol,
      displayName: t.displayName,
      group: t.group,
      pct1Day: t.pct1Day,
    }))
    .sort((a, b) => Math.abs(b.pct1Day) - Math.abs(a.pct1Day))
    .slice(0, 6);

  return {
    generated_at: new Date().toISOString(),
    base_edition: `${base.date}/${base.hour}`,
    sentimentDelta:
      baseSent?.score != null && today.sentimentScore != null
        ? today.sentimentScore - baseSent.score
        : null,
    baseSentiment: baseSent?.score ?? null,
    overnight,
    newKeywords: newKeywords.slice(0, 6),
    premarketTips: today.premarketTips,
    lhbRows: today.lhbRows ?? [],
    flowLine: today.flowLine,
    newEvents: newEvents.slice(0, 5),
    note:
      REPORT_LOCALE === "en"
        ? "Overnight digest vs previous edition — arithmetic only, zero AI. Not investment advice."
        : `对比 ${base.date}/${base.hour} 档的隔夜速览——纯算术、零 AI。不构成投资建议。`,
  };
}

/**
 * Teaching-grade replay: the most recent PRE-today sentiment score vs
 * today's index moves (same report's quant.market). Pure arithmetic over
 * already-published data — explicitly not investment advice.
 */
function buildSentimentReview(
  trend: SentimentTrendPoint[],
  indices: Array<{ name: string; changePct: number }> | undefined,
  today: string,
): {
  yesterdayDate: string;
  yesterdayHour: string;
  yesterdayScore: number;
  avgChangePct: number | null;
  verdict: string;
  samples: number;
  accumulated: number;
} | null {
  const prev = trend.filter((t) => t.date < today).pop();
  if (!prev || !indices || indices.length === 0) return null;
  const avgChangePct =
    indices.reduce((acc, i) => acc + i.changePct, 0) / indices.length;
  const s = prev.score;
  let verdict: string;
  if (Math.abs(s) < 18) {
    verdict = avgChangePct >= 0 ? "中性情绪 · 市场走平偏强" : "中性情绪 · 市场走弱";
  } else if (s <= -18 && avgChangePct > 0) {
    verdict = "偏空情绪 + 市场高开 → 反转观察样本";
  } else if (s <= -18) {
    verdict = "偏空情绪 + 市场走弱 → 顺势样本";
  } else if (avgChangePct > 0) {
    verdict = "偏多情绪 + 市场走强 → 顺势样本";
  } else {
    verdict = "偏多情绪 + 市场走弱 → 落空观察样本";
  }
  return {
    yesterdayDate: prev.date,
    yesterdayHour: prev.hour,
    yesterdayScore: prev.score,
    avgChangePct,
    verdict,
    samples: Math.max(0, trend.filter((t) => t.date < today).length - 1),
    accumulated: REVIEW_SAMPLE_FLOOR,
  };
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
  // A backfill builds a PAST date folder with articles fetched right now.
  // Flag it so the page says so instead of implying the archive always held it.
  const isBackfill = date < naturalTodayKey();
  if (process.env.EDITION_DATE?.trim()) {
    console.log(
      `[daily] EDITION_DATE=${date} override in effect` +
        (isBackfill ? ` — backfilling ${date}/${hour} (not today's edition)` : ""),
    );
  }
  console.log(`[daily] ${date} edition ${hour} — fetching sources…\n`);
  stage("sources");
  const { articles, health } = await fetchAll();
  console.log(`\n[daily] total articles: ${articles.length}`);
  logFetchHealth(health);
  if (articles.length === 0) {
    throw new Error("no articles fetched — aborting");
  }

  // Classify once, immediately after fetch. Both the enrichment step and the
  // write site need lane/topic, and computing them twice would risk the two
  // disagreeing; `classifyAll` is pure and never throws, so this cannot fail
  // the run.
  const tagged = withTopics(articles, sources);

  if (!llmOff) {
    // Enrich GH Trending, papers, and the routed news selection.
    stage("enrichment");
    await enrichGhTrending(articles);
    await enrichTrendingPapers(articles);
    await enrichRoutedSelection(articles, tagged);
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
  const isMorning = editionKind(hour) === "morning";
  const sentimentTrend = loadSentimentTrend();
  const sentimentHistory = sentimentTrend.map((t) => t.score);
  report.sentiment = scoreSentiment(articles, sentimentHistory);
  // Editorial lead: editor-pinned headline, refused unless today's own
  // sources ground it (lib/editorial/lead.ts). Zero fabrication.
  try {
    const lead = loadLeadConfig("data/lead.json", (f) => fs.readFileSync(f, "utf8"));
    if (lead) {
      const applied = applyLead(articles, lead, date, hour);
      if (applied) {
        report.editorial_lead = applied;
        report.hero_headline = applied.title;
        console.log(`[daily] editorial lead applied: ${applied.title} (grounded by: ${applied.groundedBy.slice(0, 40)})`);
      } else {
        console.log(`[daily] editorial lead skipped — not grounded in today's sources`);
      }
    }
  } catch (e) {
    console.warn(`[daily] editorial lead failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
  // Theme article hits — pure catalog matching over all article titles
  // (zero network; board heat merges in bake-themes at publish time).
  report.themes = THEME_CATALOG
    .map((th) => ({
      key: th.key,
      name: th.name,
      articleHits: themeArticleHits(
        articles.map((a) => a.title),
        th,
      ).hits,
    }))
    .filter((x) => x.articleHits > 0)
    .sort((a, b) => b.articleHits - a.articleHits)
    .slice(0, 12);
  if (report.themes.length) {
    console.log(
      `[daily] themes: ${report.themes.slice(0, 4).map((t) => t.name + "×" + t.articleHits).join(", ")}`,
    );
  }
  console.log(
    `[daily] sentiment: ${report.sentiment.label} (${report.sentiment.score}, +${report.sentiment.posHits}/−${report.sentiment.negHits} over ${report.sentiment.scanned} finance items` +
      (report.sentiment.percentile !== null
        ? `, percentile ${report.sentiment.percentile}`
        : `, history ${sentimentHistory.length}/${MIN_HISTORY_SAMPLES}`) +
      `)`,
  );
  report.fetch_health = health;
  if (isBackfill) report.backfilled = true;
  if (isMorning) {
    try {
      const base = loadYesterdayEdition(date);
      if (base) {
        report.morning_brief = buildMorningBrief(
          base,
          {
            sentimentScore: report.sentiment?.score ?? null,
            keywords: report.keywords,
            eventUrls: new Set((quant?.events ?? []).map((e) => e.url)),
            events: (quant?.events ?? []).map((e) => ({
              symbol: e.symbol,
              displayName: e.displayName,
              title: e.title,
              url: e.url,
            })),
            tickers: trading?.tickers,
            premarketTips: loadPremarketTips(date),
            lhbRows: loadLhb(),
            flowLine: quant?.fundFlows?.sectors?.length
              ? `主力净流入前三：${quant.fundFlows.sectors
                  .slice()
                  .sort((a, b) => b.netInflowYi - a.netInflowYi)
                  .slice(0, 3)
                  .map((x) => `${x.name} ${x.netInflowYi >= 0 ? "+" : ""}${x.netInflowYi.toFixed(1)}亿`)
                  .join("、")}`
              : null,
          },
          report.keywords,
        );
        console.log(
          `[daily] morning brief: Δsentiment=${report.morning_brief.sentimentDelta ?? "—"} overnight=${report.morning_brief.overnight.length} newKw=${report.morning_brief.newKeywords.length} newEvents=${report.morning_brief.newEvents.length}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[daily] morning brief failed (non-fatal): ${msg}`);
    }
  }
  console.log(`[daily] digest ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  stage("write");
  const dateDir = path.join(OUTPUT_DIR, date);
  fs.mkdirSync(dateDir, { recursive: true });
  const base = path.join(dateDir, hour);
  // Tag once, then use the *same* tagged list for both the sidecar and the
  // render. Increment 2 routes on these values, so persisting one classification
  // and rendering another would be a silent drift between what a reader sees and
  // what `npm run render` would reproduce from the cache.
  const raw = groupRaw(tagged, sources);
  logRoutingHealth(raw);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(
    `${base}-articles.json`,
    JSON.stringify({ date, hour, articles: tagged }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    `${base}.html`,
    renderHtml(report, raw, date, {
      editionHour: hour,
      siblingHours,
      backfilled: isBackfill,
      sentimentContext: {
        trendScores: sentimentHistory.slice(-20),
        trendAccumulated: sentimentHistory.length,
        trendNeeded: MIN_HISTORY_SAMPLES,
        review: buildSentimentReview(
          sentimentTrend,
          quant?.market?.indices,
          date,
        ),
      },
    }),
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
