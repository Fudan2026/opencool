# OpenCool 财经早报

基于 [leiting-eric/DailyBrief](https://github.com/leiting-eric/DailyBrief) 的财经向 Fork，并蒸馏了 FinNewsCollectionBot / china-finance-rss / nosey-agent / DailyHotApi 等项目的做法。

**目标**：每天早上打开一个链接，看到中国与全球大事——**财经优先**、多源交叉、**不做个性化推荐**。

上游演示：https://leiting-eric.github.io/DailyBrief/

---

## 5 分钟上线（无 API Key 也可）

1. 把本仓库推到你的 GitHub（或 `gh repo create` / Fork 后 rename 为 `opencool`）。
2. **Settings → Actions → General** → Workflow permissions = **Read and write**；允许 Actions。
3. **Settings → Pages** → Source = **Deploy from a branch** → `gh-pages` / `/ (root)`（第一次 workflow 跑完才有该分支）。
4. （可选）**Settings → Secrets and variables → Actions → Variables**：
   - `REPORT_TZ=Asia/Shanghai`
   - `REPORT_HOUR=7`
   - `REPORT_LOCALE=zh`
5. **不要**先配 LLM Key 也行：无 Key 时自动 `LLM_MODE=off`。
6. **Actions → Daily Brief → Run workflow** 手动跑一次。

成功后打开：

```text
https://<你的用户名>.github.io/<仓库名>/
```

之后默认每天北京时间约 **07:00** 自动更新（Actions cron 偶发漏跑时有 catchup）。

---

## 无 Key vs 有 Key

| 模式 | 条件 | 行为 | 成本 |
|------|------|------|------|
| **试用（默认）** | 未配置任何 LLM Secret | `LLM_MODE=off`：抓取 + Jaccard 去重 + 多源交叉排序 + 行情指标 | ≈ $0（仅 Actions 分钟） |
| **升级摘要** | 配置 `DEEPSEEK_API_KEY`（或其它） | 自动 `LLM_MODE=on`：中文摘要 + 交易点评 | DeepSeek 约 $0.01–0.02/天 |

**不是复利**：每天独立跑一次；历史报告是静态 HTML，不会反复烧 token。

### 升级 DeepSeek（推荐）

1. Secrets 增加 `DEEPSEEK_API_KEY`
2. Variables 可选：`LLM_BACKEND=deepseek`（workflow 默认已是 deepseek）
3. 再跑一次 workflow 即可

也可用 Anthropic / OpenAI / MiniMax / 智谱——对照上游 README 的 secret / `LLM_BACKEND` 对照表。

本地试用：

```bash
cp .env.example .env.local
# 编辑：LLM_MODE=off
npm ci
LLM_MODE=off REPORT_TZ=Asia/Shanghai npm run daily
npm run build-site
open daily_reports/index.html
```

---

## 信源（财经向）

**国际财经**：Bloomberg / WSJ / FT / BBC Business / Economist / CNBC / Yahoo Finance  

**中文财经**：华尔街见闻、财联社电报、金十、东方财富、人民网财经、FT 中文网（经公开 RSS / RSSHub；单源失败不阻断）  

**时政**：BBC / Guardian / NYT / NPR / DW 中文 / Al Jazeera / The Diplomat  

**社交热榜（标题旁路，热度≠事实）**：抖音 / 微博 / 知乎 / 百度 —— 经 [DailyHotApi](https://github.com/imsyy/DailyHotApi) 公开 JSON，不爬正文、不登录  

小红书正文爬取本步不做。科技社区类信源默认关闭，可在 [`sources.config.json`](sources.config.json) 把 `enabled` 改回 `true`。

---

## 蒸馏说明

| 来源 | 用了什么 |
|------|----------|
| DailyBrief | 全管道、Pages、行情面板、双语骨架 |
| FinNewsCollectionBot / china-finance-rss | 中文财经源清单 |
| nosey-agent / Daily-Intelligence-System | 无 LLM 时的去重与交叉打分 |
| DailyHotApi | 社交热榜 JSON |

上游 remote 建议保留：

```bash
git remote add upstream https://github.com/leiting-eric/DailyBrief.git
git fetch upstream
```

---

## 本步明确不做

- VIP / 付费墙（日后可把仓库改 private，再加鉴权）
- 小红书 / 抖音正文抓取
- 与量化下单通道打通

License：继承上游 MIT。
