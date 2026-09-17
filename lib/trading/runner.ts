import { analyzeTicker, type TickerAnalysis } from "./signals";
import { WATCHLIST } from "./watchlist";
import { fetchTickerData } from "./yahoo";

const CONCURRENCY = 4;

/**
 * Fetch + analyze the entire watchlist with bounded concurrency.
 * Failures are non-fatal — the affected ticker is dropped.
 */
export async function analyzeWatchlist(): Promise<TickerAnalysis[]> {
  const out: (TickerAnalysis | null)[] = new Array(WATCHLIST.length).fill(null);
  let i = 0;

  async function worker() {
    while (i < WATCHLIST.length) {
      const idx = i++;
      const def = WATCHLIST[idx];
      try {
        const raw = await fetchTickerData(def.symbol);
        if (!raw) {
          console.warn(`[trading] ${def.symbol} returned no data`);
          continue;
        }
        out[idx] = analyzeTicker(def, raw);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[trading] ${def.symbol} failed: ${msg}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, WATCHLIST.length) }, () =>
      worker(),
    ),
  );
  return out.filter((x): x is TickerAnalysis => x !== null);
}
