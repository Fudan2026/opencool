# OpenCool Data Contract

Consumer-facing reference for every JSON surface OpenCool publishes to
GitHub Pages. The **executable** version of this contract lives in
`tests/golden/sidecar-schema.test.ts` — CI blocks any change that breaks
a listed field. If you must move a field, update that test explicitly in
the same PR and bump the note below.

Consumers today: SuPro (`src/lib/opencool/map.ts`), local MCP tools
(`mcp/server.mjs`), RSS readers (`feed.xml`), agents (`llms.txt`).

Base URL: `https://fudan2026.github.io/opencool/` · Timezone:
`Asia/Shanghai` everywhere. License MIT.

## Per-edition sidecar `/<YYYY-MM-DD>/<HH>.json`

Written by `npm run daily` for each real edition (HH ∈ 06/13/19).

| Field | Type | Notes |
|---|---|---|
| `hero_headline` | string | Lead headline (may carry a language note) |
| `daily_overview` | string | Digest overview paragraph |
| `tech_briefs` / `finance_briefs` / `politics_briefs` | `BriefItem[]` | `{title,url,source,summary,importance}` |
| `editor_note` | string | Mode provenance (e.g. LLM off) |
| `keywords` | `string[]` | Cleaned top keywords (stopword-filtered) |
| `trading?` | object | Watchlist indicators (optional) |
| `quant?` | object | Retail quant extras: `market.indices[].changePct`, `events[]`, … |
| `sentiment.score` | number −100..100 | **Per-article mean tone** (wave-6 calibrated, `tanh((raw/scanned)/3)`) |
| `sentiment.raw` | number | Signed weighted hit total before normalization |
| `sentiment.label` | string | 中性/偏多/强偏多/偏空/强偏空 |
| `sentiment.sectors[]` | array | `{key,score,posHits,negHits,articles,topDrivers}` per asset group + `general` |
| `sentiment.percentile` | number\|null | Rank vs ≥20 recent editions; `null` while history is short |
| `morning_brief?` | object | **06:00 editions only**: `{base_edition,sentimentDelta,baseSentiment,overnight[],newKeywords[],newEvents[],note}` |
| `fetch_health.entries[]` | array | `{id,ms,ok,count,error?}` per source |

The companion `/<date>/<HH>-articles.json` is a raw article cache
(pruned after 30 days) — do not build on it.

**Placeholder rule**: friendly placeholder `/<date>/<HH>.html` pages
contain the string `尚未更新` and have **no** `.json` sidecar. Check the
sidecar to distinguish real editions.

## Data products (repo root of gh-pages)

| Path | Producer | Shape |
|---|---|---|
| `sentiment-history.json` | build-site | `{generatedAt,cap:60,count,items:[{date,hour,score,label,posHits,negHits,scanned,percentile}]}` — chronological, newest last |
| `keywords.json` | `npm run keywords:bake` | `{generatedAt,windowDays:7,editions,items:[{term,count,firstSeen,lastSeen}]}` — top 40 |
| `weekly.json` + `weekly.html` | `npm run weekly:bake` | 7-day review: `{daysCovered,editions,avgSentiment,sentimentCurve,sectorAvg,topEvents,keywords,indexRows}` (baked when ≥5 days) |
| `themes.json` | `npm run themes:bake` | 24 curated themes: `{key,name,boardCode,boardName,boardChangePct,boardUp,boardDown,articleHits,matchedAliases,constituents:[{symbol,name,changePct}]}`. Top-level `{generatedAt,source,status:`ok`\|`degraded`\|`failed`,registry:`live`\|`snapshot`\|`none`,edition,themes}`. `boardUp`/`boardDown` are advancing/declining member counts. `status:"failed"` means zero themes resolved a board while a committed board map existed — treat board fields as absent. |
| `feed.xml` | build-site | RSS 2.0, newest 30 **real** editions |
| `status.html` | build-site | Publish matrix (14d) + source-health + sentiment trend |
| `source-overlay.json` | build-site | `{disabled:[{id,reason,since}]}` — present only when sources fail ≥3 straight days |
| `tools.json` + `ai-instructions.html` | build-site | Static MCP manifest (N tools → static endpoints) + agent onboarding page |
| `llms.txt` | build-site | Agent-discoverable index of all of the above |

## Point-in-time tape `tape/<YYYY-MM-DD>/<HHMM>.json`

One immutable snapshot per A-share session slot (09:35 … 15:05 Asia/Shanghai,
ten a weekday), written by `npm run tape:bake`.

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | number | Snapshot payload version (1) |
| `date` / `slot` / `slotKey` | string | Report-timezone date, `HH:MM` slot, and the filename stem |
| `revision` | number | `0` for a slot's first capture, `N` for the Nth re-capture |
| `observedAt` | string | When **we** fetched, ISO 8601 with the market offset |
| `timezone` | string | Report timezone the slot and clocks are expressed in |
| `registry` | string | Board registry actually used (`live`\|`snapshot`\|`none`) |
| `indices` / `industries` / `themes` / `fundFlows` / `limitPool` | section | Each: `{asOf, observedAt, timestampSource, records[], meta?}` |

Every section **and every record inside it** carries both clocks:
`asOf` is the market timestamp the value describes (from the upstream payload's
own quote stamp where it has one), `observedAt` is when we fetched it.
`timestampSource` is `"upstream"` when `asOf` came from the payload and
`"fetch"` when it is our own fetch instant — never an invented market time.

A re-capture never rewrites a slot: it writes `<HHMM>.rev-N.json` and appends a
line to `revisions.jsonl` naming which sections actually moved. The base file's
bytes are immutable, and the base file is the value the v1 namespace publishes
for that slot.

`index.json` per day is derived (rebuilt from the snapshots), so a stale copy
repairs itself. Key readers on the snapshot files, not the index.

## Versioned namespace `/v1/` — the pinned contract

`/v1/` is a frozen, additive-only view. **Pin these paths, not the root ones.**
A root surface (`stories.json`, `themes.json`, `tape/…`) may evolve with the
pipeline; a `/v1` path may not. The executable version of this section is
`tests/golden/v1-contract.test.ts` plus `lib/v1/contract.ts`.

| Path | Producer | Shape (required top-level keys) |
|---|---|---|
| `v1/manifest.json` | `npm run v1:bake` | `{schemaVersion,namespace:"v1",generatedAt,timezone,endpoints[],snapshots{},coverage{},license{},deprecation{},guarantees{}}` |
| `v1/asof/<YYYY-MM-DD>.json` | `npm run v1:bake` | `{schemaVersion,namespace,date,timezone,generatedAt,tradingDay,beforeLaunch,expectedSlots[],pendingSlots[],slots[],gaps[],counts{}}` |
| `v1/coverage.json` | `npm run v1:bake` | `{schemaVersion,namespace,generatedAt,timezone,tape{},days[],stories{},horizons[],gaps[],summary{}}` |
| `v1/stories.json` | re-export of `stories.json` | `{version,timezone,retentionDays,maxStories,updatedAt,generatedAt,stories[],counts{},firstMover{},revisionTrail{}}` |
| `v1/themes.json` | re-export of `themes.json` | `{generatedAt,themes[]}` |
| `v1/reactions.json` | `npm run reactions:bake`, re-exported — **only when `reactions.json` exists** | `{schemaVersion,dataThrough,timezone,counts,observations[],gaps[]}`. Advertised in the manifest only once the bake has run; never served as an empty placeholder. `counts.horizons[key] = {ok,pending,gap}` is the authoritative classification. |

`v1/asof/<date>.json` is the answer to "what was knowable at 11:35 that day":
`slots[]` is in slot order, and **each slot** carries its own `asOf` and
`observedAt` (plus the same pair on every section and record inside it), while
`captures[]` lists every re-capture with its `.rev-N` file and the sections it
moved.

`gaps[]` is the part to read before the numbers. Every **due** slot that has no
snapshot is named with a stable code — `missed`, `future`,
`section-unavailable`, `base-missing` — plus `input-missing`/`input-unreadable`
for a whole absent input. A trading day is never silently short.

Three kinds of slot are *not* gaps, and each says so explicitly instead of
appearing as a hole:

- **not yet due** — `pendingSlots[]` lists them on a day still in progress, and
  they are excluded from `counts.expectedSlots` and from every percentage, so a
  10:10 rebuild of a healthy morning reads 2/2 rather than 2/10;
- **not a trading day** — `tradingDay: false`, `expectedSlots: 0`, no gaps: an
  honest weekend is not ten failures;
- **before the tape existed** — `beforeLaunch: true`, `expectedSlots: 0`, no
  gaps: a hole that can never be filled is not an obligation, and counting it
  would deflate every later coverage figure.

`v1/coverage.json` is the same ledger in aggregate plus the two things the tape
cannot show on its own: `stories.firstSeenCoveragePct` (how many ledger records
carry a `firstSeenAt`) and `horizons[]` (how many observations already have an
`ok` `+1h`/`+1d`/`+5d` measurement and how many are still pending, taken from
`reactions.json` `counts.horizons` rather than re-derived).
`summary.coveragePct` is `null` — not `0`, not `100` — while there is nothing
owed yet, because either number would be read as a judgement that has not been
earned. The denominator is always "slots that were actually due by the build
instant", never the full schedule on a day in progress.

`integrity.html` renders the same payload for a human. It carries no score and
no green checkmarks: a day with gaps is never rendered as success, and when the
tape has no days at all the page says so in a sentence instead of drawing an
empty table.

### What `/v1` promises

1. **Additive-only.** No field a consumer sees is removed or retyped within v1.
   New fields may appear at any time; consumers must ignore unknown ones.
2. **A breaking change ships as `/v2/`**, and after `/v2/` publishes, `/v1/`
   keeps being written for at least 12 months with its manifest naming the
   successor. An endpoint that stops is removed from the manifest in the same
   build that stops writing it.
3. **Two clocks on every tape value**, both ISO 8601 with an explicit offset.
4. **Gaps are named**, never silently absent.
5. **Append-only storage**: a re-capture writes `rev-N`, it does not rewrite.
6. **Deterministic generation**: `/v1` files are built from local files with no
   network call, so a replay of the same tree produces the same bytes.
7. **License**: code MIT; data terms are stated in `manifest.license.data`
   (delayed vendor quotes, reading only, not for execution, not advice, no
   third-party licensed dataset redistributed).

### What `/v1` explicitly does **not** promise

1. **No real-time push** — no WebSocket, no SSE, no streaming. Everything is a
   static file refreshed by a build; the granularity is the capture slot, not
   the tick.
2. **No L2 depth or order book** — we do not buy, resell or fabricate licensed
   depth data.
3. **No revision history beyond the published revision trail** — that is
   `tape/<date>/revisions.jsonl` plus the `.rev-N.json` files. There is no
   deeper edit history, and a slot's base file is never rewritten.
4. **No retroactive archive edits** — published slots are not rewritten, and a
   backfilled edition is labelled as a backfill rather than presented as that
   day's snapshot. A gap that closed late stays visible in `revisions`/`gaps`.
5. **No SLA** — a missed tick is a named gap, not a refund. No uptime guarantee,
   no per-second snapshots, no cross-market (HK/US) parity, no delisted-security
   retention.

Zero LLM is unchanged by this namespace: `/v1` is produced by arithmetic over
local files, inside the same build job whose `LLM_MODE` is pinned to `off` and
whose post-run `scripts/assert-zero-llm.mjs` fails the run on any call. The
publish-lag assertion is likewise untouched — `/v1` neither delays nor advances
an edition.

## MCP tools (local, `cd mcp && npm start`)

`list_watchlist` · `get_quote` · `get_kline` · `market_overview` ·
`sentiment_query` · `sentiment_trend` · `search_editions`.

## Change policy

1. Fields listed here are load-bearing for external consumers.
2. Additive changes (new optional fields) are always safe.
3. Moves/renames require: golden schema test update + version note here +
   a deprecation window in `llms.txt`.
4. Scores are **not** comparable across the wave-6 calibration boundary
   (pre-2026-11 editions used an additive scale that saturated at ±100);
   use `percentile` for cross-era comparisons.
5. **Inside `/v1/`, rule 3 does not apply — rule 1 of "What `/v1` promises"
   does.** There is no move/rename escape hatch in v1: a field that must change
   shape is added alongside the old one, and the old one keeps its exact type
   for as long as v1 lives. Removing a field, renaming one, or changing its type
   inside v1 is a bug, and `tests/golden/v1-contract.test.ts` fails the build for
   it. The only sanctioned way to break a v1 shape is `/v2/`.
