import http from "node:http";
import https from "node:https";

import Parser from "rss-parser";
import { curlFetch } from "./curl-fetch";
import type { Category, RawArticle } from "./types";

const PARSER_OPTIONS = {
  timeout: 10000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; DailyBriefBot/1.0; +https://github.com/)",
  },
} as const;

const parser = new Parser(PARSER_OPTIONS);

/**
 * `rss-parser` rejects on timeout/error without destroying the underlying
 * request, so the socket it opened stays referenced and the whole pipeline
 * process refuses to exit after "[daily] done." (measured: ~6m15s of idle
 * hang per run, enough to eat a CI job's budget). Give each parse a private
 * agent and destroy it once the parse settles — that closes the abandoned
 * socket and drops the last ref'd handle.
 */
function newAgentFor(url: string): http.Agent {
  const Ctor = url.startsWith("https") ? https.Agent : http.Agent;
  return new Ctor({ keepAlive: false });
}

/**
 * Parse a feed URL with an agent that is always destroyed afterwards, even
 * when the parse rejects (timeout, DNS failure, TLS error). Exported so the
 * regression guard can exercise the timeout path against a local server that
 * never answers.
 */
export async function parseUrlWithCleanup(
  url: string,
  timeoutMs: number = PARSER_OPTIONS.timeout,
): Promise<Awaited<ReturnType<Parser["parseURL"]>>> {
  const agent = newAgentFor(url);
  const scoped = new Parser({
    ...PARSER_OPTIONS,
    timeout: timeoutMs,
    requestOptions: { agent },
  });
  try {
    return await scoped.parseURL(url);
  } finally {
    agent.destroy();
  }
}

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
          : await parseUrlWithCleanup(u);
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
