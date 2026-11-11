import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadThemeCatalog, THEME_CATALOG } from "./catalog";

test("custom themes", async (t) => {
  await t.test("missing custom file falls back to built-ins", () => {
    const cat = loadThemeCatalog("/nonexistent/themes.custom.json");
    assert.deepEqual(cat.map((x) => x.key), THEME_CATALOG.map((x) => x.key));
  });

  await t.test("custom entries append and same-key replace", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "themes-custom-"));
    const fp = path.join(dir, "themes.custom.json");
    fs.writeFileSync(fp, JSON.stringify([
      { key: "ai", name: "AI 2.0", aliases: ["AGI"], boardHints: ["人工智能"] },
      { key: "stablecoin", name: "稳定币", aliases: ["稳定币", "USDT"], boardHints: ["稳定币"] },
    ]));
    const cat = loadThemeCatalog(fp);
    const ai = cat.find((x) => x.key === "ai")!;
    assert.equal(ai.name, "AI 2.0");
    assert.deepEqual(ai.aliases, ["AGI"]);
    assert.ok(cat.some((x) => x.key === "stablecoin"));
    assert.equal(cat.length, THEME_CATALOG.length + 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test("invalid custom file errors loudly", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "themes-custom-"));
    const fp = path.join(dir, "themes.custom.json");
    fs.writeFileSync(fp, "{not json");
    assert.throws(() => loadThemeCatalog(fp), /not valid JSON/);
    fs.writeFileSync(fp, JSON.stringify([{ key: "bad" }]));
    assert.throws(() => loadThemeCatalog(fp), /key and name must be non-empty strings/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
