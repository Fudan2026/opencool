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
| `tools.json` + `ai-instructions.html` | build-site | Static MCP manifest (7 tools → static endpoints) + agent onboarding page |
| `llms.txt` | build-site | Agent-discoverable index of all of the above |

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
