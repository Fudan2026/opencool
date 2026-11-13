#!/usr/bin/env node
/**
 * Post-build assertion for the reading pages.
 *
 * The baker exits 0 on purpose when there is no tape or no ledger — a page that
 * says "waiting for the next session" is a correct deliverable. That makes
 * "exited 0" a weak signal on its own: a regression that renders an empty
 * document, or writes the wrong filename, would also exit 0 and publish a 200
 * with nothing in it.
 *
 * So this checks the thing that actually gets served: both files exist, are
 * non-trivial, and carry the marker each page is built around. It is a check on
 * what landed on disk, matching `assert-tape-snapshot.mjs` rather than being a
 * second opinion on the same data.
 *
 * Usage:
 *   node scripts/assert-reading-pages.mjs [--dir daily_reports]
 *
 * Exit 0 on pass, 1 on failure.
 */
import fs from "node:fs";
import path from "node:path";

/** Each page, and the marker that proves its own content rendered. */
const PAGES = [
  {
    file: "hour.html",
    // The 口径 block ships in every state, including the empty one, so its
    // absence means the page body did not render at all.
    markers: ["盘中逐时报", "口径"],
    minBytes: 2000,
  },
  {
    file: "stories.html",
    // Either the ledger rendered or the named gap did; both are real pages.
    markers: ["故事线"],
    minBytes: 2000,
    anyOf: [["data-rank-basis=", 'data-gap="ledger"']],
  },
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export function checkPage(dir, spec) {
  const problems = [];
  const file = path.join(dir, spec.file);
  if (!fs.existsSync(file)) {
    return [`${spec.file} does not exist`];
  }
  const html = fs.readFileSync(file, "utf8");
  if (html.length < spec.minBytes) {
    problems.push(`${spec.file} is only ${html.length} bytes (minimum ${spec.minBytes})`);
  }
  if (!html.includes("<!doctype html>")) problems.push(`${spec.file} is not an HTML document`);
  for (const marker of spec.markers) {
    if (!html.includes(marker)) problems.push(`${spec.file} is missing marker ${JSON.stringify(marker)}`);
  }
  for (const group of spec.anyOf ?? []) {
    if (!group.some((m) => html.includes(m))) {
      problems.push(`${spec.file} carries none of ${JSON.stringify(group)}`);
    }
  }
  // Neither page may ship an unresolved template placeholder: `fill()` leaves
  // `{key}` in place when a variable is missing, which would render to the
  // reader as a raw brace.
  const leaked = [...html.matchAll(/\{(?:[a-z][A-Za-z0-9_]*){1}\}/g)]
    .map((m) => m[0])
    // The pages inline a little JS/CSS; only flag placeholders in visible text.
    .filter((token) => !/^\{(?:0|1|min|max)\}$/.test(token));
  if (leaked.length) {
    problems.push(`${spec.file} leaked template placeholders: ${[...new Set(leaked)].slice(0, 5).join(", ")}`);
  }
  return problems;
}

function main() {
  const dir = arg("dir", "daily_reports");
  const problems = [];
  for (const spec of PAGES) problems.push(...checkPage(dir, spec));

  if (problems.length) {
    for (const p of problems) console.error(`[assert-reading-pages] ${p}`);
    console.error(
      `[assert-reading-pages] refusing to publish: ${problems.length} problem(s). ` +
        "A page that is absent or empty would still serve HTTP 200.",
    );
    process.exit(1);
  }
  for (const spec of PAGES) {
    const bytes = fs.statSync(path.join(dir, spec.file)).size;
    console.log(`[assert-reading-pages] ok ${spec.file} (${bytes} bytes)`);
  }
}

main();
