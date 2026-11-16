/**
 * The board atlas — verification that every published row is real.
 *
 * The atlas exists to make one claim trustworthy: "this company belongs to
 * this industry board". Everything below fails if that claim degrades:
 *
 *   1. **Zero unverified rows.** Every `boardCode` in the committed atlas
 *      must exist in the committed board registry (`board-map.json`) and be
 *      an *industry* board (type 2) — the only kind the tape quotes on every
 *      capture, so an atlas row is always a measurable target.
 *   2. **An alias resolves to exactly one company.** A duplicated alias is
 *      not a judgement call: it is excluded and recorded in `ambiguous`.
 *      The published alias→company map must be a bijection.
 *   3. **No alias names a sector or an index.** Aliases that appear inside a
 *      board name, and tickers that collide with quoted index codes, are
 *      excluded by the baker; these tests keep them excluded.
 *   4. **Indexes match the tape's own instruments.** The three index rows are
 *      exactly the codes `fetchMarketOverview` captures, and the market
 *      fallback's 上证指数 is among them.
 *   5. **Attribution behaviour.** The atlas is consulted only after the
 *      explicit entity table, only when the tape quoted the board, and never
 *      on a cold tape — `pending` semantics are untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadBoardAtlas,
  parseAtlas,
  matchAtlas,
  resolveAtlasTarget,
  resetBoardAtlasCache,
  aliasPosition,
  type BoardAtlas,
} from "./atlas";
import { NOT_GENERIC } from "./atlas-curation";
import { attributeStory, MARKET_INDEX_CODE } from "./attribution";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loaded = loadBoardAtlas();
assert.ok(loaded, "lib/reactions/board-atlas.json must exist and parse — run npm run atlas:bake");
const atlas: BoardAtlas = loaded;

/**
 * The committed registry snapshot, read raw because the
 * `loadBoardMapSnapshot` loader drops each board's `type` — and the industry
 * filter is the whole verification here.
 */
function snapshotBoards(): Array<{ code: string; name: string; type: number }> {
  const raw = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../themes/board-map.json"), "utf8"),
  ) as { boards?: Array<{ code?: unknown; name?: unknown; type?: unknown }> };
  return (raw.boards ?? []).flatMap((b) =>
    typeof b.code === "string" && typeof b.name === "string" && typeof b.type === "number"
      ? [{ code: b.code, name: b.name, type: b.type }]
      : [],
  );
}

/** Industry boards from the committed registry snapshot — the tape's universe. */
function industryBoardCodes(): Set<string> {
  return new Set(snapshotBoards().filter((b) => b.type === 2).map((b) => b.code));
}

test("atlas — the committed file parses and is non-trivial", () => {
  assert.ok(atlas, "board-atlas.json must exist and parse");
  assert.equal(atlas.schemaVersion, 1);
  assert.ok(atlas.companies.length >= 1000, `companies=${atlas.companies.length} — a fetch failure shipped an almost-empty atlas`);
  assert.ok(atlas.boards >= 400, `boards=${atlas.boards} — the bake did not cover the registry`);
  assert.equal(atlas.indexes.length, 3);
});

test("atlas — zero unverified rows: every boardCode is a real industry board", () => {
  const codes = industryBoardCodes();
  assert.ok(codes.size >= 400, "board-map.json snapshot looks wrong — the verification itself is broken");
  const bad = atlas.companies.filter((c) => !codes.has(c.boardCode));
  assert.deepEqual(
    bad.map((c) => `${c.company}:${c.boardCode}`),
    [],
    "atlas rows pointing outside the committed industry registry are unverified",
  );
  // The boardName must agree with the registry's own name for that board.
  const nameOf = new Map(snapshotBoards().map((b) => [b.code, b.name]));
  const misnamed = atlas.companies.filter((c) => nameOf.get(c.boardCode) !== c.boardName);
  assert.deepEqual(misnamed.map((c) => `${c.company}:${c.boardCode}:${c.boardName}`), []);
});

test("atlas — every alias resolves to exactly one company (no collisions ship)", () => {
  const owner = new Map<string, string>(); // alias -> company name
  const collisions: string[] = [];
  for (const c of atlas.companies) {
    for (const alias of c.aliases) {
      if (owner.has(alias)) {
        collisions.push(`${alias}: ${owner.get(alias)} / ${c.company}`);
      } else {
        owner.set(alias, c.company);
      }
    }
  }
  assert.deepEqual(collisions, [], "a shipped alias resolving to two companies is the one thing the atlas may never do");
  // And a collision excluded from matching must be listed in `ambiguous` —
  // exclusions are recorded, never silent.
  for (const m of atlas.ambiguous) {
    if (m.reason === "duplicate") assert.ok((m.companies ?? []).length >= 2, `${m.alias}: a duplicate must name both companies`);
  }
});

test("atlas — no alias is a sector word or a quoted index code", () => {
  // The baker's rule is containment: an alias inside ANY board name (region
  // and concept names are sector words too) would map sector headlines to one
  // company. The test enforces the same rule over the shipped file, minus the
  // reviewed exceptions in NOT_GENERIC (a company-named board is not a sector
  // word — e.g. 东方财富热股 is named after 东方财富).
  const exceptions = new Set(Object.keys(NOT_GENERIC));
  const haystack = `|${snapshotBoards().map((b) => b.name).join("|")}|`;
  const generic = atlas.companies.flatMap((c) =>
    c.aliases.filter((a) => !exceptions.has(a) && haystack.includes(a)).map((a) => `${c.company}:${a}`),
  );
  assert.deepEqual(
    generic.slice(0, 20),
    [],
    "an alias inside a board name would map sector headlines to one company",
  );
  // 平安银行's ticker is the 上证指数 code; such tickers must never ship.
  const indexCodes = new Set(atlas.indexes.map((i) => i.code));
  const tickerClash = atlas.companies.filter((c) => indexCodes.has(c.code) && c.aliases.includes(c.code));
  assert.deepEqual(
    tickerClash.map((c) => `${c.company}:${c.code}`),
    [],
    "a ticker that is also an index code is ambiguous and must be excluded",
  );
});

test("atlas — index rows are exactly the instruments the tape quotes", () => {
  // `fetchMarketOverview` captures 1.000001 / 0.399001 / 0.399006; hardcoding
  // the expectation here fails the test the day that capture list changes
  // without the atlas following it.
  assert.deepEqual(
    atlas.indexes.map((i) => i.code).sort(),
    ["000001", "399001", "399006"],
  );
  assert.ok(atlas.indexes.some((i) => i.code === MARKET_INDEX_CODE), "the market fallback's index must be alias-addressable");
  for (const i of atlas.indexes) {
    assert.ok(i.aliases.length >= 1);
    assert.ok(i.aliases.includes(i.name), "the index's own tape name must be an alias");
  }
  // Index aliases must not collide with company aliases either.
  const companyAliases = new Set(atlas.companies.flatMap((c) => c.aliases));
  const clash = atlas.indexes.flatMap((i) => i.aliases.filter((a) => companyAliases.has(a)));
  assert.deepEqual(clash, []);
});

test("atlas — parseAtlas rejects malformed files instead of guessing", () => {
  resetBoardAtlasCache();
  assert.equal(parseAtlas("{ not json"), null);
  assert.equal(parseAtlas('{"schemaVersion":2}'), null);
  assert.equal(parseAtlas(JSON.stringify({ schemaVersion: 1, companies: [], indexes: [] })), null); // ambiguous missing
  assert.equal(loadBoardAtlas("/nonexistent/atlas.json"), null, "a missing file must degrade to the explicit-links path");
});

test("atlas — matching is literal, word-bounded for ASCII, deterministic", () => {
  assert.equal(aliasPosition("沪指跌0.5%", "沪指"), 0);
  assert.equal(aliasPosition("601318创年内新高", "601318"), 0);
  // A longer number must not satisfy a 6-digit alias.
  assert.equal(aliasPosition("26013180", "601318"), -1);
  assert.equal(aliasPosition("x601318y", "601318"), -1);

  const guizhou = atlas.companies.find((c) => c.company === "贵州茅台");
  assert.ok(guizhou, "贵州茅台 must be in the atlas (a 白酒 member)");
  const m = matchAtlas("贵州茅台中期分红方案出炉", atlas);
  assert.equal(m.length, 1);
  assert.equal(m[0].company?.company, "贵州茅台");

  // Ambiguous short forms are excluded from the file itself, so a headline
  // that names two banks' shared fragment resolves neither. 平安 (中国平安 vs
  // 平安银行) and 兴业 (兴业银行 vs 兴业证券) were generated and then rejected —
  // they must be recorded in `ambiguous`. 中信/民生/浪潮 were never safe
  // enough to generate at all — they must simply not exist as aliases.
  const ambiguousAliases = new Set(atlas.ambiguous.map((x) => x.alias));
  for (const rejected of ["平安", "兴业"]) {
    assert.ok(ambiguousAliases.has(rejected), `${rejected} was rejected and must be recorded as ambiguous`);
  }
  const shipped = new Set(atlas.companies.flatMap((c) => c.aliases));
  for (const neverGenerated of ["中信", "民生", "浪潮", "美的", "平安", "兴业"]) {
    assert.ok(!shipped.has(neverGenerated), `${neverGenerated} must never auto-link`);
  }
  const r = resolveAtlasTarget("平安集团公告", atlas);
  assert.equal(r, null, "平安 is ambiguous (中国平安/平安银行) and must not auto-link");

  // Earliest match wins; ties break to the company (a sector claim beats an
  // index observation).
  const first = resolveAtlasTarget("贵州茅台涨停，沪指微涨", atlas);
  assert.equal(first?.kind, "company");
  const indexFirst = resolveAtlasTarget("沪指微涨，贵州茅台涨停", atlas);
  assert.equal(indexFirst?.kind, "index", "the earliest-named subject is the story's subject");
  const onlyIndex = resolveAtlasTarget("创业板指涨超1%", atlas);
  assert.equal(onlyIndex?.kind, "index");
  assert.equal(onlyIndex?.match.index?.code, "399006");
});

test("atlas — tie-breaks are deterministic and cover the full-tie cases", () => {
  // A synthetic atlas, passed directly: the tie-break rules are only reachable
  // with same-position matches, which the committed file happens never to
  // produce — so the fixture manufactures them.
  const syn: BoardAtlas = {
    schemaVersion: 1,
    generatedAt: "test",
    source: "test",
    registry: "snapshot",
    boards: 1,
    companies: [
      { company: "甲公司", code: "600001", boardCode: "BK1001", boardName: "测试一", aliases: ["同位"] },
      { company: "乙公司", code: "600002", boardCode: "BK1002", boardName: "测试二", aliases: ["同位更长"] },
    ],
    indexes: [{ code: "000001", name: "上证指数", aliases: ["同位指"] }],
    ambiguous: [],
  };
  // Same position, different lengths: the longer alias is the more specific
  // claim and wins.
  const longer = resolveAtlasTarget("同位更长与同位涨停", syn);
  assert.equal(longer?.match.company?.company, "乙公司");
  // A full tie between a company and an index: the sector claim beats the
  // index observation.
  const tie: BoardAtlas = {
    ...syn,
    companies: [{ company: "甲公司", code: "600001", boardCode: "BK1001", boardName: "测试一", aliases: ["同位词"] }],
    indexes: [{ code: "000001", name: "上证指数", aliases: ["同位词"] }],
  };
  assert.equal(tie.companies[0].aliases[0], tie.indexes[0].aliases[0]);
  const full = resolveAtlasTarget("同位词异动", tie);
  assert.equal(full?.kind, "company", "on a full tie the company wins");
});

/* ------------------------------------------------------------------ */
/* Attribution integration                                             */
/* ------------------------------------------------------------------ */

/** Warm context: every board/index the tests need, quoted. */
function warmCtx(over: Partial<Parameters<typeof attributeStory>[1]> = {}) {
  return {
    themeBoards: new Map([
      ["ai", { code: "BK0800", name: "人工智能" }],
      ["ai-compute", { code: "BK1134", name: "算力" }],
    ]),
    tapeStarted: true,
    hasIndex: () => true,
    hasBoard: () => true,
    ...over,
  };
}

const STORY = (over: Record<string, unknown> = {}) => ({
  id: "st_atlas",
  firstSeenAt: "2026-11-16T09:00:00+08:00",
  firstEdition: "2026-11-16/06",
  topic: "global-markets",
  entities: [],
  ...over,
});

test("attribution — the atlas is a consulted table, after the explicit links", async (t) => {
  const maotai = atlas.companies.find((c) => c.company === "贵州茅台")!;

  await t.test("a title naming a member company is measured on its verified board", () => {
    const a = attributeStory(STORY({ title: "贵州茅台：拟实施中期分红" }), warmCtx());
    assert.equal(a.attribution, "entity");
    assert.equal(a.target, `board:${maotai.boardCode}`);
    assert.equal(a.targetLabel, maotai.boardName);
    assert.equal(a.entity, "贵州茅台");
    assert.match(a.attributionReason, /verified constituent/);
  });

  await t.test("an explicit entity link wins over an atlas title match", () => {
    const a = attributeStory(
      STORY({ title: "贵州茅台", topic: "tech-ai", entities: ["nvidia"] }),
      warmCtx(),
    );
    assert.equal(a.attribution, "entity");
    assert.equal(a.entity, "nvidia", "the curated table is preferred, the atlas is second");
  });

  await t.test("the atlas requires the tape to have quoted the board", () => {
    const a = attributeStory(
      STORY({ title: "贵州茅台：拟实施中期分红" }),
      warmCtx({ hasBoard: () => false }),
    );
    assert.notEqual(a.target, `board:${maotai.boardCode}`, "a mapping the tape cannot measure must not pin the story");
    assert.equal(a.attribution, "market");
  });

  await t.test("a title naming an index is measured on that index, still market", () => {
    const a = attributeStory(STORY({ title: "创业板指涨超1%，新能源车领涨" }), warmCtx());
    assert.equal(a.attribution, "market");
    assert.equal(a.target, "index:399006");
    assert.equal(a.entity, null, "an index match never populates the entity field");
    assert.match(a.attributionReason, /never a sector claim/);
  });

  await t.test("an index the tape did not quote falls through, never guesses", () => {
    const a = attributeStory(
      STORY({ title: "创业板指涨超1%" }),
      warmCtx({ hasIndex: (code: string) => code === "000001" }),
    );
    assert.equal(a.attribution, "market");
    assert.equal(a.target, `index:${MARKET_INDEX_CODE}`, "falls back to the quoted proxy, not the unquoted named index");
  });

  await t.test("a cold tape stays pending whether or not the title has an atlas hit", () => {
    const cold = { themeBoards: new Map(), tapeStarted: false, hasIndex: () => false, hasBoard: () => false };
    for (const title of [undefined, "贵州茅台涨停", "沪指大涨"]) {
      const a = attributeStory(STORY({ title }), cold);
      assert.equal(a.attribution, "pending", `title=${title} must be pending on a cold tape`);
      assert.equal(a.target, null);
      assert.equal(a.attributionPending, true);
      assert.match(a.attributionReason, /tape has not started/);
    }
  });

  await t.test("a cold tape still names the atlas candidate it could not resolve", () => {
    const a = attributeStory(STORY({ title: "贵州茅台涨停" }), {
      themeBoards: new Map(),
      tapeStarted: false,
      hasIndex: () => false,
    });
    assert.match(a.attributionReason, /贵州茅台/);
  });
});
