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
import { fileURLToPath } from "node:url";

const MCP_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Resolve daily_reports whether cwd is mcp/ or the repo root. */
function reportsDir() {
  for (const cand of ["../daily_reports", "daily_reports"]) {
    if (fs.existsSync(cand)) return cand;
  }
  return "../daily_reports";
}
// Embedded fallback only — the live list is mcp/watchlist.json,
// generated from lib/trading/watchlist.ts by `npm run mcp:sync-watchlist`
// (parity is enforced by tests/golden/mcp-parity.test.ts).
const WATCHLIST_FALLBACK = [
  "600519.SS", "300750.SZ", "601318.SS", "600036.SS", "510300.SS", "159915.SZ",
  "000001.SS", "BABA", "0700.HK", "SPY", "BTC-USD",
];

function loadWatchlist() {
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(MCP_DIR, "watchlist.json"), "utf8"),
    );
    if (Array.isArray(j?.entries) && j.entries.length) return j.entries;
  } catch {
    /* fall back to the embedded list */
  }
  return WATCHLIST_FALLBACK.map((symbol) => ({ symbol, displayName: symbol, group: "unknown" }));
}

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

function searchEditions(args) {
  const fp = path.join(reportsDir(), "search-index.json");
  if (!fs.existsSync(fp)) {
    throw new Error(
      "search-index.json not found — run npm run search:bake (after daily)",
    );
  }
  const idx = JSON.parse(fs.readFileSync(fp, "utf8"));
  const q = String(args?.q || "").trim();
  if (!q) throw new Error("q is required");
  const limit = Math.max(1, Math.min(Number(args?.limit) || 10, 50));
  // Tokenizer port of lib/search/tokenize.ts (CJK bigrams + ascii words).
  const STOP = new Set(["the","and","for","with","from","that","this","are","was","were","will","have","has","had","after","over","into","says","said","to","of","in","on","at","by","it","its","is","be","been","am","as","or","an","not","but","new","out","up","down","about","more","than","can","may","how","why","who","what","when","all","also","just","now","get","one","two","first","amid","via","po","com","www","http","https","中国","美国","市场","今日","报道","公司","企业","行业","问题","工作","进行","表示","记者"]);
  const terms = [];
  const seen = new Set();
  for (const w of (q.toLowerCase().match(/[a-z0-9][a-z0-9.+^=-]{2,}/g) || []))
    if (!STOP.has(w) && !seen.has(w)) { seen.add(w); terms.push(w); }
  for (const run of (q.match(/[一-鿿]{2,}/g) || []))
    for (let i = 0; i < run.length - 1; i++) {
      const g = run.slice(i, i + 2);
      if (!seen.has(g)) { seen.add(g); terms.push(g); }
    }
  if (!terms.length) throw new Error("query produced no tokens");
  const lists = terms.map((t) => idx.postings[t] || []).filter((l) => l.length);
  if (!lists.length) return { query: q, count: 0, results: [] };
  const intersect = (a, b) => {
    const o = []; let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { o.push(a[i]); i++; j++; }
      else if (a[i] < b[j]) i++; else j++;
    }
    return o;
  };
  let pool = lists[0];
  for (let i = 1; i < lists.length; i++) pool = intersect(pool, lists[i]);
  if (!pool.length) {
    const score = new Map();
    for (const l of lists) for (const idx2 of l) score.set(idx2, (score.get(idx2) || 0) + 1);
    pool = [...score.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]).map((e) => e[0]).slice(0, limit);
  }
  const results = pool.slice(0, limit).map((idx2) => idx.docs[idx2]);
  return { query: q, count: results.length, results };
}

/** Extremely small JSON-RPC MCP-ish loop over stdin/stdout (tools/list + tools/call). */
const tools = [
  {
    name: "list_watchlist",
    description:
      "List OpenCool watchlist (synced from lib/trading/watchlist.ts): symbols + display names + groups",
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
    name: "themes_query",
    description:
      "Curated theme heat (themes.json): board changePct + article hits + top constituents; optional minHits filter",
    inputSchema: {
      type: "object",
      properties: { minHits: { type: "number" } },
    },
  },
  {
    name: "search_editions",
    description:
      "Full-text search over published editions (search-index.json): q (required), limit <= 50",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string" }, limit: { type: "number" } },
      required: ["q"],
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
  if (name === "list_watchlist") {
    const entries = loadWatchlist();
    return {
      symbols: entries.map((e) => e.symbol),
      details: entries,
      note: "synced from lib/trading/watchlist.ts via npm run mcp:sync-watchlist",
    };
  }
  if (name === "get_quote" || name === "get_kline") {
    return yahooChart(args.symbol || "600519.SS");
  }
  if (name === "market_overview") return marketOverview();
  if (name === "sentiment_query") return sentimentQuery(args);
  if (name === "sentiment_trend") return sentimentTrend(args);
  if (name === "search_editions") return searchEditions(args);
  if (name === "lhb_query") {
    const fp = path.join(reportsDir(), "lhb.json");
    if (!fs.existsSync(fp)) {
      throw new Error("lhb.json not found — run npm run lhb:bake");
    }
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  }
  if (name === "themes_query") {
    const fp = path.join(reportsDir(), "themes.json");
    if (!fs.existsSync(fp)) {
      throw new Error("themes.json not found — run npm run themes:bake");
    }
    const j = JSON.parse(fs.readFileSync(fp, "utf8"));
    const minHits = Number(args?.minHits) || 0;
    return {
      edition: j.edition,
      themes: (j.themes ?? []).filter((t) => t.articleHits >= minHits),
    };
  }
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
