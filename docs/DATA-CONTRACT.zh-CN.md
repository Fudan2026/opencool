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
| `tools.json` + `ai-instructions.html` | build-site | 静态 MCP 清单（N 工具 → 静态端点）+ agent 上手指引页 |
| `llms.txt` | build-site | 面向 agent 的全量索引 |

## 盘中时点快照 `tape/<YYYY-MM-DD>/<HHMM>.json`

A 股每个交易时段写一份不可变快照（上海时间 09:35 … 15:05，每个交易日十个），
由 `npm run tape:bake` 写入。

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | number | 快照负载版本（1） |
| `date` / `slot` / `slotKey` | string | 报告时区日期、`HH:MM` 时点、文件名主干 |
| `revision` | number | 该时点首次采集为 `0`，第 N 次重采为 `N` |
| `observedAt` | string | **我们**抓取的时刻，带市场时区偏移的 ISO 8601 |
| `timezone` | string | 时点与时钟所用的报告时区 |
| `registry` | string | 实际使用的板块注册表（`live`\|`snapshot`\|`none`） |
| `indices` / `industries` / `themes` / `fundFlows` / `limitPool` | section | 每个分区为 `{asOf, observedAt, timestampSource, records[], meta?}` |

每个分区**以及分区内每一条记录**都带两个时钟：`asOf` 是该数值所描述的
市场时刻（上游载荷自带行情时间戳时取该时间戳），`observedAt` 是我们抓取
它的时刻。`timestampSource` 为 `"upstream"` 表示 `asOf` 来自载荷，为
`"fetch"` 表示用了我们自己的抓取时刻——从不编造市场时间。

重采永不覆盖：写 `<HHMM>.rev-N.json` 并在 `revisions.jsonl` 追加一行，
点明哪些分区真的变了。首个快照文件的字节不可变，且 v1 命名空间为该时点
发布的就是这个首个快照的值。

每天的 `index.json` 是派生文件（由快照重建），所以陈旧副本会自我修复。
读取方应以快照文件为准，而不是 index。

## 版本化命名空间 `/v1/`——可锁定的契约

`/v1/` 是冻结的、只增不改的视图。**要锁就锁这些路径，不要锁根路径。**
根路径（`stories.json`、`themes.json`、`tape/…`）会随流水线演进；`/v1`
路径不会。本节的可执行版本是 `tests/golden/v1-contract.test.ts` 与
`lib/v1/contract.ts`。

| 路径 | 产出方 | 结构（必需顶层键） |
|---|---|---|
| `v1/manifest.json` | `npm run v1:bake` | `{schemaVersion,namespace:"v1",generatedAt,timezone,endpoints[],snapshots{},coverage{},license{},deprecation{},guarantees{}}` |
| `v1/asof/<YYYY-MM-DD>.json` | `npm run v1:bake` | `{schemaVersion,namespace,date,timezone,generatedAt,tradingDay,beforeLaunch,expectedSlots[],pendingSlots[],slots[],gaps[],counts{}}` |
| `v1/coverage.json` | `npm run v1:bake` | `{schemaVersion,namespace,generatedAt,timezone,tape{},days[],stories{},horizons[],gaps[],summary{}}` |
| `v1/stories.json` | `stories.json` 的再导出 | `{version,timezone,retentionDays,maxStories,updatedAt,generatedAt,stories[],counts{},firstMover{},revisionTrail{}}` |
| `v1/themes.json` | `themes.json` 的再导出 | `{generatedAt,themes[]}` |
| `v1/reactions.json` | `npm run reactions:bake` 产出后**再导出**，仅当文件存在时 | `{schemaVersion,dataThrough,timezone,counts,observations[],gaps[]}`。烘焙跑过之后才进清单，绝不发空占位文件。`counts.horizons[key] = {ok,pending,gap}` 是权威分类。 |

`v1/asof/<date>.json` 回答的是「那天 11:35 时能看到什么」：`slots[]` 按时点
顺序排列，**每个时点**都自带 `asOf` 与 `observedAt`（内部每个分区、每条记录
同样如此），`captures[]` 列出每一次重采及其 `.rev-N` 文件、以及它改动了哪些
分区。

看数字之前先看 `gaps[]`。每个**已到点**却没有快照的时点都会以稳定代码点名：
`missed`、`future`、`section-unavailable`、`base-missing`，整个输入缺失则为
`input-missing` / `input-unreadable`。交易日绝不静默少给。

以下三类时点**不算缺口**，且都会显式说明，而不是变成一个洞：

- **还没到点**——盘中重建时列在 `pendingSlots[]`，且不计入
  `counts.expectedSlots` 与任何百分比，所以 10:10 重建一个健康早盘是 2/2
  而不是 2/10；
- **非交易日**——`tradingDay: false`、`expectedSlots: 0`、无缺口：
  一个诚实的周末不是十次失败；
- **早于 tape 上线**——`beforeLaunch: true`、`expectedSlots: 0`、无缺口：
  永远补不上的洞不是义务，把它算进去会让此后每个覆盖率数字永久偏低。

`v1/coverage.json` 是同一本缺口账的汇总，外加 tape 自己给不出的两件事：
`stories.firstSeenCoveragePct`（台账中有多少条带 `firstSeenAt`）与
`horizons[]`（有多少条观测已有 `ok` 的 `+1h`/`+1d`/`+5d` 测量、多少条仍在等待，
直接取 `reactions.json` 的 `counts.horizons`，不另行推导）。
在还没有「应到」时点时，`summary.coveragePct` 是 `null`——不是 `0`、也不是
`100`，因为这两个数字都会被读成一个尚未取得的结论。分母永远是「截至本次构建
已经到点的时点数」，绝不是盘中某天的完整日程。

`integrity.html` 把同一份负载渲染给人看。它没有评分、没有绿色对勾：
有缺口的日期绝不会被渲染成成功；tape 完全没有任何一天时，页面用一句话说明
这件事，而不是画一张空表。

### `/v1` 承诺什么

1. **只增不改。** v1 内任何消费方可见的字段都不会被删除或改类型。新字段
   随时可能追加，消费方必须忽略不认识的字段。
2. **破坏性变更以 `/v2/` 发布**；`/v2/` 上线后 `/v1/` 至少继续写入 12 个月，
   且清单里写明继任者。停掉的端点会在停止写入的同一次构建里从清单移除。
3. **每条盘中数据都带两个时钟**，均为带显式偏移的 ISO 8601。
4. **缺口具名**，绝不静默缺失。
5. **只追加存储**：重采写 `rev-N`，不覆盖。
6. **确定性生成**：`/v1` 文件由本地文件生成、不发网络请求，同一棵树重放
   得到同样的字节。
7. **许可**：代码 MIT；数据条款写在 `manifest.license.data`（延时行情、仅供
   阅读、不用于下单、不构成投资建议、不再分发任何第三方授权数据集）。
8. **清单即「哪些是真的」的索引。** 发布使用 `keep_files: true`，它在远端合并
   目录而不是替换，因此一个不再产出的 `v1/asof/…` 文件可能在分支上停留到下一次
   整树发布为止。`manifest.json` 每次运行都会重写，并精确列出现存的端点与日期
   —— 请以清单为准，而不要按路径猜；不在清单里的文件即使还能解析到，也不属于
   契约的一部分。

### `/v1` 明确**不**承诺什么

1. **不做实时推送**——没有 WebSocket、没有 SSE、没有流式。一切都只是构建时
   刷新的静态文件；粒度是采集时点，不是逐笔。
2. **不做 L2 十档或订单簿**——我们不买、不转售、不编造需要授权的盘口数据。
3. **除已发布的修订轨迹外不做更深修订史**——即
   `tape/<date>/revisions.jsonl` 与 `.rev-N.json`。没有更深的编辑史，
   且时点的首个快照文件永不被重写。
4. **不回头修改已归档内容**——已发布的时点不被重写；补发的档期会标注为补发，
   而不是伪装成当日快照。迟到才补上的缺口在 `revisions`/`gaps` 里仍然可见。
5. **不承诺 SLA**——漏采的时点是一个具名缺口，不是一次赔付。不承诺正常运行
   时间、不承诺逐秒快照、不承诺港美市场同等深度、不承诺退市证券全量保留。

本命名空间不改变零 LLM：`/v1` 由本地文件算术生成，就在同一个 build job 内，
其 `LLM_MODE` 固定为 `off`，且跑完由 `scripts/assert-zero-llm.mjs` 断言零调用。
发布延迟断言同样不受影响——`/v1` 既不拖慢也不提前任何一期。

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
5. **在 `/v1/` 内，第 3 条不适用——适用的是「`/v1` 承诺什么」第 1 条。**
   v1 内没有改名/移动的例外通道：必须改变形状的字段只能旁挂新字段，
   旧字段在 v1 存续期间保持原有类型不变。在 v1 内删除字段、改名或改类型
   都是缺陷，`tests/golden/v1-contract.test.ts` 会让构建失败。唯一被允许
   打破 v1 形状的方式是 `/v2/`。
