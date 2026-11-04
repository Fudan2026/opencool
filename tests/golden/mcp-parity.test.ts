import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WATCHLIST } from "../../lib/trading/watchlist";

/**
 * GOLDEN: the MCP server must serve the same watchlist as the pipeline.
 * Kills the drift class where mcp/server.mjs's embedded list silently
 * diverges from lib/trading/watchlist.ts (it shipped 11 vs 32 symbols,
 * with a 000001.SS/.SZ semantic trap).
 */
test("golden: MCP watchlist parity with the pipeline watchlist", () => {
  const mcpDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../mcp",
  );
  const fp = path.join(mcpDir, "watchlist.json");
  assert.ok(fs.existsSync(fp), "mcp/watchlist.json missing — run npm run mcp:sync-watchlist");
  const j = JSON.parse(fs.readFileSync(fp, "utf8"));
  assert.ok(Array.isArray(j.entries), "watchlist.json entries must be an array");

  const libSymbols = WATCHLIST.map((t) => t.symbol).sort();
  const mcpSymbols = j.entries.map((e: { symbol: string }) => e.symbol).sort();
  assert.deepEqual(mcpSymbols, libSymbols);

  const libByName = new Map(WATCHLIST.map((t) => [t.symbol, t]));
  for (const e of j.entries) {
    const lib = libByName.get(e.symbol);
    assert.ok(lib, `unknown symbol ${e.symbol}`);
    assert.equal(e.displayName, lib.displayName, `${e.symbol} displayName drift`);
    assert.equal(e.group, lib.group, `${e.symbol} group drift`);
  }
});
