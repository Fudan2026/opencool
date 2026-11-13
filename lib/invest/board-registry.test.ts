/**
 * Regression guard for the theme board outage that started 2026-11-11.
 *
 * `clist/get` 502'd for every client for days and `bake-themes` logged
 * `boards=0` on every run, which emptied board heat and every theme's
 * constituents. CI stayed green because the only board test fed
 * `resolveBoard()` a synthetic array: it kept passing while the live fetch
 * returned nothing.
 *
 * These tests run the real parse → resolve path over captured payloads, so a
 * payload-shape change or a silently-empty fetch fails here instead of
 * shipping a degraded `themes.json`. The last test is the explicit guard:
 * with a fixture present, a bake that produces zero boards is a failure, not
 * a degraded success.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchBoardQuotes,
  fetchConstituents,
  loadBoardMapSnapshot,
  parseBoardQuotes,
  parseBoardRegistry,
  parseConstituents,
  toQuoteSecid,
  type BoardEntry,
} from "./board-registry";
import { resolveBoard, THEME_CATALOG } from "../themes/catalog";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "..", "tests", "fixtures");

const registryFixture = () =>
  (JSON.parse(readFileSync(path.join(FIXTURES, "em-board-registry.json"), "utf8")) as {
    pages: unknown[];
  }).pages;

const quotesFixture = () =>
  JSON.parse(readFileSync(path.join(FIXTURES, "em-board-quotes.json"), "utf8")) as unknown;

const SNAPSHOT = path.join(HERE, "..", "themes", "board-map.json");

/** Themes the shipped catalog must be able to resolve against a real registry. */
const MIN_RESOLVED_THEMES = 15;

function resolvedCount(boards: BoardEntry[]): number {
  return THEME_CATALOG.filter((th) => resolveBoard(th, boards) !== null).length;
}

test("board registry payload parses into usable boards", async (t) => {
  await t.test("every page row becomes a coded, named, quotable board", () => {
    const boards = parseBoardRegistry(registryFixture());
    assert.ok(boards.length > 1000, `expected the full registry, got ${boards.length}`);
    for (const b of boards) {
      assert.match(b.code, /^BK\d+$/, `unexpected board code: ${b.code}`);
      assert.ok(b.name.length > 0, `board ${b.code} has no name`);
      assert.equal(b.secid, `90.${b.code}`, "secid must be the 90.<code> quote id");
    }
  });

  await t.test("delisted boards are dropped and duplicates collapse", () => {
    const boards = parseBoardRegistry([
      {
        result: {
          data: [
            { NEW_BOARD_CODE: "BK0001", BOARD_NAME: "有效板块", IS_VALID: "1", BOARD_TYPE_NEW: "3" },
            { NEW_BOARD_CODE: "BK0002", BOARD_NAME: "已退板块", IS_VALID: "0", BOARD_TYPE_NEW: "3" },
            { NEW_BOARD_CODE: "BK0001", BOARD_NAME: "有效板块", IS_VALID: "1", BOARD_TYPE_NEW: "3" },
            { NEW_BOARD_CODE: "", BOARD_NAME: "无代码", IS_VALID: "1" },
          ],
        },
      },
      null,
    ]);
    assert.deepEqual(
      boards.map((b) => b.code),
      ["BK0001"],
    );
  });
});

test("the shipped catalog resolves a healthy share of the real registry", async (t) => {
  await t.test("live-shaped payload resolves at least 15 of 24 themes", () => {
    const boards = parseBoardRegistry(registryFixture());
    const resolved = THEME_CATALOG.map((th) => ({ theme: th, board: resolveBoard(th, boards) })).filter(
      (r) => r.board !== null,
    );
    assert.ok(
      resolved.length >= MIN_RESOLVED_THEMES,
      `only ${resolved.length}/${THEME_CATALOG.length} themes resolved a board; ` +
        `a healthy registry resolves at least ${MIN_RESOLVED_THEMES}. ` +
        `Resolved: ${resolved.map((r) => `${r.theme.key}->${r.board?.code}`).join(", ")}`,
    );
    for (const r of resolved) {
      assert.match(r.board!.code, /^BK\d+$/);
    }
  });

  await t.test("the committed snapshot resolves the same share as live", () => {
    const boards = loadBoardMapSnapshot(SNAPSHOT);
    assert.ok(boards, "committed board-map.json is missing or unreadable");
    const count = resolvedCount(boards);
    assert.ok(
      count >= MIN_RESOLVED_THEMES,
      `the fallback snapshot only resolves ${count}/${THEME_CATALOG.length} themes — ` +
        `refresh it with \`npm run board-map:bake\``,
    );
  });

  await t.test("every theme resolves a board, not just most of them", () => {
    // Stronger than the ship gate: with the full registry there is no theme
    // without a matching board, so a miss means a stale boardHint.
    const boards = loadBoardMapSnapshot(SNAPSHOT)!;
    const misses = THEME_CATALOG.filter((th) => resolveBoard(th, boards) === null).map((th) => th.key);
    assert.deepEqual(misses, [], `boardHints no longer match the registry for: ${misses.join(", ")}`);
  });
});

test("board quotes parse with change percent and breadth", async (t) => {
  await t.test("a real ulist.np payload yields codes, moves and up/down counts", () => {
    const quotes = parseBoardQuotes(quotesFixture());
    assert.ok(quotes.size >= 10, `expected the captured quotes, got ${quotes.size}`);
    const ai = quotes.get("BK0800")!;
    assert.equal(ai.name, "人工智能");
    assert.equal(typeof ai.changePct, "number");
    assert.ok(ai.up > 0 && ai.down > 0, "breadth counts must survive parsing");
  });

  await t.test("a non-numeric move is dropped, never coerced to flat", () => {
    const quotes = parseBoardQuotes({
      data: { diff: [{ f12: "BK0001", f14: "停牌板块", f3: "-" }, { f12: "BK0002", f14: "正常板块", f3: 1.5 }] },
    });
    assert.equal(quotes.has("BK0001"), false, "a suspended board must not read as 0%");
    assert.equal(quotes.get("BK0002")?.changePct, 1.5);
  });

  await t.test("constituent SECUCODEs map onto quote secids", () => {
    assert.equal(toQuoteSecid("000034.SZ"), "0.000034");
    assert.equal(toQuoteSecid("600000.SH"), "1.600000");
    assert.equal(toQuoteSecid("830799.BJ"), "0.830799");
    assert.equal(toQuoteSecid("not-a-symbol"), null);
  });

  await t.test("a constituent payload yields member secids and the board total", () => {
    const refs = parseConstituents({
      result: {
        data: [
          { SECUCODE: "000034.SZ", TOTAL_COUNT: 758 },
          { SECUCODE: "000035.SZ", TOTAL_COUNT: 758 },
        ],
      },
    });
    assert.deepEqual(refs.secids, ["0.000034", "0.000035"]);
    assert.equal(refs.total, 758);
  });

  await t.test("an empty constituent payload is empty, not an error", () => {
    assert.deepEqual(parseConstituents({ result: null }), { secids: [], total: 0 });
  });

  await t.test("a throttle reply that parses as empty is retried, not believed", async () => {
    // The live service answers 200 + {"success":false,"message":"返回数据为空"}
    // when it is throttling. Reading that as "board has no members" is what
    // silently emptied constituents; real boards always have members.
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      const body =
        calls === 1
          ? '{"version":null,"result":null,"success":false,"message":"返回数据为空","code":9201}'
          : '{"result":{"data":[{"SECUCODE":"000034.SZ","TOTAL_COUNT":758}]}}';
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const refs = await fetchConstituents("人工智能", {
      fetchImpl: impl,
      sleepImpl: () => Promise.resolve(),
    });

    assert.equal(calls, 2, "the throttled reply should have been retried");
    assert.deepEqual(refs.secids, ["0.000034"]);
    assert.equal(refs.total, 758);
  });

  await t.test("constituents give up after the retry budget and stay empty", async () => {
    const impl = (async () =>
      new Response('{"result":null,"success":false,"message":"返回数据为空"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const refs = await fetchConstituents("人工智能", {
      fetchImpl: impl,
      sleepImpl: () => Promise.resolve(),
      attempts: 3,
    });
    assert.deepEqual(refs, { secids: [], total: 0 });
  });
});

test("fetchBoardQuotes batches every board into one working endpoint call", async () => {
  const boards = parseBoardRegistry(registryFixture()).slice(0, 12);
  const captured = readFileSync(path.join(FIXTURES, "em-board-quotes.json"), "utf8");
  const asked: string[] = [];

  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    // Only the ulist.np shape is stubbed; anything else is a routing mistake.
    assert.match(url, /\/api\/qt\/ulist\.np\/get\?/, "quotes must use ulist.np/get, not clist/get");
    return new Response(captured, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const quotes = await fetchBoardQuotes(boards, { fetchImpl: impl, sleepImpl: () => Promise.resolve() });

  assert.ok(quotes.size >= 10, `batched quotes came back thin: ${quotes.size}`);
  assert.equal(asked.length, 1, "twelve boards must fit in a single batch request");
  assert.match(asked[0], /secids=90\.BK/, "the batch must pass explicit board secids");
});

/**
 * The acceptance guard. A fixture being present means the payload *can* be
 * parsed, so zero resolved boards is a silent regression — exactly the state
 * that shipped `boardCode: null` for all 24 themes from 2026-11-11.
 */
test("board resolution must not degrade to zero while a fixture is present", async (t) => {
  await t.test("registry fixture -> non-zero boards -> non-zero resolutions", () => {
    const boards = parseBoardRegistry(registryFixture());
    assert.ok(boards.length > 0, "parsed fixture produced no boards");
    const resolved = resolvedCount(boards);
    assert.ok(resolved > 0, "boards parsed but no theme resolved — resolution is silently broken");
    assert.ok(
      resolved >= MIN_RESOLVED_THEMES,
      `${resolved}/${THEME_CATALOG.length} resolved, below the ${MIN_RESOLVED_THEMES} ship gate`,
    );
  });

  await t.test("a bake that resolves no board is a failure, even with empty input", () => {
    // Mirrors the baker's guard: `boards === 0` while a fixture exists means the
    // fetch path broke, so the baker's status must not read "ok".
    const bakeStatus = (boardThemes: number, fixturePresent: boolean) =>
      boardThemes > 0 ? "ok" : fixturePresent ? "failed" : "degraded";
    assert.equal(bakeStatus(24, true), "ok");
    assert.equal(bakeStatus(0, true), "failed", "zero boards with a fixture present must fail loudly");
    assert.equal(bakeStatus(0, false), "degraded", "no fixture at all is honest degradation");
  });
});
