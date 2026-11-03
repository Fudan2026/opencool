import Parser from "rss-parser";
import { curlFetch } from "./curl-fetch";
import type { Category, RawArticle } from "./types";

const parser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; DailyBriefBot/1.0; +https://github.com/)",
  },
});

const CURL_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Feed URL try-order: primary first, then mirrors in config order.
 * Pure so the fallback policy is unit-testable.
 */
export function resolveFeedOrder(url: string, mirrors?: string[]): string[] {
  return [url, ...(mirrors ?? [])].filter(
    (u, i, arr) => typeof u === "string" && u.length > 0 && arr.indexOf(u) === i,
  );
}

export async function fetchRss(
  sourceId: string,
  url: string,
  category: Category,
  options: { limit?: number; useCurl?: boolean; mirrors?: string[] } = {},
): Promise<RawArticle[]> {
  const limit = options.limit ?? 30;
  const urls = resolveFeedOrder(url, options.mirrors);

  let feed: Awaited<ReturnType<Parser["parseURL"]>> | undefined;
  let lastErr: unknown;
  let served = urls[0];
  for (const u of urls) {
    try {
      feed =
        options.useCurl === true
          ? await parser.parseString(await curlFetch(u, CURL_HEADERS))
          : await parser.parseURL(u);
      served = u;
      break;
    } catch (e) {
      lastErr = e;
      if (urls.length > 1) {
        console.warn(`  ${sourceId.padEnd(20)} feed failed (${u}) — trying mirror`);
      }
    }
  }
  if (!feed) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  if (served !== urls[0]) {
    console.log(`  ${sourceId.padEnd(20)} served by mirror: ${served}`);
  }

  return (feed.items ?? [])
    .slice(0, limit)
    .map((item) => ({
      sourceId,
      title: (item.title ?? "").trim(),
      url: (item.link ?? "").trim(),
      excerpt: stripHtml(item.contentSnippet ?? item.content ?? "").slice(
        0,
        300,
      ),
      publishedAt: item.isoDate ? new Date(item.isoDate) : undefined,
      category,
    }))
    .filter((a) => a.title && a.url);
}
