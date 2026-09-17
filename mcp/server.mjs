#!/usr/bin/env node
/**
 * Minimal OpenCool MCP server (stdio) — local agents only.
 * Tools wrap Yahoo chart + Eastmoney index snapshot. Zero paid API keys.
 *
 * Usage:
 *   cd mcp && npm start
 */
const WATCHLIST = [
  "600519.SS", "300750.SZ", "601318.SS", "600036.SS", "510300.SS", "159915.SZ",
  "000001.SS", "BABA", "0700.HK", "SPY", "BTC-USD",
];

async function yahooChart(symbol, range = "3mo") {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "OpenCool-MCP/1.0", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`yahoo HTTP ${res.status}`);
  const data = await res.json();
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error("no chart result");
  const meta = r.meta || {};
  const closes = (r.indicators?.quote?.[0]?.close || []).filter((x) => x != null);
  return {
    symbol: meta.symbol || symbol,
    price: meta.regularMarketPrice,
    currency: meta.currency,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
    closes: closes.slice(-90),
  };
}

async function marketOverview() {
  const secids = ["1.000001", "0.399001", "0.399006"];
  const out = [];
  for (const secid of secids) {
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f57,f58,f43,f170`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "OpenCool-MCP/1.0", Referer: "https://quote.eastmoney.com/" },
      });
      if (!res.ok) continue;
      const j = await res.json();
      const d = j?.data;
      if (!d) continue;
      out.push({
        code: String(d.f57),
        name: d.f58,
        price: d.f43 / 100,
        changePct: (d.f170 || 0) / 100,
      });
    } catch {
      /* skip */
    }
  }
  return { indices: out, note: "delayed free snapshot" };
}

/** Extremely small JSON-RPC MCP-ish loop over stdin/stdout (tools/list + tools/call). */
const tools = [
  {
    name: "list_watchlist",
    description: "List OpenCool default A-share / ETF / macro symbols",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_quote",
    description: "Yahoo quote + recent closes for a symbol (e.g. 600519.SS)",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
  },
  {
    name: "get_kline",
    description: "Daily closes spark array (Yahoo 3mo)",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
  },
  {
    name: "market_overview",
    description: "Eastmoney delayed A-share major indices",
    inputSchema: { type: "object", properties: {} },
  },
];

async function handleTool(name, args) {
  if (name === "list_watchlist") return { symbols: WATCHLIST };
  if (name === "get_quote" || name === "get_kline") {
    return yahooChart(args.symbol || "600519.SS");
  }
  if (name === "market_overview") return marketOverview();
  throw new Error(`unknown tool ${name}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = msg;
    const reply = (result) => {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
    };
    const fail = (message) => {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n",
      );
    };
    try {
      if (method === "initialize") {
        reply({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "opencool-mcp", version: "0.1.0" },
        });
      } else if (method === "tools/list") {
        reply({ tools });
      } else if (method === "tools/call") {
        const name = params?.name;
        const args = params?.arguments || {};
        const data = await handleTool(name, args);
        reply({
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        });
      } else if (method === "notifications/initialized" || method === "ping") {
        if (id != null) reply({});
      } else {
        fail(`unsupported method ${method}`);
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }
});

console.error("[opencool-mcp] ready on stdio");
