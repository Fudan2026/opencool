/**
 * Bake weekly.html + weekly.json — 7-day review page (sentiment curve,
 * sector averages, top events, hot keywords). Pure arithmetic over the
 * restored sidecar tree; zero LLM. Idempotent: requires >= 5 days of
 * data, otherwise skips (leaving any previous page intact).
 * Runs under tsx (build-trails precedent).
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";

import { aggregateKeywords, cleanKeywords } from "../lib/nlp/keywords";

const ROOT = "daily_reports";
const OUT_HTML = path.join(ROOT, "weekly.html");
const OUT_JSON = path.join(ROOT, "weekly.json");
const WINDOW_DAYS = 7;
const MIN_DAYS = 5;
const SLOTS = ["06", "13", "19"];
const SECTOR_LABELS: Record<string, string> = {
  "china-ashare": "A 股蓝筹",
  "china-etf": "ETF",
  "china-equity": "中概港股",
  "us-equity": "美股",
  crypto: "加密",
  "commodity-fx": "商品汇率",
  macro: "宏观指数",
  general: "大盘综合",
};

function esc(x: string): string {
  return x
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface EditionRow {
  date: string;
  hour: string;
  score: number | null;
  sectors: Array<{ key: string; score: number }>;
  events: Array<{ symbol: string; displayName: string; title: string; url: string }>;
  keywords?: string[];
  indices?: Array<{ name: string; changePct: number }>;
}

function main() {
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const rows: EditionRow[] = [];
  const days = fs
    .readdirSync(ROOT)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= cutoff)
    .sort();
  for (const d of days) {
    for (const h of SLOTS) {
      const fp = path.join(ROOT, d, `${h}.json`);
      if (!fs.existsSync(fp)) continue;
      try {
        const r = JSON.parse(fs.readFileSync(fp, "utf8"));
        rows.push({
          date: d,
          hour: h,
          score: r?.sentiment?.score ?? null,
          sectors: (r?.sentiment?.sectors ?? []).map(
            (x: { key: string; score: number }) => ({ key: x.key, score: x.score }),
          ),
          events: (r?.quant?.events ?? []).map(
            (e: { symbol: string; displayName: string; title: string; url: string }) => ({
              symbol: e.symbol,
              displayName: e.displayName,
              title: e.title,
              url: e.url,
            }),
          ),
          keywords: r?.keywords,
          indices: r?.quant?.market?.indices,
        });
      } catch {
        // unreadable — skip
      }
    }
  }

  const daysCovered = new Set(rows.map((r) => r.date)).size;
  if (daysCovered < MIN_DAYS) {
    console.log(
      `[weekly:bake] only ${daysCovered} days in window (< ${MIN_DAYS}) — skip, previous weekly.html kept`,
    );
    return;
  }

  const scores = rows.filter((r) => r.score != null).map((r) => r.score as number);
  const avgSentiment = scores.length
    ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
    : null;

  const sectorAcc = new Map<string, number[]>();
  for (const r of rows) {
    for (const s of r.sectors) {
      sectorAcc.set(s.key, [...(sectorAcc.get(s.key) ?? []), s.score]);
    }
  }
  const sectorAvg = [...sectorAcc.entries()]
    .map(([key, arr]) => ({
      key,
      label: SECTOR_LABELS[key] ?? key,
      avg: Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10,
      editions: arr.length,
    }))
    .sort((a, b) => Math.abs(b.avg) - Math.abs(a.avg));

  const evAcc = new Map<string, { symbol: string; displayName: string; title: string; url: string; count: number }>();
  for (const r of rows) {
    for (const e of r.events) {
      const key = `${e.symbol}::${e.url}`;
      const cur = evAcc.get(key);
      if (cur) cur.count++;
      else evAcc.set(key, { ...e, count: 1 });
    }
  }
  const topEvents = [...evAcc.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const kwAgg = aggregateKeywords(
    rows.map((r) => ({ date: r.date, hour: r.hour, keywords: r.keywords })),
    WINDOW_DAYS,
  );

  const indexAvg = new Map<string, { name: string; avg: number; n: number }>();
  for (const r of rows) {
    for (const i of r.indices ?? []) {
      const cur = indexAvg.get(i.name) ?? { name: i.name, avg: 0, n: 0 };
      cur.avg += i.changePct;
      cur.n++;
      indexAvg.set(i.name, cur);
    }
  }
  const indexRows = [...indexAvg.values()].map((v) => ({
    name: v.name,
    avgChangePct: Math.round((v.avg / v.n) * 100) / 100,
    editions: v.n,
  }));

  const payload = {
    generatedAt: new Date().toISOString(),
    source: "build-weekly",
    windowDays: WINDOW_DAYS,
    daysCovered,
    editions: rows.length,
    avgSentiment,
    sentimentCurve: rows.flatMap((r) =>
      r.score == null ? [] : [{ date: r.date, hour: r.hour, score: r.score }],
    ),
    sectorAvg,
    topEvents,
    keywords: kwAgg.items.slice(0, 20),
    indexRows,
    note: "零 AI · 纯算术周报 · 不构成投资建议",
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2) + "\n", "utf8");

  const w = 640;
  const hgt = 90;
  const curve: Array<{ date: string; hour: string; score: number }> =
    payload.sentimentCurve;
  if (curve.length === 0) {
    console.log("[weekly:bake] no sentiment data — skip page, JSON only");
    return;
  }
  const min = Math.min(...curve.map((c) => c.score), -20);
  const max = Math.max(...curve.map((c) => c.score), 20);
  const span = Math.max(1, max - min);
  const pts = curve
    .map((c, i) => {
      const x = curve.length > 1 ? (i / (curve.length - 1)) * (w - 8) + 4 : w / 2;
      const y = hgt - 8 - ((c.score - min) / span) * (hgt - 16);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const stroke = curve.length && curve[curve.length - 1].score >= curve[0].score ? "#15803d" : "#b91c1c";

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCool · 周报</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Noto+Sans+SC:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg:#fff8f0; --fg:#1a1510; --muted:#7a6a5a; --accent:#e85d04; --card:#fff; --rule:#f0e0d0; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; font-family:"Noto Sans SC","DM Sans",system-ui,sans-serif;
    background: radial-gradient(ellipse 80% 50% at 10% -10%, #ffe8cc 0%, transparent 55%),
      radial-gradient(ellipse 60% 40% at 100% 0%, #ffd6e7 0%, transparent 50%), var(--bg);
    color:var(--fg); line-height:1.6; }
  main { max-width:760px; margin:0 auto; padding:3rem 1.5rem 4rem; }
  .brand { font-family:"DM Sans",sans-serif; font-weight:700; font-size:.85rem; letter-spacing:.12em;
    text-transform:uppercase; color:var(--accent); }
  h1 { font-size:2rem; margin:.4rem 0 .3rem; letter-spacing:-.03em; }
  h2 { font-size:1.05rem; margin:2rem 0 .7rem; }
  .meta { color:var(--muted); }
  .card { background:var(--card); border:1px solid var(--rule); border-radius:.75rem; padding:.85rem 1rem; margin:.6rem 0; }
  .chips { display:flex; gap:.4rem; flex-wrap:wrap; }
  .chip { padding:.3rem .7rem; border:1px solid var(--rule); border-radius:999px; font-size:.85rem; background:var(--card); }
  .pos { color:#15803d; } .neg { color:#b91c1c; }
  table { border-collapse:collapse; width:100%; background:var(--card); border-radius:.75rem; overflow:hidden; }
  th, td { text-align:left; padding:.5rem .8rem; border-bottom:1px solid var(--rule); font-size:.85rem; }
  th { color:var(--muted); font-weight:600; }
  a { color:var(--accent); text-decoration:none; }
  ul { margin:.3rem 0; padding-left:1.2rem; }
</style>
</head>
<body>
<main>
  <div class="brand">OpenCool</div>
  <h1>周报</h1>
  <p class="meta">${payload.daysCovered} 天 · ${payload.editions} 档 · 平均情绪 <b class="${(avgSentiment ?? 0) >= 0 ? "pos" : "neg"}">${avgSentiment ?? "—"}</b> · ${esc(payload.note)}</p>

  <h2>情绪曲线（近 ${curve.length} 档）</h2>
  <div class="card"><svg viewBox="0 0 ${w} ${hgt}" width="100%" height="${hgt}" role="img" aria-label="weekly sentiment curve">
    <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
  </svg></div>

  <h2>板块情绪均值</h2>
  <div class="chips">${sectorAvg.map((s) => `<span class="chip ${s.avg >= 0 ? "pos" : "neg"}">${esc(s.label)} ${s.avg > 0 ? "+" : ""}${s.avg}</span>`).join("")}</div>

  <h2>指数均值（档期收盘快照）</h2>
  <table><thead><tr><th>指数</th><th>均值涨跌</th><th>档数</th></tr></thead>
  <tbody>${indexRows.map((i) => `<tr><td>${esc(i.name)}</td><td class="${i.avgChangePct >= 0 ? "pos" : "neg"}">${i.avgChangePct >= 0 ? "+" : ""}${i.avgChangePct.toFixed(2)}%</td><td>${i.editions}</td></tr>`).join("")}</tbody></table>

  <h2>周度事件 Top ${topEvents.length}</h2>
  <div class="card"><ul>${topEvents.map((e) => `<li><span style="color:var(--accent);font-weight:600">${esc(e.displayName)}</span> <b>×${e.count}</b> · <a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a></li>`).join("")}</ul></div>

  <h2>周关键词 Top ${Math.min(20, payload.keywords.length)}</h2>
  <div class="chips">${payload.keywords.map((k) => `<span class="chip">${esc(k.term)} <b>${k.count}</b></span>`).join("")}</div>

  <p style="margin-top:2rem"><a href="./index.html">← 回到最新一期</a> · <a href="./archive.html">历史归档</a> · <a href="./status.html">运行状态</a></p>
  <p class="meta">由 build-weekly 幂等烘焙 · ${payload.generatedAt}</p>
</main>
</body>
</html>
`;
  fs.writeFileSync(OUT_HTML, html, "utf8");
  console.log(
    `[weekly:bake] wrote ${OUT_HTML} + ${OUT_JSON} days=${payload.daysCovered} editions=${payload.editions}`,
  );
}

main();
