/**
 * One tape capture: resolve the registry, build every section, assemble the
 * snapshot. Separated from `store.ts` so the store stays a pure file layer that
 * the tests can drive with fixtures, and from `sections.ts` so each section's
 * fail-open rule sits next to its fetch.
 */

import {
  fetchBoardRegistry,
  loadBoardMapSnapshot,
  type BoardEntry,
} from "../invest/board-registry";
import { captureSections, type CaptureOptions, type TapeSections } from "./sections";
import { isoWithOffset } from "./time";
import { TAPE_SCHEMA_VERSION, type TapeSnapshot } from "./store";

export { TAPE_SECTIONS } from "./sections";

export interface BoardResolution {
  boards: BoardEntry[] | null;
  registry: "live" | "snapshot" | "none";
}

export interface CaptureResult {
  snapshot: TapeSnapshot;
  /** Registry actually used for board resolution. */
  registry: "live" | "snapshot" | "none";
  /** `name=count` per section, for the run log. */
  summary: string;
  /** True when at least one section came back unavailable. */
  degraded: boolean;
}

/**
 * Resolve the board registry once, preferring live data and falling back to the
 * committed snapshot. A capture needs the registry for three sections, so
 * resolving it here rather than per section means all three agree on the board
 * list even if the registry service is flapping mid-capture.
 */
export async function resolveBoards(): Promise<BoardResolution> {
  const live = await fetchBoardRegistry();
  if (live?.length) return { boards: live, registry: "live" };
  const snapshot = loadBoardMapSnapshot();
  if (snapshot?.length) return { boards: snapshot, registry: "snapshot" };
  return { boards: null, registry: "none" };
}

/**
 * Capture one snapshot.
 *
 * Never throws for an upstream failure: each section degrades independently, so
 * a dead concept-board feed cannot cost us the index values we did see. The
 * only rejection is a caller bug — a malformed slot string.
 */
export async function captureSnapshot(
  options: CaptureOptions & { resolved?: BoardResolution },
): Promise<CaptureResult> {
  const now = options.now ?? new Date();
  const resolved: BoardResolution =
    options.resolved ?? (await resolveBoards());
  const { sections, observedAt } = await captureSections({ ...options, resolved });

  const snapshot: TapeSnapshot = {
    schemaVersion: TAPE_SCHEMA_VERSION,
    date: options.date,
    slot: options.slot,
    slotKey: "",
    revision: 0,
    observedAt,
    timezone: options.timezone,
    registry: resolved.registry,
    ...sections,
  };

  const summary = summaryLine(sections);
  return { snapshot, registry: resolved.registry, summary, degraded: sectionsMissing(sections).length > 0 };
}

function summaryLine(sections: TapeSections): string {
  return (Object.keys(sections) as Array<keyof TapeSections>)
    .map((name) => {
      const s = sections[name];
      return `${name}=${s.unavailable ? "n/a" : s.records.length}`;
    })
    .join(" ");
}

export function sectionsMissing(sections: TapeSections): string[] {
  return (Object.keys(sections) as Array<keyof TapeSections>).filter(
    (name) => sections[name].unavailable === true,
  );
}

/** `09:35` + the capture instant → `<date>/0935` label used in logs. */
export function captureLabel(date: string, slot: string, now: Date, tz: string): string {
  return `${date} ${slot} (${isoWithOffset(now, tz)})`;
}
