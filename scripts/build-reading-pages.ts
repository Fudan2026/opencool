/**
 * Build `daily_reports/hour.html` and `daily_reports/stories.html`.
 *
 * Two reading pages over the point-in-time artifacts, run after the bakes that
 * produce them and before `build-site` publishes the tree:
 *
 *   hour.html     the intraday tape as prose — one sentence per cross-section,
 *                 slot and day navigation, two clocks always visible;
 *   stories.html  story threads — sightings, revision trail, first-mover column.
 *
 * Why a separate baker rather than more code in `build-site.mjs`: build-site is
 * a publishing pipeline (index, archive, feed, status, prunes) that happens to
 * also render extras, while these two pages are *products* over two specific
 * datasets and need their own loaders, caps and fail-open paths. A dedicated
 * script also means the pages can be rebuilt from cached artifacts in under a
 * second without touching the publish pipeline.
 *
 * Fail-open, always exit 0:
 *   - no tape  → hour.html renders the "waiting for the first snapshot" state;
 *   - missing slots/days → named gaps inside the page, never a blank table;
 *   - bad snapshot JSON → that slot is a named gap;
 *   - no/invalid stories.json → stories.html renders the named ledger gap.
 * A page that cannot be built must not block an edition that can.
 *
 * Zero LLM, zero network: this script only reads files under `daily_reports/`.
 */

import "./_env";

import fs from "node:fs";
import path from "node:path";

import { renderHourPage } from "../lib/output/hour-page";
import { renderStoriesPage } from "../lib/output/stories-page";
import { loadAllSources } from "../lib/sources/registry";
import { TAPE_SLOTS } from "../lib/tape/schedule";
import { buildSlotReading, readTapeDays, type SlotReading, type StoryContext } from "../lib/tape/reading";
import { reviveLedger, type StoriesPayload, type StoryRecord } from "../lib/stories/ledger";
import { buildPayload } from "../lib/stories/ledger";
import { isoWithOffset } from "../lib/stories/time";

const ROOT = process.env.REPORTS_DIR?.trim() || "daily_reports";
const TZ = process.env.REPORT_TZ?.trim() || "Asia/Shanghai";

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Source display names, so a sighting reads "彭博" rather than `bloomberg`.
 * Best-effort: the registry loader is the source of truth and throws on a
 * malformed config, which must not cost the page.
 */
function sourceNames(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of loadAllSources()) out[s.id] = s.name;
  return out;
}

/** Load the ledger, tolerating a missing or corrupt file (fail-open). */
function loadStories(): {
  payload: StoriesPayload | null;
  stories: StoryRecord[] | null;
  reason: string;
} {
  const file = path.join(ROOT, "stories.json");
  if (!fs.existsSync(file)) {
    return { payload: null, stories: null, reason: "stories.json not present yet" };
  }
  const raw = readJson(file);
  if (!raw) return { payload: null, stories: null, reason: "stories.json is not valid JSON" };
  const { ledger, skipped } = reviveLedger(raw);
  const body = raw as Partial<StoriesPayload>;
  const counts = body.counts ?? {
    stories: ledger.stories.length,
    sightings: ledger.stories.reduce((n, s) => n + s.sightings.length, 0),
    multiSightingStories: 0,
    storiesWithRevisions: ledger.stories.filter((s) => s.headlineRevisions.length > 0).length,
    skippedRecords: skipped,
    editions: 0,
    articles: 0,
    duplicates: 0,
  };
  const payload =
    body.firstMover && body.revisionTrail
      ? ({ ...ledger, generatedAt: body.generatedAt ?? isoWithOffset(new Date(), TZ), counts, firstMover: body.firstMover, revisionTrail: body.revisionTrail } as StoriesPayload)
      : buildPayload(ledger, {
          editions: counts.editions,
          articles: counts.articles,
          duplicates: counts.duplicates,
          skippedRecords: skipped,
        });
  return { payload, stories: ledger.stories, reason: "" };
}

function buildHour(): void {
  const names = sourceNames();
  const { stories, reason: ledgerReason } = loadStories();
  const storyCtx: StoryContext = {
    stories,
    sourceNames: names,
    reason: ledgerReason || "ledger unavailable",
  };

  const days = readTapeDays(path.join(ROOT, "tape"));
  const readings = new Map<string, SlotReading>();
  for (const day of days) {
    for (const slot of day.slots) {
      if (!slot.snapshot) continue;
      readings.set(
        `${day.date}/${slot.time}`,
        buildSlotReading(slot.snapshot, { stories: storyCtx }),
      );
    }
  }

  const html = renderHourPage({
    days,
    readings,
    timezone: days[0]?.slots.find((s) => s.snapshot)?.snapshot?.timezone ?? TZ,
    expectedSlots: TAPE_SLOTS as string[],
    empty: days.length === 0,
  });
  const out = path.join(ROOT, "hour.html");
  fs.writeFileSync(out, html, "utf8");

  const filled = days.reduce((n, d) => n + d.slots.filter((s) => s.snapshot).length, 0);
  const expected = days.length * (TAPE_SLOTS as string[]).length;
  console.log(
    `[hour] ${out} · ${days.length} day(s) · ${filled}/${expected || 0} slot(s) captured` +
      (days.length === 0 ? " · waiting for the first snapshot" : ""),
  );
}

function buildStories(): void {
  const names = sourceNames();
  const { payload, reason } = loadStories();
  const html = renderStoriesPage({ payload, reason, sourceNames: names });
  const out = path.join(ROOT, "stories.html");
  fs.writeFileSync(out, html, "utf8");
  console.log(
    `[stories] ${out} · ` +
      (payload
        ? `${payload.counts.stories} story/ies · ${payload.counts.sightings} sighting(s) · basis=${payload.firstMover.leadBasis}`
        : `named gap (${reason})`),
  );
}

function main(): void {
  fs.mkdirSync(ROOT, { recursive: true });
  // `--only=hour` lets the tape job refresh the intraday page alone: it
  // restores only the tape tree plus stories.json, so rebuilding stories.html
  // there would overwrite the real ledger page with the empty state.
  const only = (process.env.READING_PAGES ?? argOnly()).trim();
  const wantHour = only === "" || only === "hour" || only === "both";
  const wantStories = only === "" || only === "stories" || only === "both";
  const jobs: Array<[string, () => void]> = [];
  if (wantHour) jobs.push(["hour", buildHour]);
  if (wantStories) jobs.push(["stories", buildStories]);

  // Each page is independently fail-open: a problem building one must not stop
  // the other, and neither may fail the publish.
  for (const [name, fn] of jobs) {
    try {
      fn();
    } catch (e) {
      console.error(
        `[${name}] FAILED to build (publish continues): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

function argOnly(): string {
  const flag = process.argv.find((a) => a.startsWith("--only="));
  return flag ? flag.slice("--only=".length) : "";
}

main();
