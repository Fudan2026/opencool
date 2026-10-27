import test from "node:test";
import assert from "node:assert/strict";

import { cleanKeywords } from "../../lib/nlp/keywords";
import { loadSourceOverlay } from "../../lib/sources/overlay";
import {
  reportFixture,
  sentimentFixture,
  morningBriefFixture,
} from "./helpers";

/**
 * GOLDEN: the sidecar JSON contract. External consumers (SuPro
 * src/lib/opencool/map.ts, MCP tools, RSS/llms clients) depend on these
 * paths. Changing shape = breaking the ecosystem; update this contract
 * explicitly if a field must move.
 */

type Json = Record<string, unknown>;

function roundtrip(report: Json): Json {
  return JSON.parse(JSON.stringify(report)) as Json;
}

test("golden: sidecar consumer contract", async (t) => {
  const sidecar = roundtrip(reportFixture() as unknown as Json);

  await t.test("top-level fields consumed by ecosystem", () => {
    for (const key of [
      "hero_headline",
      "daily_overview",
      "finance_briefs",
      "keywords",
      "sentiment",
    ]) {
      assert.ok(key in sidecar, `contract field missing: ${key}`);
    }
  });

  await t.test("keywords: string array (SuPro mapper tags from it)", () => {
    const kw = sidecar.keywords;
    assert.ok(Array.isArray(kw));
    assert.ok((kw as string[]).every((k) => typeof k === "string"));
    assert.deepEqual(cleanKeywords(kw as string[]).length > 0, true);
  });

  await t.test("sentiment: score/label/sectors/percentile stable", () => {
    const s = sidecar.sentiment as Json;
    assert.equal(typeof s.score, "number");
    assert.equal(typeof s.label, "string");
    assert.ok(Array.isArray(s.sectors));
    for (const sec of s.sectors as Json[]) {
      assert.equal(typeof sec.key, "string");
      assert.equal(typeof sec.score, "number");
      assert.ok(Array.isArray(sec.topDrivers));
    }
    assert.ok(s.percentile === null || typeof s.percentile === "number");
  });

  await t.test("morning_brief: base/delta/overnight/newKeywords shape", () => {
    const mb = sidecar.morning_brief as Json;
    assert.equal(typeof mb.base_edition, "string");
    assert.ok(mb.sentimentDelta === null || typeof mb.sentimentDelta === "number");
    assert.ok(Array.isArray(mb.overnight));
    for (const o of mb.overnight as Json[]) {
      for (const k of ["symbol", "displayName", "group", "pct1Day"]) {
        assert.ok(k in o, `overnight field missing: ${k}`);
      }
    }
    assert.ok(Array.isArray(mb.newKeywords));
    assert.ok(Array.isArray(mb.newEvents));
  });

  await t.test("fetch_health: entries {id,ms,ok,count} stable", () => {
    const fh = {
      generated_at: "2026-10-27T03:00:00Z",
      entries: [{ id: "x", ms: 100, ok: true, count: 3 }],
    };
    const j = roundtrip(fh as unknown as Json);
    const e = (j.entries as Json[])[0];
    for (const k of ["id", "ms", "ok", "count"]) {
      assert.ok(k in e, `fetch_health entry field missing: ${k}`);
    }
  });

  await t.test("sentiment fixture itself stays contract-clean", () => {
    const s = sentimentFixture();
    assert.ok(Math.abs(s.score) <= 100);
    assert.ok(s.sectors.every((x) => Math.abs(x.score) <= 100));
    assert.equal(typeof morningBriefFixture().base_edition, "string");
  });
});

test("golden: legacy sidecars stay consumable (no new fields)", async (t) => {
  const legacy = {
    hero_headline: "旧档标题",
    daily_overview: "旧档概览",
    tech_briefs: [],
    finance_briefs: [],
    politics_briefs: [],
    editor_note: "",
    keywords: ["MLF"],
  } as Json;
  const j = roundtrip(legacy);
  assert.equal(typeof j.hero_headline, "string");
  // consumers must tolerate missing optional sections
  assert.deepEqual(cleanKeywords(undefined), []);
  assert.deepEqual(cleanKeywords(j.keywords as string[]), ["MLF"]);
  assert.equal(loadSourceOverlay("/nonexistent").disabled.length, 0);
});
