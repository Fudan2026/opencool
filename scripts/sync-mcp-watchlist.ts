/**
 * Sync mcp/watchlist.json from lib/trading/watchlist.ts — kills the
 * drift class where the MCP server's embedded list diverges from the
 * pipeline's watchlist (it had 11 symbols vs 32, including a
 * 000001.SS/.SZ semantic trap). mcp/server.mjs reads the generated file
 * with its embedded list as fallback. Run via `npm run mcp:sync-watchlist`.
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";

import { WATCHLIST } from "../lib/trading/watchlist";

const OUT = path.join("mcp", "watchlist.json");

const payload = {
  generatedAt: new Date().toISOString(),
  source: "lib/trading/watchlist.ts (npm run mcp:sync-watchlist)",
  entries: WATCHLIST.map((t) => ({
    symbol: t.symbol,
    displayName: t.displayName,
    group: t.group,
  })),
};

fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(
  `[mcp:sync-watchlist] wrote ${OUT} entries=${payload.entries.length}`,
);
