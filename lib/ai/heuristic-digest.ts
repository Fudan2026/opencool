/**
 * Zero-LLM daily digest: Jaccard near-dedupe + cross-source corroboration
 * scoring (distilled from nosey-agent / Daily-Intelligence-System patterns).
 * Produces the same DailyReport shape the HTML renderer expects.
 */

import { REPORT_LOCALE } from "../sources/registry";
import type { Category } from "../sources/types";
import type { ArticleInput, BriefItem, DailyReport } from "./pipeline";

const BRIEF_LIMITS: Record<Category, number> = {
  finance: 5,
  politics: 3,
  tech: 4,
};

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(title: string): Set<string> {
  const norm = normalizeTitle(title);
  const parts = norm.split(" ").filter((t) => t.length >= 2);
  // CJK: also emit overlapping bigrams so short Chinese titles can match.
  const cjk = norm.replace(/\s+/g, "");
  if (/[\u4e00-\u9fff]/.test(cjk) && cjk.length >= 4) {
    for (let i = 0; i < cjk.length - 1; i++) {
      parts.push(cjk.slice(i, i + 2));
    }
  }
  return new Set(parts);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

type Cluster = {
  canonical: ArticleInput;
  tokens: Set<string>;
  sources: Set<string>;
  members: ArticleInput[];
};

function clusterArticles(items: ArticleInput[], threshold = 0.45): Cluster[] {
  const clusters: Cluster[] = [];
  for (const item of items) {
    const tokens = tokenize(item.title);
    let best: Cluster | null = null;
    let bestScore = 0;
    for (const c of clusters) {
      const score = jaccard(tokens, c.tokens);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best && bestScore >= threshold) {
      best.members.push(item);
      best.sources.add(item.source);
      for (const t of tokens) best.tokens.add(t);
      const aTime = item.publishedAt?.getTime() ?? 0;
      const cTime = best.canonical.publishedAt?.getTime() ?? 0;
      if (aTime > cTime) best.canonical = item;
    } else {
      clusters.push({
        canonical: item,
        tokens,
        sources: new Set([item.source]),
        members: [item],
      });
    }
  }
  return clusters;
}

function freshnessBoost(publishedAt?: Date): number {
  if (!publishedAt) return 0.5;
  const ageH = (Date.now() - publishedAt.getTime()) / 3_600_000;
  if (ageH < 0) return 1;
  if (ageH <= 12) return 1;
  if (ageH <= 36) return 0.7;
  if (ageH <= 72) return 0.4;
  return 0.15;
}

function scoreCluster(c: Cluster): number {
  // Cross-source corroboration is the anti-filter-bubble signal.
  const sourceScore = Math.min(c.sources.size, 5);
  return sourceScore * 2 + freshnessBoost(c.canonical.publishedAt);
}

function toBrief(c: Cluster): BriefItem {
  const a = c.canonical;
  const excerpt = (a.summary || a.excerpt || "").trim().slice(0, 220);
  const multi =
    c.sources.size > 1
      ? REPORT_LOCALE === "en"
        ? ` Also reported by ${[...c.sources].filter((s) => s !== a.source).slice(0, 3).join(", ")}.`
        : ` 亦见于 ${[...c.sources].filter((s) => s !== a.source).slice(0, 3).join("、")}。`
      : "";
  const summary =
    excerpt ||
    (REPORT_LOCALE === "en"
      ? "No excerpt available — open the original link."
      : "暂无摘要，请点开原文。") + multi;
  const importance = Math.min(10, Math.round(scoreCluster(c) + 3));
  return {
    title: a.title,
    url: a.url,
    source:
      c.sources.size > 1
        ? `${a.source} +${c.sources.size - 1}`
        : a.source,
    summary: excerpt ? excerpt + multi : summary,
    importance,
  };
}

function pickBriefs(items: ArticleInput[], limit: number): BriefItem[] {
  const clusters = clusterArticles(items)
    .map((c) => ({ c, score: scoreCluster(c) }))
    .sort((a, b) => b.score - a.score);
  return clusters.slice(0, limit).map(({ c }) => toBrief(c));
}

function topKeywords(briefs: BriefItem[], n = 6): string[] {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "are",
    "was",
    "will",
    "have",
    "after",
    "over",
    "into",
    "says",
    "said",
    "中国",
    "美国",
    "市场",
    "今日",
    "报道",
  ]);
  const counts = new Map<string, number>();
  for (const b of briefs) {
    for (const t of tokenize(b.title)) {
      if (t.length < 2 || stop.has(t)) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

/**
 * Build a DailyReport without calling any LLM.
 */
export function generateHeuristicReport(articles: ArticleInput[]): DailyReport {
  const byCat: Record<Category, ArticleInput[]> = {
    tech: [],
    finance: [],
    politics: [],
  };
  for (const a of articles) {
    if (a.category in byCat) byCat[a.category].push(a);
  }

  const finance_briefs = pickBriefs(byCat.finance, BRIEF_LIMITS.finance);
  const politics_briefs = pickBriefs(byCat.politics, BRIEF_LIMITS.politics);
  const tech_briefs = pickBriefs(byCat.tech, BRIEF_LIMITS.tech);

  const lead =
    finance_briefs[0] || politics_briefs[0] || tech_briefs[0] || null;

  const hero_headline = lead
    ? lead.title.slice(0, 40)
    : REPORT_LOCALE === "en"
      ? "OpenCool daily finance brief"
      : "OpenCool 财经早报";

  const overviewParts: string[] = [];
  if (REPORT_LOCALE === "en") {
    overviewParts.push(
      "Heuristic digest (no LLM): ranked by cross-source corroboration and recency — not personalized.",
    );
    if (finance_briefs[0])
      overviewParts.push(`Finance lead: ${finance_briefs[0].title}.`);
    if (politics_briefs[0])
      overviewParts.push(`World lead: ${politics_briefs[0].title}.`);
    if (tech_briefs[0])
      overviewParts.push(`Tech lead: ${tech_briefs[0].title}.`);
  } else {
    overviewParts.push(
      "启发式早报（未调用大模型）：按「多源交叉出现 × 时效」排序，不做个性化推荐。",
    );
    if (finance_briefs[0])
      overviewParts.push(`财经头条：${finance_briefs[0].title}。`);
    if (politics_briefs[0])
      overviewParts.push(`时政头条：${politics_briefs[0].title}。`);
    if (tech_briefs[0])
      overviewParts.push(`科技头条：${tech_briefs[0].title}。`);
  }

  const allBriefs = [...finance_briefs, ...politics_briefs, ...tech_briefs];

  return {
    hero_headline,
    daily_overview: overviewParts.join(" "),
    tech_briefs,
    finance_briefs,
    politics_briefs,
    editor_note:
      REPORT_LOCALE === "en"
        ? "LLM_MODE=off — titles and excerpts from sources; add a DeepSeek (or other) API key to enable AI summaries."
        : "当前为 LLM_MODE=off：标题与摘要来自信源原文；配置 DeepSeek 等 API Key 后可升级为 AI 摘要。",
    keywords: topKeywords(allBriefs),
  };
}
