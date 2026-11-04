/**
 * Bake daily_reports/calendar.json — pre-market tips (盘前要闻提示)
 * from Eastmoney's keyless news-column API (biz=web_news_col, verified
 * live 2026-11-04; same shape as the competitor 盘前必读 free format).
 * Fail-open: on failure writes status "unavailable" and the morning
 * brief simply omits the section. Runs BEFORE `npm run daily` in CI.
 * Zero LLM.
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";

const ROOT = "daily_reports";
const OUT = path.join(ROOT, "calendar.json");
const LIMIT = 8;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface Tip {
  time: string;
  title: string;
  summary: string;
  url: string;
}

async function fetchColumn(url: string): Promise<Tip[] | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      code?: string | number;
      data?: { list?: Array<{ showTime?: string; title?: string; summary?: string; url?: string }> };
    };
    if (String(j.code) !== "1" || !j.data?.list?.length) return null;
    return j.data.list
      .filter((x) => x.title && x.url)
      .map((x) => ({
        time: String(x.showTime ?? "").slice(11, 16),
        title: String(x.title).slice(0, 80),
        summary: String(x.summary ?? "").slice(0, 120),
        url: String(x.url),
      }))
      .slice(0, LIMIT);
  } catch {
    return null;
  }
}

async function main() {
  const candidates = [
    "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=350&order=1&needInteractData=0&page_index=1&page_size=20&req_trace=1&fields=code,showTime,title,mediaName,summary,url&types=1,20",
  ];
  let items: Tip[] | null = null;
  let source = "";
  for (const url of candidates) {
    items = await fetchColumn(url);
    if (items?.length) {
      source = url;
      break;
    }
  }

  const payload = items?.length
    ? {
        generatedAt: new Date().toISOString(),
        source: "eastmoney-np-listapi",
        status: "ok" as const,
        items,
      }
    : {
        generatedAt: new Date().toISOString(),
        source: candidates[0],
        status: "unavailable" as const,
        items: [],
      };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(
    `[calendar:bake] wrote ${OUT} status=${payload.status} items=${payload.items.length}`,
  );
  void source;
}

main().catch((e) => {
  console.error(e);
  // fail-open: do not fail CI
  process.exit(0);
});
