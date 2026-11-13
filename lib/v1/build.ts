/**
 * Build the `/v1` namespace and the coverage ledger from files already on disk.
 *
 * Two rules shape everything below:
 *
 *   1. **Deterministic.** No network, no clock beyond `generatedAt`, no random
 *      ids. The same tree produces the same payloads, so a replay can be
 *      diffed against what is published.
 *   2. **A gap is data.** A missing snapshot, a missing section, a missing
 *      input file is never smoothed away: it becomes a `gaps[]` entry with a
 *      stable code and a reason. An empty table that reads like success is the
 *      failure mode this module exists to prevent.
 *
 * Nothing here decides presentation — `lib/output/render.ts` renders
 * `integrity.html` from the coverage payload, so every user-facing string stays
 * in the `STR` tables.
 */

import fs from "node:fs";
import path from "node:path";

import { TAPE_SECTIONS, type TapeSection } from "../tape/sections";
import { TAPE_SLOTS } from "../tape/schedule";
import { civilNow, isoWithOffset, slotKey, slotMinutes } from "../tape/time";
import { getReportTz } from "../utils";
import {
  V1_ENDPOINTS,
  V1_GUARANTEES,
  V1_HORIZONS,
  V1_SCHEMA_VERSION,
  V1_TAPE_LAUNCH_DATE,
  isOffsetIso,
} from "./contract";

/* ------------------------------------------------------------------ */
/* Gap vocabulary                                                      */
/* ------------------------------------------------------------------ */

/**
 * Every reason a snapshot, a section or an input can be absent.
 *
 * Codes are part of the contract (consumers and the page key on them), so they
 * are stable strings rather than prose. `integrity.html` maps each one to a
 * localized sentence; the English `reason` here is what a JSON consumer reads.
 *
 * Note what is *not* here: there is no "market-closed" gap, because a closed
 * day owes nothing and therefore produces no gaps at all (`tradingDay: false`
 * says it). And there is no "no-directory" gap: a missing day is named per slot,
 * so a reader counting holes counts the same thing the schedule does.
 */
export const GAP_CODES = [
  "missed",
  "future",
  "section-unavailable",
  "base-missing",
  "input-missing",
  "input-unreadable",
] as const;

export type GapCode = (typeof GAP_CODES)[number];

export interface Gap {
  /** `null` when the gap is about a whole day or a whole input, not one slot. */
  slot: string | null;
  code: GapCode;
  /** Short English explanation. Machine-readable; the page localizes by code. */
  reason: string;
  /** Section name for `section-unavailable`. */
  section?: string;
}

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

export interface SlotCapture {
  revision: number;
  file: string;
  /** Site-relative path, so a consumer can fetch the immutable bytes. */
  path: string;
  observedAt: string | null;
  /** Sections named as changed by `revisions.jsonl`, when the log has them. */
  changed: string[] | null;
}

export interface AsOfSlot {
  slot: string;
  observedAt: string;
  asOf: string;
  revision: number;
  captures: SlotCapture[];
  registry: string | null;
  sections: Record<string, TapeSection<unknown>>;
  unavailableSections: Array<{ name: string; reason: string }>;
}

export interface AsOfDay {
  schemaVersion: number;
  namespace: string;
  date: string;
  timezone: string;
  generatedAt: string;
  tradingDay: boolean;
  beforeLaunch: boolean;
  expectedSlots: string[];
  /** Slots on a day in progress that have not come due yet — not gaps. */
  pendingSlots: string[];
  slots: AsOfSlot[];
  gaps: Gap[];
  counts: {
    /** Slots this day owed by the build instant (see `buildAsOfDay`). */
    expectedSlots: number;
    capturedSlots: number;
    revisionFiles: number;
    gaps: number;
  };
  note: string;
}

export interface CoverageDay {
  date: string;
  tradingDay: boolean;
  beforeLaunch: boolean;
  expectedSlots: number;
  capturedSlots: number;
  missingSlots: string[];
  /** Not yet due at build time (today only) — excluded from every denominator. */
  pendingSlots: string[];
  /** Revision files for the day (a re-capture, never a rewrite). */
  revisions: number;
  /** Per-section count of slots in which that section produced records. */
  sections: Record<string, number>;
  gaps: Gap[];
}

export interface StoriesCoverage {
  available: boolean;
  reason?: string;
  total: number;
  withFirstSeenAt: number;
  withoutFirstSeenAt: number;
  /** 0–100, one decimal. 0 when there are no stories — 100 would be a lie. */
  firstSeenCoveragePct: number;
  editions: number | null;
  sightings: number | null;
  storiesWithRevisions: number | null;
  updatedAt: string | null;
}

export interface HorizonCoverage {
  key: string;
  hours: number;
  /** Stories carrying a completed measurement for this horizon. */
  measured: number;
  /** Stories still waiting for it. */
  pending: number;
  available: boolean;
}

export interface CoveragePayload {
  schemaVersion: number;
  namespace: string;
  generatedAt: string;
  timezone: string;
  tape: {
    launchDate: string;
    started: boolean;
    expectedSlotsPerDay: number;
    firstDate: string | null;
    lastDate: string | null;
    days: number;
    tradingDays: number;
    snapshots: number;
    revisionFiles: number;
  };
  days: CoverageDay[];
  stories: StoriesCoverage;
  horizons: HorizonCoverage[];
  gaps: Array<Gap & { date: string | null }>;
  summary: {
    daysWithGaps: number;
    daysComplete: number;
    expectedSlots: number;
    capturedSlots: number;
    /** Null when nothing was expected yet — not 100, which would read as success. */
    coveragePct: number | null;
    gaps: number;
  };
}

export interface ManifestPayload {
  schemaVersion: number;
  namespace: string;
  generatedAt: string;
  timezone: string;
  endpoints: Array<{
    id: string;
    path: string;
    version: number;
    available: boolean;
    description: string;
  }>;
  snapshots: {
    launchDate: string;
    started: boolean;
    expectedSlotsPerDay: number;
    firstDate: string | null;
    lastDate: string | null;
    totalSlots: number;
    totalRevisionFiles: number;
    days: Array<{ date: string; slots: number; revisions: number; complete: boolean }>;
  };
  coverage: {
    days: number;
    tradingDays: number;
    daysWithGaps: number;
    expectedSlots: number;
    capturedSlots: number;
    coveragePct: number | null;
    gaps: number;
  };
  license: { code: string; url: string; data: string };
  deprecation: {
    policy: string;
    breakingChange: string;
    successor: string;
    noticePeriod: string;
  };
  /**
   * Promises and explicit non-promises. `key` indexes the localized sentence in
   * `STR`; `text` is the English copy published here so a JSON-only consumer
   * reads the whole contract without a second file.
   */
  guarantees: {
    promised: Array<{ key: string; text: string }>;
    notPromised: Array<{ key: string; text: string }>;
  };
}

export interface V1Build {
  generatedAt: string;
  timezone: string;
  /** Relative path under `v1/` → payload. */
  files: Record<string, unknown>;
  manifest: ManifestPayload;
  coverage: CoveragePayload;
  /** Days written as `asof/<date>.json`, oldest first. */
  asofDays: AsOfDay[];
}

export interface V1BuildOptions {
  /** `daily_reports` root. */
  root?: string;
  now?: Date;
  timezone?: string;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_FILE_RE = /^(\d{2})(\d{2})(?:\.rev-(\d+))?\.json$/;

function readJson(file: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) as unknown };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Weekday check on a date key (UTC arithmetic — the key is date-only). */
function isWeekday(date: string): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

function shiftDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

interface SlotGroup {
  base: string;
  slot: string;
  files: Array<{ revision: number; file: string }>;
}

function groupSlots(dir: string): Map<string, SlotGroup> {
  const groups = new Map<string, SlotGroup>();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return groups;
  }
  for (const f of names) {
    const m = SLOT_FILE_RE.exec(f);
    if (!m) continue;
    const base = `${m[1]}${m[2]}`;
    const revision = m[3] ? Number(m[3]) : 0;
    let g = groups.get(base);
    if (!g) {
      g = { base, slot: `${m[1]}:${m[2]}`, files: [] };
      groups.set(base, g);
    }
    g.files.push({ revision, file: f });
  }
  for (const g of groups.values()) g.files.sort((a, b) => a.revision - b.revision);
  return groups;
}

/** `changed` lists from `revisions.jsonl`, keyed `base|revision`. */
function readRevisionLog(dir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const fp = path.join(dir, "revisions.jsonl");
  let text: string;
  try {
    text = fs.readFileSync(fp, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const entry = JSON.parse(s) as { slot?: unknown; revision?: unknown; changed?: unknown };
      if (typeof entry.slot !== "string" || typeof entry.revision !== "number") continue;
      const key = `${entry.slot.replace(":", "")}|${entry.revision}`;
      out.set(
        key,
        Array.isArray(entry.changed)
          ? entry.changed.filter((x): x is string => typeof x === "string")
          : [],
      );
    } catch {
      // a torn line costs one diagnostic, never the build
    }
  }
  return out;
}

/** Latest market clock among a snapshot's sections, else its own observation. */
function latestAsOf(snapshot: Record<string, unknown>, fallback: string): string {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const name of TAPE_SECTIONS) {
    const section = snapshot[name] as Partial<TapeSection<unknown>> | undefined;
    const stamp = section?.asOf;
    if (!isOffsetIso(stamp)) continue;
    const ms = Date.parse(stamp);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = stamp;
    }
  }
  return best ?? fallback;
}

/* ------------------------------------------------------------------ */
/* Tape                                                                */
/* ------------------------------------------------------------------ */

interface TapeDay {
  date: string;
  dir: string;
  groups: Map<string, SlotGroup>;
  revisions: Map<string, string[]>;
}

function readTapeDays(tapeRoot: string): TapeDay[] {
  if (!fs.existsSync(tapeRoot)) return [];
  const out: TapeDay[] = [];
  for (const name of fs.readdirSync(tapeRoot)) {
    if (!DAY_RE.test(name)) continue;
    const dir = path.join(tapeRoot, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push({
      date: name,
      dir,
      groups: groupSlots(dir),
      revisions: readRevisionLog(dir),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The slots this store expects for a day.
 *
 * Read from the day's own `index.json` when present, so an older day keeps the
 * slot list it was captured under if the schedule ever changes; otherwise the
 * live schedule. One list, never two disagreeing ones.
 */
function expectedSlotList(tapeDay: TapeDay | null): string[] {
  if (tapeDay) {
    const idx = readJson(path.join(tapeDay.dir, "index.json"));
    if (idx.ok) {
      const slots = (idx.value as { expectedSlots?: unknown }).expectedSlots;
      if (Array.isArray(slots) && slots.length && slots.every((s) => typeof s === "string")) {
        return slots as string[];
      }
    }
  }
  return [...TAPE_SLOTS];
}

/**
 * Why a due slot on an expected trading day has no file.
 *
 * Only called for slots that are *already due*: a slot that has not arrived yet
 * is reported separately as `pendingSlots`, because "not late yet" and "we missed
 * it" are different claims and folding them together is what lets a vendor look
 * fully covered while half the session has not happened.
 */
function absenceCode(
  slot: string,
  date: string,
  now: { date: string; hour: number; minute: number },
): { code: GapCode; reason: string } {
  if (date > now.date) {
    return { code: "future", reason: `${date} is in the future` };
  }
  return {
    code: "missed",
    reason: `no snapshot for ${slot} on ${date} — the tick was dropped, or the exchange was closed (we cannot tell them apart offline)`,
  };
}

/**
 * One slot, built from the **base** capture.
 *
 * The base file is the immutable first observation of that slot, which is what
 * "what was knowable at 11:35" means. Later re-captures are listed in
 * `captures[]` with their own instants and the sections they moved — separate
 * corrections, not a rewrite of the slot.
 */
function buildSlot(
  group: SlotGroup,
  tapeDay: TapeDay,
  fallbackInstant: string,
): { slot: AsOfSlot | null; gaps: Gap[] } {
  const gaps: Gap[] = [];
  const reads = group.files.map((f) => ({ ...f, parsed: readJson(path.join(tapeDay.dir, f.file)) }));
  const base = reads.find((r) => r.revision === 0);
  const chosen = base ?? reads[reads.length - 1];

  if (!chosen || !chosen.parsed.ok) {
    gaps.push({
      slot: group.slot,
      code: "base-missing",
      reason: `snapshot file(s) present but unreadable: ${group.files.map((f) => f.file).join(", ")}`,
    });
    return { slot: null, gaps };
  }
  if (!base) {
    gaps.push({
      slot: group.slot,
      code: "base-missing",
      reason: `first capture file is missing; ${chosen.file} is the oldest surviving capture`,
    });
  }

  const snap = chosen.parsed.value as Record<string, unknown>;
  const observedAt = isOffsetIso(snap.observedAt) ? snap.observedAt : fallbackInstant;
  const asOf = latestAsOf(snap, observedAt);

  const sections: Record<string, TapeSection<unknown>> = {};
  const unavailableSections: Array<{ name: string; reason: string }> = [];
  for (const name of TAPE_SECTIONS) {
    const section = snap[name] as TapeSection<unknown> | undefined;
    if (!section || typeof section !== "object" || !Array.isArray(section.records)) continue;
    sections[name] = section;
    if (section.unavailable) {
      const reason = typeof section.reason === "string" && section.reason
        ? section.reason
        : "section reported unavailable without a reason";
      unavailableSections.push({ name, reason });
      gaps.push({ slot: group.slot, code: "section-unavailable", section: name, reason });
    }
  }

  const captures: SlotCapture[] = [];
  for (const r of reads) {
    if (!r.parsed.ok) continue;
    const s = r.parsed.value as Record<string, unknown>;
    captures.push({
      revision: r.revision,
      file: r.file,
      path: `tape/${tapeDay.date}/${r.file}`,
      observedAt: isOffsetIso(s.observedAt) ? s.observedAt : null,
      changed:
        r.revision === 0 ? null : (tapeDay.revisions.get(`${group.base}|${r.revision}`) ?? null),
    });
  }

  return {
    slot: {
      slot: group.slot,
      observedAt,
      asOf,
      revision: chosen.revision,
      captures,
      registry: typeof snap.registry === "string" ? snap.registry : null,
      sections,
      unavailableSections,
    },
    gaps,
  };
}

const ASOF_NOTE =
  "Each slot is the immutable first capture of that slot (the base file) with its two clocks: " +
  "asOf is the market timestamp the values describe, observedAt is when we fetched them. " +
  "Later re-captures are listed in captures[] and live at their own tape/<date>/<HHMM>.rev-N.json path; " +
  "the base bytes are never rewritten. Every absent slot or section is named in gaps[] with a code.";

function buildAsOfDay(
  date: string,
  tapeDay: TapeDay | null,
  ctx: {
    timezone: string;
    generatedAt: string;
    now: { date: string; hour: number; minute: number };
  },
): { day: AsOfDay; coverage: CoverageDay } {
  const expected = expectedSlotList(tapeDay);
  const tradingDay = isWeekday(date);
  const beforeLaunch = date < V1_TAPE_LAUNCH_DATE;
  const gaps: Gap[] = [];
  const slots: AsOfSlot[] = [];
  const sectionHits: Record<string, number> = {};
  let revisionFiles = 0;

  // Gaps are broken obligations, not a description of the calendar. Three kinds
  // of slot owe nothing and therefore emit no gap code:
  //
  //   - a weekend (`tradingDay: false`) — the market was shut;
  //   - a slot on today that has not arrived yet — the tick is not late, it is
  //     not due. Counting it would make every intraday rebuild show a hole that
  //     fills itself;
  //   - a day before the tape existed (`beforeLaunch: true`) — we had no
  //     mechanism, so "missed" would be an accusation about a capability we
  //     never had, and those unfillable holes would deflate every coverage
  //     number for the rest of the store's life.
  //
  // The flags (`tradingDay`, `beforeLaunch`, `notYetDueSlots`) are all in the
  // file, so the reason is stated rather than inferred from an absence.
  const notYetDue = expected.filter(
    (slot) => date === ctx.now.date && slotMinutes(slot) > ctx.now.hour * 60 + ctx.now.minute,
  );
  const notYetDueSet = new Set(notYetDue);

  for (const slot of expected) {
    const group = tapeDay?.groups.get(slotKey(slot));
    if (!group) {
      if (!tradingDay || beforeLaunch || notYetDueSet.has(slot)) continue;
      const absent = absenceCode(slot, date, ctx.now);
      gaps.push({ slot, code: absent.code, reason: absent.reason });
      continue;
    }
    revisionFiles += group.files.filter((f) => f.revision > 0).length;
    const built = buildSlot(group, tapeDay as TapeDay, ctx.generatedAt);
    gaps.push(...built.gaps);
    if (built.slot) {
      slots.push(built.slot);
      for (const [name, section] of Object.entries(built.slot.sections)) {
        if (!section.unavailable && section.records.length) {
          sectionHits[name] = (sectionHits[name] ?? 0) + 1;
        }
      }
    }
  }

  // What this day actually owed by the instant of this build: the full schedule
  // on a past trading day, the slots that have already come due on today, zero
  // on a weekend or before launch. This is the denominator every percentage on
  // the site uses, and it is the only one that cannot be gamed by looking at a
  // day mid-session.
  const owed = !tradingDay || beforeLaunch
    ? 0
    : date === ctx.now.date
      ? expected.length - notYetDue.length
      : expected.length;

  slots.sort((a, b) => slotMinutes(a.slot) - slotMinutes(b.slot));
  gaps.sort(
    (a, b) =>
      (a.slot === null ? -1 : slotMinutes(a.slot)) - (b.slot === null ? -1 : slotMinutes(b.slot)) ||
      a.code.localeCompare(b.code) ||
      (a.section ?? "").localeCompare(b.section ?? ""),
  );

  const day: AsOfDay = {
    schemaVersion: V1_SCHEMA_VERSION,
    namespace: "v1",
    date,
    timezone: ctx.timezone,
    generatedAt: ctx.generatedAt,
    tradingDay,
    beforeLaunch,
    expectedSlots: expected,
    pendingSlots: notYetDue,
    slots,
    gaps,
    counts: {
      // `expectedSlots` here is what this day actually owed: zero on a weekend
      // and zero before the tape existed. The `expectedSlots` array above is the
      // schedule the store checks against; this count is the obligation. A
      // weekend or pre-launch capture is therefore never reported as 1/10
      // progress, and never as nine failures either.
      expectedSlots: owed,
      capturedSlots: slots.length,
      revisionFiles,
      gaps: gaps.length,
    },
    note: ASOF_NOTE,
  };

  const coverage: CoverageDay = {
    date,
    tradingDay,
    beforeLaunch,
    // A weekend or a pre-launch day expects nothing (see the loop above), so a
    // forced out-of-session capture is never counted as 1/10 progress.
    expectedSlots: owed,
    capturedSlots: slots.length,
    missingSlots:
      owed > 0
        ? expected.filter((s) => !notYetDueSet.has(s) && !slots.some((x) => x.slot === s))
        : [],
    pendingSlots: notYetDue,
    revisions: revisionFiles,
    sections: sectionHits,
    gaps,
  };
  return { day, coverage };
}

/* ------------------------------------------------------------------ */
/* Stories / themes / reactions                                        */
/* ------------------------------------------------------------------ */

type InputRead =
  | { available: true; payload: Record<string, unknown>; reason?: undefined }
  | { available: false; payload: null; reason: string };

function readRootJson(root: string, name: string): InputRead {
  const rel = `daily_reports/${name}.json`;
  const fp = path.join(root, `${name}.json`);
  if (!fs.existsSync(fp)) return { available: false, payload: null, reason: `${rel} is absent` };
  const parsed = readJson(fp);
  if (!parsed.ok) {
    return { available: false, payload: null, reason: `${rel} is unreadable: ${parsed.error}` };
  }
  const value = parsed.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { available: false, payload: null, reason: `${rel} is not a JSON object` };
  }
  return { available: true, payload: value as Record<string, unknown> };
}

function storiesCoverage(input: InputRead): StoriesCoverage {
  const payload = input.payload ?? {};
  const stories = Array.isArray(payload.stories) ? (payload.stories as unknown[]) : [];
  let withFirst = 0;
  for (const raw of stories) {
    const first = (raw as Record<string, unknown> | null)?.firstSeenAt;
    if (isOffsetIso(first)) withFirst++;
  }
  const counts = (payload.counts ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    available: input.available,
    ...(input.available ? {} : { reason: input.reason }),
    total: stories.length,
    withFirstSeenAt: withFirst,
    withoutFirstSeenAt: stories.length - withFirst,
    firstSeenCoveragePct: stories.length > 0 ? round1((withFirst / stories.length) * 100) : 0,
    editions: num(counts.editions),
    sightings: num(counts.sightings),
    storiesWithRevisions: num(counts.storiesWithRevisions),
    updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : null,
  };
}

/**
 * Per-horizon counts for the reaction library.
 *
 * `counts.horizons[key]` is authoritative when present: the bake itself already
 * classified every observation as `ok` / `pending` / `gap`, and re-deriving that
 * here would be a second opinion that could disagree with the file next to it.
 * Only when that block is absent does this fall back to inspecting the rows,
 * reading several plausible shapes so an earlier or later version of the bake
 * still yields a number instead of a silent zero.
 */
function horizonCoverage(input: InputRead, total: number): HorizonCoverage[] {
  const payload = input.payload ?? {};
  const counts = (payload.counts ?? {}) as Record<string, unknown>;
  const byHorizon = (counts.horizons ?? {}) as Record<string, unknown>;

  const rowsOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const rows = rowsOf(payload.items).length
    ? rowsOf(payload.items)
    : rowsOf(payload.rows).length
      ? rowsOf(payload.rows)
      : rowsOf(payload.reactions).length
        ? rowsOf(payload.reactions)
        : rowsOf(payload.observations);

  return V1_HORIZONS.map((h) => {
    const declared = byHorizon[h.key] as
      | { ok?: unknown; pending?: unknown; gap?: unknown }
      | undefined;
    if (declared && typeof declared === "object") {
      const measured = typeof declared.ok === "number" ? declared.ok : 0;
      const pending = typeof declared.pending === "number" ? declared.pending : 0;
      return {
        key: h.key,
        hours: h.hours,
        measured,
        pending,
        available: input.available,
      };
    }

    // Fallback: count rows whose status (or numeric value) says measured.
    let measured = 0;
    let pending = 0;
    for (const raw of rows) {
      const row = raw as Record<string, unknown> | null;
      if (!row) continue;
      const nested = row.horizons as Record<string, unknown> | undefined;
      const value = row[h.key] ?? nested?.[h.key];
      if (value === null || value === undefined) {
        pending++;
        continue;
      }
      if (typeof value === "number") {
        measured++;
        continue;
      }
      if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        if (obj.status === "ok" || typeof obj.changePct === "number" || typeof obj.measuredAt === "string") {
          measured++;
        } else {
          pending++;
        }
        continue;
      }
      pending++;
    }
    return {
      key: h.key,
      hours: h.hours,
      measured,
      pending: rows.length > 0 ? pending : Math.max(0, total - measured),
      available: input.available,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Copy that is part of the contract                                  */
/* ------------------------------------------------------------------ */

const LICENSE = {
  code: "MIT",
  url: "https://github.com/Fudan2026/opencool/blob/main/LICENSE",
  data:
    "Code is MIT. Data terms: quotes come from public delayed endpoints of the exchanges' own vendors and are " +
    "published for reading, at most one publish cycle behind; they are not a licensed real-time feed, are not " +
    "for order execution, and are not investment advice. Story headlines and links remain the property of their " +
    "publishers. No third-party licensed dataset is redistributed. If you mirror this data, keep the gaps page " +
    "visible — a mirror that drops gaps is no longer point-in-time.",
};

const DEPRECATION = {
  policy:
    "Within /v1 nothing a consumer sees is removed or retyped. New fields may appear at any time and consumers " +
    "must ignore unknown ones. A field that must change shape is added alongside the old one, and the old one " +
    "keeps its exact type until /v1 is retired.",
  breakingChange: "A breaking change ships as a new namespace: /v2/<same path>.",
  successor: "/v2/manifest.json",
  noticePeriod:
    "After /v2/ publishes, /v1/ keeps being written for at least 12 months and its manifest keeps naming the " +
    "successor. No silent removal: an endpoint that stops is removed from the manifest in the same build that " +
    "stops writing it.",
};

/**
 * The guarantee lists are single-sourced in `contract.ts`. The page localizes
 * them by `key`; the manifest publishes the English `text`. Copying the wording
 * here would let the two drift.
 */
const PROMISES = V1_GUARANTEES.promised.map((g) => ({ key: g.key as string, text: g.en }));
const NOT_PROMISED = V1_GUARANTEES.notPromised.map((g) => ({ key: g.key as string, text: g.en }));

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/**
 * Build every v1 payload.
 *
 * The returned `files` map is keyed by path inside `v1/`, so the writer and the
 * golden test can assert exactly what will be published without touching disk.
 */
export function buildV1(options: V1BuildOptions = {}): V1Build {
  const root = options.root ?? path.resolve("daily_reports");
  const now = options.now ?? new Date();
  const timezone =
    options.timezone ??
    getReportTz() ??
    Intl.DateTimeFormat().resolvedOptions().timeZone ??
    "UTC";
  const generatedAt = isoWithOffset(now, timezone);
  const nowCivil = civilNow(now, timezone);

  const tapeDays = readTapeDays(path.join(root, "tape"));
  const tapeByDate = new Map(tapeDays.map((d) => [d.date, d]));

  // Days that should carry an as-of file: every captured day, plus every
  // trading weekday from the launch date up to today. A fully missed weekday is
  // a real gap and deserves a file that says so, rather than a 404 a reader
  // would have to interpret.
  const wanted = new Set<string>();
  for (const d of tapeDays) wanted.add(d.date);
  // Every calendar day from launch to today, not just weekdays: a Saturday that
  // has no file at all is indistinguishable from a Saturday we forgot to
  // publish. A weekend file states `tradingDay: false` and owes nothing, which
  // is a different claim from silence.
  for (let cursor = V1_TAPE_LAUNCH_DATE; cursor <= nowCivil.date; cursor = shiftDays(cursor, 1)) {
    wanted.add(cursor);
  }

  const ctx = { timezone, generatedAt, now: nowCivil };
  const asofDays: AsOfDay[] = [];
  const coverageDays: CoverageDay[] = [];
  for (const date of [...wanted].sort()) {
    const { day, coverage } = buildAsOfDay(date, tapeByDate.get(date) ?? null, ctx);
    asofDays.push(day);
    coverageDays.push(coverage);
  }

  const storiesInput = readRootJson(root, "stories");
  const themesInput = readRootJson(root, "themes");
  const reactionsInput = readRootJson(root, "reactions");

  const stories = storiesCoverage(storiesInput);
  const horizons = horizonCoverage(reactionsInput, stories.total);

  const inputGaps: Array<Gap & { date: string | null }> = [];
  for (const [name, input] of [
    ["stories", storiesInput],
    ["themes", themesInput],
  ] as const) {
    if (input.available) continue;
    inputGaps.push({
      date: null,
      slot: null,
      code: fs.existsSync(path.join(root, `${name}.json`)) ? "input-unreadable" : "input-missing",
      reason: input.reason,
    });
  }

  const tradingDays = coverageDays.filter((d) => d.tradingDay);
  const expectedSlots = coverageDays.reduce((n, d) => n + d.expectedSlots, 0);
  const capturedSlots = coverageDays.reduce((n, d) => n + d.capturedSlots, 0);
  const slotGaps = coverageDays.reduce((n, d) => n + d.gaps.length, 0);

  const coverage: CoveragePayload = {
    schemaVersion: V1_SCHEMA_VERSION,
    namespace: "v1",
    generatedAt,
    timezone,
    tape: {
      launchDate: V1_TAPE_LAUNCH_DATE,
      started: asofDays.some((d) => d.slots.length > 0),
      expectedSlotsPerDay: TAPE_SLOTS.length,
      firstDate: asofDays.length ? asofDays[0].date : null,
      lastDate: asofDays.length ? asofDays[asofDays.length - 1].date : null,
      days: coverageDays.length,
      tradingDays: tradingDays.length,
      snapshots: asofDays.reduce((n, d) => n + d.slots.length, 0),
      revisionFiles: asofDays.reduce((n, d) => n + d.counts.revisionFiles, 0),
    },
    days: coverageDays,
    stories,
    horizons,
    gaps: inputGaps,
    summary: {
      daysWithGaps: coverageDays.filter((d) => d.gaps.length > 0).length,
      daysComplete: tradingDays.filter(
        (d) => d.gaps.length === 0 && d.expectedSlots > 0 && d.capturedSlots === d.expectedSlots,
      ).length,
      expectedSlots,
      // Before launch (and on a weekend) nothing is expected, so there is no
      // percentage to report. `null` is honest; 100 would read as success and
      // 0 as failure — both false.
      capturedSlots,
      coveragePct: expectedSlots > 0 ? round1((capturedSlots / expectedSlots) * 100) : null,
      gaps: slotGaps + inputGaps.length,
    },
  };

  const availability: Record<string, boolean> = {
    manifest: true,
    asof: asofDays.length > 0,
    coverage: true,
    stories: storiesInput.available,
    themes: themesInput.available,
    reactions: reactionsInput.available,
  };

  // An endpoint is advertised only when this build actually writes it. Listing
  // `/reactions.json` before the bake that produces it exists would send a
  // consumer to a 404 it cannot distinguish from "no reactions yet".
  const endpoints: ManifestPayload["endpoints"] = V1_ENDPOINTS.filter(
    (ep) => availability[ep.id],
  ).map((ep) => ({
    id: ep.id,
    path: ep.path,
    version: V1_SCHEMA_VERSION,
    available: true,
    description: ep.description,
  }));

  const manifest: ManifestPayload = {
    schemaVersion: V1_SCHEMA_VERSION,
    namespace: "v1",
    generatedAt,
    timezone,
    endpoints,
    snapshots: {
      launchDate: V1_TAPE_LAUNCH_DATE,
      started: asofDays.some((d) => d.slots.length > 0),
      expectedSlotsPerDay: TAPE_SLOTS.length,
      firstDate: asofDays.length ? asofDays[0].date : null,
      lastDate: asofDays.length ? asofDays[asofDays.length - 1].date : null,
      totalSlots: asofDays.reduce((n, d) => n + d.slots.length, 0),
      totalRevisionFiles: asofDays.reduce((n, d) => n + d.counts.revisionFiles, 0),
      days: asofDays.map((d) => ({
        date: d.date,
        slots: d.slots.length,
        revisions: d.counts.revisionFiles,
        complete:
          d.tradingDay && d.expectedSlots.length > 0 && d.slots.length === d.expectedSlots.length && d.gaps.length === 0,
      })),
    },
    coverage: {
      days: coverageDays.length,
      tradingDays: tradingDays.length,
      daysWithGaps: coverage.summary.daysWithGaps,
      expectedSlots,
      capturedSlots,
      coveragePct: coverage.summary.coveragePct,
      gaps: coverage.summary.gaps,
    },
    license: { ...LICENSE },
    deprecation: { ...DEPRECATION },
    guarantees: {
      promised: PROMISES.map((g) => ({ ...g })),
      notPromised: NOT_PROMISED.map((g) => ({ ...g })),
    },
  };

  const files: Record<string, unknown> = {};
  for (const day of asofDays) files[`asof/${day.date}.json`] = day;
  files["coverage.json"] = coverage;
  files["manifest.json"] = manifest;

  const RE_EXPORT = (input: InputRead, sourceName: string): Record<string, unknown> => ({
    ...(input.payload as Record<string, unknown>),
    namespace: "v1",
    source: {
      path: `/${sourceName}.json`,
      note: `re-exported verbatim under the frozen path; the root /${sourceName}.json keeps evolving with the pipeline`,
    },
  });
  if (storiesInput.available) files["stories.json"] = RE_EXPORT(storiesInput, "stories");
  if (themesInput.available) files["themes.json"] = RE_EXPORT(themesInput, "themes");
  if (reactionsInput.available) files["reactions.json"] = RE_EXPORT(reactionsInput, "reactions");

  return { generatedAt, timezone, files, manifest, coverage, asofDays };
}

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

export interface WriteReport {
  written: string[];
  removed: string[];
  dir: string;
}

/**
 * Write the payloads under `<root>/v1/`, and remove v1 files this build no
 * longer produces.
 *
 * Cleanup is scoped to `v1/reactions.json` and `v1/asof/*.json`: those are the
 * only paths whose existence depends on an input, so a stale copy would
 * otherwise survive a restore-and-republish and advertise data that is gone.
 * Nothing outside `v1/` is touched.
 */
export function writeV1(build: V1Build, options: { root?: string } = {}): WriteReport {
  const root = options.root ?? path.resolve("daily_reports");
  const dir = path.join(root, "v1");
  fs.mkdirSync(path.join(dir, "asof"), { recursive: true });

  const written: string[] = [];
  const targets = new Set<string>();
  for (const [rel, payload] of Object.entries(build.files)) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    targets.add(rel);
    written.push(fp);
  }

  const candidates: string[] = [];
  if (fs.existsSync(path.join(dir, "reactions.json"))) candidates.push("reactions.json");
  const asofDir = path.join(dir, "asof");
  if (fs.existsSync(asofDir)) {
    for (const f of fs.readdirSync(asofDir)) {
      if (f.endsWith(".json")) candidates.push(`asof/${f}`);
    }
  }

  const removed: string[] = [];
  for (const rel of candidates) {
    if (targets.has(rel)) continue;
    try {
      fs.rmSync(path.join(dir, rel));
      removed.push(path.join(dir, rel));
    } catch {
      // a failed cleanup must never fail the bake
    }
  }

  return { written, removed, dir };
}
