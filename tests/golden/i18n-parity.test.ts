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

test("i18n: the topic block's strings exist in both locales", async (t) => {
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
