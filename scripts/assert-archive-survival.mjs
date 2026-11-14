#!/usr/bin/env node
/**
 * ARCHIVE-SURVIVAL ASSERT — the build job's publish must never silently wipe
 * an edition it did not write.
 *
 * The failure mode this guards (forensics: missing-19s-forensics): the build
 * job restores the published tree with `git --work-tree=daily_reports checkout
 * origin/gh-pages -- . || true`, then publishes with `keep_files: false` —
 * peaceiris' push REPLACES the remote tree with the local one. A partial
 * restore (the `|| true` swallows it) therefore deletes every unrestored old
 * edition from gh-pages on the next publish, and the run stays green. 109/109
 * ever-committed sidecars exist today only because that never coincided.
 *
 * Two phases, one script:
 *   --capture  BEFORE publishing: list every `YYYY-MM-DD/HH.json` sidecar in
 *              the FETCHED origin/gh-pages tree (git ls-tree — the true remote
 *              state, independent of the possibly-partial checkout) and write
 *              the list outside the publish dir ($RUNNER_TEMP).
 *   --assert   AFTER publishing: every captured sidecar must still exist in
 *              the publish output tree (./daily_reports). Missing ones are
 *              named in a ::error:: annotation and the step fails.
 *
 * Deliberately a post-publish assert, same philosophy as the publish-lag one:
 * a detected wipe turns the run red and pages (notify-failure), but the new
 * edition still goes live. The named files are recoverable from gh-pages
 * history — the forensics showed every sidecar ever published is still in it.
 * Nothing legitimately deletes a sidecar: placeholders are HTML-only, so the
 * rule can be absolute.
 *
 * Env: RUNNER_TEMP (list-file dir; falls back to os.tmpdir() for local use).
 * Exit: 0 pass / nothing-to-do, 1 archive damaged (or the capture state is
 * missing — an assert must never fail silent).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SIDECAR_RE = /^\d{4}-\d{2}-\d{2}\/\d{2}\.json$/;

/** Keep only `<date>/<HH>.json` paths — the sidecars the gate probes. */
export function filterSidecarPaths(paths) {
  return paths.filter((p) => SIDECAR_RE.test(p));
}

function listFilePath(override) {
  if (override) return override;
  return path.join(process.env.RUNNER_TEMP || os.tmpdir(), "gh-pages-sidecars.txt");
}

/**
 * List the sidecars in the fetched origin/gh-pages tree. Empty when gh-pages
 * does not exist yet (first run — nothing to protect).
 */
export function captureSidecarList({ gitDir = process.cwd() } = {}) {
  try {
    execSync("git rev-parse --verify --quiet origin/gh-pages", { cwd: gitDir, stdio: "ignore" });
  } catch {
    return [];
  }
  const out = execSync("git ls-tree -r --name-only origin/gh-pages", {
    cwd: gitDir,
    encoding: "utf8",
  });
  return filterSidecarPaths(out.split("\n").map((l) => l.trim()).filter(Boolean));
}

/**
 * Which captured sidecars are missing from the publish output tree?
 * Empty array = the archive survived. A missing capture list THROWS: the
 * assert step is only meaningful when --capture ran first.
 * @returns {Promise<string[]>} missing relative paths
 */
export async function checkSurvival({ listFile, publishDir = "daily_reports" } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(listFile, "utf8");
  } catch (e) {
    throw new Error(
      `capture list ${listFile} is unreadable — run the --capture phase before publishing (${e.message})`,
    );
  }
  const listed = filterSidecarPaths(raw.split("\n").map((l) => l.trim()).filter(Boolean));
  const missing = [];
  for (const rel of listed) {
    if (!fs.existsSync(path.join(publishDir, rel))) missing.push(rel);
  }
  return { listed: listed.length, missing };
}

async function main() {
  const mode = process.argv.includes("--capture")
    ? "capture"
    : process.argv.includes("--assert")
      ? "assert"
      : null;
  const listOverride = (() => {
    const i = process.argv.indexOf("--list-file");
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "";
  })();

  if (mode === "capture") {
    const list = captureSidecarList();
    const file = listFilePath(listOverride);
    fs.writeFileSync(file, list.join("\n") + (list.length ? "\n" : ""));
    console.log(`[archive] captured ${list.length} existing sidecar(s) from origin/gh-pages → ${file}`);
    return;
  }

  if (mode === "assert") {
    const { listed, missing } = await checkSurvival({ listFile: listFilePath(listOverride) });
    if (listed === 0) {
      console.log("[archive] no prior sidecars captured (first run) — nothing to protect");
      return;
    }
    if (missing.length) {
      console.error(
        `::error::archive damaged: ${missing.length}/${listed} published sidecar(s) went missing from the publish tree — ` +
          `a partial gh-pages restore was about to wipe them (recoverable from gh-pages history): ${missing.join(", ")}`,
      );
      process.exit(1);
    }
    console.log(`[archive] all ${listed} prior sidecar(s) survived the publish`);
    return;
  }

  console.error("usage: assert-archive-survival.mjs --capture | --assert [--list-file <path>]");
  process.exit(2);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[archive] FAILED: ${e?.message ?? e}`);
    process.exit(1);
  });
}
