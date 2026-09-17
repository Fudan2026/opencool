/**
 * Match today's headlines to watchlist aliases — event-driven lite.
 */

import type { ArticleInput } from "../ai/pipeline";
import { WATCHLIST } from "../trading/watchlist";

export interface EventHit {
  symbol: string;
  displayName: string;
  title: string;
  url: string;
  source: string;
  matched: string;
}

export function matchEvents(articles: ArticleInput[], limit = 20): EventHit[] {
  const hits: EventHit[] = [];
  const seen = new Set<string>();
  for (const a of articles) {
    for (const t of WATCHLIST) {
      const keys = [t.displayName, ...(t.aliases ?? []), t.symbol.replace(/\.(SS|SZ|HK)$/i, "")];
      for (const k of keys) {
        if (!k || k.length < 2) continue;
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
