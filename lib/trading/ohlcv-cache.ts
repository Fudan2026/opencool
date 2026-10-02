/**
 * Last-good OHLCV sidecar cache under daily_reports/.cache/ohlcv/.
 * Owned by the pipeline (same tree as report output); gitignored via daily_reports/.
 */

import fs from "node:fs";
import path from "node:path";

import type { OHLC, TickerRawData } from "./yahoo";

const CACHE_DIR = path.join("daily_reports", ".cache", "ohlcv");

function safeName(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9._=-]/g, "_");
}

function cachePath(symbol: string): string {
  return path.join(CACHE_DIR, `${safeName(symbol)}.json`);
}

interface CachedPayload {
  savedAt: string;
  data: {
    symbol: string;
    currency: string;
    exchangeName: string;
    regularMarketPrice: number;
    fiftyTwoWeekHigh: number;
    fiftyTwoWeekLow: number;
    candles: Array<{
      date: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>;
  };
}

export function saveOhlcvCache(data: TickerRawData): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const payload: CachedPayload = {
      savedAt: new Date().toISOString(),
      data: {
        symbol: data.symbol,
        currency: data.currency,
        exchangeName: data.exchangeName,
        regularMarketPrice: data.regularMarketPrice,
        fiftyTwoWeekHigh: data.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: data.fiftyTwoWeekLow,
        candles: data.candles.map((c) => ({
          date: c.date.toISOString(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        })),
      },
    };
    fs.writeFileSync(cachePath(data.symbol), JSON.stringify(payload), "utf8");
  } catch {
    /* cache write is best-effort */
  }
}

export function loadOhlcvCache(
  symbol: string,
): { data: TickerRawData; savedAt: string } | null {
  try {
    const p = cachePath(symbol);
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as CachedPayload;
    if (!raw?.data?.candles?.length) return null;
    const candles: OHLC[] = raw.data.candles.map((c) => ({
      date: new Date(c.date),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
    return {
      savedAt: raw.savedAt,
      data: {
        symbol: raw.data.symbol,
        currency: raw.data.currency,
        exchangeName: raw.data.exchangeName,
        regularMarketPrice: raw.data.regularMarketPrice,
        fiftyTwoWeekHigh: raw.data.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: raw.data.fiftyTwoWeekLow,
        candles,
      },
    };
  } catch {
    return null;
  }
}
