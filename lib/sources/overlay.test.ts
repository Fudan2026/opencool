import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadSourceOverlay } from "./overlay";

test("source overlay", async (t) => {
  await t.test("missing file -> empty, not corrupt", () => {
    const r = loadSourceOverlay("/nonexistent-dir");
    assert.deepEqual(r.disabled, []);
    assert.equal(r.corrupt, false);
  });

  await t.test("valid overlay entries pass through", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-"));
    fs.writeFileSync(
      path.join(dir, "source-overlay.json"),
      JSON.stringify({ disabled: ["a", "b"], reason: "fail-streak>=3" }),
    );
    const r = loadSourceOverlay(dir);
    assert.deepEqual(r.disabled, ["a", "b"]);
    assert.equal(r.corrupt, false);
    assert.equal(r.reason, "fail-streak>=3");
    fs.rmSync(dir, { recursive: true });
  });

  await t.test("corrupt JSON or bad shape -> empty + corrupt flag", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-"));
    fs.writeFileSync(path.join(dir, "source-overlay.json"), "{not json");
    assert.deepEqual(loadSourceOverlay(dir).disabled, []);
    assert.equal(loadSourceOverlay(dir).corrupt, true);
    fs.writeFileSync(path.join(dir, "source-overlay.json"), '{"disabled":"x"}');
    const r = loadSourceOverlay(dir);
    assert.deepEqual(r.disabled, []);
    assert.equal(r.corrupt, true);
    fs.rmSync(dir, { recursive: true });
  });
});
