#!/usr/bin/env node
/**
 * Docker scheduler for the full OpenCool bake sequence. Mirrors CI order:
 *   calendar -> lhb -> daily -> trails -> keywords -> weekly -> themes
 *   -> periods -> search -> build-site.
 *
 * Every LOOP_MINUTES (default 30) it picks the latest due slot via
 * lib/utils.ts editionHourKey(). If that slot's sidecar is missing, the
 * whole sequence runs; otherwise it idles. Failed runs retry next tick
 * (self-healing). DAILY_ONCE=1 performs one evaluation and exits.
 * DAILY_FORCE=1 regenerates even when the sidecar exists.
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { todayKey, editionHourKey } from "../lib/utils.ts";

const ROOT = "daily_reports";
const LOOP_MINUTES = Math.max(1, Number(process.env.LOOP_MINUTES || 30));
const ONCE = process.env.DAILY_ONCE === "1";
const FORCE = process.env.DAILY_FORCE === "1";
const STEPS = [
  "calendar:bake",
  "lhb:bake",
  "daily",
  "build-trails",
  "keywords:bake",
  "weekly:bake",
  "themes:bake",
  "periods:bake",
  "search:bake",
  "build-site",
];

function runStep(step) {
  console.log(`\n[docker-daily] npm run ${step}`);
  const r = spawnSync("npm", ["run", step], {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: true,
    env: { ...process.env, LLM_MODE: process.env.LLM_MODE || "off" },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${step} exited ${r.status}`);
}

function tick() {
  const date = todayKey();
  const hour = editionHourKey();
  const sidecar = `${ROOT}/${date}/${hour}.json`;
  if (!FORCE && fs.existsSync(sidecar)) {
    console.log(`[docker-daily] ${date}/${hour} already baked — idle`);
    return;
  }
  console.log(`[docker-daily] baking ${date}/${hour}${FORCE ? " (forced)" : ""}`);
  for (const step of STEPS) runStep(step);
  console.log(`[docker-daily] done ${date}/${hour}`);
}

tick();
if (!ONCE) {
  setInterval(() => {
    try {
      tick();
    } catch (e) {
      // A failing edition must not kill the scheduler; the next tick retries.
      console.error(`[docker-daily] tick failed: ${e instanceof Error ? e.message : e}`);
    }
  }, LOOP_MINUTES * 60_000);
}
