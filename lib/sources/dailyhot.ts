/**
 * Fetch social hot-rank lists via public DailyHot-compatible JSON APIs
 * (imsyy/DailyHotApi). Titles + links only — no login, no body scrape.
 * Failures return [] so the rest of the daily pipeline keeps running.
 */

import type { RawArticle } from "./types";

interface HotItem {
  title?: string;
  name?: string;
  url?: string;
  mobileUrl?: string;
  hot?: string | number;
  desc?: string;
}

interface HotResponse {
  data?: HotItem[];
  title?: string;
}

const DEFAULT_BASES = [
  "https://api-hot.imsyy.top",
  // Community mirrors occasionally used when the primary is unreachable
  // from Actions / certain regions. Override entirely via DAILYHOT_API_BASE.
  "https://dailyhot-api.vercel.app",
];

async function fetchJson(url: string, timeoutMs = 15_000): Promise<HotResponse | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "OpenCool-DailyBrief/1.0",
      },
    });
    if (!res.ok) {
      console.warn(`[dailyhot] ${url} → HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as HotResponse;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[dailyhot] ${url} failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function bases(): string[] {
  const override = process.env.DAILYHOT_API_BASE?.trim();
  if (override) return [override.replace(/\/$/, "")];
  return DEFAULT_BASES;
}

/**
 * `source.url` should be a DailyHot path like `/douyin` or a full URL.
 * Optional `?limit=N` is honored (default 20).
 */
export async function fetchDailyHot(sourceId: string, url: string): Promise<RawArticle[]> {
  if (url.startsWith("http")) {
    const endpoint = new URL(url);
    if (!endpoint.searchParams.has("limit")) {
      endpoint.searchParams.set("limit", "20");
    }
    const body = await fetchJson(endpoint.toString());
    return mapItems(sourceId, body?.data ?? []);
  }

  const path = url.startsWith("/") ? url : `/${url}`;
  for (const base of bases()) {
    let endpoint: URL;
    try {
      endpoint = new URL(path, base.endsWith("/") ? base : `${base}/`);
    } catch {
      continue;
    }
    if (!endpoint.searchParams.has("limit")) {
      endpoint.searchParams.set("limit", "20");
    }
    const body = await fetchJson(endpoint.toString());
    const items = body?.data ?? [];
    if (items.length > 0) {
      console.log(`[dailyhot] ${sourceId} via ${base} → ${items.length}`);
      return mapItems(sourceId, items);
    }
  }
  return [];
}

function mapItems(sourceId: string, items: HotItem[]): RawArticle[] {
  return items
    .map((it, idx): RawArticle | null => {
      const title = (it.title || it.name || "").trim();
      const link = (it.url || it.mobileUrl || "").trim();
      if (!title || !link) return null;
      const hot =
        it.hot !== undefined && it.hot !== null ? String(it.hot) : undefined;
      return {
        sourceId,
        title,
        url: link,
        excerpt: it.desc || (hot ? `热度 ${hot}` : undefined),
        publishedAt: new Date(),
        category: "politics",
        meta: hot ? `#${idx + 1} · 热度 ${hot}` : `#${idx + 1}`,
      };
    })
    .filter((x): x is RawArticle => x !== null);
}
