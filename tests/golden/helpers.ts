/**
 * Shared fixtures for the golden regression suite. Structural assertions
 * only (structure presence, not full-text equality) so copy tweaks don't
 * shatter the suite — but breaking any shipped surface does.
 */
import type {
  ArticleInput,
  DailyReport,
  MorningBrief,
} from "../../lib/ai/pipeline";
import type { RawByCategory, SubGroup } from "../../lib/output/render";

export function article(over: Partial<ArticleInput> = {}): ArticleInput {
  return {
    sourceId: "test-src",
    title: "测试标题：央行开展 5000 亿元 MLF 操作",
    excerpt: "流动性投放超预期，市场情绪回暖。",
    url: "https://example.com/a1",
    category: "finance",
    publishedAt: new Date("2026-10-27T02:00:00Z"),
    source: "测试源",
    ...over,
  } as ArticleInput;
}

export function rawByCategory(): RawByCategory {
  const group = (cat: "finance" | "tech" | "politics"): SubGroup => ({
    id: `${cat}-main`,
    name: cat,
    sources: [
      {
        sourceId: "test-src",
        sourceName: "测试源",
        items: [article({ category: cat })],
        merged: true,
      },
    ],
  });
  return { finance: [group("finance")], tech: [group("tech")], politics: [group("politics")] };
}

export function sentimentFixture() {
  return {
    generated_at: "2026-10-27T03:00:00Z",
    score: -42,
    label: "偏空",
    posHits: 4,
    negHits: 11,
    scanned: 30,
    drivers: [
      { term: "下跌", hits: 3, polarity: -1 as const },
      { term: "回暖", hits: 2, polarity: 1 as const },
    ],
    sectors: [
      {
        key: "china-ashare" as const,
        score: -30,
        posHits: 1,
        negHits: 5,
        articles: 6,
        topDrivers: [{ term: "下跌", hits: 3, polarity: -1 as const }],
      },
      {
        key: "general" as const,
        score: -45,
        posHits: 3,
        negHits: 6,
        articles: 24,
        topDrivers: [],
      },
    ],
    percentile: 12,
    note: "fixture note",
  };
}

export function morningBriefFixture(): MorningBrief {
  return {
    generated_at: "2026-10-27T03:00:00Z",
    base_edition: "2026-10-26/19",
    sentimentDelta: 8,
    baseSentiment: -50,
    overnight: [
      { symbol: "SPY", displayName: "S&P 500 ETF", group: "us-equity", pct1Day: -1.2 },
      { symbol: "BTC-USD", displayName: "比特币", group: "crypto", pct1Day: 2.5 },
    ],
    newKeywords: ["MLF", "降准"],
    newEvents: [
      {
        symbol: "600519.SS",
        displayName: "贵州茅台",
        title: "茅台发布增持公告",
        url: "https://example.com/ev1",
      },
    ],
    note: "fixture morning note",
  };
}

export function reportFixture(over: Partial<DailyReport> = {}): DailyReport {
  return {
    hero_headline: "央行开展 5000 亿元 MLF 操作",
    daily_overview: "启发式两报（零 AI）：财经头条……",
    tech_briefs: [],
    finance_briefs: [
      {
        title: "央行开展 5000 亿元 MLF 操作",
        url: "https://example.com/a1",
        source: "测试源",
        summary: "流动性投放超预期。",
        importance: 8,
      },
    ],
    politics_briefs: [],
    editor_note: "LLM_MODE=off",
    keywords: ["MLF", "央行", "流动性"],
    sentiment: sentimentFixture(),
    morning_brief: morningBriefFixture(),
    ...over,
  };
}
