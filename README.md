# OpenCool 中文财经两报

基于 [leiting-eric/DailyBrief](https://github.com/leiting-eric/DailyBrief) 的财经向 Fork。  
**零 AI · 零 API Token** · 定时抓取 + 启发式排序 · 中文财经主栏优先。

**Live：** https://fudan2026.github.io/opencool/

---

## 每天两报（上海时区）

自 **2026-09-16** 起规范为：

| 时段 | 文件 | 标签 |
|------|------|------|
| 06:00 | `YYYY-MM-DD/06.html` | 早报 |
| 19:00 | `YYYY-MM-DD/19.html` | 晚报 |

（已取消 13:00 午报。）首页 `index.html` 永远指向**最新一期**；[归档](https://fudan2026.github.io/opencool/archive.html)按日列出。

GitHub Actions Variables（推荐）：

```text
REPORT_TZ=Asia/Shanghai
REPORT_HOUR=6,19
REPORT_LOCALE=zh
LLM_MODE=off
```

Workflow **强制** `LLM_MODE=off`，即使仓库里有 API Key 也不会调用。不接 DeepSeek / 任何付费 LLM / 付费新闻 API。

---

## 信息架构（华人可读，不靠翻译模型）

1. **中文财经**（默认首栏）— 见闻 / 财联社 / 金十 / 东财 / 财新 / 一财 / 格隆汇 / 雪球 / 36氪 等 `lang:zh`
2. **X 市场声音** — AttentionVC 公开 leaderboard **站内镜像**（免翻墙浏览标题与摘要；链接仍指向 x.com）
3. **外电原文** — Bloomberg / WSJ / FT / Economist 等，标明英文原文
4. **时政** — DW 中文优先 + 精简国际；热榜仅保留财经相关标题

娱乐 / 游戏 / 综艺：热榜白名单 + 标题黑名单双层硬屏蔽；无命中则空栏，不灌娱乐。

---

## 本地跑一期

```bash
npm ci
LLM_MODE=off REPORT_TZ=Asia/Shanghai EDITION_HOUR=19 npm run daily
npm run build-site
open daily_reports/index.html
```

`EDITION_HOUR` 设为 `6` 或 `19`。不设则按当前上海时间落入最近 slot。

---

## 蒸馏来源（只用源清单与过滤，不引入 AI 推送栈）

- DailyBrief 多源调度 / 失败非致命 / Pages 归档
- TrendRadar / NewsHub / NewsNow：华尔街见闻 · 财联社 · 金十 · 雪球 · 格隆汇 · 法布 · 36氪
- FinNewsCollectionBot / china-finance-rss 公开 RSSHub 端点
- DailyHotApi 社交热榜 + 财经关键词门
- nosey 式启发式交叉去重排序

---

## 明确不做

- DeepSeek / 任何付费 LLM、付费新闻 API
- 用户体系 / VIP
- 13 点午报
- 娱乐游戏进主 feed
- 反复浏览器验收

License：MIT（继承上游）。
