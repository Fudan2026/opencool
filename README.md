# OpenCool 中文财经三报 · 散户投研

基于 [leiting-eric/DailyBrief](https://github.com/leiting-eric/DailyBrief) 的财经向 Fork。  
**零 AI · 零 API Token** · 定时抓取 + 启发式排序 · A 股/基金观察池 · 散户学堂。

**Live：** https://fudan2026.github.io/opencool/

---

## 每天三报（上海时区）

自 **2026-09-16** 起，每天三个**目标档期**：

| 目标档 | 文件 | 标签 |
|------|------|------|
| 06:00 | `YYYY-MM-DD/06.html` | 早报 |
| 13:00 | `YYYY-MM-DD/13.html` | 午报 |
| 19:00 | `YYYY-MM-DD/19.html` | 晚报 |

**档期是目标，不是承诺。** GitHub Actions 的定时触发实测会丢拍，整点发布无法保证，站点因此不承诺钟点，改为逐档公开实测：[数据完整性页](https://fudan2026.github.io/opencool/integrity.html) 用每期侧车的 `fetch_health.generated_at` 对照档期时间，给出近 14 天逐档的「准时（≤20 分钟）/ 迟到 / 提前 / 缺失」实测表。未到点或尚未生成的档期会显示**友好占位页**（不再 404）。首页永远指向最新**真实**一期。

**补发机制（防止整期丢失）**：调度门每 15 分钟触发一次（`4,19,34,49 * * * *`），用 gh-pages 上 `<date>/<slot>.json` 是否存在（只有干净的 HTTP 200 才算存在）来判断档期是否已发布；一旦发现缺失，就**从最旧的缺失档期开始补**，并回看 `REPORT_LOOKBACK_DAYS` 天（默认 1 天），因此跨过零点也不会把前一天的档期永久丢在无人区。补发出来的一期会在页眉标注「补发」——它的正文是补发当刻抓取的，不会假装是当日快照。

**可选推送**：配置 secrets `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`（Telegram 频道）或变量 `NTFY_TOPIC`（ntfy.sh 主题）后，每期发布会自动推送；未配置则为干净 no-op。

```text
REPORT_TZ=Asia/Shanghai
REPORT_HOUR=6,13,19
REPORT_LOOKBACK_DAYS=2   # 门控回看天数：漏发的档期最多补这么久
REPORT_LOCALE=zh
LLM_MODE=auto   # 本地默认：无任何 key 时等同 off；配置免费 ZHIPU_API_KEY 后自动点亮 GLM-4-Flash 导读
```

Workflow 的 build job **固定 `LLM_MODE=off`**：**零 AI · 零 Token 不是"secret 恰好没配"的偶然，而是结构性保证**。build job 不向任何步骤转发 provider key，`lib/ai/llm.ts` 在 off 模式下于派发前抛 `LlmDisabledError`，并且每次跑完都会执行 `scripts/assert-zero-llm.mjs` —— `logs/llm-calls.jsonl` 里只要出现本次运行的一条记录，run 直接失败（文件不存在 = 零调用，属正常通过）。因此往这个仓库的 Actions secrets 里加 LLM key 也不会点亮 enrichment。

**发布时效断言**：build job 推送到 gh-pages 后执行 `scripts/assert-publish-lag.mjs`，以 Asia/Shanghai 计算该档期的实际发布时刻与档期时间之差；超过 `PUBLISH_LAG_LIMIT_MIN`（默认 20 分钟）就让 run 变红并触发 `scripts/notify-failure.mjs` 的告警 webhook。补发（sidecar 标记 `backfilled`，页面标注「补发」）只记录 lag、不判失败——它是恢复，不是破约。

---

## 页面能力

- **中文财经 / 外电 / X 站内镜像**：主阅读流
- **原文 ↔ 中文导读**开关（localStorage）：更长摘录 + 启发式要点，**无机器翻译 / 无 LLM**
- **行情·A股/基金**：Yahoo 无 Key K 线指标 + 迷你走势
- **今日复盘**：东方财富延时指数 + 新闻标题命中观察池
- **市场情绪计**：财经标题词典规则打分（−100~+100 + 驱动词榜单），零 AI、规则全透明，不构成投资建议
- **技术面读线 / 大师视角 / 风控纪律**：教学向规则面板
- **散户学堂 / 知识库**：静态教程 + 客户端检索
- **快读 / 投研双模式**：每页一键切换。快读隐藏进阶面板（技术面读线 / 大师视角 / 风控 / 学堂 / 知识库 / MCP），投研默认全量；localStorage 记忆，无账号、无后端。
- **徒步路线收藏**：`trails.html` 星标收藏（本机 localStorage，无账号）
- **开放 MCP**：见 [`mcp/README.md`](mcp/README.md)（仅本地 Agent，Pages 不跑服务）
- **姐妹项目 SuPro**：`/supro.html` 是「看新闻 → 练实操」的出口 —— OpenCool 负责看懂市场（三报 / 题材 / 情绪计），[SuPro（supro.si）](https://supro.si/) 负责上手演练（择时 / 信号 / 纸盘复盘）。每期简报底部与首页浮标都带 UTM 深链。
- **Sister project SuPro**: `/supro.html` is the "read → practice" exit — OpenCool informs (briefs, themes, sentiment), [SuPro](https://supro.si/) lets you practice (timing, signals, paper trading). Every edition footer and the homepage floating badge carry UTM-tagged deep links.

---

## Data products (for consumers)

| Path | Content |
|---|---|
| `/<date>/<HH>.json` | Edition sidecar — briefs, sentiment, morning brief, fetch health |
| `/sentiment-history.json` | Rolling 60-edition sentiment series |
| `/keywords.json` | 7-day keyword frequency (stopword-cleaned) |
| `/weekly.json` + `/weekly.html` | 7-day review (curve, sectors, events) |
| `/feed.xml` | RSS 2.0, newest 30 real editions |
| `/status.html` | Publish matrix + source health |
| `/llms.txt` | Agent-discoverable index |

Full reference: [`docs/DATA-CONTRACT.md`](docs/DATA-CONTRACT.md) ·
中文版：[`docs/DATA-CONTRACT.zh-CN.md`](docs/DATA-CONTRACT.zh-CN.md) ·
定位：[`docs/data-source-strategy.md`](docs/data-source-strategy.md)（数据源战略：比历史完整性，不比延迟）

---

## 编辑定调头条（Wave 14）

`data/lead.json` 允许编辑为某日指定头条：`date`（必填）、`groundOn`（必须出现在当日信源标题中的锚点词）、`title`（定调标题）、`url/source`（信源署名）。铁律：**锚点词在当日信源中查无实据时，定调被拒绝，头条保持启发式结果**——零虚构。见 `data/lead.json` 的真实示例（2026-11-13：黄仁勋辞职，信源 DW 中文）。

---

## 用户订阅（前端地基）

`subscribe.html` 提供邮箱与订阅档位输入。当前**只把订阅意向保存到本机 localStorage，不发送邮件、不上传服务器**；支持导出意向 JSON。未来后端就绪时，通过 `SUBSCRIBE_ENDPOINT` 显式配置提交地址即可接入，无需改页面。现在也可以直接用 [`feed.xml`](feed.xml) 的 RSS 订阅。

---

## 用户自定义题材（Wave 12）

在仓库根目录放 `themes.custom.json`（见 `themes.custom.example.json`）即可扩展题材库：新键追加，同键覆盖内置定义；文件缺失时完全使用内置目录。也可用 `THEMES_EXTRA_FILE=/path/to/custom.json` 指定路径。字段 `key`、`name`、`aliases`、`boardHints` 均必填，非法结构会在烘焙时直接报错而不是静默降级。

```json
[{"key":"stablecoin","name":"稳定币","aliases":["稳定币","USDT"],"boardHints":["稳定币"]}]
```

`boardHints` 按名称匹配东方财富概念板块（不是硬编码 BK 码），自定义题材会自动获得板块热度与成分股。

---

## Docker 一键分发

```bash
docker pull ghcr.io/fudan2026/opencool:latest
mkdir -p daily_reports logs
docker run -d --name opencool -v "$PWD/daily_reports:/app/daily_reports" -v "$PWD/logs:/app/logs" ghcr.io/fudan2026/opencool:latest
```

也支持 `docker compose up -d --build`。镜像由 `.github/workflows/docker.yml` 自动构建并发布 GHCR（amd64/arm64）。完整环境变量与操作说明见 [`docs/DOCKER.md`](docs/DOCKER.md)。

---

## 本地跑一期

```bash
npm ci
LLM_MODE=off REPORT_TZ=Asia/Shanghai EDITION_HOUR=13 npm run daily
npm run build-site
open daily_reports/index.html
```

---

## 明确不做

- DeepSeek / 任何付费 LLM、付费行情
- 用户体系 / 云自选 / 自动下单 / 同花顺实盘
- 看线宝商业对接、完整海量研报库

License：MIT。
