/**
 * Source disable overlay — runtime complement to DISABLE_SOURCE_IDS.
 * sources.config.json stays the single source of truth (AGENTS.md):
 * the overlay is a GENERATED file (daily_reports/source-overlay.json,
 * written by build-site when a source fails all editions for N straight
 * days) and can be rolled back by deleting entries or the file.
 */
import fs from "node:fs";
import path from "node:path";

export interface SourceOverlay {
  disabled: string[];
  corrupt: boolean;
  reason?: string;
}

export function loadSourceOverlay(dir = "daily_reports"): SourceOverlay {
  try {
    const fp = path.join(dir, "source-overlay.json");
    if (!fs.existsSync(fp)) return { disabled: [], corrupt: false };
    const j = JSON.parse(fs.readFileSync(fp, "utf8")) as {
      disabled?: unknown;
      reason?: string;
    };
    if (!Array.isArray(j.disabled)) return { disabled: [], corrupt: true };
    return {
      disabled: j.disabled.filter((x): x is string => typeof x === "string"),
      corrupt: false,
      reason: j.reason,
    };
  } catch {
    // corrupt or unreadable overlay must never break source loading
    return { disabled: [], corrupt: true };
  }
}
