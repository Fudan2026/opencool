import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards for the tech-lane evidence trial (owner decision OC-20, landed
 * 2026-11-14).
 *
 * The keep rule is measured, not assumed: a trial source stays enabled only
 * with fetch_health uptime >=80% across available production history. The
 * measurements that shaped these guards come from the published sidecars on
 * gh-pages (2026-10-26 → 2026-11-14, 53 editions with fetch_health):
 *
 *   - NO tech source has any fetch_health entry at all — every tech entry sat
 *     disabled since 2026-09-17, before fetch_health existed (landed 10-26).
 *     That is why this had to be a production trial rather than a backtest.
 *   - Every RSSHub-family route on this repo measured 30-62% CI uptime over
 *     that window (cls-telegraph 39.6%, wallstreetcn 37.7%, caixin 30.2%,
 *     eastmoney-kuaixun 0%, jin10-flash 47.2%, wallstreetcn-live 62.5%) —
 *     far below the 80% gate. So an enabled tech source must serve from its
 *     own official feed, never an RSSHub-family primary.
 *
 * When the trial delivers its verdict (a source drops below 80%), update the
 * trial-set list and the config in the same commit so this file always states
 * the current, measured truth.
 */

const CONFIG = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../sources.config.json",
);

const RSSHUB_FAMILY_PRIMARY = /^https?:\/\/(rsshub\.app|hub\.slarker\.me)\//;

function loadConfig(): Array<Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(CONFIG, "utf8")) as Array<
    Record<string, unknown>
  >;
}

test("sources: enabled tech sources never sit on an RSSHub-family primary", () => {
  const config = loadConfig();
  for (const s of config) {
    if (s.category !== "tech" || s.enabled === false) continue;
    const url = String(s.url);
    assert.ok(
      !RSSHUB_FAMILY_PRIMARY.test(url),
      `${String(s.id)}: enabled tech source uses RSSHub-family primary ${url} — every measured route of that family runs 30-62% CI uptime, below the 80% keep gate`,
    );
  }
});

test("sources: the tech-lane trial set is explicit and enabled", () => {
  const config = loadConfig();
  const byId = new Map(config.map((s) => [String(s.id), s]));
  for (const id of ["qbitai", "solidot", "geekpark", "leiphone"]) {
    const s = byId.get(id);
    assert.ok(s, `${id} missing from sources.config.json`);
    assert.equal(s.enabled, true, `${id} must be enabled for the evidence trial`);
    assert.equal(s.category, "tech", `${id} must live in the tech lane`);
    assert.deepEqual(s.locales, ["zh"], `${id} is a zh-locale source`);
  }
  // 199it was probed 2026-11-14 and dropped BEFORE enable: the server resets
  // non-browser UAs (0/3) and timed out 2/3 through the pipeline's curl path
  // in the pre-merge dry-run. It must stay disabled until re-probed.
  assert.equal(byId.get("199it")?.enabled, false);
  // The two AI-media/community-adjacent sources keep their existing homes.
  assert.equal(byId.get("qbitai")?.subcategory, "ai-news");
  assert.equal(byId.get("solidot")?.subcategory, "cn-tech");
});

test("sources: enabled zh tech sources feed the rendered tech tab", () => {
  // The tech L1 tab renders only subcategories listed in SUBCATEGORY_ORDER
  // under tech AND in TECH_MAIN_SUBS (lib/output/render.ts). A trial source
  // with an unknown subcategory would fetch fine but never surface — the very
  // 0-item render this trial exists to end. The rendered home for the trial
  // set is ai-news / cn-tech.
  const config = loadConfig();
  const homes = new Set(["ai-news", "cn-tech"]);
  for (const s of config) {
    if (s.category !== "tech" || s.enabled === false) continue;
    assert.ok(
      homes.has(String(s.subcategory)),
      `${String(s.id)}: enabled tech source uses subcategory ${String(s.subcategory)}, which does not render in the tech tab`,
    );
  }
});
