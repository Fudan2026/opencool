/**
 * Type surface for scripts/assert-archive-survival.mjs (zero-dep ESM, run
 * directly by Node). Only the exported helpers are described; the CLI phases
 * (`--capture` / `--assert`) are the entry point and are never imported.
 */

/** Keep only `<YYYY-MM-DD>/<HH>.json` paths — the sidecars the gate probes. */
export function filterSidecarPaths(paths: string[]): string[];

/**
 * Sidecars in the FETCHED origin/gh-pages tree. Empty when gh-pages does not
 * exist yet (first run — nothing to protect).
 */
export function captureSidecarList(opts?: { gitDir?: string }): string[];

export interface SurvivalResult {
  /** How many captured sidecars the assert compared. */
  listed: number;
  /** Captured sidecars missing from the publish output tree, in capture order. */
  missing: string[];
}

/**
 * Which captured sidecars are missing from the publish output tree? Empty
 * `missing` = the archive survived. Throws when the capture list is absent —
 * the assert phase is only meaningful after a capture in the same job.
 */
export function checkSurvival(opts: {
  listFile: string;
  publishDir?: string;
}): Promise<SurvivalResult>;
