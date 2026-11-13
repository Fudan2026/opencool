/**
 * Bake one point-in-time tape snapshot — `daily_reports/tape/<date>/<HHMM>.json`.
 *
 * Zero LLM, no dependencies, fail-open per section. Every run writes exactly one
 * new file (or one `rev-N` sibling when that slot was already captured) plus the
 * day's derived `index.json`; a second run for the same slot never rewrites the
 * first.
 *
 * Slot selection comes from `lib/tape/schedule.ts`, not from this script: the
 * ten A-share session slots are a property of the market, and the same list is
 * asserted by the tests and by `scripts/gate.mjs --mode=tape`. `TAPE_SLOT` and
 * `TAPE_DATE` override it for a manual backfill or a replay from fixtures, and
 * are the only way to capture outside a session.
 *
 * Exit codes:
 *   0  wrote a snapshot (even a fully-degraded one — gaps are data)
 *   0  nothing to capture: not a session tick (the normal no-op on most runs)
 *   1  refused: append-only would be violated, or the snapshot is malformed
 */

import "./_env";

import { captureSnapshot, resolveBoards, sectionsMissing } from "../lib/tape/capture";
import { assertTwoClocks } from "../lib/tape/sections";
import { dueTapeSlot, isTradingWeekday, TAPE_SLOTS } from "../lib/tape/schedule";
import { dayDir, writeDayIndex, writeSnapshot } from "../lib/tape/store";
import { civilNow, isoWithOffset, slotKey } from "../lib/tape/time";

const DEFAULT_TZ = "Asia/Shanghai";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Minutes of catch-up allowed after a slot's nominal time (see schedule.ts). */
function graceMinutes(): number {
  const raw = process.env.TAPE_GRACE_MIN?.trim();
  if (raw === undefined || raw === "") return 20;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 && n <= 240 ? n : 20;
}

/**
 * Which slot should this run capture? `null` means "not a capture tick".
 *
 * `TAPE_SLOT` wins outright so a manual backfill or a fixture replay is
 * explicit rather than clock-dependent. Otherwise the schedule decides, which
 * is what keeps a stray 10:47 workflow tick from writing a snapshot labelled
 * 10:35 with 10:47 prices.
 */
function chooseSlot(now: Date, tz: string): { slot: string | null; why: string } {
  const forced = process.env.TAPE_SLOT?.trim();
  if (forced) {
    try {
      return { slot: `${forced.slice(0, 2)}:${forced.slice(-2)}`, why: "TAPE_SLOT override" };
    } catch {
      return { slot: null, why: `TAPE_SLOT not understood: "${forced}"` };
    }
  }
  const clock = civilNow(now, tz);
  const slot = dueTapeSlot(clock, graceMinutes());
  if (slot) return { slot, why: `${pad2(clock.hour)}:${pad2(clock.minute)} ${tz}` };
  if (!isTradingWeekday(clock.date)) return { slot: null, why: `${clock.date} is a weekend` };
  return {
    slot: null,
    why: `${pad2(clock.hour)}:${pad2(clock.minute)} ${tz} is not within ${graceMinutes()}min of a session slot`,
  };
}

async function main(): Promise<void> {
  const tz = process.env.REPORT_TZ?.trim() || DEFAULT_TZ;
  const now = new Date();
  const dateOverride = process.env.TAPE_DATE?.trim();
  const clock = civilNow(now, tz);
  const date = dateOverride || clock.date;

  const { slot, why } = chooseSlot(now, tz);
  if (!slot) {
    console.log(`[tape:bake] no capture this tick — ${why}`);
    return;
  }

  const label = `${date} ${slot} (${isoWithOffset(now, tz)})`;
  const resolved = await resolveBoards();
  const { snapshot, registry, summary, degraded } = await captureSnapshot({
    date,
    slot,
    now,
    timezone: tz,
    resolved,
  });

  // A snapshot that cannot prove its two clocks is not worth writing: the whole
  // value of the store is that a reader can trust `asOf`/`observedAt` without
  // checking the producer. This is a bug guard, not an upstream guard.
  const violations = assertTwoClocks(snapshot as unknown as Record<string, unknown>);
  if (violations.length) {
    for (const v of violations.slice(0, 10)) {
      console.error(
        `[tape:bake] clock violation ${v.section}${v.record === null ? "" : `[${v.record}]`}.${v.field}: ${v.detail}`,
      );
    }
    throw new Error(
      `${violations.length} record(s) without both asOf and observedAt — refusing to write`,
    );
  }

  const result = writeSnapshot(snapshot);
  const index = writeDayIndex(dayDir(undefined, date), date, tz);
  const missing = sectionsMissing(snapshot);

  console.log(
    `[tape:bake] ${label} → ${result.file} ` +
      `(slot=${slotKey(slot)} rev=${result.revision}${result.isRevision ? ` changed=${result.changed.join(",") || "none"}` : ""})`,
  );
  console.log(`[tape:bake] sections ${summary} registry=${registry} degraded=${degraded}`);
  if (missing.length) {
    console.log(`[tape:bake] unavailable: ${missing.join(", ")} — recorded as named gaps, not failures`);
  }
  console.log(
    `[tape:bake] day index ${date}: ${index.snapshots.length} snapshot file(s), ` +
      `expected ${TAPE_SLOTS.length} slots`,
  );
}

main().catch((e) => {
  // A refusal (append-only violation, malformed snapshot) is a real error and
  // must be visible. An upstream failure never reaches here: every section
  // swallows its own errors and degrades to `unavailable`.
  console.error(`[tape:bake] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
