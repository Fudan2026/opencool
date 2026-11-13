#!/usr/bin/env node
/**
 * Post-capture assertion for the tape job.
 *
 * The baker already refuses to write a snapshot whose records are missing a
 * clock, so this is not a second opinion on the same data — it is a check on
 * what actually LANDED ON DISK after the write, which is what gets published.
 * The two ways the mechanism can still be broken at that point are a write that
 * did not happen (no file for the slot) and a file that parses but lost its
 * clocks in transit.
 *
 * Deliberately fails the run rather than warning: the tape's entire claim is
 * that a reader can trust `asOf` / `observedAt` on every record without
 * checking the producer. Shipping a file that cannot be trusted is worse than
 * shipping nothing, because a gap is honest and a wrong timestamp is not.
 *
 * Usage:
 *   node scripts/assert-tape-snapshot.mjs --date <YYYY-MM-DD> --slot <HH:MM>
 *
 * Env fallbacks: TAPE_DATE, TAPE_SLOT. Exit 0 on pass, 1 on failure, 2 on usage.
 */
import fs from "node:fs";
import path from "node:path";

/** ISO 8601 with an explicit UTC offset — the only accepted clock form. */
const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

export function slotStem(slot) {
  const m = /^(\d{2}):?(\d{2})$/.exec(String(slot ?? "").trim());
  return m ? `${m[1]}${m[2]}` : null;
}

/** Files in `dir` belonging to `stem`: the base capture and its revisions. */
export function snapshotFiles(dir, stem) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f === `${stem}.json` || new RegExp(`^${stem}\\.rev-\\d+\\.json$`).test(f))
    .sort();
}

/**
 * Check one snapshot object. Returns a list of problems; empty means pass.
 *
 * Any object property that looks like a section (has an `records` array) is
 * treated as one, so a section added later is covered without editing this.
 */
export function checkSnapshot(snap) {
  const problems = [];
  if (!snap || typeof snap !== "object") return ["snapshot is not an object"];

  const stamp = (v) => typeof v === "string" && OFFSET_ISO.test(v);
  if (!stamp(snap.observedAt)) {
    problems.push(`snapshot.observedAt is not an offset ISO stamp: ${JSON.stringify(snap.observedAt)}`);
  }

  let sections = 0;
  for (const [name, value] of Object.entries(snap)) {
    const section = value;
    if (!section || typeof section !== "object" || !Array.isArray(section.records)) continue;
    sections += 1;
    for (const field of ["asOf", "observedAt"]) {
      if (!stamp(section[field])) {
        problems.push(`${name}.${field} is not an offset ISO stamp: ${JSON.stringify(section[field])}`);
      }
    }
    if (section.timestampSource !== "upstream" && section.timestampSource !== "fetch") {
      problems.push(`${name}.timestampSource must be upstream|fetch, got ${JSON.stringify(section.timestampSource)}`);
    }
    section.records.forEach((rec, i) => {
      for (const field of ["asOf", "observedAt"]) {
        if (!stamp(rec?.[field])) {
          problems.push(`${name}[${i}].${field} is not an offset ISO stamp: ${JSON.stringify(rec?.[field])}`);
        }
      }
    });
  }
  if (sections === 0) problems.push("snapshot carries no sections (nothing with a records array)");
  return problems;
}

/** `name=count` per section, for the log line. Unavailable ones read `n/a`. */
export function summarize(snap) {
  return Object.entries(snap ?? {})
    .filter(([, v]) => v && typeof v === "object" && Array.isArray(v.records))
    .map(([name, s]) => `${name}=${s.unavailable ? "n/a" : s.records.length}`)
    .join(" ");
}

function argValue(argv, name, fallback = "") {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function main() {
  const argv = process.argv.slice(2);
  const date = argValue(argv, "--date", process.env.TAPE_DATE ?? "");
  const slot = argValue(argv, "--slot", process.env.TAPE_SLOT ?? "");
  const root = argValue(argv, "--root", process.env.TAPE_ROOT ?? path.join("daily_reports", "tape"));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`::error::assert-tape-snapshot needs --date YYYY-MM-DD (got "${date}")`);
    process.exit(2);
  }
  const stem = slotStem(slot);
  if (!stem) {
    console.error(`::error::assert-tape-snapshot needs --slot HH:MM (got "${slot}")`);
    process.exit(2);
  }

  const dir = path.join(root, date);
  const files = snapshotFiles(dir, stem);
  console.log(`[tape-assert] ${dir}: [${fs.existsSync(dir) ? fs.readdirSync(dir).sort().join(", ") : ""}]`);

  if (!files.length) {
    console.error(`::error::no snapshot for ${date} ${slot} — the capture wrote nothing`);
    process.exit(1);
  }

  // The newest file for this slot: the base capture, or its latest revision.
  const newest = files[files.length - 1];
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(path.join(dir, newest), "utf8"));
  } catch (e) {
    console.error(`::error::${newest} is not valid JSON: ${e?.message ?? e}`);
    process.exit(1);
  }

  const problems = checkSnapshot(snap);
  if (problems.length) {
    for (const p of problems.slice(0, 20)) console.error(`::error::${p}`);
    if (problems.length > 20) console.error(`  … ${problems.length - 20} more`);
    process.exit(1);
  }

  console.log(
    `[tape-assert] PASS ${date}/${newest} slot=${snap.slot} rev=${snap.revision} ` +
      `observedAt=${snap.observedAt} ${summarize(snap)}`,
  );
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main();
