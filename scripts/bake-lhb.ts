/**
 * Bake daily_reports/lhb.json — 龙虎榜 (dragon-tiger list) top movers
 * by net amount, from Eastmoney's keyless datacenter API
 * (reportName=RPT_DAILYBILLBOARD_DETAILSNEW, live-verified 2026-11-05:
 * 175 rows/day with SECURITY_CODE/SECURITY_NAME_ABBR/CHANGE_RATE/
 * BILLBOARD_NET_AMT/TRADE_DATE). Fail-open; zero LLM.
 * Runs AFTER restore, BEFORE daily (daily consumes it).
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";

const ROOT = "daily_reports";
const OUT = path.join(ROOT, "lhb.json");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const LIMIT = 8;

function shanghaiDate(offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

interface LhbRow {
  code: string;
  name: string;
  changePct: number;
  netAmtYi: number;
  tradeDate: string;
}

async function fetchLhb(tradeDate: string): Promise<LhbRow[]> {
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW` +
    `&columns=SECURITY_CODE,SECURITY_NAME_ABBR,CHANGE_RATE,BILLBOARD_NET_AMT,TRADE_DATE` +
    `&pageSize=50&pageNumber=1&sortTypes=-1&sortColumns=BILLBOARD_NET_AMT` +
    `&filter=(TRADE_DATE%3E%3D%27${tradeDate}%27)`;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as {
      success?: boolean;
      result?: {
        data?: Array<{
          SECURITY_CODE?: string;
          SECURITY_NAME_ABBR?: string;
          CHANGE_RATE?: number;
          BILLBOARD_NET_AMT?: number;
          TRADE_DATE?: string;
        }>;
      };
    };
    if (!j.success) return [];
    // Dedupe by code — the report has one row per上榜 reason.
    const seen = new Map<string, LhbRow>();
    for (const d of j.result?.data ?? []) {
      const code = String(d.SECURITY_CODE ?? "");
      if (!code || seen.has(code)) continue;
      seen.set(code, {
        code,
        name: String(d.SECURITY_NAME_ABBR ?? code),
        changePct: Number(d.CHANGE_RATE) || 0,
        netAmtYi: Math.round((Number(d.BILLBOARD_NET_AMT) || 0) / 1e8 * 100) / 100,
        tradeDate: String(d.TRADE_DATE ?? "").slice(0, 10),
      });
    }
    return [...seen.values()].sort((a, b) => b.netAmtYi - a.netAmtYi).slice(0, LIMIT);
  } catch {
    return [];
  }
}

async function main() {
  // Try the previous trading day first (post-close list), then today.
  const candidates = [shanghaiDate(-1), shanghaiDate(0)];
  let rows: LhbRow[] = [];
  let tradeDate = "";
  for (const d of candidates) {
    rows = await fetchLhb(d);
    if (rows.length) {
      tradeDate = rows[0].tradeDate;
      break;
    }
  }

  const payload = rows.length
    ? {
        generatedAt: new Date().toISOString(),
        source: "eastmoney-datacenter",
        status: "ok" as const,
        tradeDate,
        rows,
      }
    : {
        generatedAt: new Date().toISOString(),
        source: "eastmoney-datacenter",
        status: "unavailable" as const,
        tradeDate: candidates[0],
        rows: [],
      };

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(
    `[lhb:bake] wrote ${OUT} status=${payload.status} rows=${payload.rows.length} tradeDate=${payload.tradeDate}`,
  );
}

main().catch((e) => {
  console.error(e);
  // fail-open: do not fail CI
  process.exit(0);
});
