#!/usr/bin/env node
/**
 * Minimal OpenCool MCP server (stdio) — local agents only.
 * Tools wrap Yahoo chart + Eastmoney index snapshot + sentiment data
 * products (daily_reports sidecars). Zero paid API keys.
 *
 * Usage:
 *   cd mcp && npm start
 */
import fs from "node:fs";
import path from "node:path";

/** Resolve daily_reports whether cwd is mcp/ or the repo root. */
function reportsDir() {
  for (const cand of ["../daily_reports", "daily_reports"]) {
    if (fs.existsSync(cand)) return cand;
  }
  return "../daily_reports";
}
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

function sentimentQuery(args) {
  const dir = reportsDir();
  if (args?.date && args?.hour) {
    const fp = path.join(dir, args.date, `${args.hour}.json`);
    const r = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!r?.sentiment) throw new Error(`no sentiment in ${args.date}/${args.hour}`);
    return { date: args.date, hour: args.hour, sentiment: r.sentiment };
  }
  // newest edition with sentiment
  const days = fs
    .readdirSync(dir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse();
  for (const d of days) {
    const files = fs
      .readdirSync(path.join(dir, d))
      .filter((f) => /^\d{2}\.json$/.test(f))
      .sort()
      .reverse();
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, d, f), "utf8"));
        if (r?.sentiment?.score != null) {
          return { date: d, hour: f.replace(/\.json$/, ""), sentiment: r.sentiment };
        }
      } catch {
        /* skip */
      }
    }
  }
  throw new Error("no sentiment sidecar found — run npm run daily first");
}

function sentimentTrend(args) {
  const fp = path.join(reportsDir(), "sentiment-history.json");
  if (!fs.existsSync(fp)) {
    throw new Error(
      "sentiment-history.json not found — run npm run build-site (after daily)",
    );
  }
  const hist = JSON.parse(fs.readFileSync(fp, "utf8"));
  const limit = Math.max(1, Math.min(Number(args?.limit) || 30, 60));
  return {
    count: hist.count,
    cap: hist.cap,
    items: (hist.items ?? []).slice(-limit),
    note: "chronological, newest last; percentile null until 20 samples",
  };
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
  {
    name: "sentiment_query",
    description:
      "Zero-AI dictionary sentiment of the newest (or a given date+hour) edition: score/label/sectors/percentile",
    inputSchema: {
      type: "object",
      properties: { date: { type: "string" }, hour: { type: "string" } },
    },
  },
  {
    name: "sentiment_trend",
    description:
      "Rolling sentiment history (sentiment-history.json, newest last); optional limit <= 60",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
  },
];

async function handleTool(name, args) {
  if (name === "list_watchlist") return { symbols: WATCHLIST };
  if (name === "get_quote" || name === "get_kline") {
    return yahooChart(args.symbol || "600519.SS");
  }
  if (name === "market_overview") return marketOverview();
  if (name === "sentiment_query") return sentimentQuery(args);
  if (name === "sentiment_trend") return sentimentTrend(args);
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
