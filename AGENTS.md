# AGENTS.md

Operational knowledge for any AI coding agent working on this repo (Claude Code, Codex, Cursor, Continue.dev, Aider, etc.). Claude Code users get a richer SKILL.md auto-loaded; this file is the universal subset everyone reads.

## Shared skills catalog

**`Skills.md`** (repo root) lists installable Iwencai SkillHub skills and how to invoke them. When the user asks about **financial announcements**, A-share/HK disclosure search, or SkillHub skills, read **`Skills.md`** first and follow the matching section (e.g. `announcement-search`).

## What this project is

`daily-brief` is a local-first pipeline that fetches 23 RSS / API news sources daily (22 in en mode after locale filtering), runs LLM enrichment, and renders a single self-contained HTML report. It runs on the user's machine via the OS scheduler, OR in GitHub Actions publishing to GitHub Pages. No web framework, no DB, no servers.

The repo's `CLAUDE.md` includes this file via `@AGENTS.md`. Don't add stack-specific lore (Next.js, etc.) — there's none in this codebase.

## Project layout (essentials)

```
lib/
  ai/           # LLM dispatcher + 5 backend implementations + prompts
  sources/      # fetcher dispatch + per-source TS modules
  trading/      # Yahoo finance + technical indicators + watchlist
  output/       # render.ts (HTML+MD generation), all CSS inlined
  utils.ts      # tiny shared helpers (todayKey, getReportTz)
scripts/
  _env.ts             # dotenv preload — imported FIRST by every entry script
  daily.ts            # main pipeline (5-8 min, ~6 LLM calls)
  dry-run.ts          # fetch-only validation (~30s, no LLM)
  render.ts           # re-render HTML/MD from cached sidecar (~1s)
  regen-trading.ts    # rerun just the trading commentary
  regen-enrich.ts     # top up missing summaries for a subgroup
  bake-themes.ts      # theme board heat + constituents + article hits
  bake-board-map.ts   # refresh lib/themes/board-map.json (weekly, not per edition)
  build-site.mjs      # generate index.html + archive.html for static hosting
  deploy.mjs          # scp HTML to a remote nginx host (opt-in)
  sources.ts          # `npm run sources` — list/validate sources.config.json
  install.mjs         # cross-platform OS scheduler registration
  run-daily.mjs       # scheduler wrapper (daily + log + deploy + open)
  open-report.mjs     # cross-platform "open latest report" helper
  uninstall.mjs       # tear down scheduler + ~/.claude/ links
  quota-report.ts     # LLM call usage summary
sources.config.json   # SINGLE SOURCE OF TRUTH for the source registry
```

## Core invariants

1. **`sources.config.json` is the only place sources live.** `lib/sources/registry.ts` is just a JSON loader + locale filter. Never hardcode a source list in TS. RSS sources may declare `mirrors: string[]` (fallback feed URLs tried in order after the primary fails — see `lib/sources/rss.ts` `resolveFeedOrder`); first success wins and mirror serving is logged. When a feed 403s on CI datacenter IPs, prefer `useCurl: true` (browser UA via curl) plus a verified mirror over dropping the source. Runtime exceptions (never edit the config from scripts): `DISABLE_SOURCE_IDS` env and the GENERATED `daily_reports/source-overlay.json` (build-site writes it when a source fails all editions for 3 straight days; `lib/sources/overlay.ts` reads it at module init; delete entries or the file to re-enable). The overlay only ever exists in the CI publish tree — a local build-site run may write one from local-network failures, which is harmless because it is gitignored and never committed.

2. **LLM calls go through `lib/ai/llm.ts` `runLlm()`.** Five backends behind `LLM_BACKEND` env var: `claude-cli` (default), `anthropic`, `openai`, `deepseek`, `minimax`. Never import a specific backend directly — that defeats the switch.

3. **Date keying uses `lib/utils.ts` `todayKey()`.** Honors `REPORT_TZ` env var; defaults to system local TZ. Don't hardcode `Asia/Shanghai` or `UTC` anywhere. `EDITION_DATE` (`YYYY-MM-DD`, validated — malformed or future dates throw) overrides it **only** so the Actions gate can backfill a past slot; leave it unset for every normal run.

4. **Theme customization via `themes.custom.json`** (optional): user entries merge with `lib/themes/catalog.ts` `loadThemeCatalog()` — new keys append, same-key entries replace built-ins; invalid shape throws loudly. Never hardcode user themes in TS. The file is optional and ignored when absent; `THEMES_EXTRA_FILE` can override the path.

4. **Localization via `REPORT_LOCALE` (`zh` | `en`).** All UI text in render.ts goes through `STR.<key>`; LLM prompts have ZH/EN pairs picked at module-init. When adding strings, add both.

5. **Per-source fetch errors are non-fatal.** `scripts/daily.ts` has a try/catch per source. Never `process.exit()` inside a fetcher.

6. **No agent-specific build steps.** No `next build`, no bundling. `tsx` runs TS directly. The HTML is hand-rendered, CSS is inlined string-templated.

7. **Theme board data never comes from `clist/get`.** `push2.eastmoney.com/api/qt/clist/get` 502s for our clients for hours at a time (measured 0/40 from a VM, and CI logged `boards=0` on every edition from 2026-11-11 to 2026-11-13 while tests stayed green). `bake-themes` therefore reads the registry from `datacenter-web.eastmoney.com` (`RPT_EM_BOARD`, with `lib/themes/board-map.json` as the committed fallback refreshed weekly by the `board-map` workflow) and quotes from `api/qt/ulist.np/get`, which stays healthy on the same host and accepts a comma list of `90.BKxxxx` secids. Constituents come from `RPT_BOARD_CONSTITUENT` on the same registry host. See `lib/invest/board-registry.ts`. Never reintroduce a `clist/get` dependency for boards: `daily.yml` fails the run when fewer than 15 of 24 themes resolve a board, and `lib/invest/board-registry.test.ts` fails on a silently-empty parse.

8. **Reaction windows (`lib/reactions/`, `scripts/bake-reactions.ts`) are the only place a news→sector return is computed.** It joins the tape with the ledger and publishes `daily_reports/reactions.json`. Four rules make the number defensible, and each has a test that fails if broken:
   - **`changePct` is day-relative.** A board's move over a multi-day window is the ratio of *chained* levels (`lib/reactions/tape-read.ts` `buildSeries`), never the difference of two `changePct` values. `+2%` then `+3%` is ~5.06%, not 1%. A missing close starts a new chain segment and a window spanning it is a `gap`, never bridged.
   - **Abnormal return, per horizon.** `rawReturnPct` is published, but the headline (`headlineMetric`) is `marketExcessPct` — raw minus the cross-sectional mean of *industry* boards over the identical window. `sectorExcessPct` (vs the board's own trailing drift) is null until a full prior window exists.
   - **No lookahead and no zero-length windows.** Entry is the earliest snapshot at/after `firstSeenAt`, exit the earliest at/after `firstSeenAt + horizon`. No snapshot ⇒ `pending`, never extrapolated. A window under `MIN_WINDOW_FRACTION` of the horizon is also `pending`: with a single capture entry and exit coincide and the return would be 0% by construction.
   - **`MIN_SAMPLE` (20) guards every aggregate.** Below it the row carries `n` and `status: "insufficient"` with no mean/median/percentiles at all. `marketExcessPct` needs a cross-section of `MIN_CROSS_SECTION` (50) boards.
   Attribution is an explicit reviewable table (`lib/reactions/attribution.ts`, entity→theme, then topic, then 上证指数 as a labelled market fallback). `attribution` has **four** non-null-or-null states and they are not interchangeable: `entity`/`topic` (a sector board resolved and was quoted), `market` (the tape HAD started and the story genuinely has no link — a finding), `pending` (the tape had not started, so nothing could be attributed — "could not check yet"), `null`/unmapped (tape started, nothing quoted). Collapsing `pending` into `market` reported 2,000 stories as sectorless on day one; `scripts/assert-reactions.mjs` now fails the run when tape has not started and `attributed.market > 0`. `scripts/assert-reactions.mjs` re-checks all of the above against the file before it publishes — extend it, not just the tests, when adding a rule.

## Commands

| Task | Command | Cost |
|---|---|---|
| Full pipeline | `npm run daily` | ~5-8 min, ~6 LLM calls |
| Fetch-only sanity check | `npm run dry-run` | ~30s, no LLM |
| Re-render from cache | `npm run render [date]` | <1s |
| Re-run trading section | `npm run regen-trading [date]` | ~2 min, 1 LLM call |
| Top up missing summaries | `npm run regen-enrich <cat:sub> [date]` | ~30s, 1 LLM call |
| Bake theme board heat | `npm run themes:bake` | ~1-2 min, no LLM |
| Refresh board registry snapshot | `npm run board-map:bake` | ~15s, weekly in CI |
| Bake story ledger | `npm run stories:bake` | ~1-2s, no LLM |
| Bake reaction windows | `npm run reactions:bake` | ~1s, no LLM, no network |
| Static-site generator | `npm run build-site` | <1s |
| List sources by status | `npm run sources` | instant |
| Validate sources.config.json | `npm run sources:check` | instant |

`[date]` defaults to today in `REPORT_TZ`. Output is `daily_reports/<date>/<date>.html` + `<date>.json` + `<date>-articles.json` (note the hyphen in the articles cache filename); add `<date>.md` if `OUTPUT_MARKDOWN=true`.

## Adding a source

1. Edit `sources.config.json` — append an entry. Fields: `id` (unique), `name`, `type` (`rss`/`api`/`scrape`), `url`, `category` (`tech`/`finance`/`politics`), optional `subcategory`, `enabled`, `useCurl`, `lang`, `locales`, `notes`.
2. For non-RSS types: add a fetcher in `lib/sources/<id>.ts` exporting `fetchXxx(sourceId)` returning `RawArticle[]`, then add a branch in `lib/sources/dispatch.ts`.
3. Run `npm run sources:check` to validate the JSON, then `npm run dry-run` to verify the fetch.

## Adding an LLM backend

1. New file `lib/ai/backends/<name>.ts` exporting a function compatible with the existing backends (see `claude-cli.ts` as the minimum reference).
2. Add a branch in `lib/ai/llm.ts` `runLlm()`.
3. Add `<NAME>_API_KEY` + optional `<NAME>_BASE_URL` to `.env.example`.

## Debugging a failed run

1. `logs/daily-<YYYY-MM-DD>.log` — full pipeline output for that day (date in local time, NOT UTC)
2. `logs/llm-calls.jsonl` — every LLM call with input size, latency, success, error category
3. `npm run quota-report` — usage summary by backend
4. If a tab renders wrong but the data is right, `npm run render` (1s) usually fixes display-only bugs without rerunning LLM

## What NOT to do

- Don't add Playwright / Puppeteer for fetching — the project stays light with curl + JSON APIs
- Don't import a specific LLM backend module directly; always go through `runLlm`
- Don't hardcode sources in TS — use `sources.config.json`
- Don't write into `daily_reports/` directly from agent code; let `scripts/daily.ts` or `render.ts` own that
- Don't add a web framework (Next.js, Express, etc.) — the project is intentionally static
- Don't bypass the per-source try/catch — let `daily.ts` aggregate failures

## Where to learn more

- `README.md` — user-facing intro, install, configuration
- `FORKING.md` — common customizations (LLM provider, sources, layout, styling)
- `Skills.md` — Iwencai / shared agent skills (announcement search, SkillHub install)
- `.claude/skills/daily-brief/SKILL.md` — fuller operational reference (Claude Code auto-loads it; other agents can read it directly)
- `sources.config.json` — see what sources look like in practice
