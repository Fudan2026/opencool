/**
 * Free delayed A-share index snapshot via Eastmoney public API.
 * Failures return null — never fatal.
 */

import { fetchJson } from "./http-json";

export interface IndexSnap {
  code: string;
  name: string;
  price: number;
  changePct: number;
  /**
   * Upstream quote stamp in epoch **seconds** (`f86`), when the payload carried
   * one. Optional because it is metadata, not part of the quote: the edition
   * panels ignore it and the point-in-time tape records it as the index value's
   * market clock.
   */
  quoteStamp?: number | null;
}

export interface MarketOverview {
  indices: IndexSnap[];
  fetchedAt: string;
  note: string;
}

export interface MarketOverviewOptions {
  fetchImpl?: typeof fetch;
}

async function fetchEmIndex(
  secid: string,
  options: MarketOverviewOptions = {},
): Promise<IndexSnap | null> {
  // f86 is the quote timestamp; asking for it costs nothing and is the only way
  // a caller can tell when the value it just received was actually struck.
  const fields = "f57,f58,f43,f169,f170,f46,f44,f45,f168,f47,f48,f60,f86";
  const urls = [
    `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}`,
    `https://push2delay.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}`,
  ];
  const j = await fetchJson<{
    data?: { f57?: string; f58?: string; f43?: number; f170?: number; f86?: number };
  }>(urls, {
    headers: { Referer: "https://quote.eastmoney.com/" },
    timeoutMs: 10_000,
    fetchImpl: options.fetchImpl,
  });
  const d = j?.data;
  if (!d?.f58 || d.f43 == null) return null;
  const stamp = Number(d.f86);
  return {
    code: String(d.f57 ?? secid),
    name: d.f58,
    price: d.f43 / 100,
    changePct: (d.f170 ?? 0) / 100,
    quoteStamp: Number.isFinite(stamp) && stamp > 1_000_000_000 ? stamp : null,
  };
}

/** 1.000001 上证 · 0.399001 深成指 · 0.399006 创业板 */
export async function fetchMarketOverview(
  options: MarketOverviewOptions = {},
): Promise<MarketOverview | null> {
  const pairs: [string, string][] = [
    ["1.000001", "上证指数"],
    ["0.399001", "深证成指"],
    ["0.399006", "创业板指"],
  ];
  const indices: IndexSnap[] = [];
  for (const [secid] of pairs) {
    const snap = await fetchEmIndex(secid, options);
    if (snap) indices.push(snap);
  }
  if (indices.length === 0) return null;
  return {
    indices,
    fetchedAt: new Date().toISOString(),
    note: "东方财富公开延时接口 · 非实时 · 仅供参考",
  };
}
