#!/usr/bin/env node
/**
 * Post-bake assertion for the `/v1` namespace and `/integrity.html`.
 *
 * The baker validates its paylaods before writing, so this is not a repeat of
 * that check — it verifies what actually LANDED ON DISK, which is what gets
 * published. The failure modes it catches are the ones a green bake cannot:
 *
 *   - a v1 file that never got written (the namespace shipped incomplete);
 *   - a manifest that advertises an endpoint with no file behind it, which a
 *     consumer reads as a broken promise;
 *   - an `asof/<date>.json` whose slots lost a clock in transit;
 *   - a gap that is present in `coverage.json` but unnamed in the day file (or
 *     the reverse), i.e. two surfaces disagreeing about the same hole;
 *   - an `integrity.html` that claims a clean run while `coverage.json` has gaps.
 *
 * Deliberately zero-dependency ESM: it runs on the bare runner with no `npm ci`
 * step of its own, like `assert-zero-llm.mjs` and `assert-publish-lag.mjs`.
 *
 * Usage: node scripts/assert-v1.mjs [--root daily_reports]
 * Exit 0 on pass, 1 on failure, 2 on usage error.
 */
import fs from "node:fs";
import path from "node:path";

const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

const MANIFEST_KEYS = {
  schemaVersion: "number",
  namespace: "string",
  generatedAt: "string",
  timezone: "string",
  endpoints: "array",
  snapshots: "object",
  coverage: "object",
  license: "object",
  deprecation: "object",
  guarantees: "object",
};

const COVERAGE_KEYS = {
  schemaVersion: "number",
  namespace: "string",
  generatedAt: "string",
  timezone: "string",
  tape: "object",
  days: "array",
  stories: "object",
  horizons: "array",
  gaps: "array",
  summary: "object",
};

const ASOF_KEYS = {
  schemaVersion: "number",
  namespace: "string",
  date: "string",
  timezone: "string",
  generatedAt: "string",
  tradingDay: "boolean",
  beforeLaunch: "boolean",
  expectedSlots: "array",
  pendingSlots: "array",
  slots: "array",
  gaps: "array",
  counts: "object",
};

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isFinite(v) ? "number" : "null";
  return typeof v;
}

function checkKeys(obj, spec, label, problems) {
  if (typeOf(obj) !== "object") {
    problems.push(`${label}: not an object (${typeOf(obj)})`);
    return false;
  }
  for (const [key, want] of Object.entries(spec)) {
    const got = typeOf(obj[key]);
    if (got !== want) problems.push(`${label}.${key}: expected ${want}, got ${got}`);
  }
  return true;
}

function readJson(fp, label, problems) {
  if (!fs.existsSync(fp)) {
    problems.push(`${label}: missing file ${fp}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch (e) {
    problems.push(`${label}: unreadable (${e.message})`);
    return null;
  }
}

/**
 * @param {string} root daily_reports root
 * @returns {{problems: string[], summary: Record<string, unknown>}}
 */
export function assertV1(root = "daily_reports") {
  const problems = [];
  const v1 = path.join(root, "v1");

  const manifest = readJson(path.join(v1, "manifest.json"), "manifest.json", problems);
  const coverage = readJson(path.join(v1, "coverage.json"), "coverage.json", problems);
  if (!manifest || !coverage) return { problems, summary: {} };

  checkKeys(manifest, MANIFEST_KEYS, "manifest.json", problems);
  checkKeys(coverage, COVERAGE_KEYS, "coverage.json", problems);
  if (problems.length) return { problems, summary: {} };

  // Every advertised endpoint must have a file behind it. `asof/...` is a
  // pattern, checked below against the day list.
  for (const ep of manifest.endpoints) {
    if (typeof ep.path !== "string" || typeof ep.id !== "string") {
      problems.push(`manifest.endpoints: entry without id/path (${JSON.stringify(ep)})`);
      continue;
    }
    if (ep.path.includes("<YYYY-MM-DD>")) continue;
    const rel = ep.path.replace(/^\/v1\//, "");
    const fp = path.join(v1, rel);
    if (!fs.existsSync(fp)) {
      problems.push(`manifest advertises ${ep.path} but ${fp} does not exist`);
    }
  }

  // Day files: keys, clocks on every slot and every section, and the coverage
  // ledger must agree with the day file about which slots are missing.
  const asofDir = path.join(v1, "asof");
  const dayFiles = fs.existsSync(asofDir)
    ? fs.readdirSync(asofDir).filter((f) => f.endsWith(".json")).sort()
    : [];
  const dayByDate = new Map();
  for (const f of dayFiles) {
    const label = `asof/${f}`;
    const day = readJson(path.join(asofDir, f), label, problems);
    if (!day) continue;
    if (!checkKeys(day, ASOF_KEYS, label, problems)) continue;
    const date = f.replace(/\.json$/, "");
    if (day.date !== date) problems.push(`${label}: date field ${JSON.stringify(day.date)} != filename ${date}`);
    dayByDate.set(date, day);

    for (const slot of day.slots) {
      const where = `${label} slot ${slot.slot}`;
      if (!OFFSET_ISO.test(String(slot.observedAt))) {
        problems.push(`${where}: observedAt is not offset ISO (${JSON.stringify(slot.observedAt)})`);
      }
      if (!OFFSET_ISO.test(String(slot.asOf))) {
        problems.push(`${where}: asOf is not offset ISO (${JSON.stringify(slot.asOf)})`);
      }
      for (const [name, section] of Object.entries(slot.sections ?? {})) {
        if (!section || typeof section !== "object") {
          problems.push(`${where} ${name}: not an object`);
          continue;
        }
        if (!OFFSET_ISO.test(String(section.asOf))) {
          problems.push(`${where} ${name}: section asOf is not offset ISO`);
        }
        if (!OFFSET_ISO.test(String(section.observedAt))) {
          problems.push(`${where} ${name}: section observedAt is not offset ISO`);
        }
        for (const [i, rec] of (section.records ?? []).entries()) {
          if (!OFFSET_ISO.test(String(rec?.asOf)) || !OFFSET_ISO.test(String(rec?.observedAt))) {
            problems.push(`${where} ${name}[${i}]: record lost a clock`);
          }
        }
      }
    }

    // gaps must name every expected slot that has no snapshot. `expectedSlots`
    // is the day's own list, so a schedule change cannot make an old day look
    // short by today's rules. A non-trading day owes nothing, so it emits no
    // per-slot gaps — `tradingDay: false` is the whole explanation.
    if (day.tradingDay === true && day.beforeLaunch !== true) {
      const captured = new Set(day.slots.map((s) => s.slot));
      const named = new Set(day.gaps.filter((g) => g.slot).map((g) => g.slot));
      const pending = new Set((day.pendingSlots ?? []).filter((s) => typeof s === "string"));
      for (const slot of day.expectedSlots) {
        if (captured.has(slot) || pending.has(slot)) continue;
        if (!named.has(slot)) {
          problems.push(`${label}: slot ${slot} missing but neither named in gaps[] nor pending`);
        }
      }
    }
    if (day.counts?.capturedSlots !== day.slots.length) {
      problems.push(`${label}: counts.capturedSlots != slots.length`);
    }

    const covDay = (coverage.days ?? []).find((d) => d.date === date);
    if (!covDay) {
      problems.push(`${label}: no matching entry in coverage.json days[]`);
    } else if (covDay.capturedSlots !== day.slots.length) {
      problems.push(
        `${label}: coverage.json says ${covDay.capturedSlots} captured, day file has ${day.slots.length}`,
      );
    }
  }

  // A manifest snapshot row without an asof file is the same broken promise as
  // an advertised endpoint with no file.
  for (const row of manifest.snapshots?.days ?? []) {
    if (!dayByDate.has(row.date)) {
      problems.push(`manifest.snapshots lists ${row.date} but asof/${row.date}.json is absent`);
    }
  }

  // The page must not read as a clean run while gaps exist. Two structural
  // markers keep it honest: the "not started" notice (class="empty") when there
  // is no tape at all, and the per-gap code column when coverage names gaps. A
  // page that lost both is a marketing page, not this one.
  const htmlPath = path.join(root, "integrity.html");
  if (!fs.existsSync(htmlPath)) {
    problems.push("integrity.html: missing");
  } else {
    const html = fs.readFileSync(htmlPath, "utf8");
    const started = Boolean(coverage.tape?.started);
    if (!started && !html.includes('class="empty"')) {
      problems.push("integrity.html: tape has not started but the page does not say so");
    }
    const gaps = Number(coverage.summary?.gaps ?? 0);
    if (gaps > 0 && !html.includes("gap-code")) {
      problems.push(`integrity.html: coverage reports ${gaps} gap(s) but the page renders no gap list`);
    }
  }

  return {
    problems,
    summary: {
      endpoints: manifest.endpoints.length,
      days: dayFiles.length,
      snapshots: manifest.snapshots?.totalSlots ?? 0,
      gaps: coverage.summary?.gaps ?? 0,
      coveragePct: coverage.summary?.coveragePct ?? null,
      tapeStarted: Boolean(coverage.tape?.started),
    },
  };
}

function argValue(name, fallback = "") {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function main() {
  const root = argValue("--root", "daily_reports");
  const { problems, summary } = assertV1(root);
  if (problems.length === 0) {
    console.log(
      `[v1-assert] PASS — endpoints=${summary.endpoints} days=${summary.days} ` +
        `snapshots=${summary.snapshots} gaps=${summary.gaps} ` +
        `coverage=${summary.coveragePct === null ? "n/a" : `${summary.coveragePct}%`} ` +
        `tapeStarted=${summary.tapeStarted}`,
    );
    return;
  }
  console.error(`::error::${problems.length} v1 contract violation(s) — refusing to publish`);
  for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
  if (problems.length > 40) console.error(`  … ${problems.length - 40} more`);
  process.exit(1);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main();
