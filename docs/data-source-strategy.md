# 数据源战略 · Data Source Strategy

> 定位文件。竞品蒸馏 + 时点（point-in-time）重定位 + 我们愿意签的契约 + 我们承认的缺口。
> Positioning document: competitive distill, the point-in-time reframe, the contract we
> commit to, and the gaps we admit.
>
> 写作规则：每一条断言都带来源 URL；无法用一手来源坐实的综合判断标注 **LOW-CONFIDENCE**。
> 价格无法核实时写「未公布价格 / price not published」，绝不估算。
> 本文只描述**已建成**或计划文件中显式规划的能力，规划项一律标注 `planned`。
> （约定沿用 [`COMPETITIVE-ANALYSIS.md`](./COMPETITIVE-ANALYSIS.md)。）
>
> 核验日期 / verified: 2026-11-13 · 仓库基线 / repo baseline: `51e7944`

---

# 中文版

## 0. 一句话

**OpenCool 不比延迟。OpenCool 比的是「历史不可篡改」。**

我们不打算赢下毫秒竞赛——那是付费厂商的战场。我们打算把一件本来就稀缺、而且零售市场几乎买不到的东西做扎实：
**带双时钟的、只追加的、可被第三方复核的时点快照历史**。

## 1. 重定位：延迟不是我们的赛道

### 1.1 延迟是付费厂商的战场

低延迟已经是商品化能力，价格公开可查：

- **Massive（原 Polygon.io，`polygon.io` 现 301 跳转到 `massive.com`）** 的 Stocks Advanced 套餐 **$199/月** 提供实时行情、20+ 年历史与 WebSocket；
  Stocks Basic 是 **$0/月**，但只有 **5 次/分钟**、**2 年**、**仅日终（End of Day）**，且无 WebSocket。
  来源：<https://massive.com/pricing>
- **Databento** 把 L2 `MBP-10` 与 L3 `MBO` 作为套餐区分项卖：Plus **$1,750/月**（年约），Unlimited **$4,500/月**（年约，含 16+ 年全 schema）。
  来源：<https://databento.com/pricing>
- **Tushare Pro** 把「实时分钟」单列为 **1000 元/月** 的独立权限，历史分钟另收 **2000 元**。
  来源：<https://tushare.pro/document/2?doc_id=290>

一个静态站点在这些维度上按构造必输：我们没有常驻进程、没有 WebSocket、没有交易所授权。**承认这一点，然后换赛道。**

### 1.2 稀缺的是「当时能看到什么」

行业把这件事叫 point-in-time / vintage 数据：

- **FRED vs ALFRED**：ALFRED 回答的是「历史上某一天能知道什么」，FRED 回答的是「今天知道的、关于过去的最准确版本」；两者 URL 相同，仅通过 `realtime_start` / `realtime_end` 参数区分。
  来源：<https://fred.stlouisfed.org/docs/api/fred/fred_vs_alfred.html>
- **时点数据必须有两个时间**：*effective time*（数值所描述的期间）与 *availability time*（该数值何时可被公开知晓）；一条记录对某个 `as_of` 可见，当且仅当 `availability_time ≤ as_of`。
  来源：<https://tradepolaris.com/research/point-in-time-data-and-survivorship-bias>
- **没有 availability time 的回测是在测自己管道的 bug**：Plug Power FY2018 摊薄每股亏损最初申报为 **$-0.36**（2019 年 3 月），2021 年 5 月重述为 **$-0.39**；用后者回测 2019 年，等于提前两年用了未来信息。即使最快的大型申报人，从财年末到 10-K 也要 **25–49 天**。
  来源：<https://developer.stockfit.io/blog/point-in-time-data-backtesting>

这正是我们能提供、而零售几乎买不到的东西：**不是「最新」，是「当时」。**

### 1.3 两个时钟是我们全部价值的技术支点

我们承诺的每个快照记录都带：

| 字段 | 含义 | 为什么不可省 |
|---|---|---|
| `asOf` | 该数值**描述的**市场时刻（例如 11:35 的板块涨跌幅） | 没有它，你无法判断这条数据属于哪个交易时点 |
| `observedAt` | 我们**实际抓到**它的时刻 | 没有它，你无法判断这条数据在当时是否已知 |

缺 `asOf`，文件无法用于研究；缺 `observedAt`，文件退化成「今天的看法套上昨天的日期」——正是上节所说的 look-ahead。
概念来源同上（FRED/ALFRED、TradePolaris、StockFit）。

> **诚实边界 / honest boundary**：双时钟 **tape 的机制已上线**（`lib/tape/` + `scripts/bake-tape.ts`，`/v1/asof/<date>.json` 发布），
> 但**数据还是零天**：第一个诚实快照预计在 2026-11-16 09:35（上海时间）写入，此前不可回溯编造。
> 报告正文仍是**每天 3 期**快照，其 `asOf` 只以「抓取时刻」的近似形式散落在 sidecar 的 `fetch_health.generated_at` 与 `quant.market.fetchedAt` 里。
> 所以：**时点资产是已建成机制的、尚未积累历史的。** 机制本身按 `built` 读（§4），历史积累按时间增长（§5 缺口表第 1 项）。

## 2. 竞品对照

列含义：**刷新节奏** / **历史深度** / **是否时点（point-in-time）** / **价格** / **授权姿态**。
「未公布价格」= 公开页面查不到，不是「免费」。

| 产品 | 刷新节奏 | 历史深度 | 时点？ | 价格 | 授权姿态 |
|---|---|---|---|---|---|
| **OpenCool**（我们） | 每日 3 期（06/13/19 上海时区），由 15 分钟一次的调度门驱动：<https://github.com/Fudan2026/opencool/blob/main/.github/workflows/daily.yml> | 站点归档 **60 个带日期目录**，2026-09-15 → 2026-11-13（自 `archive.html` 实测） | **部分**：sidecar 带 `fetch_health.generated_at` 抓取时刻；无独立 `asOf`、无修订轨迹 → hourly tape 为 `planned` | **免费**，无账号、无 token | **MIT**：<https://raw.githubusercontent.com/Fudan2026/opencool/main/LICENSE>；公开可再分发（含 `access-control-allow-origin: *`，实测 <https://fudan2026.github.io/opencool/llms.txt>） |
| **SuPro**（`supro.si`，本项目姊妹站） | 「零 LLM 烘焙行情」的**每日**烘焙：`/signals/` 明示 "from the daily bake" <https://supro.si/signals/> | 自报纸面战绩窗口 63 个交易日（2026-08-03 → 2026-11-05）：<https://supro.si/performance/> | 公开站点未见 as-of / vintage 查询；**LOW-CONFIDENCE**（未在其 sitemap 全部 49 个页面中找到时点声明：<https://supro.si/sitemap.xml>） | **未公布价格**（`/pricing` 返回通用落地页壳，无价目） | 条款页 `/terms/` 返回通用壳，**未公布授权条款** → **LOW-CONFIDENCE** |
| **RavenPack News Analytics** | 实时 + 全历史（Premium 源含 Dow Jones、WSJ、Barron's、MT Newswires、Benzinga）<https://www.ravenpack.com/products/news-analytics> | 自 2003 年起；40,000+ 源、13 种语言、1,200 万实体、7,000+ 事件主题；提供 relevance / novelty / impact 打分 | 提供事件时间等 temporal 字段，但**公开页面未承诺 as-of 查询** → **LOW-CONFIDENCE** | **未公布价格**（`ravenpack.com/pricing` 返回 404，核验于 2026-11-13） | 商业授权；网站条款禁止未经书面同意复制/再分发站点内容：<https://www.ravenpack.com/terms> |
| **Bigdata.com**（RavenPack 旗下，agent 形态） | 按 token 消费实时检索（"Billing ... per token consumed"）<https://www.bigdata.com/pricing> | 300+ Premium 源、35+ 语言、10 亿+ 文档、25+ 年档案 <https://www.bigdata.com/data-catalog> | 付费档列有 "Point-in-time financials and fundamentals"（Pro 档）<https://www.bigdata.com/pricing> | **Pro $40/月**（原价 $50）、**Max $160/月**（原价 $200）、Starter **$0** 含 $10 一次性额度 <https://www.bigdata.com/pricing> | **与我们正相反**：Grounding Right 明令禁止 "store, cache, retain, or archive the underlying Bigdata Content itself beyond the moment of Consumption"，禁止再分发，禁止用于训练，且要求 Zero Data Retention：<https://bigdata.com/terms-and-conditions> |
| **Massive（Polygon.io）** | 实时 WebSocket（Advanced 起）；Basic 仅日终 | Basic **2 年**；Advanced **20+ 年** <https://massive.com/pricing> | 参考数据支持 `date` 参数取「该日有效的 ticker 信息」<https://massive.com/docs/rest/stocks/tickers/ticker-overview>；财务数据标称 "point-in-time snapshots"，但 `filing_date` 明确注明「不一定是该期原始申报日」，重述会共享同一 filing_date <https://massive.com/docs/rest/stocks/fundamentals/balance-sheets> → **部分时点** | Basic **$0**（5 次/分钟）；Advanced **$199/月**；Financials & Ratios **$29/月** <https://massive.com/pricing> | 面向个人（"Individual use only"），非转售授权 <https://massive.com/pricing> |
| **Finnhub** | 实时报价 `/quote`（官方注明「不建议持续轮询，需要实时请用 WebSocket」） | 公开文档页未给出历史深度上限 → **LOW-CONFIDENCE** | 文档中未见 as-of 查询入口 → **LOW-CONFIDENCE** | 页面内嵌套餐价：marketdata-basic **$49.99**、marketdata-eod **$49.99**、marketdata-standard **$129.99**、marketdata-professional **$199.99**、all-1 **$3500**（读自 <https://finnhub.io/pricing> 自身内嵌数据）；免费档具体限额未能在服务端渲染中核实 → **LOW-CONFIDENCE** | 全站限速在套餐之上另有 **30 次/秒** 硬顶；大量端点为 "Premium Access Required" <https://finnhub.io/docs/api> |
| **Tiingo** | 日终为主，IEX 实时作为加值档 | 价格历史 **30+ 年**；基本面 5 年（Starter）/ 15+ 年（Power） | 未见 as-of 入口 → **LOW-CONFIDENCE** | Starter **$0/月**（50 次/小时、1000 次/天、500 标的/月）；Power **$30/月** <https://www.tiingo.com/pricing> | **"Internal Use Only"**：不得展示或分享给他人/其他组织；News API 仅 3 个月可查询历史 <https://www.tiingo.com/pricing> |
| **Databento** | 实时 + 历史，按 $/GB 计量或订阅 | **16+ 年**（45+ 交易所、65 万+ 标的）；L2 / L3 仅高档含全历史 | **不适用**：只卖行情/盘口记录（OHLCV、Trades、BBO、MBP-10、MBO），不是新闻/基本面 vintage 源 <https://databento.com/pricing> | 按量计费；Plus **$1,750/月**、Unlimited **$4,500/月**（年约）；注册赠 $125 额度 <https://databento.com/pricing> | 历史数据一般可分发，但外部再分发/白标需 Plus 或 Unlimited 且受交易所授权约束 <https://databento.com/pricing> |
| **东方财富公开接口** | 准实时（延时接口）/ 盘中轮询 | 依赖具体报表接口，无统一保证 | **否**：接口返回「当前值」，无 availability time | **免费**（无公开 SLA，无公开授权） | 无公开授权文本；工程上按「公开可读但不可依赖」处理——我们从单台 VM 实测：`push2.eastmoney.com/api/qt/clist/get` 在 2026-11-13 连续三次返回 **502**，`ulist.np/get` 同轮为 502/502/302，而 `datacenter-web` 的板块注册表稳定返回 200（1,081 个板块） |
| **Tushare Pro** | 日线/基础数据按积分；实时与高频单列权限 | 历史分钟自 **2009 年**；公告 **10 年以上**；新闻 **3 年以上** <https://tushare.pro/document/2?doc_id=290> | **否**：按接口售卖「最新/历史值」，无 as-of 语义 | **实时分钟 1000 元/月**；历史分钟 **2000 元**；公告 **1000 元**；新闻资讯 **1000 元**；实时日线 **200 元/月**；积分年费 200/500/1000/1500 元；机构价为个人 **10 倍**，且「不支持退款」<https://tushare.pro/document/2?doc_id=290> | 个人/机构分级授权；购买后转入阿里云充值、不退款 <https://tushare.pro/document/2?doc_id=290> |
| **AKShare** | 实时从第三方站点抓取（本地运行） | 跟随上游站点，无承诺 | **否** | **免费**，**MIT** <https://github.com/akfamily/akshare> | 文档自陈：数据来自公开源，「仅用于学术研究」，使用需注意「商业风险」；且接口会因目标站点改版而失效、需频繁升级 <https://akshare.akfamily.xyz/introduction.html> |
| **聚宽 JoinQuant** | — | — | — | **未公布价格** | **未能核验**：`joinquant.com` 对非中国大陆 IP 返回「当前地区暂不支持访问」，故本行全部字段 **LOW-CONFIDENCE** <https://joinquant.com/data/dataservice/price2> |

### 2.1 从表里读出的四件事

1. **延迟是价格战，不是护城河。** $0 到 $4,500/月 的差别买的是毫秒、深度和授权；我们在这个轴上永远排最后，所以不排。
2. **时点能力普遍是「部分」而非「完整」。** 连卖到 $199/月的行情商，其基本面接口也只做到「有 filing_date、但重述共享同一 filing_date」——原始申报日还要另查 SEC 索引（<https://massive.com/docs/rest/stocks/fundamentals/balance-sheets>）。完整 vintage 是稀缺品。
3. **「禁止缓存」是主流条款，不是例外。** Bigdata.com 明文禁止留存底层内容（<https://bigdata.com/terms-and-conditions>），Tiingo 限定 Internal Use Only（<https://www.tiingo.com/pricing>）。**只追加地留存，是我们与它们的结构性差异。**
4. **免费不等于可用。** AKShare 免费但抓第三方、随时失效（<https://akshare.akfamily.xyz/introduction.html>）；东财公开接口免费但无授权、无 SLA，且我们实测连续三次 502。**「能用一次」和「能当数据源」是两件事。**

## 3. 我们永久不做的事

以下是**永久约束**，不是「以后再说」。写在这里是为了让未来的自己无法悄悄改口。

1. **不做实时推送 / 流式**。没有 WebSocket、没有 SSE、没有常驻进程。GitHub Pages 只发静态文件；我们的发布通道是「构建 → 推分支 → 页面可见」，天然分钟级。**这是设计，不是缺陷。**
2. **不做 L2 十档 / 订单簿**。那是交易所授权 + 付费订阅的世界（Databento 把 MBP-10/MBO 放在 $1,750–4,500/月 档位，<https://databento.com/pricing>）。我们不买、不转售、不伪造。
3. **不做付费数据转售**。我们不把任何第三方授权数据打包卖出。仓库是 MIT（<https://raw.githubusercontent.com/Fudan2026/opencool/main/LICENSE>）。
4. **不做账号体系**。没有注册、没有登录、没有云自选。所有个性化都留在浏览器 localStorage。
5. **不做 LLM**。构建 job 固定 `LLM_MODE=off`，构建期不转发任何 provider key，且跑完用 `scripts/assert-zero-llm.mjs` 断言零调用——不是「恰好没配 key」，是结构性保证（<https://github.com/Fudan2026/opencool/blob/main/.github/workflows/daily.yml>）。
6. **不做个性化推荐**。同一时刻，所有人看到同一份页面。这是可复核性的前提：一份会因人而异的报告，无法被第三方当作证据。

> 与 GitHub Pages 的容量上限相安：站点 ≤ 1 GB、软带宽 100 GB/月、10 次构建/小时（用自定义 Actions 工作流时不受此限）。
> 来源：<https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits>

## 4. 我们愿意签的契约

分两栏：**已建成（built）** 与 **规划中（planned）**。不把 planned 说成 built——这是本文件的第一条纪律。

| 条款 | 状态 | 证据 / 出处 |
|---|---|---|
| **`/v1` 命名空间**：`/v1/manifest.json`、`/v1/asof/<YYYY-MM-DD>.json`、`/v1/stories.json`、`/v1/themes.json`、`/v1/coverage.json`（`/v1/reactions.json` 待反应库烘焙上线后自动纳入） | **built** | `npm run v1:bake` 在 build job 内、发布前生成；`scripts/assert-v1.mjs` 断言清单里没有「有路径无文件」的端点。执行版契约 `lib/v1/contract.ts` + `tests/golden/v1-contract.test.ts`。2026-11-13 之前实测 404，现已上线 |
| **只增不改（additive-only）**：新增可选字段永远安全；移动/重命名字段必须同时改 golden 测试、在本契约留版本注记、并在 `llms.txt` 给弃用窗口 | **built（策略层）** | [`DATA-CONTRACT.md`](./DATA-CONTRACT.md) 的 *Change policy* 第 1–3 条；执行者为 `tests/golden/sidecar-schema.test.ts` |
| **弃用窗口**：破坏性变更前先公告并保留过渡期 | **built（策略层，未版本化）**；`/v1` 命名空间内的机器可读弃用声明为 **planned** | `DATA-CONTRACT.md` 第 3 条要求「在 `llms.txt` 给弃用窗口」；`/v1/manifest.json` 承载版本与弃用策略属 planned |
| **MIT 许可，含商用与再分发** | **built** | <https://raw.githubusercontent.com/Fudan2026/opencool/main/LICENSE>；GitHub API 元数据 `license.spdx_id = MIT` |
| **跨域可读**：任何浏览器、任何 agent 都能直接取，无需 key | **built** | 实测 `llms.txt` 响应头含 `access-control-allow-origin: *` 与 `etag`（<https://fudan2026.github.io/opencool/llms.txt>） |
| **全站 Asia/Shanghai**：日期键、档期、页面时间一律上海时区 | **built（生产环境）** | 生产 workflow 固定 `REPORT_TZ: Asia/Shanghai`（<https://github.com/Fudan2026/opencool/blob/main/.github/workflows/daily.yml>）；代码侧不硬编码时区，`lib/utils.ts` 由 `REPORT_TZ` 决定（[`AGENTS.md`](../AGENTS.md) 核心不变式 3） |
| **缺口公开而非隐藏**：每期 sidecar 带 `fetch_health.entries[]`（每源耗时/成功/条数/错误），站点有 `status.html` 发布矩阵与源健康 | **built** | [`DATA-CONTRACT.md`](./DATA-CONTRACT.md) 的 `fetch_health.entries[]`；实测 <https://fudan2026.github.io/opencool/status.html> 200 |
| **逐快照覆盖率与缺口清单**：`/v1/coverage.json` + `/integrity.html` 点名每一天的缺口、修订次数、首次观测覆盖率与待测反应窗口 | **built** | 同一次 `npm run v1:bake` 产出；无 tape 数据时页面用一句话说明「采集尚未开始」，不画空表、不报百分比（`summary.coveragePct: null`）。页面无评分、无绿色对勾 |
| **不回头改已发布的一期** | **built（流程层）** | 调度门以「gh-pages 上 `<date>/<HH>.json` 是否为干净 HTTP 200」判定档期已发布，已发布即跳过（`scripts/gate.mjs`）；补发页眉标注「补发」，不假装是当日快照（[`README.md`](../README.md)） |

**我们明确不承诺**（因为还没建，且不打算用承诺掩盖）：SLA、正常运行时间保证、逐笔成交、逐秒快照、跨市场（港/美）同等深度、基本面修订史、退市证券全量保留。见下节。

## 5. 诚实的缺口表

「距离」一栏写的是**要补什么工程**，不是日历时间。

| # | 今天没有的东西 | 现状证据 | 距离（要补什么） |
|---|---|---|---|
| 1 | **小时级盘中历史（hourly tape）的深度** | 机制已上线（`lib/tape/` + `scripts/bake-tape.ts`，每交易日 10 个时点写 `<HHMM>.json`，双时钟 `asOf`+`observedAt`，重跑写 `.rev-N.json` 不覆盖）；但**已采集天数为 0**，首个快照预计 2026-11-16 09:35 | 只剩时间这一项：**积累速度受限于上线时刻，无法回溯造假**。`/v1/coverage.json` 与 `/integrity.html` 逐日点名缺口与修订次数，不虚报覆盖率 |
| 2 | **基本面修订史（revision history）** | 本站无任何财务报表明细接口；`/v1/asof` 未上线 | 需先建 vintage store（增量 2），再接入带申报日的源并保留原始申报与重述两份记录——参考做法：「保留两个值，各自标记携带它的申报文件」<https://developer.stockfit.io/blog/point-in-time-data-backtesting>。**当前零进度** |
| 3 | **退市证券保留** | 观察池为 **32 个标的 / 7 个资产组**（`lib/trading/watchlist.ts`），全部为在售标的；无退市名录 | 需引入含 `active=false` 的证券主数据（如 Massive 的 All Tickers：<https://massive.com/docs/rest/stocks/tickers/ticker-overview>）并自建历史成分快照。**这是幸存者偏差的根，也是最贵的一项** |
| 4 | **超出已积累范围的盘中历史** | 无 tape；`sentiment-history.json` 实测仅 **48 条**、2026-10-27 → 2026-11-13（上限 60） | 只能靠**时间**积累；不可回填。可回填的只有上游源本身保留的历史（如 Tushare 历史分钟，2000 元一次性，<https://tushare.pro/document/2?doc_id=290>）——但那不是我们的 availability time，仍不能算 vintage |
| 5 | **信源之外的跨市场覆盖** | 26 个 `enabled` 源（其中 15 个带 `en` locale），按 `sources.config.json` 实测；行情仅上证/深成/创业板三指数 + 观察池 | 指数覆盖受东财延时接口约束（实测 `push2` 连续 502、`push2delay` 返回 200）；扩到港股/美股需逐源验证可用性与授权，且与「不做付费数据」冲突 |
| 6 | **故事修订史与「谁最先报道」** | 现有 `lib/topics/dedupe.ts` 做聚类，但没有持久化的 `firstSeenAt` / 头条修订轨迹 | 规划增量 3：`lib/stories/` + `scripts/bake-stories.ts`，给每个聚类稳定 id 与 sighting 序列 |
| 7 | **新闻→价格反应库（+1h/+1d/+5d）** | 不存在 | 规划增量 4：`scripts/bake-reactions.ts`，纯算术、零 LLM、最小样本门槛后才发布 |
| 8 | **归档的密码学不可篡改性** | 发布用 `keep_files: false` 并从 gh-pages 恢复旧目录再整树重推；内容靠流程保证（档期已发布即跳过），不是哈希链 | 若要「可证明未被改」，需对每期产物出哈希并公开链式清单（SuPro 的治理页用「哈希上链」描述同类做法：<https://supro.si/governance/>）。**当前未做，不应宣称** |

## 6. 我们赌的那件事

三句话：

1. **延迟买不到忠诚，历史买得到信任。** 行情商按毫秒收费（$199/月 到 $4,500/月），但没人替零售保存「当时能看到什么」。
2. **只要两个时钟齐全，时间就是我们的复利。** 每多跑一天 tape，就多一天别人无法凭空造出的历史；这条曲线只能用时间换，不能用钱买。
3. **只追加 + 公开缺口 = 可被第三方复核。** 这与主流条款正相反（Bigdata.com 禁止留存、Tiingo 限定内部使用），也正是我们唯一能长期持有的差异。

## 7. 来源与核验方式

- 全部 URL 于 **2026-11-13** 用 `curl`（浏览器 UA）实取，记录 HTTP 状态。
- 关键页面正文被抽取为纯文本后逐条比对，非凭记忆引用。
- 站点内事实取自仓库与线上产物：`sources.config.json`（26 个 `enabled`）、`lib/trading/watchlist.ts`（33 标的）、`archive.html`（60 个日期目录）、`sentiment-history.json`（48 条）、`llms.txt` 响应头。
- 单点实测的接口可用性（东财 502）只代表**单台海外 VM、单日**的观测，已按此措辞标注，不外推为「永久不可用」。
- 无法核实的项已就地标 **LOW-CONFIDENCE** 或「未公布价格」，未做任何数字估算。

---

# English

## 0. One sentence

**OpenCool does not compete on latency. OpenCool competes on history you cannot rewrite.**

We are not going to win a millisecond race — that is the paid vendors' battlefield. We are going to make one scarce thing solid:
**an append-only, dual-clock, third-party-auditable history of point-in-time snapshots.**

## 1. The reframe: latency is not our lane

### 1.1 Latency is a priced commodity

- **Massive (formerly Polygon.io; `polygon.io` now 301-redirects to `massive.com`)** sells a Stocks Advanced plan at **$199/month** with real-time data, 20+ years of history and WebSockets.
  Stocks Basic is **$0/month** but capped at **5 API calls/minute**, **2 years**, **End of Day only**, no WebSocket.
  Source: <https://massive.com/pricing>
- **Databento** gates L2 `MBP-10` and L3 `MBO` by plan: Plus **$1,750/month** (annual), Unlimited **$4,500/month** (annual, 16+ years across all schemas).
  Source: <https://databento.com/pricing>
- **Tushare Pro** sells real-time minute bars as a separate **¥1,000/month** permission, with historical minute data a separate **¥2,000** purchase.
  Source: <https://tushare.pro/document/2?doc_id=290>

A static site loses this contest by construction: no long-running process, no WebSocket, no exchange licence. **Admit it, then change lanes.**

### 1.2 What is scarce is "what was knowable then"

The industry calls it point-in-time or vintage data:

- **FRED vs ALFRED**: ALFRED answers "what was known on some past date"; FRED answers "the most accurate information about the past available today". Same URLs, different `realtime_start` / `realtime_end`.
  Source: <https://fred.stlouisfed.org/docs/api/fred/fred_vs_alfred.html>
- **Point-in-time requires two times**: *effective time* (the period the value describes) and *availability time* (when it became publicly knowable). A row is visible at an `as_of` if and only if `availability_time ≤ as_of`.
  Source: <https://tradepolaris.com/research/point-in-time-data-and-survivorship-bias>
- **Without availability time, a backtest measures your pipeline's bugs**: Plug Power's FY2018 diluted loss was filed as **$-0.36** (March 2019) and restated to **$-0.39** only in May 2021 — using the restated figure in a 2019 backtest leaks two years of hindsight. Even the fastest large filers take **25 to 49 days** from fiscal year-end to 10-K.
  Source: <https://developer.stockfit.io/blog/point-in-time-data-backtesting>

That is what we can supply and retail can barely buy: **not "latest", but "then".**

### 1.3 Two clocks are the whole technical premise

| Field | Meaning | Why it cannot be dropped |
|---|---|---|
| `asOf` | the market instant the value **describes** | without it you cannot tell which trading moment a row belongs to |
| `observedAt` | the instant we **fetched** it | without it you cannot tell whether the value was knowable at the time |

Drop `asOf` and the file is unusable for research. Drop `observedAt` and it degenerates into "today's view wearing yesterday's date" — exactly the look-ahead described above.

> **Honest boundary**: the dual-clock **tape mechanism has shipped** (`lib/tape/` + `scripts/bake-tape.ts`, published at `/v1/asof/<date>.json`),
> but there is **zero data in it**: the first honest snapshot is expected at 2026-11-16 09:35 Shanghai and cannot be backdated.
> The digest itself is still **3 editions per day**, and its `asOf` exists only as an approximation via `fetch_health.generated_at` and `quant.market.fetchedAt` in the sidecar.
> So: the point-in-time asset is **built but empty** — the mechanism is `built` (§4), the history accumulates with time (§5, gap row 1).

## 2. Comparison

Columns: **refresh cadence** / **history depth** / **point-in-time?** / **price** / **licensing posture**.
"Price not published" means the public page does not state it — it does not mean free.

| Product | Cadence | Depth | Point-in-time? | Price | Licensing |
|---|---|---|---|---|---|
| **OpenCool** (us) | 3 editions/day (06/13/19 Shanghai) driven by a 15-minute gate: <https://github.com/Fudan2026/opencool/blob/main/.github/workflows/daily.yml> | **60 dated directories**, 2026-09-15 → 2026-11-13 (measured from `archive.html`) | **Partial**: sidecars carry `fetch_health.generated_at`; no separate `asOf`, no revision trail → hourly tape is `planned` | **Free**, no account, no token | **MIT**: <https://raw.githubusercontent.com/Fudan2026/opencool/main/LICENSE>; CORS-open, measured `access-control-allow-origin: *` on <https://fudan2026.github.io/opencool/llms.txt> |
| **SuPro** (`supro.si`, sister project) | **Daily** LLM-free bakes; `/signals/` states "from the daily bake" <https://supro.si/signals/> | Self-reported paper record over 63 sessions (2026-08-03 → 2026-11-05) <https://supro.si/performance/> | No as-of / vintage query found; **LOW-CONFIDENCE** (no point-in-time claim across all 49 sitemap pages: <https://supro.si/sitemap.xml>) | **Price not published** (`/pricing` serves the generic shell) | Terms page serves the generic shell; **licence not published** → **LOW-CONFIDENCE** |
| **RavenPack News Analytics** | Real-time plus full history (Dow Jones, WSJ, Barron's, MT Newswires, Benzinga) <https://www.ravenpack.com/products/news-analytics> | Since 2003; 40,000+ sources, 13 languages, 12M entities, 7,000+ event topics; relevance, novelty and impact scoring | Temporal event dates are provided, but no public as-of query guarantee → **LOW-CONFIDENCE** | **Price not published** (`ravenpack.com/pricing` returns 404, checked 2026-11-13) | Commercial; site terms forbid copying/redistributing site content without written consent: <https://www.ravenpack.com/terms> |
| **Bigdata.com** (RavenPack, agent-shaped) | Token-metered live retrieval ("per token consumed") <https://www.bigdata.com/pricing> | 300+ premium sources, 35+ languages, 1B+ documents, 25+ year archive <https://www.bigdata.com/data-catalog> | Paid tier lists "Point-in-time financials and fundamentals" (Pro) <https://www.bigdata.com/pricing> | **Pro $40/mo** (list $50), **Max $160/mo** (list $200), Starter **$0** with $10 one-time credits <https://www.bigdata.com/pricing> | **The exact opposite of us**: the Grounding Right forbids storing, caching, retaining or archiving the underlying content "beyond the moment of Consumption", forbids redistribution, forbids training, and requires Zero Data Retention: <https://bigdata.com/terms-and-conditions> |
| **Massive (Polygon.io)** | Real-time WebSocket from Advanced; Basic is end-of-day only | Basic **2 years**; Advanced **20+ years** <https://massive.com/pricing> | Reference data takes a `date` param for "the ticker available on that date" <https://massive.com/docs/rest/stocks/tickers/ticker-overview>; fundamentals are called "point-in-time snapshots" but `filing_date` explicitly "is not necessarily the date this period was originally filed" and restatements share it <https://massive.com/docs/rest/stocks/fundamentals/balance-sheets> → **partial** | Basic **$0** (5 calls/min); Advanced **$199/mo**; Financials & Ratios **$29/mo** <https://massive.com/pricing> | "Individual use only" on listed plans <https://massive.com/pricing> |
| **Finnhub** | Real-time `/quote` (docs advise against constant polling; use the WebSocket for real-time) | No documented history cap on the public docs page → **LOW-CONFIDENCE** | No as-of query documented → **LOW-CONFIDENCE** | Plan prices read from the page's own embedded payload: marketdata-basic **$49.99**, marketdata-eod **$49.99**, marketdata-standard **$129.99**, marketdata-professional **$199.99**, all-1 **$3500** (<https://finnhub.io/pricing>); free-tier limits could not be verified server-side → **LOW-CONFIDENCE** | Hard **30 calls/second** ceiling across all plans; many endpoints marked "Premium Access Required" <https://finnhub.io/docs/api> |
| **Tiingo** | Mostly end-of-day; IEX feed as an add-on | Price history **30+ years**; fundamentals 5 years (Starter) / 15+ years (Power) | No as-of query found → **LOW-CONFIDENCE** | Starter **$0/mo** (50 req/hour, 1000/day, 500 symbols/month); Power **$30/mo** <https://www.tiingo.com/pricing> | **"Internal Use Only"** — may not display or share with another person or organisation; News API keeps only 3 months queryable <https://www.tiingo.com/pricing> |
| **Databento** | Real-time and historical, metered at $/GB or subscription | **16+ years**, 45+ exchanges, 650,000+ symbols; L2/L3 full history only on higher tiers | **Not applicable** — price/book records only (OHLCV, Trades, BBO, MBP-10, MBO), not a news or fundamentals vintage source <https://databento.com/pricing> | Usage-based; Plus **$1,750/mo**, Unlimited **$4,500/mo** (annual); $125 signup credits <https://databento.com/pricing> | Historical data generally distributable, but external redistribution and white-labelling require Plus/Unlimited plus venue licences <https://databento.com/pricing> |
| **Eastmoney public APIs** | Near-real-time (delayed host) / intraday polling | Per-endpoint; no uniform guarantee | **No** — endpoints return "the current value", with no availability time | **Free** (no published SLA, no published licence) | No public licence text; treat as "publicly readable but not dependable". Measured 2026-11-13 from one VM: `push2.eastmoney.com/api/qt/clist/get` returned **502** on three consecutive attempts, `ulist.np/get` gave 502/502/302 across the same rounds, while the `datacenter-web` board registry returned 200 with 1,081 boards |
| **Tushare Pro** | Daily/basic via credit tiers; real-time and high-frequency sold separately | Minute history from **2009**; announcements **10+ years**; news **3+ years** <https://tushare.pro/document/2?doc_id=290> | **No** — sells latest/historical values per endpoint, no as-of semantics | **Real-time minute ¥1,000/mo**; historical minute **¥2,000**; announcements **¥1,000**; news **¥1,000**; real-time daily **¥200/mo**; credit tiers ¥200/500/1000/1500 per year; institutional pricing is **10×** individual; explicitly **no refunds** <https://tushare.pro/document/2?doc_id=290> | Tiered individual/institutional; prepaid into Alibaba Cloud credits, non-refundable <https://tushare.pro/document/2?doc_id=290> |
| **AKShare** | Scrapes third-party sites live, locally | Follows upstream sites, no guarantee | **No** | **Free**, **MIT** <https://github.com/akfamily/akshare> | Docs state the data comes from public sources, is "for academic research only", and users must accept "commercial risk"; interfaces break when target sites change and require frequent library upgrades <https://akshare.akfamily.xyz/introduction.html> |
| **JoinQuant (聚宽)** | — | — | — | **Price not published** | **Could not verify**: `joinquant.com` returns "Service Unavailable in Your Region" for non-mainland-China IPs, so every field in this row is **LOW-CONFIDENCE** <https://joinquant.com/data/dataservice/price2> |

### 2.1 Four readings from that table

1. **Latency is a price war, not a moat.** The $0-to-$4,500/month spread buys milliseconds, depth and rights. We finish last on that axis, so we do not enter it.
2. **Point-in-time is mostly "partial" even at $199/month.** Massive's fundamentals ship a `filing_date` that is explicitly not the original filing date, with restatements sharing it; the original date requires a separate SEC index lookup (<https://massive.com/docs/rest/stocks/fundamentals/balance-sheets>). Complete vintage is scarce.
3. **"Do not cache" is the norm, not the exception.** Bigdata.com forbids retaining the underlying content (<https://bigdata.com/terms-and-conditions>); Tiingo restricts to internal use (<https://www.tiingo.com/pricing>). **Append-only retention is our structural difference.**
4. **Free is not the same as usable.** AKShare is free but scrapes third parties and breaks (<https://akshare.akfamily.xyz/introduction.html>); Eastmoney is free but unlicensed, un-SLA'd, and measured returning 502 on three consecutive attempts here. **"Works once" and "works as a data source" are different claims.**

## 3. What we permanently refuse

Permanent constraints, not deferrals. Written down so a future version of us cannot quietly renegotiate.

1. **No real-time push or streaming.** No WebSocket, no SSE, no long-running process. GitHub Pages serves static files; our publish path is build → push branch → page visible, inherently minute-scale. **That is design, not a defect.**
2. **No L2 depth or order book.** That is exchange licensing plus paid subscriptions (Databento prices MBP-10/MBO at $1,750–$4,500/month, <https://databento.com/pricing>). We do not buy it, resell it, or fake it.
3. **No paid data resale.** We do not package and sell any third-party licensed data. The repo is MIT (<https://raw.githubusercontent.com/Fudan2026/opencool/main/LICENSE>).
4. **No accounts.** No signup, no login, no cloud watchlists. All personalisation stays in browser localStorage.
5. **No LLM.** The build job pins `LLM_MODE=off`, forwards no provider key, and asserts zero calls with `scripts/assert-zero-llm.mjs` after the build — structural, not "the secret happened to be missing" (<https://github.com/Fudan2026/opencool/blob/main/.github/workflows/daily.yml>).
6. **No personalisation.** At any instant everyone sees the same page. That is a precondition for auditability: a report that varies per reader cannot be used as evidence by a third party.

> Fits inside GitHub Pages limits: sites ≤ 1 GB, soft bandwidth 100 GB/month, 10 builds/hour (not applicable when publishing with a custom Actions workflow).
> Source: <https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits>

## 4. The contract we commit to

Two columns: **built** and **planned**. Never claim planned is built — that is rule one of this document.

| Term | Status | Evidence |
|---|---|---|
| **`/v1` namespace**: `/v1/manifest.json`, `/v1/asof/<YYYY-MM-DD>.json`, `/v1/stories.json`, `/v1/themes.json`, `/v1/coverage.json` (`/v1/reactions.json` joins automatically once the reaction bake ships) | **built** | `npm run v1:bake` runs inside the build job before publish; `scripts/assert-v1.mjs` rejects a manifest that advertises an endpoint with no file behind it. Executable contract: `lib/v1/contract.ts` + `tests/golden/v1-contract.test.ts`. Measured 404 before 2026-11-13; now live |
| **Additive-only**: new optional fields always safe; moving/renaming a field requires a golden-test update, a version note in this contract, and a deprecation window in `llms.txt` | **built (policy level)** | [`DATA-CONTRACT.md`](./DATA-CONTRACT.md) *Change policy* items 1–3, enforced by `tests/golden/sidecar-schema.test.ts` |
| **Deprecation window**: announce breaking changes and keep a transition period | **built (policy, unversioned)**; machine-readable deprecation inside `/v1` is **planned** | `DATA-CONTRACT.md` item 3 requires "a deprecation window in `llms.txt`"; `/v1/manifest.json` carrying versions and deprecation policy is planned |
| **MIT, commercial use and redistribution allowed** | **built** | <https://raw.githubusercontent.com/Fudan2026/opencool/main/LICENSE>; GitHub API metadata `license.spdx_id = MIT` |
| **CORS-open**: any browser, any agent, no key | **built** | Measured `access-control-allow-origin: *` and `etag` on <https://fudan2026.github.io/opencool/llms.txt> |
| **Asia/Shanghai everywhere**: date keys, slots and page times | **built (production)** | Workflow pins `REPORT_TZ: Asia/Shanghai` (<https://github.com/Fudan2026/opencool/blob/main/.github/workflows/daily.yml>); code never hardcodes a zone — `lib/utils.ts` reads `REPORT_TZ` ([`AGENTS.md`](../AGENTS.md) invariant 3) |
| **Gaps published, not hidden**: every sidecar carries `fetch_health.entries[]` (per-source ms/ok/count/error); `status.html` shows the publish matrix and source health | **built** | [`DATA-CONTRACT.md`](./DATA-CONTRACT.md) `fetch_health.entries[]`; measured <https://fudan2026.github.io/opencool/status.html> → 200 |
| **Per-snapshot coverage and gap ledger**: `/v1/coverage.json` + `/integrity.html` naming every gap, revision count, first-seen coverage and pending reaction horizons | **built** | Produced by the same `npm run v1:bake`; with no tape data the page says "capture has not started" in a sentence instead of drawing an empty table, and reports no percentage (`summary.coveragePct: null`). No score, no green checkmarks |
| **No retroactive edits to a published edition** | **built (process level)** | The gate treats a clean HTTP 200 `<date>/<HH>.json` on gh-pages as published and skips it (`scripts/gate.mjs`); a backfilled edition is labelled 补发 and does not pretend to be a same-day snapshot ([`README.md`](../README.md)) |

**What we explicitly do not promise** (and will not paper over with a commitment): an SLA, uptime guarantees, tick data, per-second snapshots, HK/US coverage at equal depth, fundamentals revision history, or full delisted-security retention. See below.

## 5. Honest gap table

The "distance" column names the engineering still required, not calendar time.

| # | Missing today | Evidence of absence | Distance to close |
|---|---|---|---|
| 1 | **Depth of the hourly intraday history** | Mechanism has shipped (`lib/tape/` + `scripts/bake-tape.ts`: ten slots per trading day, dual `asOf`+`observedAt`, re-runs writing `.rev-N.json` rather than overwriting) but **zero days captured**; first snapshot expected 2026-11-16 09:35 | Only time is missing. **Accumulation starts at launch — it cannot be backdated.** `/v1/coverage.json` and `/integrity.html` name every gap and revision count per day rather than quoting a flattering coverage number |
| 2 | **Fundamentals revision history** | No financial-statement endpoints at all; `/v1/asof` not live | Needs the vintage store first (increment 2), then a source carrying filing dates, keeping both original and restated values — "keep both values, each tagged with the filing that carried it" <https://developer.stockfit.io/blog/point-in-time-data-backtesting>. **Zero progress today** |
| 3 | **Delisted securities** | Watchlist is **32 tickers / 7 asset groups** (`lib/trading/watchlist.ts`), all currently listed; no delisted roster | Needs a security master with `active=false` support (e.g. Massive All Tickers: <https://massive.com/docs/rest/stocks/tickers/ticker-overview>) plus our own historical membership snapshots. **The root of survivorship bias, and the most expensive item** |
| 4 | **Intraday history beyond what capture accumulated** | No tape; `sentiment-history.json` measured at **48 items**, 2026-10-27 → 2026-11-13 (cap 60) | Only **time** buys this; it cannot be backfilled. Upstream history can be bought (Tushare historical minutes, ¥2,000 one-off, <https://tushare.pro/document/2?doc_id=290>) but it carries the vendor's availability time, not ours — not vintage |
| 5 | **Cross-market coverage beyond our sources** | 26 `enabled` sources (15 with an `en` locale) from `sources.config.json`; quotes limited to SSE/SZSE/ChiNext plus the watchlist | Index coverage is bound to delayed Eastmoney hosts (measured: `push2` 502 three times in a row, `push2delay` 200). Adding HK/US requires per-source availability and licence checks, and collides with "no paid data" |
| 6 | **Story revision history and first-mover ranking** | `lib/topics/dedupe.ts` clusters stories, but nothing persists `firstSeenAt` or headline revisions | Plan increment 3: `lib/stories/` + `scripts/bake-stories.ts` with stable ids and a sighting sequence |
| 7 | **News-to-price reaction library (+1h/+1d/+5d)** | Does not exist | Plan increment 4: `scripts/bake-reactions.ts` — pure arithmetic, zero LLM, published only after a minimum sample |
| 8 | **Cryptographic immutability of the archive** | Publishing uses `keep_files: false` and restores prior directories from gh-pages before re-pushing the whole tree; integrity rests on process (published slots are skipped), not on a hash chain | Proving non-modification needs per-edition hashes plus a published chain (SuPro describes its audit ledger as hash-chained: <https://supro.si/governance/>). **Not done; must not be claimed** |

## 6. The bet

Three lines:

1. **Latency does not buy loyalty; history buys trust.** Vendors charge by the millisecond ($199 to $4,500 per month) but nobody keeps "what was knowable then" for retail.
2. **With both clocks present, time compounds in our favour.** Every extra day of tape is a day of history nobody else can conjure. That curve is bought with time, not money.
3. **Append-only plus published gaps equals third-party auditable.** That is the inverse of the market's standard terms (Bigdata.com forbids retention, Tiingo limits to internal use) and the only difference we can hold long term.

## 7. Sources and verification method

- Every URL was fetched on **2026-11-13** with `curl` using a browser UA, recording the HTTP status.
- Key pages were converted to plain text and compared line by line; nothing is cited from memory.
- In-repo facts come from the repo and the live artefacts: `sources.config.json` (26 `enabled`), `lib/trading/watchlist.ts` (32 tickers), `archive.html` (60 dated directories), `sentiment-history.json` (48 items), and the `llms.txt` response headers.
- Single-VM availability observations (Eastmoney 502) describe **one overseas VM on one day** and are worded as such — not extrapolated to "permanently down".
- Anything unverifiable is marked **LOW-CONFIDENCE** or "price not published" in place; no number was estimated.
