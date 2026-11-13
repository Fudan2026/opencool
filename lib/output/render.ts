import type {
  ArticleInput,
  BriefItem,
  DailyReport,
  MorningBrief,
  TradingSection,
} from "../ai/pipeline";
import type { WatchlistPick } from "../ai/trading-commentary";
import { REPORT_LOCALE } from "../sources/registry";
import { getReportTz, editionKind } from "../utils";
import type { Category, SourceDef } from "../sources/types";
import { V2EX_OFF_TOPIC_RE } from "../sources/v2ex";
import { isEntertainmentTitle } from "../sources/title-filters";
import type { TickerAnalysis } from "../trading/signals";
import {
  getAssetGroupLabels,
  ASSET_GROUP_ORDER,
} from "../trading/watchlist";
import { guideBullets, isLikelyEnglishTitle } from "../invest/guide";
import {
  routeEdition,
  MIN_SECTION_ITEMS,
  type RoutedEdition,
  type RoutedLane,
  type RoutedSection,
} from "../topics/routing";
import { laneLabel, topicLabel, type LaneKey, type TopicKey } from "../topics/taxonomy";
import {
  renderReviewPanel,
  renderTechReadPanel,
  renderPersonasPanel,
  renderRiskPanel,
  renderSchoolPanel,
  renderKnowledgePanel,
  renderMcpHelpPanel,
  renderSentimentPanel,
  sparklineForTicker,
} from "./quant-panels";

// ----- i18n -----

/**
 * Localized UI strings. `t` resolves to TEXTS_ZH or TEXTS_EN at module
 * init based on REPORT_LOCALE. All hardcoded display text routes through
 * this object so adding a third locale = adding one more table.
 */
const TEXTS_ZH = {
  siteTitle: "OpenCool",
  siteTagline: "中文财经三报 · 散户投研 · 零 AI",
  editionMorning: "早报",
  editionNoon: "午报",
  editionEvening: "晚报",
  editionGeneric: "简报",
  backfillBadge: "补发",
  catTech: "技术动态",
  catFinance: "中文财经",
  catPolitics: "时政观察",
  catTrading: "行情·A股/基金",
  catCommunity: "社区讨论",
  catReview: "今日复盘",
  catTechRead: "技术面读线",
  catPersonas: "大师视角",
  catRisk: "风控纪律",
  catSchool: "散户学堂",
  catKnowledge: "知识库",
  catMcp: "开放 MCP",
  catSentiment: "市场情绪计",
  leadBadge: "编辑定调",
  morningTitle: "晨会速览",
  morningSentiment: "情绪",
  morningOvernight: "隔夜",
  morningNewKw: "新词",
  morningNewEvents: "新事件",
  morningTips: "盘前要闻",
  morningFlow: "资金动向",
  morningLhb: "龙虎榜",
  guideToggleOff: "原文",
  readQuick: "快读",
  readDeep: "投研",
  guideToggleOn: "中文导读",
  guideWireNote: "外电原文 · 无机器翻译",
  guidePoints: "导读要点",
  subAiNews: "AI 媒体",
  subTrendingPapers: "热门论文",
  subXViral: "X 市场声音",
  subBlogWeekly: "博客周刊",
  subCnCommunity: "中文社区",
  subOverseasCommunity: "海外社区",
  subFinanceNews: "中文财经",
  subCnFinance: "中文财经",
  subWire: "外电原文",
  subXMirror: "X 市场声音（站内镜像，免翻墙）",
  subFinanceCommunity: "社区讨论",
  subWorld: "国际要闻",
  subSocialHot: "财经热榜",
  subOverseasNews: "海外科技",
  subOverseas: "海外",
  emptySource: "该源今日无内容。",
  emptyCategory: "该分类今日无内容。",
  emptyGroup: "该组今日无数据。",
  footer: "内容均来自原媒体，本站仅作整理与回链。热榜≠事实核查 · 启发式摘要 · 零 AI / 零 API Token。",
  summaryLabelNews: "摘要",
  summaryLabelIntro: "介绍",
  tradingMarketOverview: "市场总览",
  tradingTodayFocus: "今日关注",
  tradingAllAssets: "全部资产",
  tradingRiskCaveat: "风险提示",
  widgetCryptoFearGreed: "加密恐慌贪婪",
  widgetCryptoCap: "加密总市值",
  widgetBtcDom: "BTC 主导率",
  widgetVolume24h: "24h 成交量",
  widgetActiveCoins: "活跃币",
  ticker5d: "5 日",
  tickerVs52wHigh: "距 52w 高",
  tickerTrend: "趋势",
  tickerMacd: "MACD / 信号",
  signalToday: "今天",
  signalDaysAgoSuffix: "天前",
  trendBullish: "多头",
  trendBearish: "空头",
  trendNeutral: "中性",
  mdTodayOverview: "今日总览",
  mdEditorNote: "编辑短评",
  mdTodayKeywords: "今日关键词",
  mdImportance: "重要度",
  archiveLink: "历史归档",
  heroOverview: "本期速览",
  // Topic-routed news block (IA increment 2). Lane labels name the *language*
  // of the copy, not the venue of the story — see lib/topics/taxonomy.ts.
  laneZh: "中文财经",
  laneExternal: "外电原文",
  topicGlobalMarkets: "全球市场",
  topicWorld: "国际时政",
  topicTechAi: "科技AI",
  topicPolicy: "政策政务",
  topicFilings: "公司公告",
  topicOpinion: "观点解读",
  viewByTopic: "按话题",
  viewBySource: "按来源",
  laneEmpty: "今日该栏目无内容。",
};

const TEXTS_EN: typeof TEXTS_ZH = {
  siteTitle: "OpenCool",
  siteTagline: "CN finance triple brief · retail quant · zero AI",
  editionMorning: "Morning",
  editionNoon: "Noon",
  editionEvening: "Evening",
  editionGeneric: "Brief",
  backfillBadge: "Backfill",
  catTech: "Tech",
  catFinance: "CN Finance",
  catPolitics: "World",
  catTrading: "Markets · A-share/ETF",
  catCommunity: "Community",
  catReview: "Daily Review",
  catTechRead: "Technical Read",
  catPersonas: "Master Lenses",
  catRisk: "Risk Discipline",
  catSchool: "Retail School",
  catKnowledge: "Knowledge",
  catMcp: "Open MCP",
  catSentiment: "Sentiment",
  leadBadge: "Editor's pick",
  morningTitle: "Morning brief",
  morningSentiment: "sentiment",
  morningOvernight: "overnight",
  morningNewKw: "new terms",
  morningNewEvents: "new events",
  morningTips: "Pre-market tips",
  morningFlow: "Flows",
  morningLhb: "Dragon-Tiger",
  guideToggleOff: "Original",
  readQuick: "Quick read",
  readDeep: "Deep dive",
  guideToggleOn: "CN guide",
  guideWireNote: "EN original · no machine translation",
  guidePoints: "Guide points",
  subAiNews: "AI Media",
  subTrendingPapers: "Trending Papers",
  subXViral: "X Markets Mirror",
  subBlogWeekly: "Blog Weekly",
  subCnCommunity: "Chinese Community",
  subOverseasCommunity: "Overseas Community",
  subFinanceNews: "CN Finance",
  subCnFinance: "CN Finance",
  subWire: "Wire (EN originals)",
  subXMirror: "X markets (on-site mirror)",
  subFinanceCommunity: "Community",
  subWorld: "World News",
  subSocialHot: "Finance Hot",
  subOverseasNews: "Overseas Tech",
  subOverseas: "Overseas",
  emptySource: "No content from this source today.",
  emptyCategory: "No content in this category today.",
  emptyGroup: "No data for this group today.",
  footer:
    "Sourced from original publishers. Hot ranks ≠ verified facts. Heuristic digest · zero AI / zero API tokens.",
  summaryLabelNews: "Summary",
  summaryLabelIntro: "Summary",
  tradingMarketOverview: "Market Overview",
  tradingTodayFocus: "Today's Focus",
  tradingAllAssets: "All Assets",
  tradingRiskCaveat: "Risk Disclaimer",
  widgetCryptoFearGreed: "Crypto Fear/Greed",
  widgetCryptoCap: "Crypto Market Cap",
  widgetBtcDom: "BTC Dominance",
  widgetVolume24h: "24h Volume",
  widgetActiveCoins: "Active coins",
  ticker5d: "5d",
  tickerVs52wHigh: "vs 52w High",
  tickerTrend: "Trend",
  tickerMacd: "MACD / Signal",
  signalToday: "today",
  signalDaysAgoSuffix: "d ago",
  trendBullish: "Bullish",
  trendBearish: "Bearish",
  trendNeutral: "Neutral",
  mdTodayOverview: "Today's Overview",
  mdEditorNote: "Editor's Note",
  mdTodayKeywords: "Keywords",
  mdImportance: "Importance",
  archiveLink: "Archive",
  heroOverview: "This edition",
  laneZh: "Chinese-Language",
  laneExternal: "External Wire",
  topicGlobalMarkets: "Global Markets",
  topicWorld: "World",
  topicTechAi: "Tech & AI",
  topicPolicy: "Policy",
  topicFilings: "Filings",
  topicOpinion: "Analysis",
  viewByTopic: "By topic",
  viewBySource: "By source",
  laneEmpty: "Nothing in this lane today.",
};

const STR = REPORT_LOCALE === "en" ? TEXTS_EN : TEXTS_ZH;
const ASSET_GROUP_LABELS_LOCALIZED = getAssetGroupLabels(REPORT_LOCALE);

// ----- types -----

export type SourceGroup = {
  sourceId: string;
  sourceName: string;
  items: ArticleInput[];
  /**
   * When true, items come from multiple merged sources and the renderer
   * should label each article with `a.source` since the source-tab row
   * is suppressed (only one synthetic group).
   */
  merged?: boolean;
};

export type SubGroup = {
  id: string;
  name: string;
  sources: SourceGroup[];
};

export type RawByCategory = Record<Category, SubGroup[]>;

/**
 * One topic section as rendered: the items selected by the router plus the
 * label and the pool size that produced them.
 *
 * `available` is carried into the markup as `data-available` so the density
 * evidence in the PR body and the golden guard can read composition straight
 * off the page instead of re-deriving it from the sidecar.
 */
export interface TopicSectionView {
  topic: TopicKey;
  label: string;
  items: ArticleInput[];
  available: number;
}

/**
 * One lane as rendered. `sections` is the shipped view (topic-routed);
 * `bySource` is the secondary 按来源 view that keeps the old subcategory/source
 * browsing available so routing never *removes* a way to reach an article.
 */
export interface LaneView {
  lane: LaneKey;
  label: string;
  count: number;
  sections: TopicSectionView[];
  bySource: SubGroup[];
  /** Topics with candidates that could not field a balanced section. */
  omitted: Array<{ topic: TopicKey; available: number }>;
}

export type RawNews = {
  /** The shipped news block: two language lanes, each topic-routed. */
  lanes: LaneView[];
  /**
   * The pre-routing category → subcategory → source grouping, kept for the
   * tech/community panels (which are not news topics) and as the source of the
   * 按来源 view. Nothing here is capped by topic.
   */
  legacy: RawByCategory;
};

// ----- labels & ordering -----

const CATEGORY_LABELS: Record<Category, string> = {
  tech: STR.catTech,
  finance: STR.catFinance,
  politics: STR.catPolitics,
};

const CATEGORY_DIGEST_LABELS: Record<Category, string> = {
  tech: STR.catTech,
  finance: STR.catFinance,
  politics: STR.catPolitics,
};

/**
 * L2 ordering per category. Categories not listed render flat (no L2 tabs).
 */
const SUBCATEGORY_ORDER: Partial<Record<Category, string[]>> = {
  // cn-community + overseas-community are listed last so the L1 "community"
  // panel (rendered separately via TECH_COMMUNITY_SUBS) can extract them.
  // Within the "tech" L1 panel itself, COMMUNITY_SUBS is filtered out.
  // Locale filtering at registry level decides which actually appears:
  // zh mode keeps cn-community (V2EX / LinuxDo); en mode keeps
  // overseas-community (Hacker News / r/stocks).
  tech: ["github-trending", "trending-papers", "x-viral", "ai-news", "cn-community", "overseas-community"],
  // CN-first: Chinese finance feed → on-site X mirror → English wires
  finance: ["cn-news", "x-mirror", "wire"],
  politics: ["world", "hot"],
};

const TECH_MAIN_SUBS = new Set(["github-trending", "trending-papers", "x-viral", "ai-news"]);
const TECH_COMMUNITY_SUBS = new Set(["cn-community", "overseas-community"]);

const SUBCATEGORY_LABELS: Record<string, string> = {
  "github-trending": "GitHub Trending",
  "trending-papers": STR.subTrendingPapers,
  "cn-community": STR.subCnCommunity,
  "overseas-community": STR.subOverseasCommunity,
  "ai-news": STR.subAiNews,
  "x-viral": STR.subXViral,
  "blog-weekly": STR.subBlogWeekly,
  news: STR.subFinanceNews,
  "cn-news": STR.subCnFinance,
  wire: STR.subWire,
  "x-mirror": STR.subXMirror,
  world: STR.subWorld,
  hot: STR.subSocialHot,
};

/**
 * Per-source item caps in the raw display, keyed by "category:subcategory".
 * Each source inside the subcategory shows up to N items. Missing keys = no cap.
 *
 * Default 20 across all L3-tabbed subcategories keeps each tab a single
 * comfortable scroll instead of 25-30 items. Merged subgroups (blog-weekly,
 * finance:news, politics:world) ignore this — they use MERGED_SUBGROUP_LIMITS.
 */
const SOURCE_DISPLAY_LIMITS: Record<string, number> = {
  "tech:github-trending": 20,
  "tech:cn-community": 10,
  "tech:x-viral": 20,
  "tech:trending-papers": 20,
  "finance:x-mirror": 30,
  "politics:hot": 15,
};

/**
 * Sources whose fetcher returns items already sorted by an engagement/heat
 * algorithm we want to preserve. groupRaw skips its default date-desc sort
 * for these so the final render reflects the source's own ranking.
 */
const PRESERVE_FETCH_ORDER_SOURCES = new Set([
  "attentionvc-ai",
  "huggingface-papers",
  "douyin-hot",
  "weibo-hot",
  "zhihu-hot",
  "baidu-hot",
]);

function displayLimitFor(
  category: Category,
  subId: string | undefined,
): number | undefined {
  if (!subId) return undefined;
  return SOURCE_DISPLAY_LIMITS[`${category}:${subId}`];
}

/**
 * Subcategories that should collapse their sources into a single flat
 * time-sorted list (no L3 source tabs), keyed by "category:subcategory".
 * Value = number of items kept after merging. Each rendered article
 * will display its `source` label inline since the per-source tab row
 * is suppressed.
 *
 * Used when:
 *  - sources are heterogeneous but each publishes few items (blog-weekly)
 *  - the user explicitly wants a curated time-sorted feed rather than
 *    per-source browsing (finance:news, only authoritative sources)
 *
 * Exported so daily.ts can read the cap to keep enrichment in sync.
 */
export const MERGED_SUBGROUP_LIMITS: Record<string, number> = {
  "tech:ai-news": 15,
  "finance:news": 18,
  "finance:cn-news": 24,
  "finance:wire": 14,
  "politics:world": 15,
};

/**
 * Politics sources (especially Al Jazeera / BBC / The Diplomat) regularly
 * mix in World Cup / Olympic / football coverage. Filter at the title level
 * so the merged "国际要闻" stream stays politics-only.
 *
 * Pattern is intentionally specific — avoid generic words like "team" or
 * "match" that overlap with diplomacy headlines.
 */
const POLITICS_SPORTS_RE =
  /\b(World\s*Cup|Olympics?|UEFA|FIFA|NBA|NFL|NHL|MLB|ATP|WTA|Premier\s*League|Bundesliga|La\s*Liga|Serie\s*A|Champions\s*League|Eurovision|Wimbledon|Grand\s*Slam|F1|Formula\s*1|Ronaldo|Messi|Mbappe|Beckham|Lukaku|Mitoma|sportsman|footballer|squad)\b|世界杯|奥运|残奥|冬奥|欧冠|英超|西甲|意甲|德甲|网球|足球|篮球|高尔夫|棒球|板球|橄榄球/i;

export function isSportsArticle(title: string): boolean {
  return POLITICS_SPORTS_RE.test(title);
}

function mergedLimitFor(
  category: Category,
  subId: string,
): number | undefined {
  return MERGED_SUBGROUP_LIMITS[`${category}:${subId}`];
}

// ----- grouping -----

/**
 * Legacy grouping: category → subcategory → source, capped by the
 * `SOURCE_DISPLAY_LIMITS` / `MERGED_SUBGROUP_LIMITS` tables.
 *
 * Still the source of the secondary 按来源 view (and of the tech/community
 * panels), so a reader who wants to browse one wire's raw output keeps that
 * path. The shipped default view is topic-routed — see `groupRaw`.
 */
export function groupBySource(
  articles: ArticleInput[],
  registry: SourceDef[],
): RawByCategory {
  const subcatOf = new Map<string, string | undefined>();
  for (const s of registry) subcatOf.set(s.id, s.subcategory);
  // Drop articles from sources that have since been disabled — important
  // when scripts/render.ts re-renders against a stale sidecar that still
  // contains the disabled sources' fetched data.
  const enabledIds = new Set(
    registry.filter((s) => s.enabled !== false).map((s) => s.id),
  );

  type Bucket = { sourceName: string; items: ArticleInput[] };
  const buckets: Record<Category, Map<string, Bucket>> = {
    tech: new Map(),
    finance: new Map(),
    politics: new Map(),
  };
  // Pre-seed empty buckets for every enabled source so per-source-tabbed
  // subcategories (e.g. cn-community) still render a tab for sources that
  // returned 0 items today. Without this, a transient LinuxDo Cloudflare
  // block would silently collapse the L3 tab nav, making users wonder
  // whether the other forum even exists.
  for (const s of registry) {
    if (s.enabled === false) continue;
    if (!buckets[s.category].has(s.id)) {
      buckets[s.category].set(s.id, { sourceName: s.name, items: [] });
    }
  }

  for (const a of articles) {
    if (!enabledIds.has(a.sourceId)) continue;
    if (a.category === "politics" && isSportsArticle(a.title)) continue;
    if (isEntertainmentTitle(a.title)) continue;
    if (
      (a.sourceId === "v2ex-hot" || a.sourceId === "linuxdo") &&
      V2EX_OFF_TOPIC_RE.test(a.title)
    )
      continue;
    const map = buckets[a.category];
    let b = map.get(a.sourceId);
    if (!b) {
      b = { sourceName: a.source, items: [] };
      map.set(a.sourceId, b);
    }
    b.items.push(a);
  }

  for (const cat of Object.keys(buckets) as Category[]) {
    for (const [id, b] of buckets[cat].entries()) {
      if (PRESERVE_FETCH_ORDER_SOURCES.has(id)) continue;
      b.items.sort(
        (a, b) =>
          (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
      );
    }
  }

  function toSourceGroup(
    sourceId: string,
    b: Bucket,
    limit: number | undefined,
  ): SourceGroup {
    return {
      sourceId,
      sourceName: b.sourceName,
      items: limit ? b.items.slice(0, limit) : b.items,
    };
  }

  function sortByRegistry(list: SourceGroup[]): SourceGroup[] {
    return [...list].sort((a, b) => {
      const ia = registry.findIndex((s) => s.id === a.sourceId);
      const ib = registry.findIndex((s) => s.id === b.sourceId);
      return ia - ib;
    });
  }

  const out: RawByCategory = { tech: [], finance: [], politics: [] };

  for (const cat of Object.keys(buckets) as Category[]) {
    const order = SUBCATEGORY_ORDER[cat];
    if (!order) {
      // Flat: one synthetic subgroup with every source.
      const sources: SourceGroup[] = [];
      for (const [id, b] of buckets[cat].entries()) {
        sources.push(toSourceGroup(id, b, undefined));
      }
      out[cat] = sources.length
        ? [{ id: "all", name: CATEGORY_LABELS[cat], sources: sortByRegistry(sources) }]
        : [];
      continue;
    }
    // Subcategory split: bucket each source under its registered subcategory.
    const subs: SubGroup[] = [];
    for (const subId of order) {
      const mergeLimit = mergedLimitFor(cat, subId);
      if (mergeLimit !== undefined) {
        // Merge: flatten all sources under this subcategory into a single
        // time-sorted SourceGroup. Articles keep their `source` field so
        // the renderer can label them.
        const flat: ArticleInput[] = [];
        for (const [id, b] of buckets[cat].entries()) {
          if (subcatOf.get(id) === subId) flat.push(...b.items);
        }
        if (flat.length === 0) continue;
        flat.sort(
          (a, b) =>
            (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
        );
        subs.push({
          id: subId,
          name: SUBCATEGORY_LABELS[subId] ?? subId,
          sources: [
            {
              sourceId: "_merged",
              sourceName: SUBCATEGORY_LABELS[subId] ?? subId,
              items: flat.slice(0, mergeLimit),
              merged: true,
            },
          ],
        });
        continue;
      }

      const limit = displayLimitFor(cat, subId);
      const sources: SourceGroup[] = [];
      for (const [id, b] of buckets[cat].entries()) {
        if (subcatOf.get(id) === subId) sources.push(toSourceGroup(id, b, limit));
      }
      if (sources.length === 0) continue;
      subs.push({
        id: subId,
        name: SUBCATEGORY_LABELS[subId] ?? subId,
        sources: sortByRegistry(sources),
      });
    }
    out[cat] = subs;
  }

  return out;
}

// ----- topic routing (IA increment 2) -----

/**
 * Topic labels resolved from `TEXTS_ZH` / `TEXTS_EN`.
 *
 * `lib/topics/taxonomy.ts` owns the bilingual table too, and that copy is what
 * `topicLabel()` returns. This map exists so the *rendered* label comes from the
 * same `STR` object as every other string on the page — the repo's i18n rule is
 * that all display text goes through the pairs, and a taxonomy module that
 * bypassed it would be the one place a translator forgot to look.
 */
const TOPIC_LABELS: Record<TopicKey, string> = {
  "global-markets": STR.topicGlobalMarkets,
  world: STR.topicWorld,
  "tech-ai": STR.topicTechAi,
  policy: STR.topicPolicy,
  filings: STR.topicFilings,
  opinion: STR.topicOpinion,
};

const LANE_LABELS: Record<LaneKey, string> = {
  zh: STR.laneZh,
  external: STR.laneExternal,
};

function topicLabelLocalized(topic: TopicKey): string {
  return TOPIC_LABELS[topic] ?? topicLabel(topic, REPORT_LOCALE);
}

function laneLabelLocalized(lane: LaneKey): string {
  return LANE_LABELS[lane] ?? laneLabel(lane, REPORT_LOCALE);
}

/**
 * Build the shipped news block: two language lanes, each routed into topic
 * sections with density caps and cross-source dedupe.
 *
 * The editorial filters that used to live only in the merged-list path
 * (sports, entertainment, V2EX off-topic) now run *before* routing so a
 * filtered article cannot consume a section slot. That ordering matters: the
 * audit found a weather forecast and a cricket press conference occupying
 * finance/politics slots, and a cap applied before the filter would have kept
 * them while dropping real news.
 *
 * Non-fatal by construction — `routeEdition` is pure and catches per-article
 * failures inside the classifier, so a single malformed article degrades to a
 * source-tier topic instead of taking the block down.
 */
export function groupRaw(
  articles: ArticleInput[],
  registry: SourceDef[],
): RawNews {
  const enabledIds = new Set(
    registry.filter((s) => s.enabled !== false).map((s) => s.id),
  );
  const subcategories: Record<string, string | undefined> = {};
  for (const s of registry) subcategories[s.id] = s.subcategory;

  const eligible = articles.filter((a) => {
    if (!enabledIds.has(a.sourceId)) return false;
    if (a.category === "politics" && isSportsArticle(a.title)) return false;
    if (isEntertainmentTitle(a.title)) return false;
    if (
      (a.sourceId === "v2ex-hot" || a.sourceId === "linuxdo") &&
      V2EX_OFF_TOPIC_RE.test(a.title)
    ) {
      return false;
    }
    return true;
  });

  const routed = routeEdition(eligible, subcategories);
  const bySource = groupBySource(eligible, registry);
  const registryById = new Map(registry.map((s) => [s.id, s] as const));

  const lanes: LaneView[] = [];
  for (const lane of routed.lanes) {
    lanes.push({
      lane: lane.lane,
      label: laneLabelLocalized(lane.lane),
      count: lane.sections.reduce((n, s) => n + s.items.length, 0),
      sections: lane.sections.map((s) => ({
        topic: s.topic,
        label: topicLabelLocalized(s.topic),
        items: s.items,
        available: s.available,
      })),
      bySource: laneViewBySource(lane, registryById),
      omitted: lane.omitted.map((o) => ({ topic: o.topic, available: o.available })),
    });
  }
  return { lanes, legacy: bySource };
}

/**
 * Per-source cap inside the 按来源 view.
 *
 * The view exists to *recover reach* for items the topic caps left out, not to
 * re-publish the whole fetch. Without a bound it emitted ~500 compact rows and
 * nearly doubled the page (52 KB → 88 KB gzipped); at 12 the page grows by
 * roughly a third while every source's newest dozen items stay one click away —
 * which is more than the legacy panels ever showed per source.
 */
const LANE_SOURCE_VIEW_LIMIT = 12;

/**
 * The 按来源 view for one lane: each contributing source's newest items.
 *
 * Built from the lane's own pool rather than by filtering the legacy
 * category/subcategory grouping, because that grouping is capped
 * (`MERGED_SUBGROUP_LIMITS`) and would therefore hide exactly the items the
 * topic caps left out — the one thing this view exists to recover. The only
 * articles genuinely absent are the duplicates `dedupeStories` suppressed,
 * which are by definition the same story as a survivor.
 *
 * Grouping key is the registry's `category:subcategory` when the source is
 * known, so the tab labels stay familiar (中文财经 / 外电原文 / 国际要闻); a
 * source with no registry entry lands in its declared category alone.
 */
function laneViewBySource(
  lane: RoutedLane,
  registryById: ReadonlyMap<string, SourceDef>,
): SubGroup[] {
  const groups = new Map<string, { name: string; order: number; sources: Map<string, ArticleInput[]> }>();
  lane.pool.forEach((item, order) => {
    const def = registryById.get(item.sourceId);
    const key = def ? `${def.category}:${def.subcategory ?? "all"}` : `source:${item.sourceId}`;
    let group = groups.get(key);
    if (!group) {
      const name = def
        ? SUBCATEGORY_LABELS[def.subcategory ?? ""] ?? CATEGORY_LABELS[def.category]
        : item.source || item.sourceId;
      group = { name, order, sources: new Map() };
      groups.set(key, group);
    }
    const arr = group.sources.get(item.sourceId) ?? [];
    arr.push(item);
    group.sources.set(item.sourceId, arr);
  });

  const subs: SubGroup[] = [];
  for (const [id, group] of [...groups.entries()].sort((a, b) => a[1].order - b[1].order)) {
    const sources: SourceGroup[] = [];
    for (const [sourceId, items] of group.sources) {
      sources.push({
        sourceId,
        sourceName: items[0]?.source || sourceId,
        items: [...items]
          .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
          .slice(0, LANE_SOURCE_VIEW_LIMIT),
      });
    }
    if (sources.length === 0) continue;
    subs.push({ id, name: group.name, sources });
  }
  return subs;
}

// ----- HTML helpers -----

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(d: Date | undefined): string {
  if (!d) return "";
  try {
    // zh: "05/20 16:00"  · en: "May 20, 4:00 PM" → keep 24h en-GB style "20/05 16:00"
    const localeTag = REPORT_LOCALE === "en" ? "en-GB" : "zh-CN";
    return d.toLocaleString(localeTag, {
      timeZone: getReportTz(),
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

// ----- raw article renderers -----

function renderArticleHtml(a: ArticleInput, showSource = false): string {
  const title = escapeHtml(a.title);
  const url = escapeHtml(a.url);
  const excerptRaw = (a.excerpt || "").trim();
  const summaryText = a.summary ?? (a as unknown as { cnSummary?: string }).cnSummary;
  const excerptShort = excerptRaw ? escapeHtml(excerptRaw.slice(0, 160)) : "";
  const excerptLong = excerptRaw
    ? escapeHtml(excerptRaw.slice(0, 420))
    : summaryText
      ? escapeHtml(String(summaryText).slice(0, 420))
      : "";
  const summary = summaryText ? escapeHtml(String(summaryText).slice(0, 360)) : "";
  const meta = a.meta ? escapeHtml(a.meta) : "";
  const time = formatDate(a.publishedAt);
  const sourceLabel = showSource && a.source ? escapeHtml(a.source) : "";
  const metaLine = [sourceLabel, time].filter(Boolean).join(" · ");
  const newsy = a.category === "finance" || a.category === "politics";
  const summaryLabel = newsy ? STR.summaryLabelNews : STR.summaryLabelIntro;
  const bullets = guideBullets(a.title, a.excerpt, summaryText);
  const wire = isLikelyEnglishTitle(a.title);
  const guideHtml = `<div class="guide-block" hidden>
    ${wire ? `<p class="guide-wire">${STR.guideWireNote}</p>` : ""}
    ${excerptLong ? `<p class="article-excerpt guide-excerpt">${excerptLong}</p>` : ""}
    ${summary ? `<p class="article-summary"><span class="summary-label">${summaryLabel}</span> ${summary}</p>` : ""}
    ${
      bullets.length
        ? `<ul class="guide-bullets"><li class="guide-label">${STR.guidePoints}</li>${bullets
            .map((b) => `<li>${escapeHtml(b)}</li>`)
            .join("")}</ul>`
        : ""
    }
  </div>`;
  return `<article class="article">
  <h3 class="article-title"><a href="${url}" target="_blank" rel="noopener noreferrer">${title}</a></h3>
  ${meta ? `<p class="article-stats">${meta}</p>` : ""}
  ${metaLine ? `<p class="article-meta">${metaLine}</p>` : ""}
  <div class="orig-block">
    ${excerptShort ? `<p class="article-excerpt">${excerptShort}</p>` : ""}
  </div>
  ${guideHtml}
</article>`;
}

/**
 * Compact row for the secondary 按来源 view: headline, source, time. No excerpt
 * and no guide block — the full text is one click away in the topic view.
 */
function renderCompactArticle(a: ArticleInput, showSource = false): string {
  const metaLine = [
    showSource && a.source ? escapeHtml(a.source) : "",
    formatDate(a.publishedAt),
  ]
    .filter(Boolean)
    .join(" · ");
  return `<article class="article article-compact">
  <h3 class="article-title"><a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.title)}</a></h3>
  ${metaLine ? `<p class="article-meta">${metaLine}</p>` : ""}
</article>`;
}

function renderSourceContent(
  category: string,
  subId: string,
  source: SourceGroup,
  isActive: boolean,
  itemRenderer: (a: ArticleInput, showSource: boolean) => string = renderArticleHtml,
): string {
  const showSource = source.merged === true;
  return `<div class="source-content${isActive ? " active" : ""}" data-source-content="${escapeHtml(source.sourceId)}" data-sub="${escapeHtml(subId)}" data-cat="${category}">
    ${source.items.length === 0 ? `<p class="empty">${STR.emptySource}</p>` : source.items.map((a) => itemRenderer(a, showSource)).join("\n")}
  </div>`;
}

function renderSourceTabs(
  category: string,
  subId: string,
  sources: SourceGroup[],
): string {
  // Single-source L2s (X 推文 / GitHub Trending) skip the L3 row — the L2 tab
  // label already identifies the dataset. L3 only earns its row when there
  // are ≥2 sources to switch between (e.g. 社区讨论 V2EX vs LinuxDo).
  if (sources.length < 2) return "";
  return `<nav class="source-tabs">${sources
    .map(
      (s, i) =>
        `<button class="source-tab${i === 0 ? " active" : ""}" data-source="${escapeHtml(s.sourceId)}" data-sub="${escapeHtml(subId)}" data-cat="${category}">${escapeHtml(s.sourceName)}<span class="count">${s.items.length}</span></button>`,
    )
    .join("")}</nav>`;
}

function renderSubContent(
  category: string,
  sub: SubGroup,
  isActive: boolean,
  itemRenderer?: (a: ArticleInput, showSource: boolean) => string,
): string {
  return `<div class="sub-content${isActive ? " active" : ""}" data-sub-content="${escapeHtml(sub.id)}" data-cat="${category}">
    ${renderSourceTabs(category, sub.id, sub.sources)}
    <div class="source-contents">
      ${sub.sources.map((s, i) => renderSourceContent(category, sub.id, s, i === 0, itemRenderer)).join("\n")}
    </div>
  </div>`;
}

function renderRawCategoryPanel(
  category: Category,
  subs: SubGroup[],
): string {
  if (subs.length === 0) {
    return `<p class="empty">${STR.emptyCategory}</p>`;
  }
  if (subs.length === 1) {
    return renderSubContent(category, subs[0], true);
  }
  const subTabs = subs
    .map((s, i) => {
      const count = s.sources.reduce((n, src) => n + src.items.length, 0);
      return `<button class="sub-tab${i === 0 ? " active" : ""}" data-sub="${escapeHtml(s.id)}" data-cat="${category}">${escapeHtml(s.name)}<span class="count">${count}</span></button>`;
    })
    .join("");
  const panels = subs
    .map((s, i) => renderSubContent(category, s, i === 0))
    .join("\n");
  return `<nav class="sub-tabs">${subTabs}</nav>\n<div class="sub-contents">${panels}</div>`;
}

// ----- topic-routed lane panels (IA increment 2) -----

/**
 * One topic section.
 *
 * A section is a flat list — the source label is shown inline on every item
 * because there is no L3 source tab here (that is the whole point: the reader
 * is browsing a topic, not a wire). `data-available` records how many items the
 * section had before capping, so the density evidence is readable straight off
 * the published page.
 *
 * Empty sections are never passed in: `groupRaw` omits them, which is how the
 * permanent 技术动态 / 财经热榜 empty shells disappear without special-casing.
 */
function renderTopicSection(section: TopicSectionView, lane: LaneKey): string {
  if (section.items.length === 0) return "";
  const items = section.items.map((a) => renderArticleHtml(a, true)).join("\n");
  return `<section class="topic-section" data-topic="${section.topic}" data-lane="${lane}" data-available="${section.available}" data-rendered="${section.items.length}">
  <h3 class="topic-heading">${escapeHtml(section.label)}<span class="count">${section.items.length}</span></h3>
  <div class="topic-items">${items}</div>
</section>`;
}

/**
 * The 按来源 view for one lane, reusing the existing sub/source tabs.
 *
 * Rendered as a sibling of the topic view inside the same panel, hidden by
 * default and toggled by the 按话题 / 按来源 switch. Keeping it in the DOM means
 * the toggle is a class flip, not a re-render, so no JavaScript is required to
 * read the primary view.
 *
 * Items here are compact (headline + source + time, no excerpt) on purpose:
 * this view exists to *locate* something the topic caps left out, and each
 * article also appears in full in the topic view. Rendering both bodies would
 * roughly double the page for no added reach.
 */
function renderLaneBySource(lane: LaneView): string {
  if (lane.bySource.length === 0) return "";
  const subTabs = lane.bySource
    .map((s, i) => {
      const count = s.sources.reduce((n, src) => n + src.items.length, 0);
      return `<button class="sub-tab${i === 0 ? " active" : ""}" data-sub="${escapeHtml(s.id)}" data-cat="${lane.lane}">${escapeHtml(s.name)}<span class="count">${count}</span></button>`;
    })
    .join("");
  const panels = lane.bySource
    .map((s, i) => renderSubContent(lane.lane, s, i === 0, renderCompactArticle))
    .join("\n");
  return `<div class="lane-by-source">
    <nav class="sub-tabs">${subTabs}</nav>
    <div class="sub-contents">${panels}</div>
  </div>`;
}

/**
 * One lane panel: the topic sections in locked order, plus the source view.
 *
 * When the lane has no sections at all the panel still says so in words rather
 * than rendering an empty shell with a heading — "该栏目今日无内容" is honest,
 * an empty section is not.
 */
function renderLanePanel(lane: LaneView): string {
  const sections = lane.sections
    .map((s) => renderTopicSection(s, lane.lane))
    .filter(Boolean)
    .join("\n");
  const bySource = renderLaneBySource(lane);
  const body = sections || `<p class="empty">${STR.laneEmpty}</p>`;
  return `<div class="lane-views">
    <nav class="view-tabs" role="group" aria-label="view mode">
      <button type="button" class="view-btn active" data-view="topic">${STR.viewByTopic}</button>
      ${bySource ? `<button type="button" class="view-btn" data-view="source">${STR.viewBySource}</button>` : ""}
    </nav>
    <div class="lane-view lane-view-topic active">${body}</div>
    ${bySource ? `<div class="lane-view lane-view-source">${bySource}</div>` : ""}
  </div>`;
}

// ----- top-level renderer -----

export interface SentimentReviewContext {
  yesterdayDate: string;
  yesterdayHour: string;
  yesterdayScore: number;
  avgChangePct: number | null;
  verdict: string;
  samples: number;
  accumulated: number;
}

export interface SentimentPanelContext {
  /** Chronological recent scores (newest last), for the sparkline. */
  trendScores: number[];
  /** How many history samples exist / are needed for percentile+review. */
  trendAccumulated: number;
  trendNeeded: number;
  /** Yesterday-sentiment vs today-market replay row (null while thin). */
  review?: SentimentReviewContext | null;
}

export type RenderHtmlOptions = {
  editionHour?: string;
  siblingHours?: string[];
  sentimentContext?: SentimentPanelContext;
  /**
   * This edition is a catch-up build for a past date: the articles in it were
   * fetched NOW, not on that date. Marking it keeps the archive honest.
   */
  backfilled?: boolean;
};

function editionLabelFor(hour?: string): string {
  if (!hour) return STR.editionGeneric;
  const kind = editionKind(hour);
  if (kind === "morning") return STR.editionMorning;
  if (kind === "noon") return STR.editionNoon;
  if (kind === "evening") return STR.editionEvening;
  return STR.editionGeneric;
}

export function renderHtml(
  report: DailyReport,
  raw: RawNews,
  date: string,
  opts: RenderHtmlOptions = {},
): string {
  const trading = report.trading;
  const quant = report.quant;
  const sentiment = report.sentiment;
  const sentimentContext = opts.sentimentContext;
  const editionHour = opts.editionHour;
  const editionLabel = editionLabelFor(editionHour);
  const siblingHours = (opts.siblingHours ?? []).filter(Boolean);

  const lanes = raw.lanes;
  const techMainSubs = raw.legacy.tech.filter((s) => TECH_MAIN_SUBS.has(s.id));
  const techCommunitySubs = raw.legacy.tech.filter((s) => TECH_COMMUNITY_SUBS.has(s.id));

  const sumItems = (subs: SubGroup[]) =>
    subs.reduce(
      (n, sg) => n + sg.sources.reduce((m, s) => m + s.items.length, 0),
      0,
    );
  // Only the tech/community panels still count by category; the news lanes
  // carry their own counts so a lane can never disagree with its sections.
  const counts = {
    tech: sumItems(techMainSubs),
    community: sumItems(techCommunitySubs),
  };

  // Lane tabs: the shipped news entry points. A lane with nothing to show keeps
  // its tab only when every lane is empty, so the page never presents an empty
  // tab beside a full one — the same rule topic sections follow one level down.
  const visibleLanes = lanes.filter((l) => l.count > 0);
  const tabbedLanes = visibleLanes.length > 0 ? visibleLanes : lanes.slice(0, 1);
  const laneTabs = tabbedLanes
    .map(
      (l, i) =>
        `<button class="tab${i === 0 ? " active" : ""}" data-tab="${l.lane}">${escapeHtml(l.label)}<span class="count">${l.count}</span></button>`,
    )
    .join("");
  const lanePanels = (visibleLanes.length > 0 ? visibleLanes : tabbedLanes)
    .map(
      (l, i) =>
        `<section class="panel${i === 0 ? " active" : ""}" data-panel="${l.lane}">${renderLanePanel(l)}</section>`,
    )
    .join("\n");

  const tz = getReportTz() || "local";
  const siblingNav =
    siblingHours.length > 0 && editionHour
      ? `<nav class="edition-switch" aria-label="editions">${siblingHours
          .map((h) => {
            const lab = editionLabelFor(h);
            const active = h === editionHour ? " active" : "";
            const href =
              process.env.WEB_MODE === "true"
                ? `./${h}.html`
                : `./${h}.html`;
            return `<a class="ed-chip${active}" href="${href}">${lab}<span>${h}:00</span></a>`;
          })
          .join("")}</nav>`
      : "";

  function renderMorningBrief(mb?: MorningBrief): string {
    if (!mb) return "";
    const dCls =
      mb.sentimentDelta == null ? "" : mb.sentimentDelta >= 0 ? "positive" : "negative";
    const dTxt =
      mb.sentimentDelta == null
        ? "—"
        : `${mb.sentimentDelta > 0 ? "+" : ""}${mb.sentimentDelta}`;
    const overnight = mb.overnight
      .map(
        (o) =>
          `<span class="mb-chip ${o.pct1Day >= 0 ? "positive" : "negative"}">${escapeHtml(o.displayName)} ${o.pct1Day >= 0 ? "+" : ""}${o.pct1Day.toFixed(2)}%</span>`,
      )
      .join("");
    const kws = mb.newKeywords
      .map((k) => `<span class="mb-chip">${escapeHtml(k)}</span>`)
      .join("");
    const evs = mb.newEvents
      .map(
        (e) =>
          `<li><span class="mb-ev">${escapeHtml(e.displayName)}</span><a href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.title)}</a></li>`,
      )
      .join("");
    return `<div class="hero-morning">
      <p class="mb-title">${STR.morningTitle} <span class="muted tiny">vs ${escapeHtml(mb.base_edition)}</span></p>
      <p class="mb-row">${STR.morningSentiment} <b class="${dCls}">${dTxt}</b>${mb.baseSentiment != null ? ` <span class="muted tiny">(base ${mb.baseSentiment})</span>` : ""}</p>
      ${overnight ? `<p class="mb-row">${STR.morningOvernight} ${overnight}</p>` : ""}
      ${kws ? `<p class="mb-row">${STR.morningNewKw} ${kws}</p>` : ""}
    ${
      mb.premarketTips?.length
        ? `<div class="mb-row">${STR.morningTips}<ul class="mb-events">${mb.premarketTips
            .map(
              (t) =>
                `<li><span class="muted tiny">${escapeHtml(t.time)}</span> <a href="${escapeHtml(t.url)}" target="_blank" rel="noopener">${escapeHtml(t.title)}</a></li>`,
            )
            .join("")}</ul></div>`
        : ""
    }
    ${mb.flowLine ? `<p class="mb-row">${STR.morningFlow} <span class="muted">${escapeHtml(mb.flowLine)}</span></p>` : ""}
    ${
      mb.lhbRows?.length
        ? `<div class="mb-row">${STR.morningLhb}<ul class="mb-events">${mb.lhbRows
            .map(
              (r) =>
                `<li><a href="https://quote.eastmoney.com/${escapeHtml(r.code)}.html" target="_blank" rel="noopener">${escapeHtml(r.name)}</a> <span class="${r.changePct >= 0 ? "positive" : "negative"}">${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(1)}%</span> <span class="muted tiny">净买 ${r.netAmtYi.toFixed(2)}亿</span></li>`,
            )
            .join("")}</ul></div>`
        : ""
    }
      ${evs ? `<div class="mb-row">${STR.morningNewEvents}<ul class="mb-events">${evs}</ul></div>` : ""}
      <p class="muted tiny">${escapeHtml(mb.note)}</p>
    </div>`;
  }

  const heroBlock = `
  <section class="hero">
    <div class="hero-brand">
      <div class="brand-mark">${STR.siteTitle}</div>
      <p class="brand-tag">${STR.siteTagline}</p>
    </div>
    <div class="hero-meta">
      <span class="ed-badge">${editionLabel}</span>
      ${
        opts.backfilled
          ? `<span class="ed-badge ed-backfill" title="${escapeHtml(STR.backfillBadge)}">${escapeHtml(STR.backfillBadge)}</span>`
          : ""
      }
      <span class="hero-date">${date}${editionHour ? ` · ${editionHour}:00` : ""} · ${tz}</span>
    </div>
    ${
      report.hero_headline
        ? `<h1 class="hero-headline">${escapeHtml(report.hero_headline)}</h1>`
        : `<h1 class="hero-headline">${editionLabel} · ${date}</h1>`
    }
    ${report.editorial_lead ? `<p class="lead-badge"><a href="${escapeHtml(report.editorial_lead.url || "#")}" target="_blank" rel="noopener">${STR.leadBadge} · ${escapeHtml(report.editorial_lead.source || "信源")}</a></p>` : ""}
    ${
      report.daily_overview
        ? `<p class="hero-overview"><span class="ov-label">${STR.heroOverview}</span>${escapeHtml(report.daily_overview)}</p>`
        : ""
    }
    ${renderMorningBrief(report.morning_brief)}
    ${siblingNav}
    <div class="guide-switch" role="group" aria-label="reading mode">
      <button type="button" class="guide-btn active" data-guide="off">${STR.guideToggleOff}</button>
      <button type="button" class="guide-btn" data-guide="on">${STR.guideToggleOn}</button>
    </div>
    <div class="depth-switch" role="group" aria-label="reading depth">
      <button type="button" class="depth-btn" data-depth="quick">${STR.readQuick}</button>
      <button type="button" class="depth-btn active" data-depth="deep">${STR.readDeep}</button>
    </div>
    ${
      process.env.WEB_MODE === "true"
        ? `<a class="archive-link" href="../archive.html">${STR.archiveLink}</a>`
        : ""
    }
  </section>`;

  return `<!doctype html>
<html lang="${REPORT_LOCALE === "en" ? "en" : "zh-CN"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${STR.siteTitle} · ${editionLabel} · ${date}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,500;0,9..40,700;1,9..40,500&family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #fff7ef;
    --bg-elevated: #ffffff;
    --fg: #1c1410;
    --fg-soft: #4a3b32;
    --muted: #8a7364;
    --rule: #f0ddd0;
    --card: #ffffff;
    --link: #c2410c;
    --accent: #ea580c;
    --accent-fg: #fff7ef;
    --splash: #fb923c;
    --mint: #0d9488;
    --rank-high-bg: #ffedd5;
    --rank-high-fg: #9a3412;
    --rank-mid-bg: #fef3c7;
    --rank-mid-fg: #92400e;
    --rank-low-bg: #ccfbf1;
    --rank-low-fg: #0f766e;
    --hero-grad-from: #fff1e0;
    --hero-grad-to: #ffe4ec;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background:
      radial-gradient(ellipse 90% 55% at 0% -5%, #ffd8a8 0%, transparent 55%),
      radial-gradient(ellipse 70% 45% at 100% 0%, #ffc9de 0%, transparent 50%),
      radial-gradient(ellipse 50% 35% at 50% 100%, #cffafe 0%, transparent 55%),
      var(--bg);
    color: var(--fg);
    font-family: "Noto Sans SC", "DM Sans", system-ui, sans-serif;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 980px; margin: 0 auto; padding: 2rem 1.35rem 4rem; }

  .hero {
    margin-bottom: 1.75rem;
    padding: 1.6rem 1.5rem 1.4rem;
    border-radius: 1.25rem;
    background: linear-gradient(145deg, var(--hero-grad-from), var(--hero-grad-to));
    border: 1px solid rgba(234, 88, 12, 0.12);
    box-shadow: 0 12px 40px rgba(234, 88, 12, 0.08);
  }
  .brand-mark {
    font-family: "Fraunces", "Noto Sans SC", serif;
    font-size: clamp(2.4rem, 6vw, 3.4rem);
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1;
    color: var(--fg);
  }
  .brand-tag {
    margin: 0.35rem 0 0;
    color: var(--muted);
    font-size: 0.92rem;
  }
  .hero-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.65rem;
    margin: 1.1rem 0 0.75rem;
  }
  .ed-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.28rem 0.7rem;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .ed-badge.ed-backfill {
    background: transparent;
    color: var(--muted);
    border: 1px dashed var(--muted);
  }
  .hero-date { color: var(--muted); font-size: 0.86rem; }
  .hero-headline {
    font-family: "Fraunces", "Noto Sans SC", serif;
    font-size: clamp(1.35rem, 3.2vw, 1.85rem);
    font-weight: 600;
    margin: 0;
    line-height: 1.35;
    letter-spacing: -0.02em;
  }
  .lead-badge { margin:.35rem 0 0; font-size:.8rem; }
  .hero-morning { margin:.9rem 0 .2rem; padding:.75rem 1rem; background:var(--card);
    border:1px solid var(--rule); border-radius:.75rem; }
  .hero-morning .mb-title { margin:0 0 .3rem; font-weight:700; }
  .hero-morning .mb-row { margin:.3rem 0; display:flex; flex-wrap:wrap; gap:.35rem; align-items:baseline; }
  .mb-chip { padding:.15rem .55rem; border:1px solid var(--rule); border-radius:999px; font-size:.8rem; background:var(--bg-elevated); }
  .mb-events { margin:.2rem 0 0; padding-left:1.1rem; }
  .mb-events li { font-size:.85rem; margin:.2rem 0; }
  .mb-events .mb-ev { color:var(--accent); font-weight:600; margin-right:.35rem; }
  .hero-overview {
    margin: 0.9rem 0 0;
    padding: 0.85rem 1rem;
    background: rgba(255,255,255,0.72);
    border-radius: 0.75rem;
    border-left: 3px solid var(--mint);
    color: var(--fg-soft);
    font-size: 0.95rem;
  }
  .ov-label {
    display: block;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--mint);
    margin-bottom: 0.25rem;
  }
  .edition-switch {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    margin-top: 1rem;
  }
  .ed-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.35rem;
    padding: 0.4rem 0.75rem;
    border-radius: 999px;
    background: rgba(255,255,255,0.8);
    border: 1px solid var(--rule);
    color: var(--fg-soft);
    text-decoration: none;
    font-size: 0.85rem;
    font-weight: 600;
  }
  .ed-chip span { font-size: 0.72rem; color: var(--muted); font-weight: 500; }
  .ed-chip.active, .ed-chip:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .archive-link {
    display: inline-block;
    margin-top: 0.9rem;
    font-size: 0.85rem;
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }
  .archive-link:hover { text-decoration: underline; }

  .eyebrow {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--muted);
    font-weight: 600;
  }
  h1.report-title { display: none; }

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0 0 1rem;
    padding: 0.35rem;
    background: rgba(255,255,255,0.65);
    border: 1px solid var(--rule);
    border-radius: 999px;
  }
  .tab {
    border: none;
    background: transparent;
    color: var(--fg-soft);
    padding: 0.55rem 0.95rem;
    border-radius: 999px;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    font-size: 0.9rem;
  }
  .tab .count {
    margin-left: 0.35rem;
    font-size: 0.75rem;
    color: var(--muted);
    font-weight: 500;
  }
  .tab.active {
    background: var(--fg);
    color: #fff7ef;
  }
  .tab.active .count { color: rgba(255,247,239,0.7); }

  .panel { display: none; }
  .panel.active { display: block; animation: rise 0.35s ease; }
  @keyframes rise {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
  }

  .sub-tabs, .source-tabs, .trading-group-tabs {
    display: flex; flex-wrap: wrap; gap: 0.35rem; margin-bottom: 0.85rem;
  }
  .sub-tab, .source-tab, .trading-group-tab {
    border: 1px solid var(--rule);
    background: var(--card);
    color: var(--fg-soft);
    padding: 0.35rem 0.7rem;
    border-radius: 999px;
    cursor: pointer;
    font: inherit;
    font-size: 0.82rem;
  }
  .sub-tab.active, .source-tab.active, .trading-group-tab.active {
    border-color: var(--accent);
    color: var(--accent);
    background: #fff7ed;
  }
  .sub-content, .source-content, .trading-group-content { display: none; }
  .sub-content.active, .source-content.active, .trading-group-content.active { display: block; }

  .article {
    padding: 0.95rem 0;
    border-bottom: 1px solid var(--rule);
  }
  .article:last-child { border-bottom: none; }
  .article a.title {
    color: var(--fg);
    text-decoration: none;
    font-weight: 600;
    font-size: 1.02rem;
  }
  .article a.title:hover { color: var(--accent); }
  .article .meta-line {
    margin-top: 0.25rem;
    font-size: 0.78rem;
    color: var(--muted);
  }
  .article .excerpt {
    margin: 0.35rem 0 0;
    color: var(--fg-soft);
    font-size: 0.9rem;
  }
  .empty { color: var(--muted); padding: 1rem 0; }

  .brief-list { list-style: none; padding: 0; margin: 0; }
  .brief-item {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.75rem;
    padding: 0.9rem 0;
    border-bottom: 1px solid var(--rule);
  }
  .brief-rank {
    width: 1.6rem; height: 1.6rem;
    border-radius: 0.45rem;
    display: grid; place-items: center;
    font-size: 0.75rem; font-weight: 700;
  }
  .brief-rank.high { background: var(--rank-high-bg); color: var(--rank-high-fg); }
  .brief-rank.mid  { background: var(--rank-mid-bg);  color: var(--rank-mid-fg); }
  .brief-rank.low  { background: var(--rank-low-bg);  color: var(--rank-low-fg); }

  .overview-card, .hero-card { display: none; }

  footer {
    margin-top: 2.5rem;
    border-top: 1px solid var(--rule);
    padding-top: 1.1rem;
    color: var(--muted);
    font-size: 0.82rem;
  }

  /* trading / tickers (kept lean) */
  .trading-overview, .trading-picks, .ticker-card, .crypto-widgets {
    background: var(--card); border: 1px solid var(--rule); border-radius: 0.9rem;
    padding: 1rem 1.1rem; margin-bottom: 0.85rem;
  }
  .ticker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.65rem; }
  .ticker-card h3 { margin: 0 0 0.35rem; font-size: 0.95rem; }
  .ticker-pct.positive, .trend-bullish, .positive { color: #15803d; }
  .ticker-pct.negative, .trend-bearish, .negative { color: #b91c1c; }
  .signal-pill { font-size: 0.72rem; padding: 0.18rem 0.55rem; border-radius: 999px; font-weight: 500; display: inline-block; margin: 0.15rem; }
  .signal-pill.tone-bull { background: rgba(22,163,74,0.13); color: #166534; }
  .signal-pill.tone-bear { background: rgba(220,38,38,0.13); color: #991b1b; }
  .signal-pill.tone-caution { background: rgba(217,119,6,0.15); color: #92400e; }
  .trading-risk {
    margin: 1.5rem 0 0; padding: 0.9rem 1.2rem; background: var(--card);
    border-radius: 0.75rem; border-left: 3px solid #d97706;
  }
  .pick-stance-bull { background: rgba(22,163,74,0.12); color: #16a34a; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.75rem; }
  .pick-stance-bear { background: rgba(220,38,38,0.12); color: #dc2626; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.75rem; }
  .pick-stance-neutral { background: var(--card); color: var(--muted); padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.75rem; }
  .merged-source { font-size: 0.75rem; color: var(--muted); }
  .depth-switch { display:inline-flex; gap:0.25rem; margin:0.75rem 0 0; padding:0.2rem; }
  .depth-btn { border:1px solid var(--rule); background:var(--card); color:var(--muted);
    border-radius:999px; padding:.35rem .8rem; font-size:.85rem; cursor:pointer; }
  .depth-btn.active { border-color:var(--accent); color:var(--accent); font-weight:700; }
  body.read-quick .panel[data-panel="techread"],
  body.read-quick .panel[data-panel="personas"],
  body.read-quick .panel[data-panel="risk"],
  body.read-quick .panel[data-panel="school"],
  body.read-quick .panel[data-panel="knowledge"],
  body.read-quick .panel[data-panel="mcp"] { display:none !important; }
  body.read-quick .tabs .tab[data-tab="techread"],
  body.read-quick .tabs .tab[data-tab="personas"],
  body.read-quick .tabs .tab[data-tab="risk"],
  body.read-quick .tabs .tab[data-tab="school"],
  body.read-quick .tabs .tab[data-tab="knowledge"],
  body.read-quick .tabs .tab[data-tab="mcp"] { display:none; }
  .guide-switch { display:inline-flex; gap:0.25rem; margin:0.75rem 0 0; padding:0.2rem;
    background:rgba(255,255,255,0.55); border-radius:999px; border:1px solid var(--rule); }
  .guide-btn { border:0; background:transparent; padding:0.35rem 0.85rem; border-radius:999px;
    font:inherit; font-size:0.82rem; font-weight:600; cursor:pointer; color:var(--muted); }
  .guide-btn.active { background:var(--accent); color:#fff; }
  body.guide-on .orig-block { display:none; }
  body.guide-on .guide-block { display:block; }
  .guide-block[hidden] { display:none !important; }
  body.guide-on .guide-block[hidden] { display:block !important; }
  .guide-bullets { margin:0.4rem 0 0; padding-left:1.1rem; font-size:0.9rem; }
  .guide-label { list-style:none; margin-left:-1.1rem; font-weight:700; color:var(--accent); font-size:0.78rem; }
  .guide-wire { font-size:0.78rem; color:var(--muted); margin:0.25rem 0; }
  .panel-h { font-size:1.05rem; margin:1.2rem 0 0.5rem; }
  .lede { color:var(--muted); margin:0 0 0.85rem; }
  .muted { color:var(--muted); }
  .tiny { font-size:0.75rem; }
  .idx-grid, .risk-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:0.55rem; margin-bottom:0.75rem; }
  .idx-card, .risk-card, .lesson, .persona-block { background:var(--card); border:1px solid var(--rule); border-radius:0.75rem; padding:0.85rem 1rem; margin-bottom:0.65rem; }
  .event-list { padding-left:1.1rem; }
  .event-list li { margin:0.35rem 0; }
  .ev-sym { font-weight:700; margin-right:0.35rem; }
  .verdict { display:inline-block; font-size:0.72rem; font-weight:700; padding:0.1rem 0.45rem; border-radius:0.35rem; }
  .v-绿 { background:rgba(22,163,74,0.15); color:#166534; }
  .v-黄 { background:rgba(217,119,6,0.15); color:#92400e; }
  .v-红 { background:rgba(220,38,38,0.13); color:#991b1b; }
  #kb-q { width:100%; max-width:420px; padding:0.55rem 0.75rem; border:1px solid var(--rule); border-radius:0.55rem; font:inherit; margin-bottom:0.75rem; }
  .kb-results article { background:var(--card); border:1px solid var(--rule); border-radius:0.65rem; padding:0.7rem 0.9rem; margin-bottom:0.45rem; }
  .lvl { font-size:0.72rem; font-weight:700; color:var(--accent); }
  pre.code { background:#1a1510; color:#fff8f0; padding:0.85rem 1rem; border-radius:0.55rem; overflow:auto; font-size:0.85rem; }
  .spark { display:block; margin:0.35rem 0; }
  .tabs { flex-wrap: wrap; }
  .data-note { font-size:0.78rem; color:#92400e; background:rgba(217,119,6,0.12); padding:0.35rem 0.55rem; border-radius:0.4rem; margin:0.35rem 0; }
  .ticker-card.degraded { opacity:0.92; border-style:dashed; }
  .ticker-card.fav-hit { box-shadow: inset 0 0 0 2px rgba(180,83,9,0.35); }
  .fav-star { border:0; background:transparent; cursor:pointer; font-size:1.1rem; line-height:1; color:var(--muted); padding:0.15rem; }
  .fav-star.on { color:#b45309; }
  .fav-pin { margin:0 0 1rem; padding:0.85rem 1rem; background:var(--card); border:1px dashed var(--rule); border-radius:0.75rem; }
  .fav-pin h2 { margin:0 0 0.55rem; font-size:1rem; }
  .fav-pin-empty { color:var(--muted); font-size:0.85rem; margin:0; }
  .flow-table { width:100%; border-collapse:collapse; font-size:0.88rem; margin:0.4rem 0 0.75rem; }
  .flow-table th, .flow-table td { text-align:left; padding:0.4rem 0.5rem; border-bottom:1px solid var(--rule); }
  .event-counts { font-size:0.85rem; margin:0 0 0.55rem; }
  .ev-count { display:inline-block; margin:0.15rem 0.25rem 0.15rem 0; }
  .ev-count.fav-hit, .event-list li.fav-hit .ev-sym { color:#b45309; }
  .toy-backtest { margin-top:1rem; }
  .senti-head { display:flex; align-items:baseline; gap:.6rem; flex-wrap:wrap; }
  .senti-score { font-size:2.1rem; font-weight:700; font-family:"DM Sans",sans-serif; }
  .senti-label { padding:.2rem .65rem; border:1px solid currentColor; border-radius:999px; font-size:.85rem; font-weight:600; }
  .senti-bar { position:relative; height:.55rem; border-radius:999px; margin:.9rem 0 .3rem;
    background:linear-gradient(90deg,#b91c1c,#d4a017 50%,#15803d); }
  .senti-marker { position:absolute; top:-.3rem; width:.35rem; height:1.15rem; border-radius:2px;
    background:#1a1510; transform:translateX(-50%); box-shadow:0 0 0 2px rgba(255,255,255,.7); }
  .senti-scale { display:flex; justify-content:space-between; margin-bottom:1.1rem; }
  .senti-drivers { display:flex; gap:.4rem; flex-wrap:wrap; }
  .senti-chip { padding:.3rem .7rem; border:1px solid var(--rule); border-radius:999px;
    font-size:.85rem; background:var(--card); }
  .senti-trend { margin:.6rem 0 1rem; padding:.7rem .9rem; background:var(--card);
    border:1px solid var(--rule); border-radius:.75rem; }
  .senti-trend p { margin:.35rem 0 0; }
  .senti-review { margin:0 0 1rem; padding:.7rem .9rem; background:var(--card);
    border:1px solid var(--rule); border-radius:.75rem; }
  .senti-review p { margin:.3rem 0; }

  /* ----- topic-routed lane block (IA increment 2) ----- */
  .view-tabs { display:inline-flex; gap:0.25rem; margin:0 0 0.85rem; padding:0.2rem;
    background:rgba(255,255,255,0.65); border:1px solid var(--rule); border-radius:999px; }
  .view-btn { border:0; background:transparent; padding:0.3rem 0.75rem; border-radius:999px;
    font:inherit; font-size:0.82rem; font-weight:600; cursor:pointer; color:var(--muted); }
  .view-btn.active { background:var(--accent); color:var(--accent-fg); }
  .lane-view { display:none; }
  .lane-view.active { display:block; }
  .topic-section { margin:0 0 1.5rem; }
  .topic-section:last-child { margin-bottom:0; }
  .topic-heading { display:flex; align-items:baseline; gap:0.45rem;
    font-family:"Fraunces","Noto Sans SC",serif; font-size:1.05rem; font-weight:700;
    margin:0 0 0.55rem; padding-bottom:0.3rem; border-bottom:2px solid var(--rule); }
  .topic-heading .count { font-family:"DM Sans",system-ui,sans-serif; font-size:0.72rem;
    font-weight:600; color:var(--accent); background:var(--rank-high-bg);
    padding:0.05rem 0.45rem; border-radius:999px; }
  .topic-items .article { background:var(--card); border:1px solid var(--rule);
    border-radius:0.7rem; padding:0.7rem 0.9rem; margin:0 0 0.5rem; }
  .topic-items .article:last-child { margin-bottom:0; }
  .topic-items .article-title { font-size:0.95rem; }

</style>
</head>
<body>
<main>
  ${heroBlock}

  <nav class="tabs" role="tablist">
    ${laneTabs}
    ${trading ? `<button class="tab" data-tab="trading">${STR.catTrading}<span class="count">${trading.tickers.length}</span></button>` : ""}
    <button class="tab" data-tab="review">${STR.catReview}</button>
    <button class="tab" data-tab="sentiment">${STR.catSentiment}</button>
    <button class="tab" data-tab="techread">${STR.catTechRead}</button>
    <button class="tab" data-tab="personas">${STR.catPersonas}</button>
    <button class="tab" data-tab="risk">${STR.catRisk}</button>
    <button class="tab" data-tab="school">${STR.catSchool}</button>
    <button class="tab" data-tab="knowledge">${STR.catKnowledge}</button>
    <button class="tab" data-tab="mcp">${STR.catMcp}</button>
    ${counts.tech > 0 ? `<button class="tab" data-tab="tech">${CATEGORY_LABELS.tech}<span class="count">${counts.tech}</span></button>` : ""}
    ${techCommunitySubs.length > 0 ? `<button class="tab" data-tab="community">${STR.catCommunity}<span class="count">${counts.community}</span></button>` : ""}
  </nav>

  ${lanePanels}
  ${trading ? `<section class="panel" data-panel="trading">${renderTradingPanel(trading)}</section>` : ""}
  <section class="panel" data-panel="review">${renderReviewPanel(quant, report.themes)}</section>
  <section class="panel" data-panel="sentiment">${renderSentimentPanel(sentiment, sentimentContext)}</section>
  <section class="panel" data-panel="techread">${renderTechReadPanel(trading)}</section>
  <section class="panel" data-panel="personas">${renderPersonasPanel(quant)}</section>
  <section class="panel" data-panel="risk">${renderRiskPanel(quant)}</section>
  <section class="panel" data-panel="school">${renderSchoolPanel()}</section>
  <section class="panel" data-panel="knowledge">${renderKnowledgePanel()}</section>
  <section class="panel" data-panel="mcp">${renderMcpHelpPanel()}</section>
  ${counts.tech > 0 ? `<section class="panel" data-panel="tech">
    ${renderRawCategoryPanel("tech", techMainSubs)}
  </section>` : ""}
  ${techCommunitySubs.length > 0 ? `<section class="panel" data-panel="community">
    ${renderRawCategoryPanel("tech", techCommunitySubs)}
  </section>` : ""}

  <footer>
    ${STR.footer}
  </footer>
</main>
<script>
  document.querySelectorAll('.tabs > .tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = btn.dataset.tab;
      document.querySelectorAll('.tabs > .tab').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      document.querySelectorAll('.panel').forEach(function (p) {
        p.classList.toggle('active', p.dataset.panel === target);
      });
    });
  });
  // Topic / source view switch inside a lane panel. Class flip only — the
  // topic view is server-rendered and visible with JavaScript disabled, so the
  // secondary view can never be the only path to an article.
  document.querySelectorAll('.view-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var views = btn.closest('.lane-views');
      if (!views) return;
      var which = btn.dataset.view;
      views.querySelectorAll('.view-btn').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      views.querySelectorAll('.lane-view').forEach(function (v) {
        v.classList.toggle('active', v.classList.contains('lane-view-' + which));
      });
    });
  });
  // Scope sub-tab / source-tab toggles to the parent .panel so two L1 panels
  // can share the same data-cat (e.g. tech main + community both data-cat=tech)
  // without stomping on each other's active state.
  document.querySelectorAll('.sub-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var panel = btn.closest('.panel');
      if (!panel) return;
      var sub = btn.dataset.sub;
      panel.querySelectorAll('.sub-tab').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      panel.querySelectorAll('.sub-content').forEach(function (p) {
        p.classList.toggle('active', p.dataset.subContent === sub);
      });
    });
  });
  document.querySelectorAll('.source-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var subContent = btn.closest('.sub-content');
      if (!subContent) return;
      var src = btn.dataset.source;
      subContent.querySelectorAll('.source-tab').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      subContent.querySelectorAll('.source-content').forEach(function (p) {
        p.classList.toggle('active', p.dataset.sourceContent === src);
      });
    });
  });
  // Trading panel: asset-group sub-tabs (US/crypto/china/commodity)
  document.querySelectorAll('.trading-group-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var grp = btn.dataset.group;
      document.querySelectorAll('.trading-group-tab').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      document.querySelectorAll('.trading-group-content').forEach(function (p) {
        p.classList.toggle('active', p.dataset.group === grp);
      });
    });
  });
  // 中文导读 toggle (zero LLM) — persist in localStorage
  (function () {
    var KEY = 'opencool-guide';
    function apply(on) {
      document.body.classList.toggle('guide-on', on);
      document.querySelectorAll('.guide-btn').forEach(function (b) {
        b.classList.toggle('active', (b.dataset.guide === 'on') === on);
      });
    }
    apply(localStorage.getItem(KEY) === '1');
    document.querySelectorAll('.guide-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var on = btn.dataset.guide === 'on';
        localStorage.setItem(KEY, on ? '1' : '0');
        apply(on);
      });
    });
  })();
  // Reading depth toggle (quick vs deep) — persist in localStorage.
  (function () {
    var KEY = 'opencool-read-depth';
    function apply(mode) {
      var quick = mode === 'quick';
      document.body.classList.toggle('read-quick', quick);
      document.querySelectorAll('.depth-btn').forEach(function (b) {
        b.classList.toggle('active', (b.dataset.depth === 'quick') === quick);
      });
    }
    apply(localStorage.getItem(KEY) || 'deep');
    document.querySelectorAll('.depth-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var mode = btn.dataset.depth;
        localStorage.setItem(KEY, mode);
        apply(mode);
      });
    });
  })();
  // Local-only favorites (star) — no cloud sync
  (function () {
    var KEY = 'opencool-favorites';
    function load() {
      try { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
      catch (e) { return []; }
    }
    function save(arr) {
      localStorage.setItem(KEY, JSON.stringify(arr));
    }
    function apply() {
      var favs = load();
      var set = {};
      favs.forEach(function (s) { set[s] = true; });
      document.querySelectorAll('.ticker-card[data-symbol]').forEach(function (card) {
        var sym = card.getAttribute('data-symbol');
        var on = !!set[sym];
        card.classList.toggle('is-fav', on);
        var btn = card.querySelector('.fav-star');
        if (btn) {
          btn.classList.toggle('on', on);
          btn.setAttribute('aria-pressed', on ? 'true' : 'false');
          btn.title = on ? '取消自选' : '加入自选';
        }
      });
      document.querySelectorAll('.event-list li[data-symbol], .ev-count[data-symbol]').forEach(function (el) {
        el.classList.toggle('fav-hit', !!set[el.getAttribute('data-symbol')]);
      });
      var pin = document.getElementById('fav-pin-body');
      if (!pin) return;
      pin.innerHTML = '';
      if (!favs.length) {
        pin.innerHTML = '<p class="fav-pin-empty">点击行情卡片星标，自选保存在本机浏览器（非云同步）。</p>';
        return;
      }
      favs.forEach(function (sym) {
        var src = document.querySelector('.trading-group-contents .ticker-card[data-symbol="' + sym + '"]');
        if (!src) return;
        var clone = src.cloneNode(true);
        clone.classList.add('fav-hit');
        pin.appendChild(clone);
      });
      pin.querySelectorAll('.fav-star').forEach(function (btn) {
        btn.addEventListener('click', onStarClick);
      });
    }
    function onStarClick(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var card = ev.currentTarget.closest('.ticker-card');
      if (!card) return;
      var sym = card.getAttribute('data-symbol');
      var favs = load().filter(function (s) { return s !== sym; });
      if (!ev.currentTarget.classList.contains('on')) favs.unshift(sym);
      save(favs);
      apply();
    }
    document.querySelectorAll('.fav-star').forEach(function (btn) {
      btn.addEventListener('click', onStarClick);
    });
    apply();
  })();
  // Knowledge client search
  (function () {
    var el = document.getElementById('kb-data');
    var box = document.getElementById('kb-results');
    var input = document.getElementById('kb-q');
    if (!el || !box || !input) return;
    var data = [];
    try { data = JSON.parse(el.textContent || '[]'); } catch (e) { data = []; }
    function render(q) {
      var s = (q || '').trim().toLowerCase();
      var rows = data.filter(function (k) {
        if (!s) return true;
        var bag = (k.term + ' ' + (k.aliases || []).join(' ') + ' ' + k.body + ' ' + (k.tags || []).join(' ')).toLowerCase();
        return bag.indexOf(s) !== -1;
      }).slice(0, 16);
      box.innerHTML = rows.map(function (k) {
        return '<article><strong>' + k.term + '</strong> <span class="muted">' + (k.tags || []).join(' · ') + '</span><p>' + k.body + '</p></article>';
      }).join('') || '<p class="empty">无匹配词条</p>';
    }
    render('');
    input.addEventListener('input', function () { render(input.value); });
  })();
</script>
</body>
</html>`;
}

// ----- trading panel -----

const SIGNAL_TONE: Record<string, "bull" | "bear" | "caution"> = {
  "golden-cross": "bull",
  "macd-bull-cross": "bull",
  "above-sma50-sma200": "bull",
  "near-52w-high": "bull",
  "bb-lower-touch": "bull",
  "kdj-oversold": "bull",
  "death-cross": "bear",
  "macd-bear-cross": "bear",
  "below-sma50-sma200": "bear",
  "near-52w-low": "bear",
  "bb-upper-touch": "bear",
  "kdj-overbought": "bear",
  "rsi-overbought": "caution",
  "rsi-oversold": "caution",
  "volume-spike": "caution",
};

const TREND_LABEL: Record<TickerAnalysis["trend"], string> = {
  bullish: STR.trendBullish,
  bearish: STR.trendBearish,
  neutral: STR.trendNeutral,
};

function stanceClass(stance: string): "bull" | "bear" | "neutral" {
  // Supports both legacy ("看多"/"看空") and current ("偏上行"/"偏下行")
  // stance values. The current values were chosen to avoid Sonnet's
  // "no investment advice" guardrail; rendering keeps both readable.
  if (/多|涨|上行|bull/i.test(stance)) return "bull";
  if (/空|跌|下行|bear/i.test(stance)) return "bear";
  return "neutral";
}

function fmtNum(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  // Use thousand separators only for prices >= 1000
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(dp).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n.toFixed(dp);
}

function fmtPct(n: number, dp = 2): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(dp)}%`;
}

function renderPickCard(p: WatchlistPick): string {
  const cls = stanceClass(p.stance);
  const symbol = escapeHtml(p.symbol);
  const name = escapeHtml(p.display_name ?? p.symbol);
  const stance = escapeHtml(p.stance);
  const rationale = escapeHtml(p.rationale ?? "");
  return `<article class="trading-pick stance-${cls}">
    <header class="pick-head">
      <div class="pick-symbol-block">
        <span class="pick-symbol">${symbol}</span>
        <span class="pick-name">${name}</span>
      </div>
      <span class="pick-stance pick-stance-${cls}">${stance}</span>
    </header>
    <p class="pick-rationale">${rationale}</p>
  </article>`;
}

function renderTickerCard(t: TickerAnalysis): string {
  const trendCls = t.trend;
  const priceCls = t.pct1Day >= 0 ? "positive" : "negative";
  const pct5Cls = t.pct5Day >= 0 ? "positive" : "negative";
  const signals = t.signals
    .map((s) => {
      const tone = SIGNAL_TONE[s.type] ?? "caution";
      const ageSuffix =
        s.daysAgo !== undefined
          ? ` <span class="signal-age">(${s.daysAgo === 0 ? STR.signalToday : `${s.daysAgo} ${STR.signalDaysAgoSuffix}`})</span>`
          : "";
      return `<span class="signal-pill tone-${tone}">${escapeHtml(s.label)}${ageSuffix}</span>`;
    })
    .join("");
  const currencyPrefix = t.currency === "USD" ? "$" : t.currency === "HKD" ? "HK$" : t.currency === "CNY" ? "¥" : "";
  const spark = sparklineForTicker(t);
  const degraded = t.dataStatus && t.dataStatus !== "live";
  const dataNote =
    degraded || t.dataStatus === "missing"
      ? `<p class="data-note">${escapeHtml(t.dataNote ?? "数据暂缺")}</p>`
      : "";
  // Show at most 3 extra indicator fields to avoid clutter
  const extraRows: string[] = [];
  if (t.bbMid != null) {
    extraRows.push(
      `<div><dt>布林(中)</dt><dd>${fmtNum(t.bbMid)}</dd></div>`,
    );
  }
  if (t.atr14 != null) {
    extraRows.push(`<div><dt>ATR(14)</dt><dd>${fmtNum(t.atr14, 2)}</dd></div>`);
  }
  if (t.kdjJ != null) {
    extraRows.push(`<div><dt>KDJ-J</dt><dd>${fmtNum(t.kdjJ, 1)}</dd></div>`);
  }
  return `<article class="ticker-card${degraded ? " degraded" : ""}" data-symbol="${escapeHtml(t.symbol)}">
    <header class="ticker-head">
      <div class="ticker-id">
        <button type="button" class="fav-star" aria-label="自选" aria-pressed="false" title="加入自选">★</button>
        <h3 class="ticker-symbol">${escapeHtml(t.symbol)}</h3>
        <p class="ticker-name">${escapeHtml(t.displayName)}</p>
      </div>
      <div class="ticker-price-block">
        <span class="ticker-price">${currencyPrefix}${fmtNum(t.currentPrice)}</span>
        <span class="ticker-pct ${priceCls}">${fmtPct(t.pct1Day)}</span>
      </div>
    </header>
    ${dataNote}
    ${spark}
    <dl class="ticker-indicators">
      <div><dt>${STR.ticker5d}</dt><dd class="${pct5Cls}">${fmtPct(t.pct5Day)}</dd></div>
      <div><dt>${STR.tickerVs52wHigh}</dt><dd>${fmtPct(t.pct52WeekHigh, 1)}</dd></div>
      <div><dt>RSI(14)</dt><dd class="rsi-${t.rsiState}">${fmtNum(t.rsi14, 1)}</dd></div>
      <div><dt>${STR.tickerTrend}</dt><dd class="trend-${trendCls}">${TREND_LABEL[t.trend]}</dd></div>
      <div><dt>SMA 20 / 50 / 200</dt><dd>${fmtNum(t.sma20)} / ${fmtNum(t.sma50)} / ${fmtNum(t.sma200)}</dd></div>
      <div><dt>${STR.tickerMacd}</dt><dd>${fmtNum(t.macd, 3)} / ${fmtNum(t.macdSignal, 3)}</dd></div>
      ${extraRows.join("")}
    </dl>
    ${signals ? `<div class="ticker-signals">${signals}</div>` : ""}
  </article>`;
}

function fearGreedTone(value: number): "fear-extreme" | "fear" | "neutral" | "greed" | "greed-extreme" {
  if (value <= 24) return "fear-extreme";
  if (value <= 44) return "fear";
  if (value <= 55) return "neutral";
  if (value <= 74) return "greed";
  return "greed-extreme";
}

function fmtBigUsd(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)} T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)} B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)} M`;
  return `$${n.toFixed(0)}`;
}

function renderCryptoWidgets(t: TradingSection): string {
  const fg = t.crypto_fear_greed;
  const cg = t.crypto_global;
  if (!fg && !cg) return "";
  const items: string[] = [];
  if (fg) {
    const tone = fearGreedTone(fg.value);
    items.push(`<div class="crypto-widget fg-${tone}">
      <div class="widget-label">${STR.widgetCryptoFearGreed}</div>
      <div class="widget-value">${fg.value}</div>
      <div class="widget-sub">${escapeHtml(fg.classificationCn)}</div>
    </div>`);
  }
  if (cg) {
    const tone = cg.marketCapChangePct24h >= 0 ? "positive" : "negative";
    items.push(`<div class="crypto-widget">
      <div class="widget-label">${STR.widgetCryptoCap}</div>
      <div class="widget-value">${fmtBigUsd(cg.totalMarketCapUsd)}</div>
      <div class="widget-sub ${tone}">${fmtPct(cg.marketCapChangePct24h)} / 24h</div>
    </div>`);
    items.push(`<div class="crypto-widget">
      <div class="widget-label">${STR.widgetBtcDom}</div>
      <div class="widget-value">${cg.btcDominance.toFixed(1)}%</div>
      <div class="widget-sub">ETH ${cg.ethDominance.toFixed(1)}%</div>
    </div>`);
    items.push(`<div class="crypto-widget">
      <div class="widget-label">${STR.widgetVolume24h}</div>
      <div class="widget-value">${fmtBigUsd(cg.total24hVolumeUsd)}</div>
      <div class="widget-sub">${STR.widgetActiveCoins} ${cg.activeCryptocurrencies.toLocaleString()}</div>
    </div>`);
  }
  return `<div class="crypto-widgets">${items.join("")}</div>`;
}

function renderTradingPanel(trading: TradingSection): string {
  const tickers = trading.tickers;
  const groupCounts: Record<string, number> = {};
  for (const g of ASSET_GROUP_ORDER) groupCounts[g] = 0;
  for (const t of tickers) groupCounts[t.group] = (groupCounts[t.group] ?? 0) + 1;

  const groupTabs = ASSET_GROUP_ORDER.map(
    (g, i) =>
      `<button class="trading-group-tab${i === 0 ? " active" : ""}" data-group="${g}">${escapeHtml(ASSET_GROUP_LABELS_LOCALIZED[g])}<span class="count">${groupCounts[g] ?? 0}</span></button>`,
  ).join("");

  const groupPanels = ASSET_GROUP_ORDER.map((g, i) => {
    const groupTickers = tickers.filter((t) => t.group === g);
    // Crypto sub-tab carries an extra header widget panel (F&G + global stats)
    const cryptoWidgets =
      g === "crypto" ? renderCryptoWidgets(trading) : "";
    return `<div class="trading-group-content${i === 0 ? " active" : ""}" data-group="${g}">
      ${cryptoWidgets}
      ${groupTickers.length === 0 ? `<p class="empty">${STR.emptyGroup}</p>` : groupTickers.map(renderTickerCard).join("")}
    </div>`;
  }).join("");

  const overview = escapeHtml(trading.market_overview ?? "");
  const risk = escapeHtml(trading.risk_caveat ?? "");

  return `<section class="trading-overview-card">
    <span class="eyebrow">${STR.tradingMarketOverview}</span>
    <p class="overview-text trading-overview-text">${overview}</p>
  </section>

  ${
    trading.watchlist.length > 0
      ? `<section class="trading-watchlist">
    <h2 class="category-title trading-section-title">${STR.tradingTodayFocus}</h2>
    <div class="trading-picks">
      ${trading.watchlist.map(renderPickCard).join("\n")}
    </div>
  </section>`
      : ""
  }

  <section class="fav-pin" id="fav-pin">
    <h2>我的自选</h2>
    <div id="fav-pin-body"><p class="fav-pin-empty">点击行情卡片星标，自选保存在本机浏览器（非云同步）。</p></div>
  </section>

  <section class="trading-tickers">
    <h2 class="category-title trading-section-title">${STR.tradingAllAssets}</h2>
    <nav class="trading-group-tabs">${groupTabs}</nav>
    <div class="trading-group-contents">${groupPanels}</div>
  </section>

  ${
    risk
      ? `<section class="trading-risk">
    <span class="eyebrow">${STR.tradingRiskCaveat}</span>
    <p>${risk}</p>
  </section>`
      : ""
  }`;
}

// ----- markdown -----

function renderBriefMarkdown(b: BriefItem): string {
  const importance = Number.isFinite(b.importance) ? b.importance : 0;
  return `### [${b.title}](${b.url})\n${b.source} · ${STR.mdImportance} ${importance}/10\n\n${b.summary}\n`;
}

function renderSectionMarkdown(title: string, briefs: BriefItem[]): string {
  if (briefs.length === 0) return "";
  return `## ${title}\n\n${briefs.map(renderBriefMarkdown).join("\n")}\n`;
}

export function renderMarkdown(report: DailyReport, date: string): string {
  const blocks: string[] = [];
  blocks.push(`# ${STR.siteTitle} · ${date}\n`);
  if (report.hero_headline) blocks.push(`> ${report.hero_headline}\n`);
  if (report.daily_overview) {
    blocks.push(`## ${STR.mdTodayOverview}\n\n${report.daily_overview}\n`);
  }
  blocks.push(
    renderSectionMarkdown(CATEGORY_DIGEST_LABELS.tech, report.tech_briefs),
  );
  blocks.push(
    renderSectionMarkdown(
      CATEGORY_DIGEST_LABELS.finance,
      report.finance_briefs,
    ),
  );
  blocks.push(
    renderSectionMarkdown(
      CATEGORY_DIGEST_LABELS.politics,
      report.politics_briefs,
    ),
  );
  if (report.editor_note) {
    blocks.push(`## ${STR.mdEditorNote}\n\n${report.editor_note}\n`);
  }
  if (report.keywords.length > 0) {
    blocks.push(
      `## ${STR.mdTodayKeywords}\n\n${report.keywords.map((k) => `\`#${k}\``).join(" ")}\n`,
    );
  }
  return blocks.filter(Boolean).join("\n");
}
