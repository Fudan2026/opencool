/**
 * The `/v1` namespace contract — the machine-readable half.
 *
 * `/v1` is a frozen, additive-only view of what OpenCool publishes. Its whole
 * reason to exist is that the root surfaces (`stories.json`, `themes.json`,
 * `tape/…`) are free to evolve with the pipeline, while a consumer that pinned
 * `/v1/…` keeps working. That promise is only worth anything if it is
 * executable, so this module holds the required top-level shape of every v1
 * file and `tests/golden/v1-contract.test.ts` asserts the published files
 * against it. A rename or retype inside v1 fails the suite; a genuinely
 * breaking change has to move to `/v2/`.
 *
 * Nothing here fetches. Every v1 file is generated deterministically from
 * files already on disk, so a replay of the same tree produces the same bytes.
 */

/** Version of the v1 payloads. Bumped only for an additive change. */
export const V1_SCHEMA_VERSION = 1;

/** Path prefix every v1 file lives under, relative to the site root. */
export const V1_PREFIX = "/v1";

/**
 * First date the tape is expected to hold snapshots — Monday 2026-11-16 09:35
 * Asia/Shanghai, the first trading session after the capture job shipped.
 *
 * This is not a guess about history: before this date the mechanism did not
 * exist, so a weekday between the repository's first edition and this date has
 * no snapshot and never will. Naming the date is what lets `/v1/coverage.json`
 * and `/integrity.html` say "not started yet" instead of rendering an empty
 * table that reads like success.
 */
export const V1_TAPE_LAUNCH_DATE = "2026-11-16";

/** Reaction horizons the eventual reaction library measures (+1h/+1d/+5d). */
export const V1_HORIZONS = [
  { key: "1h", hours: 1 },
  { key: "1d", hours: 24 },
  { key: "5d", hours: 120 },
] as const;

/**
 * The endpoint table — one entry per file the namespace can serve.
 *
 * `optional: true` means the endpoint is only advertised and written when its
 * input exists at build time. Advertising a path that has no file behind it is
 * the exact failure the manifest is supposed to prevent, so `buildV1` filters
 * this list against what it actually wrote.
 */
export const V1_ENDPOINTS = [
  {
    id: "manifest",
    path: `${V1_PREFIX}/manifest.json`,
    optional: false,
    description:
      "This document: endpoints, snapshot index, coverage summary, license and the deprecation policy.",
  },
  {
    id: "asof",
    path: `${V1_PREFIX}/asof/<YYYY-MM-DD>.json`,
    optional: false,
    description:
      "Every tape snapshot for one day, in slot order. Each slot and each section carries asOf (market clock) and observedAt (our fetch clock); absent slots and sections are named in gaps[] with a code.",
  },
  {
    id: "coverage",
    path: `${V1_PREFIX}/coverage.json`,
    optional: false,
    description:
      "Per-day expected vs captured slot counts, every named gap, revision counts, first-seen coverage and pending reaction horizons.",
  },
  {
    id: "stories",
    path: `${V1_PREFIX}/stories.json`,
    optional: false,
    description:
      "Story ledger re-exported under the frozen path: stable ids, firstSeenAt, sightings, headline revisions, per-wire first-mover ranking.",
  },
  {
    id: "themes",
    path: `${V1_PREFIX}/themes.json`,
    optional: false,
    description:
      "Theme board heat re-exported under the frozen path: board code/name, board move, advancing/declining counts, article hits, constituents.",
  },
  {
    id: "reactions",
    path: `${V1_PREFIX}/reactions.json`,
    optional: true,
    description:
      "News-to-price reaction library (+1h/+1d/+5d). Advertised only once daily_reports/reactions.json exists at build time; omitted entirely until then rather than served empty.",
  },
] as const;

export type V1EndpointId = (typeof V1_ENDPOINTS)[number]["id"];

/**
 * The promises, as data.
 *
 * `key` has a paired `STR.integrityPromise*` entry in both locales — that is how
 * `/integrity.html` renders them in the reader's language while
 * `/v1/manifest.json` stays single-language (English). The duplication is
 * deliberate and guarded: `tests/golden/v1-contract.test.ts` asserts the English
 * text here is byte-identical to the English `STR` entry for the same key, so a
 * new guarantee must be added in both places or the suite fails.
 */
export const V1_GUARANTEES = {
  promised: [
    {
      key: "PromiseStaticJson",
      en: "Every file is static JSON produced at build time from files already in this repository's publish tree.",
    },
    {
      key: "PromiseTwoClocks",
      en: "Every tape value carries asOf (market clock) and observedAt (our fetch clock), both ISO 8601 with an offset.",
    },
    {
      key: "PromiseGapsNamed",
      en: "A missing slot, section or input is named in gaps[] with a stable code — never silently absent.",
    },
    {
      key: "PromiseAppendOnly",
      en: "A re-capture writes <HHMM>.rev-N.json; it never overwrites the base capture's bytes.",
    },
    {
      key: "PromiseAdditiveOnly",
      en: "Additive-only within v1; a breaking change ships as /v2/.",
    },
  ],
  notPromised: [
    {
      key: "NotPromisePush",
      en: "No real-time push: no WebSocket, no SSE, no streaming. Everything is a file, refreshed by a build.",
    },
    {
      key: "NotPromiseDepth",
      en: "No L2 depth or order book — we do not buy, resell or fabricate licensed depth data.",
    },
    {
      key: "NotPromiseRevisionHistory",
      en: "No revision history beyond the published trail (tape/<date>/revisions.jsonl and the .rev-N.json files).",
    },
    {
      key: "NotPromiseArchiveEdits",
      en: "No retroactive archive edits: published slots are not rewritten, and a backfilled edition is labelled as one.",
    },
    {
      key: "NotPromiseSla",
      en: "No SLA: a missed tick is a named gap, not a refund.",
    },
  ],
} as const;

type FieldType = "string" | "number" | "boolean" | "array" | "object";

/**
 * Required top-level fields per file, with the type each must keep.
 *
 * Deliberately only top level: nested shapes are asserted where they carry the
 * claim (the two clocks, gap naming) by the golden test, not by a deep schema
 * that would fail on every additive field.
 */
export const V1_REQUIRED_FIELDS: Record<string, Record<string, FieldType>> = {
  "manifest.json": {
    schemaVersion: "number",
    namespace: "string",
    generatedAt: "string",
    timezone: "string",
    endpoints: "array",
    snapshots: "object",
    coverage: "object",
    license: "object",
    deprecation: "object",
  },
  "asof/<date>.json": {
    schemaVersion: "number",
    namespace: "string",
    date: "string",
    timezone: "string",
    generatedAt: "string",
    tradingDay: "boolean",
    beforeLaunch: "boolean",
    expectedSlots: "array",
    pendingSlots: "array",
    slots: "array",
    gaps: "array",
    counts: "object",
  },
  "coverage.json": {
    schemaVersion: "number",
    namespace: "string",
    generatedAt: "string",
    timezone: "string",
    tape: "object",
    days: "array",
    stories: "object",
    horizons: "array",
    gaps: "array",
    summary: "object",
  },
  "stories.json": {
    version: "number",
    timezone: "string",
    retentionDays: "number",
    maxStories: "number",
    updatedAt: "string",
    generatedAt: "string",
    stories: "array",
    counts: "object",
    firstMover: "object",
    revisionTrail: "object",
  },
  "themes.json": {
    generatedAt: "string",
    themes: "array",
  },
  // Mirrors what `npm run reactions:bake` actually writes: the payload is
  // self-describing through `dataThrough` (the instant its tape ends) rather
  // than a wall-clock `generatedAt`, which would make a replay non-deterministic.
  "reactions.json": {
    schemaVersion: "number",
    dataThrough: "string",
    timezone: "string",
    counts: "object",
    observations: "array",
    gaps: "array",
  },
};

function typeOf(value: unknown): FieldType | "null" | "undefined" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isFinite(value) ? "number" : "null";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "undefined";
}

/**
 * Check one payload against its required top-level shape.
 *
 * Returns problems instead of throwing so the caller decides: the baker refuses
 * to write (a shape regression must not reach the site) and the golden test
 * asserts the list is empty.
 */
export function checkShape(
  payload: unknown,
  fileName: keyof typeof V1_REQUIRED_FIELDS,
): string[] {
  const spec = V1_REQUIRED_FIELDS[fileName];
  const problems: string[] = [];
  if (typeOf(payload) !== "object") {
    return [`${fileName}: not an object (${typeOf(payload)})`];
  }
  const obj = payload as Record<string, unknown>;
  for (const [field, want] of Object.entries(spec)) {
    const got = typeOf(obj[field]);
    if (got !== want) {
      problems.push(`${fileName}.${field}: expected ${want}, got ${got}`);
    }
  }
  return problems;
}

/** ISO 8601 instant with an explicit UTC offset — the only accepted clock form. */
export const V1_OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

export function isOffsetIso(value: unknown): value is string {
  return typeof value === "string" && V1_OFFSET_ISO.test(value);
}
