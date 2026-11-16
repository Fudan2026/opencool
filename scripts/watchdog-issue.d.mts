/**
 * Type surface for scripts/watchdog-issue.mjs (zero-dep ESM, run directly by
 * Node). Only the exported pure-ish helpers are described; the CLI main() is
 * the entry point and is never imported.
 */

export interface SlotProbe {
  /** What the sidecar probe actually saw on gh-pages. */
  status: "live" | "missing" | "unknown";
  /** `fetch_health.generated_at` when readable, else null. */
  generatedAt: string | null;
}

export function probeSidecarLive(opts: {
  repo: string;
  token: string;
  date: string;
  hour: string;
  fetchImpl?: typeof fetch;
}): Promise<SlotProbe>;

export interface WatchdogEvent {
  kind: "edition-built" | "pipeline-failure";
  heading: string;
  lines: string[];
  /** Hidden dedupe marker carried by the comment. */
  marker: string;
}

/**
 * What happened on this tick, or null when the tick has nothing to report.
 * `slotProbe` is the sidecar probe result taken at comment time (null when no
 * slot was named or the run succeeded).
 */
export function composeEvent(slotProbe?: SlotProbe | null): WatchdogEvent | null;

export function outcomeNote(
  result: string,
  slotProbe?: SlotProbe | null,
): string;
