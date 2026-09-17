# OpenCool MCP（本地）

面向 Cursor / Claude Desktop 的最小投研工具面。**不在 GitHub Pages 上运行**。

## 工具

| Tool | 说明 |
|------|------|
| `list_watchlist` | 默认观察池符号 |
| `get_quote` | Yahoo 行情 + 近期收盘 |
| `get_kline` | 日线收盘序列（约 3 个月） |
| `market_overview` | 东方财富延时指数快照 |

零付费 API Key。数据有延迟，仅供研究，不构成投资建议。

## 启动

```bash
cd mcp
npm start
```

## Cursor 接入示例

在 MCP 配置中：

```json
{
  "mcpServers": {
    "opencool": {
      "command": "node",
      "args": ["/ABS/PATH/TO/opencool/mcp/server.mjs"]
    }
  }
}
```

蒸馏思路来自公开 A 股 MCP / 东方财富免费接口社区项目；本实现刻意保持极简、无 AI Prompt 栈。
