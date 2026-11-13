# OpenCool Competitive Analysis — Full-Market Survey Distill (2026-11)

Three research crews surveyed the competitive landscape with evidence
links: **(A)** Chinese retail-finance information products, **(B)**
self-hosted news/finance OSS on GitHub, **(C)** international digest
products + finance MCP/agent infrastructure. Every claim carries a
source URL; unverified items are flagged LOW-CONFIDENCE. Working
language English; consumer docs are bilingual.

**What we are**: zero-AI / zero-API-token Chinese finance triple-brief
(06/13/19 Shanghai) for retail investors, static on GitHub Pages —
28-source aggregation, dictionary sentiment (sectors + percentile),
overnight digest, weekly review, keyword heat, watchlist events,
technical indicators, 散户学堂 education panels, 7 MCP tools, RSS +
llms.txt + search + status dashboard, self-healing CI. No paid LLM, no
accounts, no broker APIs — permanent constraints, not phase choices.

---

## A. Chinese retail-finance products

| Product | Signature | Free/Paid | Channel |
|---|---|---|---|
| 华尔街见闻 ([wallstreetcn.com](https://wallstreetcn.com)) | [7×24 快讯 live](https://wallstreetcn.com/live); VIP articles + [大师课](https://wallstreetcn.com/member/help); iOS widgets + voice broadcast ([App Store](https://apps.apple.com/cn/app/id891596226)) | feed free; VIP/课程 paid (price LOW-CONF) | app push + widgets + web |
| 财联社 ([cls.cn](https://www.cls.cn/telegraph)) | [电报 7×24 with 加红 urgency tab](https://www.cls.cn/telegraph); VIP columns: [九点特供 盘前必读, 盘中宝, 风口研报, 狙击龙虎榜](https://www.cls.cn/detail/1568227); [VIP 盘前资金分析](https://www.cls.cn/vip) | 电报 free; VIP paid (no refunds stated) | app push + web (no official RSS — third-party scrapers exist, LOW-CONF) |
| 选股宝 ([xuangubao.cn](https://xuangubao.cn)) | theme-investment engine (follow themes, push); [早知道 morning brief](https://xuangubao.cn/zzd/home); [Chrome theme-coloring plugin](https://chromewebstore.google.com/detail/dkfbfbbglfofocbigbhmkgihckdedcbk) | site free; VIP unverified LOW-CONF | personalized push + web |
| 韭研公社 ([jiuyangongshe.com](https://www.jiuyangongshe.com)) | tagged 题材 feed with constituent stocks; daily 涨停简图 + graded 时间轴; 工分 leaderboard economy; paid AI assistant | browse free; AI/红宝书 paid (LOW-CONF) | web + iOS |
| 淘股吧 ([tgb.cn](https://www.tgb.cn)) | 打板/游资 forum; per-stock aggregated subscriptions ([App Store](https://apps.apple.com/cn/app/id820369549)); 龙虎榜 blogs; systematic data lives at [Eastmoney data center](https://data.eastmoney.com/stock/tradedetail.html) | free community (paid tier LOW-CONF) | app + web |
| 雪球 ([xueqiu.com](https://xueqiu.com/about/faq)) | free 股价提醒/自选分组; 组合 with 调仓通知 (+paid portfolios); UGC 热帖 core | free + 高级行情 paid ([FAQ](https://xueqiu.com/about/faq)) | app push + web |
| 同花顺 ([早盘必读](http://stock.10jqka.com.cn/zaopan/)) | free daily brief: 隔夜全球市场/两融/ETF 流向/公告/财经日历/交易提示; [L2 十档盘口 paid](https://www.10jqka.com.cn/l2_tyzxone/tyzx_sdxd.html) | core free | app push + web |
| 东方财富 ([data center](https://data.eastmoney.com/stock/tradedetail.html)) | free [7×24 portal](https://www.eastmoney.com); 龙虎榜 with per-营业部 follow-up win rates; 股吧 community | free + L2 paid | app push + web |
| 公众号/知识星球 briefs | 盘前必读-style paid communities (e.g. [¥1499/年 case](https://finance.sina.com.cn/roll/observe/baijiu/2025-03-19/doc-ineqehuu1677948.shtml)); specific brands LOW-CONF | free portals + paid 星球 | WeChat/星球 push |

### Cross-product frequency ranking (what the market converges on)

1. **7×24 flash feed with urgency marking** — ~7/9 products. Needs
   always-on infra → **not compatible** with static philosophy.
   OpenCool's 3-slot digest is the honest static substitute.
2. **题材 theme→stock aggregation with heat** — ~5/9 (选股宝 core,
   韭研公社, cls 风口研报, Eastmoney concept boards, 同花顺题材吧).
   Static-compatible (Eastmoney concept APIs are free; theme
   dictionary is one-time curation) → **Wave 9 headline candidate**.
3. **盘前早报 multi-section format** — 4+/9. The proven FREE version
   ([同花顺早盘必读](http://stock.10jqka.com.cn/zaopan/)) includes
   财经日历 + 交易提示 + 公告 that OpenCool's morning brief lacks →
   **Wave 8 ships this**.

Other gaps judged: 龙虎榜 digest slot (fits — public exchange data,
static-computable); personal per-stock alerts (maybe — RSS per
watchlist is the static approximation); UGC community and paid
deep-dive columns (no — accounts/paywalls contradict constraints).

---

## B. GitHub OSS landscape (live API figures, 2026-11-04)

| Project | Stars | Activity | Signature |
|---|---|---|---|
| [sansan0/TrendRadar](https://github.com/sansan0/TrendRadar) | **63,405** | pushed 2026-10-29 | hot aggregation + keyword filter; AI filter/translate (provider/model config); **push to 9 channels** (WeChat/DingTalk/Feishu/Telegram/email/ntfy/Bark/Slack); MCP v4.1.1 with tools AND resources |
| [DIYgod/RSSHub](https://github.com/DIYgod/RSSHub) | 46,803 | pushed 2026-11-04 | "Everything is RSSible" — the RSS-from-anything router (our mirrors ride it) |
| [newsnext/newsnow](https://github.com/newsnext/newsnow) | 22,278 | pushed 2026-10-13 | realtime trending UI (~30-min cache); GitHub-OAuth personalization (Cloudflare D1); official npm MCP server; EN/中/日 READMEs |
| [myhhub/stock](https://github.com/myhhub/stock) | 14,964 | 2026-04-02 | indicators, chip distribution, strategy select/backtest/auto-trade (server-oriented) |
| [imsyy/DailyHotApi](https://github.com/imsyy/DailyHotApi) | 4,104 | 2026-03-11 | ~45 CN hot-list endpoints, RSS+JSON out, Docker/npm |
| [leiting-eric/DailyBrief](https://github.com/leiting-eric/DailyBrief) (parent) | 386 | 2026-10-26 | 53-source registry; 21 tickers + LLM commentary; 6 LLM backends |
| [frankzch/ai-news-brief](https://github.com/frankzch/ai-news-brief) | 21 | 2026-10-12 | 370+ sources; **SimHash + pgvector near-dup dedup** — pure-algorithm pattern worth stealing |

OSS additions 2025-2026: pluggable AI summaries (provider/model +
fallbacks), push-everywhere, Docker packaging, MCP exposure (now table
stakes), multi-language.

Gaps vs OpenCool: push delivery (fits — CI Telegram/ntfy is free),
SimHash dedup (fits — strengthens the dictionary-not-LLM brand), MCP
Resources (fits), EN toggle (fits), hot-list breadth (maybe — runtime
fragility), Docker (maybe — orthogonal goodwill), optional AI layer
(no — identity), OAuth personalization (no — server+DB).

---

## C. International digests + agent infrastructure

**Digest stickiness patterns** ([Morning Brew](https://www.morningbrew.com) ·
[TLDR](https://tldr.tech/llms.txt) · [Finimize](https://finimize.com/newsline)):
fixed skeleton + fixed send times (we have 06/13/19 ✓); per-story
"so-what" takeaway line (Finimize — rule-based approximation possible);
link-out-not-recap summaries (TLDR ✓ we already link out). TLDR
publishes [/llms.txt](https://tldr.tech/llms.txt) + an **/ai-instructions
page**; Morning Brew's llms.txt carries an **attribution policy**
([source](https://www.morningbrew.com/llms.txt)). Google/Lighthouse now
audits llms.txt under "agentic browsing"
([source](https://developer.chrome.com/docs/lighthouse/agentic-browsing/llms-txt)).

**Free retail data surfaces**: [Finviz](https://finviz.com) free tier =
screener + market heatmap (delayed quotes) — a bakeable static heatmap
is feasible; [StockTwits](https://api-docs.stocktwits.com) keyless API
(~30 recent tagged messages/symbol, no history — self-archive needed;
limit LOW-CONF); [Barchart](https://www.barchart.com/my/price-history/download)
free membership = bulk static downloads — validates our distribution
model.

**Finance MCP servers**: [keisku/yfinance-mcp](https://github.com/keisku/yfinance-mcp)
(4 tools, column-oriented token-frugal outputs, auto-warmup),
[alphavantage/alpha_vantage_mcp](https://github.com/alphavantage/alpha_vantage_mcp)
(~100 tools, remote OAuth + stdio, "recommended agent instructions"
snippets in README, verified connector in Claude/ChatGPT/Cursor),
[wshobson/maverick-mcp](https://github.com/wshobson/maverick-mcp)
(38 tools incl. screeners, stdio or local HTTP, no auth).
**Dominant ecosystem pattern: stdio + yfinance + zero-key.**

**The open lane — "Static MCP"**: every surveyed MCP server requires a
live process. None publishes static JSON equivalents of its tools.
OpenCool on GitHub Pages can: a `/tools.json` manifest mapping all 7
MCP tools to stable static endpoints, an `/ai-instructions.html`
onboarding page, and an attribution clause in llms.txt — agent-native
distribution no competitor offers. **Wave 8 ships this.**

---

## Gap matrix → adoption verdicts

| # | Gap (source set) | Fits zero-cost static? | Verdict |
|---|---|---|---|
| 1 | 盘前早读 sections: 财经日历/交易提示/公告 (A: 同花顺 free precedent) | **yes** | **Wave 8 · PR 26** |
| 2 | Static MCP: tools.json + ai-instructions + attribution (C: nobody has it) | **yes** | **Wave 8 · PR 27** |
| 3 | Push: Telegram/ntfy from CI (B: TrendRadar 63k★ demand signal) | **yes** | **Wave 8 · PR 28** (opt-in secrets) |
| 4 | Competitive distill itself (transparency artifact) | yes | **Wave 8 · PR 25** (this doc) |
| 5 | 题材库 theme→stocks with heat (A: 5/9 products) | yes, needs curation | **Wave 9 headline** |
| 6 | SimHash near-dup dedup (B: ai-news-brief) | yes | Wave 9 |
| 7 | Sector/market heatmap SVG (C: Finviz signature) | yes | Wave 9 |
| 8 | EN source/UI toggle (B: newsnow i18n; parent REPORT_LOCALE) | yes | Wave 9 |
| 9 | Earnings/IPO calendar for watchlist (C: AV pattern) | yes | Wave 9 (merges into PR 26's calendar bake) |
| 10 | 龙虎榜 digest slot (A: Eastmoney public data) | yes | Wave 9 candidate |
| 11 | Per-symbol social sentiment (C: StockTwits keyless) | maybe (thin window, self-archive) | later |
| 12 | 7×24 flash push (A: 7/9) | no | skip — honest 3-slot substitute |
| 13 | UGC community / OAuth sync (A: 雪球; B: newsnow) | no | skip — accounts+server |
| 14 | Paid columns/大师课 (A) | no | skip — 散户学堂 covers education free |
| 15 | Docker packaging (B) | maybe | later goodwill |

## Bottom line

The market's paid moats (realtime push, community, deep-dive columns)
are structurally off-limits to a static zero-cost project — correctly
skipped. The static-compatible convergence points (盘前早读 sections,
theme mapping, calendar) and the uncontested agent-infra lane (Static
MCP + ai-instructions + attribution) define Waves 8-9. Wave 8 ships the
distill, the proven 盘前 format, the nobody-else-has Static MCP
surface, and opt-in push.

---

## Wave 10 deep-dive (2026-11): the moat map & the news→practice funnel

Fresh web distill targeting the "automated news workflow" crowd and the
advanced-feature frontier. Search-synthesis items flagged LOW-CONFIDENCE
(no primary URL for each synthesis line).

### The 2026 moat consensus

- **Single features are commoditized.** n8n-style AI-daily pipelines
  (RSS → AI summary → push) run sub-14-minute end-to-end with 200+
  source crawlers — aggregation + summarization is table stakes
  (LOW-CONFIDENCE synthesis).
- **Durable moats = workflow penetration + proprietary/real-experience
  content + 被推荐权 (recommendability)**: personalized, decision-oriented
  output rather than raw aggregation (LOW-CONFIDENCE industry synthesis).
- **The space moved past one-size digests**: ByteDance's Doubao daily
  digest was pulled (Feb 2026) — read as strategic retreat while the
  market shifts toward vertical, customizable, interactive digests
  (LOW-CONFIDENCE).

### Frontier moves worth tracking

- **TrendRadar v6.10** ([sansan0/TrendRadar](https://github.com/sansan0/TrendRadar)):
  MCP toolset rework — `aggregate_news` (cross-platform dedup
  aggregation) and `compare_periods` (week-over-week/month-over-month
  trend comparison). **Our `compare_periods` candidate**: wave-9's
  `sentiment-history.json` + `weekly.json` already hold the series — a
  static periods-compare endpoint is a natural Wave 11 item.
- **NewsNow** ([newsnext/newsnow](https://github.com/newsnext/newsnow)):
  remains aggregation/display (realtime hot lists, OAuth
  personalization) — speed + breadth + UX, easily replicated.
- **TrendRadar consumes NewsNow's API as a data source** — evidence
  that the aggregator layer is commoditizing into infrastructure
  (LOW-CONFIDENCE).

### Honest 追平 ledger (catch-up items)

| Competitor capability | Our status | Verdict |
|---|---|---|
| `compare_periods` trend comparison (TrendRadar v6.10) | sentiment-history + weekly hold the series | Wave 11 — static endpoint is cheap |
| Role-based digest formatting (CTO/CMO versions, LOW-CONF) | single zh/en audience format | later — i18n surface |
| Interactive chat-with-your-news (TrendRadar MCP chat) | `LLM_MODE=auto` gives the free GLM path; not wired to a chat UX | later — contradicts zero-AI default, opt-in only |
| 9-channel push (TrendRadar) | Telegram + ntfy shipped (PR #28) | **caught up** — channels added on demand |
| 题材→成分股 engines (选股宝/韭研公社) | **shipped wave 9** (themes.json + panel) | **caught up** |

### The breakthrough thesis: news → practice, closed loop

The 2026 consensus says the moat is workflow penetration and
recommendability. No surveyed product closes the **news → practice**
loop inside one ecosystem: aggregators inform and stop; quant suites
practice but don't inform.

**OpenCool informs → SuPro practices** (supro.si): the funnel completes
the workflow — 看完三报想实操 → SuPro's Paper Pro (¥100M journal,
3 bps, t+1 fills, no broker API in the browser), Factor Studio +
Strategy Lab, 苏坡大模型 AIaaS, Sim Desk. Wave 10 ships the funnel:
a dedicated supro.html landing page (content from the SuPro README,
verbatim-anchored), a site-wide entry badge, and nav links. The
reciprocal backlink (supro.si /news → OpenCool) is requested from the
SuPro team via issue — one ecosystem, two surfaces, recommendability
earned on both.

---

**Data-source positioning** (point-in-time history, not latency): the vendor
comparison, the contract we commit to and our own gap table live in
[`data-source-strategy.md`](./data-source-strategy.md).
