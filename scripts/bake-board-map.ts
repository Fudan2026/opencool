/**
 * Refresh `lib/themes/board-map.json` — the committed Eastmoney board registry
 * that `bake-themes` falls back to when the live registry is unreachable.
 *
 * Board codes and names are near-static metadata, so refreshing once a day is
 * plenty: `daily.yml` never calls this. The low-frequency `board-map` workflow
 * runs it weekly and commits the diff, which keeps the fallback fresh without
 * spending a pipeline request on every edition.
 *
 * Fail-open: on an unreachable registry this exits 0 without touching the
 * committed snapshot, so a network blip can never wipe the fallback.
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";

import { fetchBoardRegistry } from "../lib/invest/board-registry";

const OUT = path.resolve("lib/themes/board-map.json");

async function main() {
  const boards = await fetchBoardRegistry();
  if (!boards?.length) {
    console.error("[board-map] registry unreachable — keeping the committed snapshot");
    return;
  }

  const previous = readPrevious();
  const payload = {
    generatedAt: new Date().toISOString(),
    source: "RPT_EM_BOARD",
    count: boards.length,
    boards: boards
      .map(({ code, name, type }) => ({ code, name, type }))
      .sort((a, b) => a.code.localeCompare(b.code)),
  };

  if (previous && previous === JSON.stringify(payload.boards.map((b) => [b.code, b.name]))) {
    console.log(`[board-map] unchanged (${boards.length} boards)`);
    return;
  }

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`[board-map] wrote ${path.relative(process.cwd(), OUT)} boards=${boards.length}`);
}

/** Existing snapshot as a comparable `[code, name]` list, for a no-op diff. */
function readPrevious(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(OUT, "utf8")) as {
      boards?: Array<{ code?: string; name?: string }>;
    };
    if (!Array.isArray(parsed.boards)) return null;
    return JSON.stringify(
      [...parsed.boards]
        .map((b) => [String(b.code ?? ""), String(b.name ?? "")] as const)
        .sort((a, b) => a[0].localeCompare(b[0])),
    );
  } catch {
    return null;
  }
}

main().catch((e) => {
  console.error(e);
  // fail-open: never fail a refresh run
  process.exit(0);
});
