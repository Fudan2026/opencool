/**
 * Bake `daily_reports/reactions.json` — the news→sector reaction windows.
 *
 * Inputs are files that already exist in the published tree:
 *   `daily_reports/tape/<date>/<HHMM>.json`  the point-in-time tape
 *   `daily_reports/stories.json`             the story ledger
 *
 * Zero network, zero LLM, no dependencies beyond node:fs. That is not an
 * incidental property: the moat here is arithmetic over observations we already
 * made, and a bake that could reach the network could not be replayed.
 *
 * Exit codes:
 *   0  wrote a payload (including an honest all-`insufficient` one)
 *   1  the payload could not be assembled at all (a bug, not an upstream gap)
 *
 * Everything an input cannot tell us is a **named gap** in `gaps[]`, never a
 * thrown error: the day-one output of this file is legitimately "tape history
 * starts Monday", and a bake that failed on that would never produce it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Retention: why this reads the whole ledger
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `+5d` needs stories whose `firstSeenAt` is at least five days old to be
 * measurable, and the ledger's 2,000-story cap is binding today (5,705 records
 * pruned). The cap is enforced *by the ledger bake*, before this script runs,
 * so raising `STORIES_MAX` here would do nothing — the knob is documented in
 * the report as a ledger-side decision, and this script states the consequence
 * in `ledger.capBinding` so the trade-off is visible in the artifact itself
 * rather than only in a PR description.
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";

import { buildReactions, loadTape, serializeReactions } from "../lib/reactions";

const ROOT = "daily_reports";
const LEDGER = path.join(ROOT, "stories.json");
const OUT = path.join(ROOT, "reactions.json");

function readJson(file: string): { value: unknown; error: string | null } {
  if (!fs.existsSync(file)) return { value: null, error: `${file} does not exist` };
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")), error: null };
  } catch (e) {
    return { value: null, error: `${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function main(): void {
  const { value: ledger, error: ledgerError } = readJson(LEDGER);
  if (ledgerError) {
    console.warn(`[reactions:bake] ${ledgerError} — baking with an empty ledger`);
  }

  // A missing or unreadable ledger is an empty ledger plus a named gap, so the
  // file still ships and still says it measured nothing.
  const ledgerInput =
    ledger && typeof ledger === "object" && !Array.isArray(ledger)
      ? (ledger as Record<string, unknown>)
      : { stories: [] };

  const payload = buildReactions(loadTape(), ledgerInput);
  if (ledgerError) {
    payload.gaps.unshift({ kind: "ledger-unreadable", detail: ledgerError, file: LEDGER });
  }

  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(OUT, serializeReactions(payload), "utf8");

  const c = payload.counts;
  console.log(
    `[reactions:bake] stories=${c.stories} ` +
      `attributed=${c.attributed.entity}/${c.attributed.topic}/${c.attributed.market} ` +
      `pending=${c.attributed.pending} unmapped=${c.attributed.unmapped}`,
  );
  console.log(
    `[reactions:bake] horizons ${Object.entries(c.horizons)
      .map(([k, v]) => `${k}=ok:${v.ok}/pending:${v.pending}/gap:${v.gap}`)
      .join(" ")}`,
  );
  console.log(
    `[reactions:bake] tape days=${payload.tape.days} snapshots=${payload.tape.snapshots} ` +
      `from=${payload.tape.from ?? "none"} to=${payload.tape.to ?? "none"}`,
  );
  console.log(
    `[reactions:bake] aggregates byTopic=${c.aggregates.byTopic} byEntity=${c.aggregates.byEntity} ` +
      `observations=${c.observationsPublished}/${c.observationsTotal}`,
  );
  console.log(
    `[reactions:bake] ledger cap=${payload.ledger.maxStories} retainedFrom=${payload.ledger.retainedFrom} ` +
      `capBinding=${payload.ledger.capBinding}`,
  );
  for (const g of payload.gaps) {
    console.log(`[reactions:bake] gap ${g.kind}: ${g.detail}${g.count ? ` (${g.count})` : ""}`);
  }
  console.log(`[reactions:bake] wrote ${OUT} (dataThrough=${payload.dataThrough ?? "none"})`);
}

main();
