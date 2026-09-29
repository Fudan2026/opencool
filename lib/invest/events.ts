/**
 * Match today's headlines to watchlist aliases — event-driven lite.
 * Title-based only; no LLM. Emits per-ticker related article counts.
 */

import type { ArticleInput } from "../ai/pipeline";
import { WATCHLIST, type TickerDef } from "../trading/watchlist";

export interface EventHit {
  symbol: string;
  displayName: string;
  title: string;
  url: string;
  source: string;
  matched: string;
}

export interface TickerEventCount {
  symbol: string;
  displayName: string;
  count: number;
}

/** Build match keys: display name, aliases, bare ticker code, common synonyms. */
export function matchKeysForTicker(t: TickerDef): string[] {
  const bare = t.symbol.replace(/\.(SS|SZ|HK)$/i, "");
  const keys = new Set<string>();
  keys.add(t.displayName);
  if (t.displayNameEn) keys.add(t.displayNameEn);
  for (const a of t.aliases ?? []) keys.add(a);
  if (/^\d{6}$/.test(bare)) keys.add(bare);
  // Strip common suffixes for broader title hits
  const stripped = t.displayName
    .replace(/\s*\(.*\)\s*$/, "")
    .replace(/(股份|集团|控股|有限|公司)+$/g, "");
  if (stripped.length >= 2) keys.add(stripped);
  return [...keys].filter((k) => k && k.length >= 2);
}

export function matchEvents(articles: ArticleInput[], limit = 40): EventHit[] {
  const hits: EventHit[] = [];
  const seen = new Set<string>();
  const keyCache = new Map<string, string[]>();

  for (const a of articles) {
    for (const t of WATCHLIST) {
      let keys = keyCache.get(t.symbol);
      if (!keys) {
        keys = matchKeysForTicker(t);
        keyCache.set(t.symbol, keys);
      }
      for (const k of keys) {
        if (!a.title.includes(k)) continue;
        const id = `${t.symbol}|${a.url}`;
        if (seen.has(id)) continue;
        seen.add(id);
        hits.push({
          symbol: t.symbol,
          displayName: t.displayName,
          title: a.title,
          url: a.url,
          source: a.source,
          matched: k,
        });
        break;
      }
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Aggregate related-article counts per ticker from event hits. */
export function countEventsByTicker(hits: EventHit[]): TickerEventCount[] {
  const map = new Map<string, TickerEventCount>();
  for (const h of hits) {
    const cur = map.get(h.symbol);
    if (cur) cur.count++;
    else
      map.set(h.symbol, {
        symbol: h.symbol,
        displayName: h.displayName,
        count: 1,
      });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}
