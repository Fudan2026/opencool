import test from "node:test";
import assert from "node:assert/strict";

import { applyLead, loadLeadConfig, type EditorialLead } from "./lead";
import type { ArticleInput } from "../ai/pipeline";

function art(title: string): ArticleInput {
  return {
    sourceId: "dw-chinese",
    title,
    url: "https://example.com/a",
    category: "finance",
    source: "DW 中文",
  } as ArticleInput;
}

const lead: EditorialLead = {
  date: "2026-11-13",
  groundOn: "黄仁勋辞职",
  title: "黄仁勋辞职 中企忧美收紧监管 忙抢租海外英伟达算力",
  url: "https://example.com/dw",
  source: "DW 中文",
};

test("editorial lead", async (t) => {
  await t.test("grounds only on sourced titles, applies to all slots of the date", () => {
    const applied = applyLead([art("黄仁勋辞职 中企忧美收紧监管")], lead, "2026-11-13", "06");
    assert.ok(applied);
    assert.equal(applied.groundedBy, "黄仁勋辞职 中企忧美收紧监管");
    const noon = applyLead([art("黄仁勋辞职 中企忧美收紧监管")], lead, "2026-11-13", "13");
    assert.ok(noon, "hour omitted → applies to every slot of the date");
  });

  await t.test("refuses when sources do not ground it", () => {
    assert.equal(applyLead([art("无关新闻")], lead, "2026-11-13", "06"), null);
  });

  await t.test("refuses on date or hour mismatch", () => {
    const dated: EditorialLead = { ...lead, hour: "06" };
    assert.equal(applyLead([art("黄仁勋辞职")], dated, "2026-11-13", "13"), null);
    assert.equal(applyLead([art("黄仁勋辞职")], lead, "2026-11-12", "06"), null);
  });

  await t.test("loadLeadConfig tolerates missing/invalid file", () => {
    assert.equal(loadLeadConfig("/nonexistent/lead.json", () => {
      throw new Error("nope");
    }), null);
    assert.equal(loadLeadConfig("lead.json", () => "{not json"), null);
    assert.equal(loadLeadConfig("lead.json", () => "{}"), null);
    const ok = loadLeadConfig("lead.json", () => JSON.stringify(lead));
    assert.equal(ok?.groundOn, "黄仁勋辞职");
  });
});
