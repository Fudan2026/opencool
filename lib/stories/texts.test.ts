import test from "node:test";
import assert from "node:assert/strict";

import { TEXTS_EN, TEXTS_ZH, storyTexts } from "./texts";

/**
 * zh/en parity for every user-visible ledger string.
 *
 * Same rule as `lib/output/render.ts` `TEXTS_ZH` / `TEXTS_EN` and the
 * `tests/golden/i18n-parity.test.ts` guard: a string exists in both tables or
 * in neither. This module is small enough to check by importing it (unlike
 * render.ts, nothing here resolves a locale at module init), so the parity is
 * proven rather than source-parsed.
 */
test("story texts: zh and en are key-for-key identical", async (t) => {
  await t.test("no key exists in only one table", () => {
    const zh = Object.keys(TEXTS_ZH).sort();
    const en = Object.keys(TEXTS_EN).sort();
    assert.deepEqual(zh.filter((k) => !en.includes(k)), [], "keys only in TEXTS_ZH");
    assert.deepEqual(en.filter((k) => !zh.includes(k)), [], "keys only in TEXTS_EN");
  });

  await t.test("every value is a non-empty string in both languages", () => {
    for (const key of Object.keys(TEXTS_ZH) as Array<keyof typeof TEXTS_ZH>) {
      assert.equal(typeof TEXTS_ZH[key], "string");
      assert.equal(typeof TEXTS_EN[key], "string");
      assert.ok(TEXTS_ZH[key].trim().length > 0, `${key} empty in zh`);
      assert.ok(TEXTS_EN[key].trim().length > 0, `${key} empty in en`);
    }
  });

  await t.test("the picker returns the right table and defaults to zh", () => {
    assert.equal(storyTexts(), TEXTS_ZH);
    assert.equal(storyTexts("zh"), TEXTS_ZH);
    assert.equal(storyTexts("en"), TEXTS_EN);
    assert.equal(storyTexts("en").firstMoverTitle, "Who reported first");
    assert.equal(storyTexts("zh").firstMoverTitle, "谁最先报道");
  });
});
