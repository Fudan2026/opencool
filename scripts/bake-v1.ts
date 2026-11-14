/**
 * Bake the `/v1/` namespace and `/integrity.html` — increment 5 + 6.
 *
 * Reads only what is already on disk (`daily_reports/tape/…`, `stories.json`,
 * `themes.json`, `reactions.json`) and writes:
 *
 *   daily_reports/v1/manifest.json
 *   daily_reports/v1/asof/<YYYY-MM-DD>.json
 *   daily_reports/v1/coverage.json
 *   daily_reports/v1/stories.json      (when stories.json exists)
 *   daily_reports/v1/themes.json       (when themes.json exists)
 *   daily_reports/v1/reactions.json    (only once reactions.json exists)
 *   daily_reports/integrity.html
 *
 * Deterministic by construction: no network, no LLM, no clock beyond
 * `generatedAt`. A missing input is a named gap and still exits 0 — the
 * difference between "we have no data" and "we have nothing to say" matters, and
 * a bake that fails on a missing optional file would turn the first into the
 * second.
 *
 * Runs AFTER the other bakes and BEFORE `build-site`, because every file it
 * writes must be inside `daily_reports/` when peaceiris publishes that tree.
 *
 * Exit codes:
 *   0  wrote the namespace (with or without tape days — gaps are data)
 *   1  a v1 payload violated its own contract (a bug, not an upstream issue)
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";

import { renderIntegrityHtml } from "../lib/output/render";
import { buildV1, writeV1 } from "../lib/v1/build";
import { checkShape } from "../lib/v1/contract";
import {
  collectPublishLag,
  injectPublishLagSection,
  renderPublishLagSection,
} from "../lib/v1/publish-lag";

const ROOT = path.resolve("daily_reports");

function main(): void {
  const build = buildV1({ root: ROOT });

  // The v1 contract is checked before writing, not after: a payload that lost a
  // required top-level field must fail this run rather than publish a broken
  // promise. Anything the check flags here is our bug, never upstream's.
  const problems: string[] = [];
  for (const [rel, payload] of Object.entries(build.files)) {
    const name = rel.startsWith("asof/") ? "asof/<date>.json" : rel;
    problems.push(...checkShape(payload, name));
  }
  if (problems.length) {
    for (const p of problems) console.error(`[v1:bake] contract violation: ${p}`);
    throw new Error(`${problems.length} v1 contract violation(s) — refusing to write`);
  }

  const report = writeV1(build, { root: ROOT });
  console.log(
    `[v1:bake] wrote ${report.written.length} file(s) under ${report.dir} ` +
      `(asof days=${build.asofDays.length} endpoints=${build.manifest.endpoints.length})`,
  );
  if (report.removed.length) {
    console.log(`[v1:bake] removed ${report.removed.length} stale file(s): ${report.removed.map((f) => path.basename(f)).join(",")}`);
  }

  const { coverage, manifest } = build;
  const pct = coverage.summary.coveragePct;
  console.log(
    `[v1:bake] tape started=${coverage.tape.started} days=${coverage.tape.days} ` +
      `tradingDays=${coverage.tape.tradingDays} snapshots=${coverage.tape.snapshots} ` +
      `revisions=${coverage.tape.revisionFiles} ` +
      `coverage=${pct === null ? "n/a" : `${pct}%`} gaps=${coverage.summary.gaps}`,
  );
  console.log(
    `[v1:bake] stories total=${coverage.stories.total} ` +
      `withFirstSeenAt=${coverage.stories.withFirstSeenAt} ` +
      `(${coverage.stories.firstSeenCoveragePct}%)`,
  );
  console.log(
    `[v1:bake] horizons ${coverage.horizons
      .map((h) => `${h.key}=${h.measured}/${h.measured + h.pending}`)
      .join(" ")} reactions=${coverage.horizons.some((h) => h.available) ? "available" : "absent"}`,
  );
  if (!coverage.tape.started) {
    console.log(
      `[v1:bake] no tape days yet — integrity.html states that in plain language ` +
        `(first expected snapshot ${coverage.tape.launchDate} 09:35)`,
    );
  }

  let html = renderIntegrityHtml(coverage, manifest);

  // Measured publish times: the slots are targets, the 14-day lag table is the
  // promise. Computed from the same restored sidecars the rest of the bake
  // reads; when the tree carries none at all (a partial restore in the
  // reading-pages job) the section states that instead of faking 42 "missing"
  // rows.
  const lag = collectPublishLag({ root: ROOT });
  const lagSection = renderPublishLagSection(lag);
  const injected = injectPublishLagSection(html, lagSection);
  if (!injected.injected) {
    console.warn(
      "[v1:bake] publish-lag section NOT injected: the integrity page lede anchor was not found — " +
        "lib/v1/publish-lag.ts and lib/output/render.ts have drifted",
    );
  }
  html = injected.html;
  console.log(
    lag.available
      ? `[v1:bake] publish-lag table: ${lag.days}d x ${lag.slots.length} slots, onTime=${lag.counts.onTime} ` +
        `late=${lag.counts.late} early=${lag.counts.early} missing=${lag.counts.missing} pending=${lag.counts.pending}`
      : "[v1:bake] publish-lag table: no edition sidecars in this tree — named no-measurement state",
  );

  const out = path.join(ROOT, "integrity.html");
  fs.writeFileSync(out, html, "utf8");
  console.log(`[v1:bake] wrote ${out} (${(html.length / 1024).toFixed(1)} KB)`);
}

main();
