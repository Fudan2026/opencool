/**
 * East Money daily kline (free, no key) for CN A-share / CN ETF.
 * Prefer this over Yahoo for .SS / .SZ symbols.
 *
 * API: push2his.eastmoney.com/api/qt/stock/kline/get
 * Failures return null — never throw.
 */

import type { OHLC, TickerRawData } from "./yahoo";

const HEADERS = {
  "User-Agent": "OpenCool/1.0",
  Referer: "https://quote.eastmoney.com/",
  Accept: "application/json",
} as const;

/**
 * Yahoo-style CN symbol → East Money secid.
 * Shanghai (.SS) → 1.<code>, Shenzhen (.SZ) → 0.<code>.
 */
export function yahooToEmSecid(symbol: string): string | null {
  const m = symbol.trim().match(/^(\d{6})\.(SS|SZ)$/i);
  if (!m) return null;
  const code = m[1];
  const market = m[2].toUpperCase() === "SS" ? "1" : "0";
  return `${market}.${code}`;
}

export function isCnAshareOrEtf(symbol: string): boolean {
  return yahooToEmSecid(symbol) != null;
}

interface EmKlineResp {
  data?: {
    code?: string;
    name?: string;
    klines?: string[];
  };
  rc?: number;
}

/**
 * Fetch ~1y daily OHLCV from East Money and map into Yahoo-shaped TickerRawData.
 */
export async function fetchEmKline(
  symbol: string,
  limit = 280,
): Promise<TickerRawData | null> {
  const secid = yahooToEmSecid(symbol);
  if (!secid) return null;

  const query =
    `?secid=${encodeURIComponent(secid)}` +
    `&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=101&fqt=1&end=20500101&lmt=${limit}`;

  const urls = [
    `https://push2his.eastmoney.com/api/qt/stock/kline/get${query}`,
    `https://push2delay.eastmoney.com/api/qt/stock/kline/get${query}`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      let json: EmKlineResp;
      try {
        json = JSON.parse(text) as EmKlineResp;
      } catch {
        continue;
      }
      const klines = json.data?.klines;
      if (!klines || klines.length === 0) continue;

      const candles: OHLC[] = [];
      for (const row of klines) {
        // date,open,close,high,low,volume,amount,...
        const parts = row.split(",");
        if (parts.length < 6) continue;
        const date = new Date(`${parts[0]}T15:00:00+08:00`);
        const open = Number(parts[1]);
        const close = Number(parts[2]);
        const high = Number(parts[3]);
        const low = Number(parts[4]);
        const volume = Number(parts[5]);
        if (![open, close, high, low].every(Number.isFinite)) continue;
        candles.push({
          date,
          open,
          high,
          low,
          close,
          volume: Number.isFinite(volume) ? volume : 0,
        });
      }
      if (candles.length === 0) continue;

      let high52 = -Infinity;
      let low52 = Infinity;
      for (const c of candles) {
        if (c.high > high52) high52 = c.high;
        if (c.low < low52) low52 = c.low;
      }
      const last = candles[candles.length - 1];

      return {
        symbol,
        currency: "CNY",
        exchangeName: secid.startsWith("1.") ? "SSE" : "SZSE",
        regularMarketPrice: last.close,
        fiftyTwoWeekHigh: high52 === -Infinity ? last.close : high52,
        fiftyTwoWeekLow: low52 === Infinity ? last.close : low52,
        candles,
      };
    } catch {
      /* try next host */
    }
  }
  return null;
}
