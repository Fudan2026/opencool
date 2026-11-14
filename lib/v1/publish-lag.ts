/**
 * Measured publish times for the edition slots — the honesty layer for the
 * site's own punctuality.
 *
 * The site publicly names slots (06:00 / 13:00 / 19:00 in REPORT_TZ), and the
 * scheduler demonstrably drops most of its ticks, so those times are targets
 * rather than promises. This module turns the measurement into a surface: for
 * every slot of the last 14 days it compares the edition sidecar's own
 * `fetch_health.generated_at` (the instant its data was generated, the same
 * field the gate and the publish-lag assertion use) against the slot's due
 * instant, and labels the result. A slot that never published is listed as
 * missing, never omitted: the table exists so the record includes the bad
 * days.
 *
 * Rendering lives here rather than in `renderIntegrityHtml` on purpose: the
 * page renderer is shared report code, and this section is baked by
 * `scripts/bake-v1.ts` (which owns integrity.html generation) from data only
 * the bake tree has. Copy still comes from the `STR` tables via `STRINGS`, so
 * zh/en parity holds exactly as it does on the rest of the page.
 *
 * Deterministic like the rest of the v1 bake: no network, no LLM, and the
 * only clock is the caller's `now`.
 */

import fs from "node:fs";
import path from "node:path";

import { addDays, civilNow } from "../../scripts/gate.mjs";
import {
  formatInTz,
  minutesBetween,
  readSidecarGeneratedAt,
  zonedWallToInstant,
} from "../../scripts/assert-publish-lag.mjs";
import { fill, STRINGS } from "../output/render";
import { getReportTz, parseReportHours } from "../utils";

export const DEFAULT_PUBLISH_LAG_LIMIT_MIN = 20;
export const PUBLISH_LAG_WINDOW_DAYS = 14;

export type PublishLagVerdict = "on-time" | "late" | "early" | "missing" | "pending";

export interface PublishLagRow {
  date: string;
  /** `"06"`, `"13"`, `"19"` — the slot key. */
  slot: string;
  /** Wall-clock due time in REPORT_TZ, e.g. `"06:00"`. */
  dueSh: string;
  /** When the sidecar's data was generated, wall clock in REPORT_TZ; null when absent. */
  actualSh: string | null;
  /** Rounded minutes, negative = generated before its slot; null when not measurable. */
  lagMinutes: number | null;
  verdict: PublishLagVerdict;
}

export interface PublishLagView {
  /**
   * False when the input tree contains no edition sidecar at all (a partial
   * restore — the reading-pages job restores only tape + ledger). Zero
   * sidecars must not render as 42 "missing" rows: that would report a
   * two-week outage the tree simply cannot see. It renders a named
   * no-measurement state instead, mirroring how the page already treats a
   * missing story ledger.
   */
  available: boolean;
  days: number;
  /** Slot keys, e.g. `["06", "13", "19"]`. */
  slots: string[];
  /** Minutes of tolerated lateness (same default as the publish-lag assertion). */
  limitMin: number;
  rows: PublishLagRow[];
  counts: { onTime: number; late: number; early: number; missing: number; pending: number };
}

export interface CollectPublishLagOptions {
  root: string;
  now?: Date;
  timezone?: string;
  days?: number;
  slots?: string[];
  limitMin?: number;
}

function escapeHtml(s: string): string {
  // Byte-identical to render.ts's local helper: the injection anchor below is
  // built from the same STR string the page renderer used, so the two must
  // agree on escaping.
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Does the tree hold at least one edition sidecar anywhere (any date, any slot)? */
function treeHasAnySidecar(root: string): boolean {
  let dates: string[] = [];
  try {
    dates = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  } catch {
    return false;
  }
  for (const d of dates) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(root, d));
    } catch {
      continue;
    }
    if (files.some((f) => /^\d{2}\.json$/.test(f))) return true;
  }
  return false;
}

/**
 * Collect the 14-day measured publish-lag table.
 *
 * Verdict rules, per slot:
 *   - sidecar with a parsable `generated_at` → measured against the due
 *     instant: `early` when before it, `on-time` within `limitMin`, `late`
 *     beyond. A premature build that is still live is shown as early, which is
 *     the fact a reader needs (the gate rebuilds those; the row updates then).
 *   - no sidecar and the due instant is still ahead → `pending`: not yet due
 *     is not missing, the same line the tape coverage draws.
 *   - no sidecar and the due instant has passed → `missing`, named, never
 *     omitted.
 *   - a sidecar whose `generated_at` is absent or unparsable is treated as
 *     unmeasurable and reported like a missing slot: punctuality that cannot
 *     be verified must not display as "on time".
 */
export function collectPublishLag(options: CollectPublishLagOptions): PublishLagView {
  const root = options.root;
  const now = options.now ?? new Date();
  const timezone = options.timezone ?? getReportTz() ?? "Asia/Shanghai";
  const days = Math.max(1, options.days ?? PUBLISH_LAG_WINDOW_DAYS);
  const slots =
    options.slots ??
    parseReportHours().map((h) => pad2(h));
  const limitMin = options.limitMin ?? DEFAULT_PUBLISH_LAG_LIMIT_MIN;

  // civilNow honours the resolved timezone rather than the env directly, so
  // `timezone` stays the single source of truth for both the window anchor and
  // the due instants (a backfill EDITION_DATE never shifts the window: this is
  // a status surface, so it anchors to the real now).
  const today = civilNow(now, timezone).date;
  const counts = { onTime: 0, late: 0, early: 0, missing: 0, pending: 0 };
  const rows: PublishLagRow[] = [];

  for (let back = 0; back < days; back += 1) {
    const date = addDays(today, -back);
    for (const slot of slots) {
      const due = zonedWallToInstant(date, Number(slot), timezone);
      const generatedRaw = readSidecarGeneratedAt(date, slot, root);
      const generatedAt = generatedRaw ? new Date(generatedRaw) : null;
      const measurable = generatedAt !== null && !Number.isNaN(generatedAt.getTime());

      let verdict: PublishLagVerdict;
      let actualSh: string | null = null;
      let lagMinutes: number | null = null;
      if (measurable && generatedAt) {
        actualSh = formatInTz(generatedAt, timezone);
        lagMinutes = minutesBetween(due, generatedAt);
        verdict = lagMinutes < 0 ? "early" : lagMinutes > limitMin ? "late" : "on-time";
      } else if (due.getTime() > now.getTime()) {
        verdict = "pending";
      } else {
        verdict = "missing";
      }
      counts[verdict === "on-time" ? "onTime" : verdict] += 1;
      rows.push({ date, slot, dueSh: `${slot}:00`, actualSh, lagMinutes, verdict });
    }
  }

  return {
    available: treeHasAnySidecar(root),
    days,
    slots,
    limitMin,
    rows,
    counts,
  };
}

function verdictCell(row: PublishLagRow): string {
  switch (row.verdict) {
    case "on-time":
      return escapeHtml(STRINGS.integrityLagOnTime);
    case "late":
      return escapeHtml(fill(STRINGS.integrityLagLate, { n: row.lagMinutes ?? 0 }));
    case "early":
      return escapeHtml(
        fill(STRINGS.integrityLagEarly, { n: Math.abs(row.lagMinutes ?? 0) }),
      );
    case "missing":
      return escapeHtml(STRINGS.integrityLagMissing);
    case "pending":
      return escapeHtml(STRINGS.integrityLagPending);
  }
}

/** Render the section exactly as it sits inside `<main>` on integrity.html. */
export function renderPublishLagSection(view: PublishLagView): string {
  const title = escapeHtml(fill(STRINGS.integrityLagTitle, { days: view.days }));

  if (!view.available) {
    return `  <section class="empty" data-surface="publish-lag-empty">
    <h2>${title}</h2>
    <p>${escapeHtml(STRINGS.integrityLagNoData)}</p>
  </section>`;
  }

  const intro = escapeHtml(
    fill(STRINGS.integrityLagIntro, {
      slots: view.slots.map((s) => `${s}:00`).join(" / "),
      limit: view.limitMin,
    }),
  );
  const summary = escapeHtml(
    fill(STRINGS.integrityLagSummary, {
      days: view.days,
      slots: view.slots.length * view.days,
      onTime: view.counts.onTime,
      late: view.counts.late,
      early: view.counts.early,
      missing: view.counts.missing,
      pending: view.counts.pending,
    }),
  );

  const body = view.rows
    .map((row) => {
      // Not-yet-due rows are muted like the tape page's closed days: the slot
      // owes nothing yet, and gray keeps it from reading as a failure.
      const cls = row.verdict === "pending" ? ' class="closed"' : "";
      return `      <tr${cls}><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.dueSh)}</td><td>${escapeHtml(
        row.actualSh ?? "—",
      )}</td><td class="n">${row.lagMinutes === null ? "—" : escapeHtml(String(row.lagMinutes))}</td><td>${verdictCell(
        row,
      )}</td></tr>`;
    })
    .join("\n");

  return `  <h2>${title}</h2>
  <p class="meta">${intro}</p>
  <p class="meta">${summary}</p>
  <table data-surface="publish-lag">
    <thead><tr><th>${escapeHtml(STRINGS.integrityColDate)}</th><th>${escapeHtml(
      STRINGS.integrityLagColSlot,
    )}</th><th>${escapeHtml(STRINGS.integrityLagColActual)}</th><th>${escapeHtml(
      STRINGS.integrityLagColLag,
    )}</th><th>${escapeHtml(STRINGS.integrityLagColVerdict)}</th></tr></thead>
    <tbody>
${body}
    </tbody>
  </table>`;
}

/**
 * Splice the section into the integrity page, directly under the intro lede.
 *
 * The anchor is rebuilt from the same `STRINGS` entry the page renderer used,
 * so the match is exact in either locale. When the page markup ever changes so
 * the anchor disappears, this returns `injected: false` and the bake logs it:
 * a silently missing table would be exactly the kind of quiet gap this page
 * refuses to publish.
 */
export function injectPublishLagSection(
  html: string,
  section: string,
): { html: string; injected: boolean } {
  const anchor = `  <p class="lede">${escapeHtml(STRINGS.integrityIntro)}</p>`;
  if (!html.includes(anchor)) return { html, injected: false };
  return { html: html.replace(anchor, `${anchor}\n${section}`), injected: true };
}
