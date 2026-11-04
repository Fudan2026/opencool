# OpenCool 数据契约（中文版）

本文件是 `docs/DATA-CONTRACT.md`（英文权威版）的中文镜像，供中文生态消费方阅读。
**可执行版契约**在 `tests/golden/sidecar-schema.test.ts` —— CI 会阻断任何破坏所列字段的变更。
如需移动字段，请在同一 PR 中显式更新该测试并在此注明。

现有消费方：SuPro（`src/lib/opencool/map.ts`）、本地 MCP 工具（`mcp/server.mjs`）、
RSS 阅读器（`feed.xml`）、agent（`llms.txt`）。

基址：`https://fudan2026.github.io/opencool/` · 时区统一为 `Asia/Shanghai`。License MIT。

## 单档侧车 `/<YYYY-MM-DD>/<HH>.json`

由 `npm run daily` 为每个真实档期写入（HH ∈ 06/13/19）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `hero_headline` | string | 头条标题（可能带语言注记） |
| `daily_overview` | string | 摘要导语段落 |
| `tech_briefs` / `finance_briefs` / `politics_briefs` | `BriefItem[]` | `{title,url,source,summary,importance}` |
| `editor_note` | string | 模式出处（如 LLM 关闭） |
| `keywords` | `string[]` | 清洗后的档期关键词（已去停用词） |
| `trading?` | object | 观察池技术指标（可选） |
| `quant?` | object | 散户量化附加：`market.indices[].changePct`、`events[]` 等 |
| `sentiment.score` | number −100..100 | **每篇均调情绪**（第六跳校准，`tanh((raw/scanned)/3)`） |
| `sentiment.raw` | number | 归一化前的有符号加权命中总量 |
| `sentiment.label` | string | 中性/偏多/强偏多/偏空/强偏空 |
| `sentiment.sectors[]` | array | 每资产组 `{key,score,posHits,negHits,articles,topDrivers}` + `general` |
| `sentiment.percentile` | number\|null | 相对 ≥20 期历史的分位；样本不足时为 `null` |
| `morning_brief?` | object | **仅 06 档**：`{base_edition,sentimentDelta,baseSentiment,overnight[],newKeywords[],newEvents[],note}` |
| `fetch_health.entries[]` | array | 每源 `{id,ms,ok,count,error?}` |

配套的 `/<date>/<HH>-articles.json` 是原始文章缓存（30 天后清理）——请勿依赖。

**占位页规则**：友好占位页 `/<date>/<HH>.html` 含字符串 `尚未更新` 且**没有**
`.json` 侧车。以侧车是否存在区分真实档期。

## 数据产品（gh-pages 根目录）

| 路径 | 产出方 | 结构 |
|---|---|---|
| `sentiment-history.json` | build-site | `{generatedAt,cap:60,count,items:[{date,hour,score,label,posHits,negHits,scanned,percentile}]}`，时间正序 |
| `keywords.json` | `npm run keywords:bake` | `{generatedAt,windowDays:7,editions,items:[{term,count,firstSeen,lastSeen}]}`，Top 40 |
| `weekly.json` + `weekly.html` | `npm run weekly:bake` | 7 天复盘：`{daysCovered,editions,avgSentiment,sentimentCurve,sectorAvg,topEvents,keywords,indexRows}`（≥5 天才产出） |
| `feed.xml` | build-site | RSS 2.0，最近 30 个真实档期 |
| `status.html` | build-site | 发布矩阵（14 天）+ 源健康 + 情绪趋势 |
| `source-overlay.json` | build-site | `{disabled:[{id,reason,since}]}` —— 仅当源连续 ≥3 天全档失败时存在 |
| `search-index.json` + `search.html` | `npm run search:bake` | 倒排索引 `{docs:[{d,h,t}],postings:{token:[docIdx...]}}`，token 为 CJK 二元组 + ASCII 词（≥3 字符、去停用词） |
| `tools.json` + `ai-instructions.html` | build-site | 静态 MCP 清单（7 工具 → 静态端点）+ agent 上手指引页 |
| `llms.txt` | build-site | 面向 agent 的全量索引 |

## MCP 工具（本地，`cd mcp && npm start`）

`list_watchlist`（与流水线观察池同步，32 标的）· `get_quote` · `get_kline` ·
`market_overview` · `sentiment_query` · `sentiment_trend` · `search_editions`。

## 变更政策

1. 本文件所列字段均为外部消费方的承重字段。
2. 加法式变更（新增可选字段）永远安全。
3. 移动/改名必须：更新 golden schema 测试 + 在此注明版本 + 在 `llms.txt`
   给出弃用窗口。
4. 情绪分数**不可跨第六跳校准边界比较**（2026-11 之前为加法标度、会在
   ±100 饱和）；跨时代比较请使用 `percentile`。
