import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * i18n parity guard for the strings this increment adds.
 *
 * The repo's rule is that every display string exists in both `TEXTS_ZH` and
 * `TEXTS_EN`. There is no test for that today (audit §5 increment 3 flags it as
 * a latent hole), so this covers the keys the topic block introduces without
 * pretending to close the whole hole.
 *
 * Deliberately source-parsing rather than importing: `render.ts` resolves
 * `REPORT_LOCALE` at module init, so an import can only ever see one table.
 */

const RENDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../lib/output/render.ts",
);

/** Keys declared in one `const TEXTS_XX … = { … }` block. */
function keysOf(locale: "ZH" | "EN"): string[] {
  const src = fs.readFileSync(RENDER, "utf8");
  const start = src.indexOf(`const TEXTS_${locale}`);
  assert.ok(start >= 0, `TEXTS_${locale} not found`);
  // Walk braces so nested objects/multiline values cannot end the block early.
  let depth = 0;
  let end = start;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const block = src.slice(start, end);
  const keys = new Set<string>();
  // Top-level keys only: two-space indent inside the object literal.
  for (const m of block.matchAll(/^ {2}(\w+):/gm)) keys.add(m[1]);
  return [...keys].sort();
}

test("i18n: the topic and integrity blocks' strings exist in both locales", async (t) => {
  const zh = keysOf("ZH");
  const en = keysOf("EN");

  await t.test("no key is missing from either table", () => {
    assert.deepEqual(
      zh.filter((k) => !en.includes(k)),
      [],
      "keys only in TEXTS_ZH",
    );
    assert.deepEqual(
      en.filter((k) => !zh.includes(k)),
      [],
      "keys only in TEXTS_EN",
    );
  });

  await t.test("the keys this increment adds are all paired", () => {
    for (const key of [
      "laneZh",
      "laneExternal",
      "topicGlobalMarkets",
      "topicWorld",
      "topicTechAi",
      "topicPolicy",
      "topicFilings",
      "topicOpinion",
      "viewByTopic",
      "viewBySource",
      "laneEmpty",
      "navIntegrity",
      // Integrity page (/integrity.html, increments 5/6). Every string on that
      // page is user-facing, and the page exists to be read by a human deciding
      // whether to trust the data — an untranslated cell there is a hole in the
      // one surface whose job is to have no holes.
      "integrityTitle",
      "integrityTagline",
      "integrityIntro",
      "integrityNoTapeTitle",
      "integrityNoTapeBody",
      "integrityTapeStarted",
      "integritySummary",
      "integritySummaryLine",
      "integrityCoveragePct",
      "integrityCoverageNA",
      "integrityDaysHeading",
      "integrityDayRow",
      "integrityDayClosed",
      "integrityDayForced",
      "integrityDayBeforeLaunch",
      "integrityDayComplete",
      "integrityGapsHeading",
      "integrityNoGaps",
      "integrityRevisionsHeading",
      "integrityRevisionsLine",
      "integrityFirstSeenHeading",
      "integrityFirstSeenLine",
      "integrityFirstSeenMissing",
      "integrityHorizonHeading",
      "integrityHorizonUnavailable",
      "integritySectionsHeading",
      "integrityContractHeading",
      "integrityContractPromise",
      "integrityContractNotPromise",
      "integrityDeprecationHeading",
      "integrityDeprecationBody",
      "integrityEndpointsHeading",
      "integrityEndpointManifest",
      "integrityEndpointAsof",
      "integrityEndpointCoverage",
      "integrityEndpointStories",
      "integrityEndpointThemes",
      "integrityEndpointReactions",
      "integrityGapReasonMissed",
      "integrityDayPendingInline",
      "integrityGapReasonFuture",
      "integrityGapReasonSectionUnavailable",
      "integrityGapReasonBaseMissing",
      "integrityGapReasonInputMissing",
      "integrityGapReasonInputUnreadable",
      "integritySectionIndices",
      "integritySectionIndustries",
      "integritySectionThemes",
      "integritySectionFundFlows",
      "integritySectionLimitPool",
      "integrityNavHome",
      "integrityNavStatus",
      "integrityNavArchive",
      "integrityColDate",
      "integrityColSlot",
      "integrityColCode",
      "integrityColPath",
      "integrityColDescription",
      "integrityColSlots",
      "integrityColMeasured",
      "integrityColPending",
      "integrityColReason",
      "integrityPromiseStaticJson",
      "integrityPromiseTwoClocks",
      "integrityPromiseGapsNamed",
      "integrityPromiseAppendOnly",
      "integrityPromiseAdditiveOnly",
      "integrityNotPromisePush",
      "integrityNotPromiseDepth",
      "integrityNotPromiseRevisionHistory",
      "integrityNotPromiseArchiveEdits",
      "integrityNotPromiseSla",
      // News → practice funnel (supro.si). Shared link labels + the
      // context-matched leads; the hour*/stories* leads are swept by the
      // reading-pages prefix test below, but the supro*/integrity* keys are
      // not, so they are listed here.
      "navSupro",
      "suproTiming",
      "suproSignals",
      "suproPaper",
      "suproDisclaimer",
      "suproThemesLead",
      "suproFlowsLead",
      "integritySuproLead",
    ]) {
      assert.ok(zh.includes(key), `TEXTS_ZH missing ${key}`);
      assert.ok(en.includes(key), `TEXTS_EN missing ${key}`);
    }
  });

  await t.test("topic labels are the locked taxonomy wording", () => {
    const src = fs.readFileSync(RENDER, "utf8");
    for (const label of ["全球市场", "国际时政", "科技AI", "政策政务", "公司公告", "观点解读"]) {
      assert.ok(src.includes(label), `zh label missing: ${label}`);
    }
    for (const label of ["Global Markets", "World", "Tech & AI", "Policy", "Filings", "Analysis"]) {
      assert.ok(src.includes(label), `en label missing: ${label}`);
    }
  });
});

/**
 * The reading pages (increment 7) pull every string from the same table, so
 * these assertions are the guard that a page cannot ship with a raw key or a
 * half-translated frame. `fill()` leaves an unknown placeholder in place rather
 * than printing `undefined`, which is why the placeholders are checked too.
 */
test("i18n: the reading pages' strings are paired and complete", async (t) => {
  const zh = keysOf("ZH");
  const en = keysOf("EN");

  await t.test("every hour-page and stories-page key exists in both locales", () => {
    const added = zh.filter((k) => k.startsWith("hour") || k.startsWith("stories") || k.startsWith("nav"));
    assert.ok(added.length >= 60, `expected the reading-page keys, found ${added.length}`);
    for (const key of added) {
      assert.ok(zh.includes(key), `TEXTS_ZH missing ${key}`);
      assert.ok(en.includes(key), `TEXTS_EN missing ${key}`);
    }
  });

  await t.test("the nav entries exist so the report can link both pages", () => {
    for (const key of ["navHour", "navStories", "navHome"]) {
      assert.ok(zh.includes(key), `TEXTS_ZH missing ${key}`);
      assert.ok(en.includes(key), `TEXTS_EN missing ${key}`);
    }
  });

  await t.test("the slot-integrity strings exist in both locales", () => {
    // These carry the difference between "the market was closed" (ordinary) and
    // "this file's label is wrong" (a defect) — a missing translation would drop
    // that distinction in one locale only.
    for (const key of [
      "hourIntegrityMislabelTitle",
      "hourIntegrityMislabelBody",
      "hourIntegrityClosedTitle",
      "hourIntegrityClosedBody",
      "hourIntegrityUnresolved",
      "hourIntegrityBadgeMislabel",
      "hourIntegrityBadgeClosed",
    ]) {
      assert.ok(zh.includes(key), `TEXTS_ZH missing ${key}`);
      assert.ok(en.includes(key), `TEXTS_EN missing ${key}`);
    }
  });

  await t.test("placeholders match across locales", () => {
    const src = fs.readFileSync(RENDER, "utf8");
    /**
     * Key → sorted placeholder names, for entries whose value is a quoted string
     * that may wrap across lines (several are wrapped for line length). Parsing
     * rather than regex-per-line: a single-line regex silently skipped every
     * wrapped entry, which would let a mistranslated frame ship undetected.
     */
    const placeholders = (block: string): Map<string, string> => {
      const out = new Map<string, string>();
      for (const m of block.matchAll(/^ {2}(\w+):\s*"((?:[^"\\]|\\.)*)"/gm)) {
        const vars = [...m[2].matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
        out.set(m[1], vars.join(","));
      }
      return out;
    };
    const zhBlock = src.slice(src.indexOf("const TEXTS_ZH"), src.indexOf("const TEXTS_EN"));
    const enBlock = src.slice(src.indexOf("const TEXTS_EN"), src.indexOf("const STR ="));
    const zhMap = placeholders(zhBlock);
    const enMap = placeholders(enBlock);
    assert.ok(zhMap.size > 100, `parser found only ${zhMap.size} keys`);
    for (const [key, spec] of zhMap) {
      if (!spec) continue;
      assert.ok(enMap.has(key), `TEXTS_EN missing ${key}`);
      assert.equal(enMap.get(key), spec, `placeholder mismatch for ${key}`);
    }
  });

  await t.test("no page renders a raw string key", () => {
    // A key left in the rendered page means a missing table entry; the tables
    // are typed, so this only catches table *content* that looks like a key.
    const src = fs.readFileSync(RENDER, "utf8");
    for (const m of src.matchAll(/^ {2}(\w+): "(\w+)"/gm)) {
      assert.notEqual(m[1], m[2], `${m[1]} looks like a raw key, not copy`);
    }
  });
});
