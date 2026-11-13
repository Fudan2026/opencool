/**
 * Type surface for scripts/assert-reading-pages.mjs (zero-dep ESM, run directly
 * by Node). Only the exported checker is described; the script's `main()` is the
 * CLI entry point and is never imported.
 */

export interface PageSpec {
  file: string;
  markers: string[];
  minBytes: number;
  /** Groups of markers where at least one member must be present. */
  anyOf?: string[][];
}

/** Problems found for one page; an empty array means the page is publishable. */
export function checkPage(dir: string, spec: PageSpec): string[];
