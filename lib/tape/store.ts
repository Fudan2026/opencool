/**
 * Append-only snapshot store for the point-in-time tape.
 *
 * Layout, one directory per trading day:
 *
 *   daily_reports/tape/<YYYY-MM-DD>/0935.json            first capture of 09:35
 *   daily_reports/tape/<YYYY-MM-DD>/0935.rev-1.json      second capture, never a rewrite
 *   daily_reports/tape/<YYYY-MM-DD>/index.json           derived list of what is present
 *   daily_reports/tape/<YYYY-MM-DD>/revisions.jsonl      one line per revision, append-only
 *
 * The hard rule is append-only. A capture for an existing slot never replaces
 * the file: it writes the next free `rev-N` sibling and appends a line naming
 * which sections actually changed. A point-in-time store that silently rewrites
 * history is worthless for research, so this is enforced with an exclusive
 * create (`wx`) rather than a check-then-write — two bakers racing for the same
 * slot cannot both win, and the loser sees an error instead of clobbering.
 *
 * `index.json` is the one derived file: it is rebuilt from the immutable
 * snapshots on every write, so it is safe to rewrite and can never disagree
 * with the files it lists.
 */

import fs from "node:fs";
import path from "node:path";

import {
  TAPE_SECTIONS,
  type TapeSection,
  type TapeSectionName,
  type TapeSections,
} from "./sections";
import { TAPE_SLOTS } from "./schedule";
import { isoWithOffset } from "./time";

/** Schema version of the snapshot payload. Bump only for an additive change. */
export const TAPE_SCHEMA_VERSION = 1;

export interface TapeSnapshot extends TapeSections {
  schemaVersion: number;
  /** `YYYY-MM-DD` in REPORT_TZ. */
  date: string;
  /** Capture slot `HH:MM`. */
  slot: string;
  /** Filename stem this snapshot was written as (`0935`, `0935.rev-1`). */
  slotKey: string;
  /** 0 for the first capture of a slot, N for its Nth revision. */
  revision: number;
  /** When the capture started, ISO with the market offset. */
  observedAt: string;
  /** REPORT_TZ the slot and clocks are expressed in. */
  timezone: string;
  /** Registry actually used for board resolution, so a stale day is visible. */
  registry: "live" | "snapshot" | "none";
}

export interface TapeIndexRow {
  /** Filename stem: `0935` for the first capture, `0935.rev-1` for a revision. */
  slot: string;
  /** Capture slot in `HH:MM`. */
  time: string;
  revision: number;
  file: string;
  observedAt: string;
  /** Sections that produced at least one record. */
  sections: string[];
  /** Sections that were unavailable, so a gap is visible in the index itself. */
  missing: string[];
}

export interface TapeIndex {
  schemaVersion: number;
  date: string;
  /** The ten session slots this store expects for the day. */
  expectedSlots: string[];
  snapshots: TapeIndexRow[];
  updatedAt: string;
}

export interface WriteOptions {
  /** Tape tree root; defaults to `daily_reports/tape`. */
  root?: string;
  /** Skip the index rewrite (tests that only assert the snapshot file). */
  skipIndex?: boolean;
}

export interface WriteResult {
  /** Absolute path written. */
  file: string;
  /** Filename stem, e.g. `0935` or `0935.rev-1`. */
  slotKey: string;
  revision: number;
  /** True when this capture revised an earlier one instead of being the first. */
  isRevision: boolean;
  /** Section names whose records differ from the capture being revised. */
  changed: TapeSectionName[];
}

export interface RevisionEntry {
  at: string;
  slot: string;
  base: string;
  wrote: string;
  revision: number;
  changed: readonly string[];
  observedAtFrom: string | null;
  observedAtTo: string;
}

const SNAPSHOT_RE = /^(\d{4})(?:\.rev-(\d+))?\.json$/;

export function tapeRoot(root?: string): string {
  return root ?? path.resolve("daily_reports", "tape");
}

export function dayDir(root: string | undefined, date: string): string {
  return path.join(tapeRoot(root), date);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function revisionOf(file: string): number {
  const m = /\.rev-(\d+)\.json$/.exec(file);
  return m ? Number(m[1]) : 0;
}

/**
 * Section-level comparison, so `revisions.jsonl` says what actually changed
 * instead of just "a second capture happened".
 *
 * Records are compared with their clock fields (`asOf`, `observedAt`) removed.
 * Those two always move between captures — a revision happens *because* time
 * passed — so counting them would report every section as changed on every
 * revision and the field would carry no information. With the clocks stripped,
 * `changed` answers the question a reader actually has: which numbers moved.
 * The clock movement is recorded separately as `observedAtFrom/To`.
 */
export function changedSections(
  prev: Pick<TapeSections, TapeSectionName>,
  next: Pick<TapeSections, TapeSectionName>,
): TapeSectionName[] {
  const out: TapeSectionName[] = [];
  for (const name of TAPE_SECTIONS) {
    const a = JSON.stringify(withoutClocks(prev[name] as TapeSection<unknown>));
    const b = JSON.stringify(withoutClocks(next[name] as TapeSection<unknown>));
    if (a !== b) out.push(name);
  }
  return out;
}

/** Section metadata + records with per-record `asOf` / `observedAt` stripped. */
function withoutClocks(section: TapeSection<unknown>): unknown {
  if (!section) return null;
  return {
    ...section,
    asOf: undefined,
    observedAt: undefined,
    records: section.records.map((rec) => {
      if (!rec || typeof rec !== "object") return rec;
      const { asOf: _asOf, observedAt: _observedAt, ...rest } = rec as Record<string, unknown>;
      return rest;
    }),
  };
}

/** First free `rev-N` stem above `baseKey`, so a deleted revision is reused. */
function nextRevisionStem(baseKey: string, dir: string): { stem: string; revision: number } {
  for (let n = 1; n < 10_000; n++) {
    const stem = `${baseKey}.rev-${n}`;
    if (!fs.existsSync(path.join(dir, `${stem}.json`))) return { stem, revision: n };
  }
  throw new Error(`too many revisions for ${baseKey} — refusing to write`);
}

/** Newest existing revision of `baseKey` in `dir` (excluding the base file). */
function latestRevision(dir: string, baseKey: string): TapeSnapshot | null {
  const files = fs
    .readdirSync(dir)
    .filter((f) => new RegExp(`^${baseKey}\\.rev-\\d+\\.json$`).test(f))
    .sort((a, b) => revisionOf(b) - revisionOf(a));
  for (const f of files) {
    const parsed = readJson<TapeSnapshot>(path.join(dir, f));
    if (parsed) return parsed;
  }
  return null;
}

function appendRevisionLog(dir: string, entry: RevisionEntry): void {
  // `appendFileSync` on a short single-line write is atomic on the platforms we
  // run on; the log is diagnostic, so a torn line at worst costs detail.
  fs.appendFileSync(path.join(dir, "revisions.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Write one snapshot, never overwriting.
 *
 * `wx` (exclusive create) is the append-only guarantee, not a `existsSync`
 * check: the probe picks the revision number, and the exclusive create then
 * wins the race against a concurrent baker instead of both writing.
 */
export function writeSnapshot(snapshot: TapeSnapshot, options: WriteOptions = {}): WriteResult {
  const dir = dayDir(options.root, snapshot.date);
  fs.mkdirSync(dir, { recursive: true });

  const baseKey = snapshot.slot.replace(":", "");
  const isRevision = fs.existsSync(path.join(dir, `${baseKey}.json`));
  const target = isRevision
    ? nextRevisionStem(baseKey, dir)
    : { stem: baseKey, revision: 0 };

  // The capture this one revises: the base file, or the newest existing
  // revision when the base somehow predates it.
  const prev = isRevision
    ? (readJson<TapeSnapshot>(path.join(dir, `${baseKey}.json`)) ?? latestRevision(dir, baseKey))
    : null;

  const payload: TapeSnapshot = { ...snapshot, slotKey: target.stem, revision: target.revision };
  const file = path.join(dir, `${target.stem}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });

  const changed = prev ? changedSections(prev, payload) : [...TAPE_SECTIONS];

  if (isRevision) {
    appendRevisionLog(dir, {
      at: payload.observedAt,
      slot: payload.slot,
      base: `${baseKey}.json`,
      wrote: `${target.stem}.json`,
      revision: target.revision,
      changed,
      observedAtFrom: prev?.observedAt ?? null,
      observedAtTo: payload.observedAt,
    });
  }

  if (!options.skipIndex) writeDayIndex(dir, snapshot.date, snapshot.timezone);

  return { file, slotKey: target.stem, revision: target.revision, isRevision, changed };
}

/** Every snapshot in a day directory: oldest slot first, revisions after their base. */
export function listSnapshots(
  dir: string,
): Array<{ stem: string; time: string; revision: number; file: string }> {
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ stem: string; time: string; revision: number; file: string }> = [];
  for (const f of fs.readdirSync(dir)) {
    const m = SNAPSHOT_RE.exec(f);
    if (!m) continue;
    const hhmm = m[1];
    out.push({
      stem: f.replace(/\.json$/, ""),
      time: `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`,
      revision: m[2] ? Number(m[2]) : 0,
      file: f,
    });
  }
  return out.sort((a, b) => a.time.localeCompare(b.time) || a.revision - b.revision);
}

/** Record the base snapshot covers, for `index.json`. */
function indexRow(dir: string, entry: { stem: string; time: string; revision: number; file: string }): TapeIndexRow | null {
  const snap = readJson<TapeSnapshot>(path.join(dir, entry.file));
  if (!snap) return null;
  const sections: string[] = [];
  const missing: string[] = [];
  for (const name of TAPE_SECTIONS) {
    const section = snap[name] as TapeSection<unknown> | undefined;
    if (!section) continue;
    if (section.unavailable) missing.push(name);
    else if (section.records.length) sections.push(name);
  }
  return {
    slot: entry.stem,
    time: entry.time,
    revision: entry.revision,
    file: entry.file,
    observedAt: snap.observedAt,
    sections,
    missing,
  };
}

/**
 * Rebuild `index.json` from what is on disk.
 *
 * Derived, not a record: the snapshots are immutable and this is recomputed
 * from them, so a corrupt or stale index repairs itself on the next capture.
 * Readers should still key on the snapshot files — the index is a convenience.
 */
export function writeDayIndex(dir: string, date: string, tz: string): TapeIndex {
  const rows: TapeIndexRow[] = [];
  for (const entry of listSnapshots(dir)) {
    const row = indexRow(dir, entry);
    if (row) rows.push(row);
  }
  const index: TapeIndex = {
    schemaVersion: TAPE_SCHEMA_VERSION,
    date,
    expectedSlots: [...TAPE_SLOTS],
    snapshots: rows,
    updatedAt: isoWithOffset(new Date(), tz),
  };
  fs.writeFileSync(path.join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

/** Read back one snapshot file (used by the index builder and the tests). */
export function readSnapshot(file: string): TapeSnapshot | null {
  return readJson<TapeSnapshot>(file);
}
