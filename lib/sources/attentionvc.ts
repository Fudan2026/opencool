import type { RawArticle } from "./types";
import { isEntertainmentTitle, isFinanceTitle } from "./title-filters";

/**
 * AttentionVC tracks viral X (Twitter) posts via a public Cloud Run REST
 * API (no auth). Paid api.attentionvc.ai is NOT used.
 *
 * Free endpoint: category=finance|markets → 500 (as of 2026-09); category=
 * crypto works and is the closest markets-adjacent public bucket. We also
 * fall back to uncategorized + client-side finance keyword filter.
 *
 * OpenCool UI: on-site mirror so CN readers need not open x.com.
 */
const BASE =
  "https://reply-vc-90459984647.us-central1.run.app/v1/articles/leaderboard";

interface AvcAuthor {
  handle: string;
  name?: string;
  followers?: number;
  accountBasedIn?: string;
  isBlueVerified?: boolean;
}

interface AvcEntry {
  rank: number;
  tweetId: string;
  title: string;
  tweetCreatedAt: string;
  author: AvcAuthor;
  viewCount?: number;
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
  previewText?: string;
  coverImageUrl?: string;
  category?: string;
  subcategory?: string;
  tags?: string[];
  lang?: string;
  langsDetected?: string[];
}

interface AvcResponse {
  entries: AvcEntry[];
  updatedAt?: string;
  totalCount?: number;
}

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function buildMeta(e: AvcEntry): string {
  const parts: string[] = [`@${e.author.handle}`, "站内镜像"];
  if (typeof e.author.followers === "number") {
    parts.push(`${compactNumber(e.author.followers)} 粉丝`);
  }
  if (typeof e.viewCount === "number") {
    parts.push(`${compactNumber(e.viewCount)} 阅`);
  }
  if (typeof e.likeCount === "number") {
    parts.push(`${compactNumber(e.likeCount)} 赞`);
  }
  if (typeof e.retweetCount === "number" && e.retweetCount > 0) {
    parts.push(`${compactNumber(e.retweetCount)} 转`);
  }
  return parts.join(" · ");
}

/** Prefer en/zh; drop JP/KR noise that slips past the API lang filter. */
function isReadableLang(e: AvcEntry): boolean {
  const langs = e.langsDetected?.length
    ? e.langsDetected
    : e.lang
      ? [e.lang]
      : [];
  if (langs.length === 0) return true;
  if (langs.includes("zxx")) return true;
  return langs.some((l) => l === "en" || l === "zh" || l.startsWith("zh"));
}

async function fetchBoard(
  query: string,
): Promise<AvcEntry[]> {
  const url = `${BASE}?${query}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; OpenCoolBot/1.0)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.warn(`[attentionvc] ${url} → HTTP ${res.status}`);
    return [];
  }
  const data = (await res.json()) as AvcResponse;
  return data.entries ?? [];
}

function keepEntry(e: AvcEntry): boolean {
  if (!e.title || !e.tweetId || !e.author?.handle) return false;
  if (!isReadableLang(e)) return false;
  if (isEntertainmentTitle(e.title)) return false;
  // Crypto board is already markets-adjacent; uncategorized needs whitelist.
  if (e.category === "crypto") return true;
  return isFinanceTitle(e.title) || isFinanceTitle(e.previewText || "");
}

export async function fetchAttentionVc(
  sourceId: string,
  limit = 30,
): Promise<RawArticle[]> {
  // Prefer crypto (markets-adjacent; finance/markets return 500 on free API).
  // Fall back to uncategorized + keyword filter. Failures are non-fatal.
  let entries = await fetchBoard("window=3d&category=crypto&lang=en&limit=50");
  if (entries.length < 8) {
    const more = await fetchBoard("window=3d&lang=en&limit=50");
    const seen = new Set(entries.map((e) => e.tweetId));
    for (const e of more) {
      if (!seen.has(e.tweetId)) entries.push(e);
    }
  }

  const kept = entries.filter(keepEntry);
  console.log(
    `[attentionvc] raw=${entries.length} kept=${kept.length} (cap ${limit})`,
  );

  return kept.slice(0, limit).map((e) => ({
    sourceId,
    title: e.title,
    // x.com links; Chinese readers browse titles/excerpts on-site first
    url: `https://x.com/${e.author.handle}/status/${e.tweetId}`,
    excerpt: e.previewText?.replace(/\s+/g, " ").trim().slice(0, 300),
    publishedAt: e.tweetCreatedAt ? new Date(e.tweetCreatedAt) : undefined,
    category: "finance" as const,
    meta: buildMeta(e),
  }));
}
