import { analyzeTicker, type TickerAnalysis } from "./signals";
import { WATCHLIST, type TickerDef } from "./watchlist";
import { fetchTickerData, type TickerRawData } from "./yahoo";
import { fetchEmKline, isCnAshareOrEtf } from "./eastmoney-kline";
import { loadOhlcvCache, saveOhlcvCache } from "./ohlcv-cache";

const CONCURRENCY = 4;

export interface WatchlistFetchStats {
  attempted: number;
  ok: number;
  empty: number;
  error: number;
  stale: number;
  missing: number;
}

/**
 * Resolve OHLCV for one ticker:
 * - CN A-share / ETF (.SS/.SZ): East Money primary, Yahoo fallback
 * - others: Yahoo (crypto / US / HK / FX)
 */
async function fetchRawForTicker(
  def: TickerDef,
): Promise<{ raw: TickerRawData | null; source: "em" | "yahoo" | null }> {
  if (isCnAshareOrEtf(def.symbol)) {
    const em = await fetchEmKline(def.symbol);
    if (em && em.candles.length > 0) return { raw: em, source: "em" };
    const y = await fetchTickerData(def.symbol);
    if (y && y.candles.length > 0) return { raw: y, source: "yahoo" };
    return { raw: null, source: null };
  }
  const y = await fetchTickerData(def.symbol);
  if (y && y.candles.length > 0) return { raw: y, source: "yahoo" };
  return { raw: null, source: null };
}

function missingCard(def: TickerDef, reason: string): TickerAnalysis {
  return analyzeTicker(def, {
    symbol: def.symbol,
    currency: "",
    exchangeName: "",
    regularMarketPrice: 0,
    fiftyTwoWeekHigh: 0,
    fiftyTwoWeekLow: 0,
    candles: [],
  }, { dataStatus: "missing", dataNote: reason });
}

/**
 * Fetch + analyze the entire watchlist with bounded concurrency.
 * Failures are non-fatal. Last-good cache yields degraded cards;
 * total miss yields a "数据暂缺" card (never silent blank).
 */
export async function analyzeWatchlist(): Promise<TickerAnalysis[]> {
  const out: (TickerAnalysis | null)[] = new Array(WATCHLIST.length).fill(null);
  const stats: WatchlistFetchStats = {
    attempted: WATCHLIST.length,
    ok: 0,
    empty: 0,
    error: 0,
    stale: 0,
    missing: 0,
  };
  let i = 0;

  async function worker() {
    while (i < WATCHLIST.length) {
      const idx = i++;
      const def = WATCHLIST[idx];
      try {
        const { raw, source } = await fetchRawForTicker(def);
        if (raw && raw.candles.length > 0) {
          saveOhlcvCache(raw);
          out[idx] = analyzeTicker(def, raw, {
            dataStatus: "live",
            dataNote: source === "em" ? "East Money" : "Yahoo",
          });
          stats.ok++;
          continue;
        }

        stats.empty++;
        const cached = loadOhlcvCache(def.symbol);
        if (cached) {
          const note = `数据暂缺 · 使用上次成功缓存 (${cached.savedAt.slice(0, 10)})`;
          out[idx] = analyzeTicker(def, cached.data, {
            dataStatus: "stale",
            dataNote: note,
          });
          stats.stale++;
          console.warn(`[trading] ${def.symbol} live miss → last-good cache`);
          continue;
        }

        out[idx] = missingCard(def, "数据暂缺 · 无可用行情与缓存");
        stats.missing++;
        console.warn(`[trading] ${def.symbol} returned no data`);
      } catch (e) {
        stats.error++;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[trading] ${def.symbol} failed: ${msg}`);
        const cached = loadOhlcvCache(def.symbol);
        if (cached) {
          out[idx] = analyzeTicker(def, cached.data, {
            dataStatus: "stale",
            dataNote: `数据暂缺 · 抓取异常后使用缓存 (${cached.savedAt.slice(0, 10)})`,
          });
          stats.stale++;
        } else {
          out[idx] = missingCard(def, `数据暂缺 · ${msg}`);
          stats.missing++;
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, WATCHLIST.length) }, () =>
      worker(),
    ),
  );

  const successLike = stats.ok + stats.stale;
  console.log(
    `[trading] Yahoo/EM success rate: ${successLike}/${stats.attempted}` +
      ` (ok=${stats.ok} stale=${stats.stale} empty=${stats.empty} error=${stats.error} missing=${stats.missing})`,
  );

  return out.filter((x): x is TickerAnalysis => x !== null);
}
