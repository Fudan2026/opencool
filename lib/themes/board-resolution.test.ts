/**
 * End-to-end board resolution against the real Eastmoney payload shape.
 *
 * `lib/themes/themes.test.ts` exercises `resolveBoard()` on a synthetic array,
 * which is why the outage that emptied board heat never turned CI red: the
 * synthetic fixture kept matching while the live fetch returned nothing.
 *
 * `tests/fixtures/em-board-list.json` is a real capture of the paginated
 * `m:90+t:3` concept-board response (554 boards, 6 pages, captured
 * 2026-11-13). This test runs the same parse-and-resolve path the baker uses,
 * so a payload-shape change fails here instead of shipping `boards=0`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchJson } from "../../lib/invest/http-json";
import { resolveBoard, THEME_CATALOG } from "../../lib/themes/catalog";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "..", "..", "tests", "fixtures", "em-board-list.json");

interface BoardRow {
  code: string;
  name: string;
  changePct: number;
}

/** Same mapping `scripts/bake-themes.ts` applies to each `diff` row. */
function toBoardRows(raw: string): { boards: BoardRow[]; total: number } {
  const j = JSON.parse(raw) as {
    data?: { total?: number; diff?: Array<{ f12: string; f14: string; f3: number }> };
  };
  const boards = (j.data?.diff ?? []).map((d) => ({
    code: String(d.f12),
    name: String(d.f14),
    changePct: Number(d.f3) || 0,
  }));
  return { boards, total: j.data?.total ?? 0 };
}

test("the captured board payload parses into resolvable boards", () => {
  const { boards, total } = toBoardRows(readFileSync(FIXTURE, "utf8"));

  // Shape: every board must have a code, a name, and a numeric move.
  assert.ok(boards.length > 500, `expected the full board list, got ${boards.length}`);
  assert.equal(total, 554);
  for (const b of boards) {
    assert.match(b.code, /^BK\d+$/, `unexpected board code: ${b.code}`);
    assert.ok(b.name.length > 0);
    assert.equal(typeof b.changePct, "number");
  }
});

test("the theme catalog resolves a healthy share of boards", () => {
  const { boards } = toBoardRows(readFileSync(FIXTURE, "utf8"));

  const resolved = THEME_CATALOG.map((th) => ({ theme: th, board: resolveBoard(th, boards) }));
  const hits = resolved.filter((r) => r.board !== null);

  // The shipped catalog matched 15/24 themes when the endpoint was healthy
  // (CI run 42986364645, 2026-11-11 13:00). A regression that breaks parsing
  // drives this to zero — that is the failure this test exists to catch.
  assert.ok(
    hits.length >= 10,
    `only ${hits.length}/${THEME_CATALOG.length} themes resolved a board; ` +
      `a healthy board list resolves well over 10. Resolved: ` +
      hits.map((h) => `${h.theme.name}->${h.board?.code}`).join(", "),
  );

  // Board codes must be real Eastmoney codes, not empty placeholders.
  for (const h of hits) {
    assert.match(h.board!.code, /^BK\d+$/);
  }
});

test("fetchJson parses the stubbed board payload end to end", async () => {
  const raw = readFileSync(FIXTURE, "utf8");
  const url = "https://push2.eastmoney.com/api/qt/clist/get?fs=m:90+t:3";

  const impl = (async () =>
    new Response(raw, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  const j = await fetchJson<{ data?: { diff?: unknown[] } }>(url, {
    fetchImpl: impl,
    attempts: 1,
  });
  assert.equal(j?.data?.diff?.length, 554, "the shared helper lost the board rows");
});
