# OpenCool 财经三报

基于 [leiting-eric/DailyBrief](https://github.com/leiting-eric/DailyBrief) 的财经向 Fork。  
启发式摘要 · **不调用 LLM（零 token）** · 每天三期可回看。

**Live：** https://fudan2026.github.io/opencool/

---

## 每天三报（上海时区）

| 时段 | 文件 | 标签 |
|------|------|------|
| 06:00 | `YYYY-MM-DD/06.html` | 早报 |
| 13:00 | `YYYY-MM-DD/13.html` | 午报 |
| 19:00 | `YYYY-MM-DD/19.html` | 晚报 |

首页 `index.html` 永远指向**最新一期**。归档页按日列出三报。

GitHub Actions Variables（已推荐）：

```text
REPORT_TZ=Asia/Shanghai
REPORT_HOUR=6,13,19
REPORT_LOCALE=zh
LLM_MODE=off
```

Workflow **强制** `LLM_MODE=off`，即使仓库里有 API Key 也不会调用。DeepSeek 等付费摘要本轮不开；以后若要开，再改 workflow。

---

## 本地跑一期

```bash
npm ci
LLM_MODE=off REPORT_TZ=Asia/Shanghai EDITION_HOUR=19 npm run daily
npm run build-site
open daily_reports/index.html
```

`EDITION_HOUR` 可设为 `6` / `13` / `19`。不设则按当前上海时间落入最近 slot。

---

## 信源

- **国际财经**：Bloomberg / WSJ / FT / Economist / BBC Business / CNBC / MarketWatch …
- **中文财经**：财联社、金十、华尔街见闻、东方财富、人民网财经、财新、第一财经、FT 中文网 …
- **时政精简**：BBC / Guardian / NYT 等
- **社交热榜**：微博 / 抖音 / 知乎 / 百度 —— 仅保留**财经相关**标题（娱乐过滤）

单源失败不阻断整报。

---

## 蒸馏来源

DailyBrief 管道 · FinNewsCollectionBot / china-finance-rss 源清单 · DailyHotApi 热榜 · nosey 式启发式去重。

---

## 明确不做（本轮）

- DeepSeek / 任何付费 LLM
- 回填 2026-09-15 之前的报告
- VIP / 小红书正文爬取
- 冷黑「机构终端」皮肤

License：MIT（继承上游）。
