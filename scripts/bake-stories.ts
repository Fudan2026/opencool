/**
 * Bake daily_reports/stories.json — the story ledger.
 *
 * Reads every `daily_reports/<date>/<HH>-articles.json` sidecar already on disk
 * and folds them into a ledger that persists across editions, in file order, so
 * the result is reproducible from the published tree alone.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Where the persistence lives (and why not somewhere new)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * CI restores the whole gh-pages tree into `daily_reports/` before the build
 * ("Restore existing reports from gh-pages"), and publishes `daily_reports/`
 * back afterwards. So a file in that tree IS a persistent store: `stories.json`
 * is written there, read back on the next run, and republished by the existing
 * push. No new store, no database, no extra workflow step — that pattern is
 * already load-bearing for `sentiment-history.json`, `keywords.json`,
 * `themes.json` and friends.
 *
 * The ledger is a *derived* artifact of the retained sidecars, so a lost or
 * corrupt `stories.json` is recoverable by re-baking: every sidecar in the
 * retention window is replayed. That is also why the prune window here matches
 * the articles-sidecar prune (30 days) — beyond it there is nothing left to
 * replay from.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Observation time
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The edition's own fetch instant is `fetch_health.generated_at` in `<HH>.json`
 * — the moment the pipeline actually pulled the feeds. That is our observation
 * clock, and it is used for every sighting in that edition. It is NOT the
 * feed's `pubDate` and NOT the nominal slot time: a 13:00 edition built at
 * 13:04 observed its articles at 13:04, and an edition recovered by the hourly
 * gate at 15:20 observed them at 15:20. Both are recorded as they happened.
 *
 * `fetch_health` absent (an older or hand-made sidecar) falls back to the slot
 * time, and the fallback count is reported so a run that leaned on it is
 * visible instead of looking identical to a precise one.
 *
 * Fail-open: a sidecar that will not parse is skipped and counted; the bake
 * exits 0 regardless. Zero LLM, zero network.
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";

import {
  buildPayload,
  emptyLedger,
  ingestEdition,
  pruneLedger,
  reviveLedger,
  sortStories,
  DEFAULT_MAX_STORIES,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_WINDOW_DAYS,
  type EditionInput,
  type LedgerStats,
  type StoryArticle,
} from "../lib/stories/ledger";
import { getReportTz } from "../lib/utils";

const ROOT = "daily_reports";
const OUT = path.join(ROOT, "stories.json");
const REVISION_TRAIL_LIMIT = 50;

function envInt(name: string, fallback: number, min = 0): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min ? Math.floor(raw) : fallback;
}

/** `2026-11-13` + `13` → the instant that slot nominally covers, in REPORT_TZ. */
function slotInstant(date: string, hour: string): Date | null {
  const h = String(hour).padStart(2, "0");
  const utcGuess = new Date(`${date}T${h}:00:00Z`);
  if (Number.isNaN(utcGuess.getTime())) return null;
  // Convert the civil slot to a real instant without pulling in a tz library:
  // render the guess in REPORT_TZ, and shift by the difference.
  const tz = getReportTz();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(utcGuess)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const drift = asUtc - utcGuess.getTime();
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), Number(h)) - drift);
}

/** Every `<date>/<HH>-articles.json`, oldest first — replay order. */
function sidecarFiles(): Array<{ date: string; hour: string; file: string }> {
  if (!fs.existsSync(ROOT)) return [];
  const out: Array<{ date: string; hour: string; file: string }> = [];
  for (const day of fs.readdirSync(ROOT).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()) {
    const dir = path.join(ROOT, day);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries.filter((x) => /^\d{2}-articles\.json$/.test(x)).sort()) {
      out.push({ date: day, hour: f.slice(0, 2), file: path.join(dir, f) });
    }
  }
  return out;
}

/** The instant the pipeline fetched that edition, from its own sidecar. */
function observedAtFor(date: string, hour: string): { at: Date | null; precise: boolean } {
  const sidecar = path.join(ROOT, date, `${hour}.json`);
  try {
    const r = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    const raw = r?.fetch_health?.generated_at;
    const at = typeof raw === "string" ? new Date(raw) : null;
    if (at && !Number.isNaN(at.getTime())) return { at, precise: true };
  } catch {
    // no sidecar / unreadable — fall through to the nominal slot
  }
  return { at: slotInstant(date, hour), precise: false };
}

function readArticles(file: string): StoryArticle[] | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(r?.articles)) return null;
    return r.articles.filter(
      (a: unknown): a is StoryArticle =>
        !!a && typeof a === "object" &&
        typeof (a as StoryArticle).sourceId === "string" &&
        typeof (a as StoryArticle).title === "string",
    );
  } catch {
    return null;
  }
}

function main(): void {
  const retentionDays = envInt("STORIES_RETENTION_DAYS", DEFAULT_RETENTION_DAYS);
  const maxStories = Math.max(1, envInt("STORIES_MAX", DEFAULT_MAX_STORIES, 1));
  const windowDays = Math.max(1, envInt("STORIES_WINDOW_DAYS", DEFAULT_WINDOW_DAYS, 1));

  // Prior ledger, if the gh-pages restore brought one in. A corrupt file is
  // reported and ignored (the sidecars replay it), never fatal.
  let priorSkipped = 0;
  let ledger = emptyLedger({ retentionDays, maxStories });
  if (fs.existsSync(OUT)) {
    try {
      const raw = JSON.parse(fs.readFileSync(OUT, "utf8"));
      const revived = reviveLedger(raw, { retentionDays, maxStories });
      ledger = revived.ledger;
      priorSkipped = revived.skipped;
      console.log(
        `[stories:bake] restored ${ledger.stories.length} stories from ${OUT}` +
          (priorSkipped ? ` (${priorSkipped} unreadable records skipped)` : ""),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[stories:bake] ${OUT} unreadable (${msg}) — rebuilding from sidecars`);
    }
  }

  const stats: LedgerStats & { skippedRecords: number } = {
    editions: 0,
    articles: 0,
    duplicates: 0,
    skippedRecords: priorSkipped,
  };

  let slotFallbacks = 0;
  const missingObserved: string[] = [];
  const unreadable: string[] = [];

  for (const { date, hour, file } of sidecarFiles()) {
    const articles = readArticles(file);
    if (!articles) {
      unreadable.push(`${date}/${hour}`);
      continue;
    }
    const { at, precise } = observedAtFor(date, hour);
    if (!at) {
      missingObserved.push(`${date}/${hour}`);
      continue;
    }
    if (!precise) slotFallbacks++;

    const edition: EditionInput = { date, hour, observedAt: at, articles };
    const r = ingestEdition(ledger, edition);
    stats.editions++;
    stats.articles += articles.length;
    stats.duplicates += r.duplicates;
  }

  const pruned = pruneLedger(ledger);
  sortStories(ledger);
  ledger.updatedAt = new Date().toISOString();
  ledger.timezone = getReportTz() ?? ledger.timezone;
  ledger.retentionDays = retentionDays;
  ledger.maxStories = maxStories;

  const payload = buildPayload(ledger, stats, {
    windowDays,
    revisionLimit: REVISION_TRAIL_LIMIT,
  });

  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");

  const top = payload.firstMover.wires
    .filter((w) => w.contestedFirsts > 0)
    .slice(0, 3)
    .map((w) => `${w.sourceId}:${w.contestedFirsts}(${w.medianLeadMinutes ?? "—"}m)`)
    .join(" ");
  console.log(
    `[stories:bake] wrote ${OUT} editions=${stats.editions} articles=${stats.articles} ` +
      `stories=${payload.counts.stories} multi=${payload.counts.multiSightingStories} ` +
      `revisions=${payload.revisionTrail.totalRevisions} pruned=${pruned} ` +
      `contested=${payload.firstMover.contestedStories}/${payload.firstMover.storiesInWindow} ` +
      `tied=${payload.firstMover.tiedFirstStories}`,
  );
  if (top) console.log(`[stories:bake] top first movers (contested): ${top}`);
  if (unreadable.length) {
    console.warn(
      `[stories:bake] ${unreadable.length} unreadable sidecar(s) skipped: ${unreadable.slice(0, 6).join(",")}`,
    );
  }
  if (slotFallbacks) {
    console.warn(
      `[stories:bake] ${slotFallbacks} edition(s) had no fetch_health.generated_at — observation time fell back to the nominal slot`,
    );
  }
  if (missingObserved.length) {
    console.warn(
      `[stories:bake] ${missingObserved.length} edition(s) had no usable observation time: ${missingObserved.slice(0, 6).join(",")}`,
    );
  }
}

try {
  main();
} catch (e) {
  console.error(e);
  // fail-open: the ledger is a data product, never a publish gate
  process.exit(0);
}
