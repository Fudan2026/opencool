# OpenCool 中文财经三报 · 散户投研

基于 [leiting-eric/DailyBrief](https://github.com/leiting-eric/DailyBrief) 的财经向 Fork。  
**零 AI · 零 API Token** · 定时抓取 + 启发式排序 · A 股/基金观察池 · 散户学堂。

**Live：** https://fudan2026.github.io/opencool/

---

## 每天三报（上海时区）

自 **2026-09-16** 起：

| 时段 | 文件 | 标签 |
|------|------|------|
| 06:00 | `YYYY-MM-DD/06.html` | 早报 |
| 13:00 | `YYYY-MM-DD/13.html` | 午报 |
| 19:00 | `YYYY-MM-DD/19.html` | 晚报 |

未到点或尚未生成的档期会显示**友好占位页**（不再 404）。首页永远指向最新**真实**一期。

```text
REPORT_TZ=Asia/Shanghai
REPORT_HOUR=6,13,19
REPORT_LOCALE=zh
LLM_MODE=off
```

Workflow **强制** `LLM_MODE=off`。

---

## 页面能力

- **中文财经 / 外电 / X 站内镜像**：主阅读流
- **原文 ↔ 中文导读**开关（localStorage）：更长摘录 + 启发式要点，**无机器翻译 / 无 LLM**
- **行情·A股/基金**：Yahoo 无 Key K 线指标 + 迷你走势
- **今日复盘**：东方财富延时指数 + 新闻标题命中观察池
- **技术面读线 / 大师视角 / 风控纪律**：教学向规则面板
- **散户学堂 / 知识库**：静态教程 + 客户端检索
- **开放 MCP**：见 [`mcp/README.md`](mcp/README.md)（仅本地 Agent，Pages 不跑服务）

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
