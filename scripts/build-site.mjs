#!/usr/bin/env node
/**
 * Build the static site for GitHub Pages.
 * Run AFTER `npm run daily` has produced at least one edition.
 *
 * Discovers:
 *   - daily_reports/<YYYY-MM-DD>/(06|13|19).html  (triple brief)
 *   - Legacy: daily_reports/<YYYY-MM-DD>/<YYYY-MM-DD>.html
 *
 * Writes:
 *   - index.html   = latest real edition (never a placeholder)
 *   - archive.html = grouped list (早报/午报/晚报); norm from 2026-09-16
 *   - Placeholder HH.html for missing slots on the latest day (no 404)
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = "daily_reports";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ARCHIVE_NORM_FROM = "2026-09-16";
const SLOTS = ["06", "13", "19"];

const LABEL = {
  "06": "早报",
  13: "午报",
  19: "晚报",
};

function labelFor(hour) {
  return LABEL[hour] || `${hour}:00`;
}

function parseHoursEnv() {
  const raw = process.env.REPORT_HOUR?.trim() || "6,13,19";
  const parts = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 23);
  const uniq = [...new Set(parts.length ? parts : [6, 13, 19])].sort(
    (a, b) => a - b,
  );
  return uniq.map((h) => String(h).padStart(2, "0"));
}

function placeholderHtml(date, hour, latestRel) {
  const lab = labelFor(hour);
  const home = latestRel
    ? `./${latestRel.replace(/^\.\//, "")}`
    : "./index.html";
  // When served from date folder vs root, sibling links differ; build both relative.
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCool · ${lab}尚未更新 · ${date}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Noto+Sans+SC:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg:#fff8f0; --fg:#1a1510; --muted:#7a6a5a; --accent:#e85d04; --card:#fff; --rule:#f0e0d0; }
  body { margin:0; min-height:100vh; font-family:"Noto Sans SC","DM Sans",system-ui,sans-serif;
    background: radial-gradient(ellipse 80% 50% at 10% -10%, #ffe8cc 0%, transparent 55%),
      radial-gradient(ellipse 60% 40% at 100% 0%, #ffd6e7 0%, transparent 50%), var(--bg);
    color:var(--fg); display:flex; align-items:center; justify-content:center; }
  .box { max-width:420px; margin:2rem; padding:2rem 1.75rem; background:var(--card);
    border:1px solid var(--rule); border-radius:1rem; text-align:center; }
  .brand { font-family:"DM Sans",sans-serif; font-weight:700; letter-spacing:0.12em;
    text-transform:uppercase; color:var(--accent); font-size:0.8rem; }
  h1 { font-size:1.45rem; margin:0.6rem 0 0.4rem; }
  p { color:var(--muted); line-height:1.55; margin:0.5rem 0; }
  a { color:var(--accent); font-weight:600; text-decoration:none; }
  .chips { display:flex; gap:0.4rem; justify-content:center; flex-wrap:wrap; margin-top:1.2rem; }
  .chips a { padding:0.4rem 0.75rem; border:1px solid var(--rule); border-radius:999px; font-size:0.85rem; }
</style>
</head>
<body>
<div class="box">
  <div class="brand">OpenCool</div>
  <h1>${lab}尚未更新</h1>
  <p>${date} · ${hour}:00（上海时区）这一期还没生成。</p>
  <p>流水线在整点附近自动抓取；到点后刷新本页即可。零 AI / 零 Token。</p>
  <p><a href="${home.startsWith("./") && !home.includes("/") ? "../index.html" : home.includes("/") ? `../index.html` : "./index.html"}">← 回到最新一期</a>
   · <a href="../archive.html">历史归档</a></p>
  <div class="chips">
    ${SLOTS.map((h) => `<a href="./${h}.html">${labelFor(h)} ${h}:00</a>`).join("")}
  </div>
</div>
</body>
</html>`;
}

if (!fs.existsSync(ROOT)) {
  console.error(`[build-site] ${ROOT}/ doesn't exist — run \`npm run daily\` first.`);
  process.exit(1);
}

/** @type {{ date: string, hour: string, rel: string, mtime: number, placeholder?: boolean }[]} */
const editions = [];

for (const d of fs.readdirSync(ROOT)) {
  if (!DATE_RE.test(d)) continue;
  const dir = path.join(ROOT, d);
  if (!fs.statSync(dir).isDirectory()) continue;

  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".html")) continue;
    const base = f.slice(0, -5);
    if (/^\d{2}$/.test(base) && base !== d) {
      const full = path.join(dir, f);
      const html = fs.readFileSync(full, "utf8");
      const isPh = html.includes("尚未更新");
      editions.push({
        date: d,
        hour: base,
        rel: `${d}/${f}`,
        mtime: fs.statSync(full).mtimeMs,
        placeholder: isPh,
      });
      continue;
    }
    if (base === d) {
      const full = path.join(dir, f);
      editions.push({
        date: d,
        hour: "legacy",
        rel: `${d}/${f}`,
        mtime: fs.statSync(full).mtimeMs,
      });
    }
  }
}

editions.sort((a, b) => {
  const c = b.date.localeCompare(a.date);
  if (c !== 0) return c;
  if (a.hour === "legacy") return 1;
  if (b.hour === "legacy") return -1;
  return b.hour.localeCompare(a.hour);
});

const realEditions = editions.filter((e) => !e.placeholder);
if (realEditions.length === 0 && editions.length === 0) {
  console.error(`[build-site] no edition HTML found in ${ROOT}/`);
  process.exit(1);
}

const latest = realEditions[0] || editions[0];
const latestDate = latest.date;

// Ensure all configured slots exist for the latest day (friendly placeholders)
const slotHours = parseHoursEnv();
const latestDir = path.join(ROOT, latestDate);
fs.mkdirSync(latestDir, { recursive: true });
for (const h of slotHours) {
  const fp = path.join(latestDir, `${h}.html`);
  if (!fs.existsSync(fp)) {
    const html = placeholderHtml(latestDate, h, latest.rel);
    fs.writeFileSync(fp, html, "utf8");
    console.log(`[build-site] placeholder ${latestDate}/${h}.html`);
    editions.push({
      date: latestDate,
      hour: h,
      rel: `${latestDate}/${h}.html`,
      mtime: Date.now(),
      placeholder: true,
    });
  }
}

// mcp-desk.html — 机构数据台: operator-baked snapshot from the ZCode
// financial MCP plugins (quota-daily). Every row shows its source for
// independent verification (复查). Gated on data/mcp-desk.json.
if (fs.existsSync("data/mcp-desk.json")) {
  const desk = JSON.parse(fs.readFileSync("data/mcp-desk.json", "utf8"));
  const escH = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const macroRows = desk.macro
    .map((m) => `<tr><td>${escH(m.k)}</td><td><b>${escH(m.v)}</b></td><td class="d-meta">${escH(m.asOf)}</td><td class="d-src">${escH(m.src)}</td></tr>`)
    .join("");
  const idxRows = desk.indexValuation
    .map((i) => `<tr><td>${escH(i.name)}</td><td><b>${i.close.toLocaleString("en-US")}</b></td><td>${i.chg ? `<span class="${i.chg.startsWith("-") ? "neg" : "pos"}">${escH(i.chg)}</span>` : "—"}</td><td>${i.pe ?? "—"}${i.peTtm ? ` (TTM ${i.peTtm})` : ""}</td><td>${i.pb ?? "—"}</td><td class="d-src">${escH(i.src)}</td></tr>`)
    .join("");
  const stockRows = desk.stocksDualSource
    .map((st) => {
      const okv = st.verdict === "一致";
      return `<tr><td>${escH(st.name)} <span class="d-meta">${escH(st.symbol)}</span></td>
        <td>THS ${st.ths.totalMcap.toLocaleString("en-US")}</td>
        <td>Wind ${st.wind.totalMcap.toLocaleString("en-US")}</td>
        <td><span class="${okv ? "pos" : "neg"}">${okv ? "✓ 一致" : "✗ Δ" + st.mcapDeltaPct + "%"}</span></td>
        <td class="d-meta">Wind ${escH(st.wind.price)} ${escH(st.wind.chg)}</td></tr>`;
    })
    .join("");
  const fundRows = desk.funds
    .map((f) => `<tr><td>${escH(f.name)} <span class="d-meta">${escH(f.code)}</span></td><td><b>${f.price}</b></td><td class="${f.chg.startsWith("-") ? "neg" : "pos"}">${escH(f.chg)}</td><td>${f.scaleYi.toFixed(1)} 亿</td><td class="d-src">${escH(f.src)}</td></tr>`)
    .join("");
  const newsRows = desk.news
    .map((n) => `<li><a href="${escH(n.url)}" target="_blank" rel="noopener">${escH(n.title)}</a> <span class="d-meta">${escH(n.src)} · ${escH(n.date)}</span></li>`)
    .join("");
  const smokeRows = desk.localMcpSmoke.results
    .map((r) => `<span class="d-chip ${r.ok === true ? "pos" : r.ok === false ? "neg" : ""}">${escH(r.tool)} ${r.ok === true ? "✓" : r.ok === false ? "✗" : "—"}${r.note ? ` <span class="d-meta">${escH(r.note)}</span>` : ""}</span>`)
    .join("");
  const deskHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCool · MCP 机构数据台</title>
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
  main { max-width:820px; margin:0 auto; padding:3rem 1.5rem 4rem; }
  .brand { font-family:"DM Sans",sans-serif; font-weight:700; font-size:.85rem; letter-spacing:.12em;
    text-transform:uppercase; color:var(--accent); }
  h1 { font-size:2rem; margin:.4rem 0 .3rem; }
  h2 { font-size:1.05rem; margin:1.9rem 0 .6rem; }
  .meta { color:var(--muted); font-size:.9rem; }
  table { border-collapse:collapse; width:100%; background:var(--card); border-radius:.75rem; overflow:hidden; margin-bottom:.5rem; }
  th, td { text-align:left; padding:.5rem .75rem; border-bottom:1px solid var(--rule); font-size:.85rem; }
  th { color:var(--muted); font-weight:600; }
  .d-src { color:var(--muted); font-size:.75rem; max-width:15rem; }
  .d-meta { color:var(--muted); font-size:.78rem; }
  .pos { color:#15803d; font-weight:600; } .neg { color:#b91c1c; font-weight:600; }
  .d-chip { display:inline-flex; gap:.3rem; align-items:baseline; padding:.25rem .6rem; border:1px solid var(--rule);
    border-radius:999px; font-size:.8rem; background:var(--card); margin:.15rem .2rem .15rem 0; }
  ul { margin:.3rem 0; padding-left:1.2rem; } li { margin:.35rem 0; font-size:.9rem; }
  a { color:var(--accent); text-decoration:none; }
  .home { color:var(--accent); text-decoration:none; font-weight:600; }
</style>
</head>
<body>
<main>
  <div class="brand">OpenCool</div>
  <h1>MCP 机构数据台</h1>
  <p class="meta">检索时点 ${desk.retrievedAt} · 采集窗口 ${desk.harvestWindow} · ZCode MCP 调用 ${desk.harvestCalls.zcodeMcp} 次 + 本仓 stdio 冒烟 ${desk.harvestCalls.localStdio} 次</p>
  <p class="meta">操作员烘焙快照（额度每日重置，随批发布刷新）。<b>每行标注来源，可独立复查。</b>零 AI，不构成投资建议。</p>

  <h2>宏观 · 流动性</h2>
  <table><thead><tr><th>指标</th><th>数值</th><th>截至</th><th>来源（可复查）</th></tr></thead><tbody>${macroRows}</tbody></table>

  <h2>指数估值</h2>
  <table><thead><tr><th>指数</th><th>收盘</th><th>涨跌</th><th>PE</th><th>PB</th><th>来源</th></tr></thead><tbody>${idxRows}</tbody></table>

  <h2>双源交叉验证（同花顺 × Wind）</h2>
  <table><thead><tr><th>标的</th><th>总市值 (THS)</th><th>总市值 (Wind)</th><th>校验</th><th>行情 (Wind)</th></tr></thead><tbody>${stockRows}</tbody></table>

  <h2>ETF 快照</h2>
  <table><thead><tr><th>基金</th><th>价</th><th>涨跌</th><th>规模</th><th>来源</th></tr></thead><tbody>${fundRows}</tbody></table>

  <h2>当日要闻（来源可点开复查）</h2>
  <ul>${newsRows}</ul>

  <h2>本仓 MCP 服务冒烟（stdio · 9 工具）</h2>
  <div>${smokeRows}</div>
  <p class="meta">本会话修复：themes_query 的 TS 注解致 .mjs 语法错（自 #30 起）、lhb_query 缺 dispatch 分支（自 #31 起）——全量冒烟暴露后修复。</p>

  <p style="margin-top:2rem"><a class="home" href="./index.html">← 回到最新一期</a>
   · <a class="home" href="./status.html">运行状态</a>
   · <a class="home" href="./archive.html">历史归档</a></p>
</main>
</body>
</html>
`;
  fs.writeFileSync(path.join(ROOT, "mcp-desk.html"), deskHtml, "utf8");
  console.log(`[build-site] mcp-desk.html (${desk.harvestCalls.zcodeMcp} MCP calls)`);
}

// ---------------------------------------------------------------------------
// News → practice funnel. OpenCool informs, SuPro practices (supro.si).
// Every outbound SuPro link carries the same UTM scheme so the sister site
// can attribute traffic per surface (home / timing / signals / paper / news /
// landing / badge). Keep copy calm and retail-friendly: no hype, no advice.
// ---------------------------------------------------------------------------
const SUPRO_UTM = "utm_source=opencool&utm_medium=brief&utm_campaign=news_to_practice";

function suproLink(pathname, content) {
  const p = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `https://supro.si${p}?${SUPRO_UTM}&utm_content=${content}`;
}

const SUPRO_LINKS = {
  home: suproLink("/", "home"),
  timing: suproLink("/timing/broad/", "timing"),
  signals: suproLink("/signals", "signals"),
  paper: suproLink("/paper", "paper"),
  news: suproLink("/news", "news"),
  landing: suproLink("/", "landing"),
  badge: suproLink("/", "badge"),
};

// Injected once per edition page (06 / 13 / 19) before </main>. Idempotent:
// the marker guards against double injection when build-site re-runs.
const FUNNEL_MARKER = 'data-funnel="supro"';

function funnelCtaHtml() {
  return `  <section class="funnel-cta" ${FUNNEL_MARKER} aria-label="OpenCool × SuPro">
    <h2>看完新闻，然后呢？</h2>
    <p class="funnel-lead">OpenCool 负责<b>看懂</b>市场：三报、题材结构、情绪计。SuPro 负责<b>上手</b>练一遍：择时、信号、纸盘复盘。两边互为姐妹项目，看报 → 研究 → 模拟实操，一条闭环。</p>
    <p class="funnel-links">
      <a class="funnel-link primary" href="${SUPRO_LINKS.home}" target="_blank" rel="noopener">进入 SuPro →</a>
      <a class="funnel-link" href="${SUPRO_LINKS.timing}" target="_blank" rel="noopener">大盘择时</a>
      <a class="funnel-link" href="${SUPRO_LINKS.signals}" target="_blank" rel="noopener">今日信号</a>
      <a class="funnel-link" href="${SUPRO_LINKS.paper}" target="_blank" rel="noopener">纸盘演练</a>
      <a class="funnel-link" href="${SUPRO_LINKS.news}" target="_blank" rel="noopener">资讯一站</a>
    </p>
    <p class="funnel-note">纸盘模拟，非投资建议；行情以数据源为准。</p>
  </section>
`;
}

const FUNNEL_STYLE = `  <style>
  .funnel-cta { margin:2.5rem 0 0; padding:1.1rem 1.25rem; background:var(--card);
    border:1px solid var(--rule); border-left:3px solid #1e3a8a; border-radius:.9rem; }
  .funnel-cta h2 { margin:0 0 .45rem; font-size:1.02rem; }
  .funnel-lead { margin:0 0 .7rem; color:var(--fg-soft); font-size:.9rem; line-height:1.6; }
  .funnel-links { margin:0 0 .5rem; display:flex; flex-wrap:wrap; gap:.4rem; }
  .funnel-link { display:inline-block; padding:.4rem .85rem; border-radius:999px;
    border:1px solid var(--rule); color:var(--fg); text-decoration:none; font-size:.84rem; }
  .funnel-link:hover { border-color:#1e3a8a; color:#1e3a8a; }
  .funnel-link.primary { background:#1e3a8a; border-color:#1e3a8a; color:#fff; }
  .funnel-note { margin:0; color:var(--muted); font-size:.76rem; }
  </style>
`;

function injectFunnelCta(html) {
  if (html.includes(FUNNEL_MARKER)) return { html, injected: false };
  const anchor = html.includes("<footer")
    ? "<footer"
    : html.includes("</main>")
      ? "</main>"
      : "</body>";
  if (!html.includes(anchor)) return { html, injected: false };
  const withStyle = html.includes("</head>")
    ? html.replace("</head>", `${FUNNEL_STYLE}</head>`)
    : html;
  return {
    html: withStyle.replace(anchor, `${funnelCtaHtml()}${anchor}`),
    injected: true,
  };
}

// supro.html — sister-project landing (SuPro / supro.si). Content
// adapted verbatim from the SuPro repo README; the news→practice funnel:
// OpenCool informs, SuPro practices.
const suproHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCool · 量化实操 · SuPro (supro.si)</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Noto+Sans+SC:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg:#fff8f0; --fg:#1a1510; --muted:#7a6a5a; --accent:#e85d04; --card:#fff; --rule:#f0e0d0; --navy:#1e3a8a; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; font-family:"Noto Sans SC","DM Sans",system-ui,sans-serif;
    background: radial-gradient(ellipse 80% 50% at 10% -10%, #ffe8cc 0%, transparent 55%),
      radial-gradient(ellipse 60% 40% at 100% 0%, #ffd6e7 0%, transparent 50%), var(--bg);
    color:var(--fg); line-height:1.65; }
  main { max-width:820px; margin:0 auto; padding:3rem 1.5rem 4rem; }
  .brand { font-family:"DM Sans",sans-serif; font-weight:700; font-size:.85rem; letter-spacing:.12em;
    text-transform:uppercase; color:var(--accent); }
  h1 { font-size:2.1rem; margin:.4rem 0 .3rem; letter-spacing:-.03em; }
  h2 { font-size:1.1rem; margin:1.9rem 0 .6rem; }
  .meta { color:var(--muted); font-size:.9rem; }
  .cta { display:inline-block; margin:.4rem .6rem .4rem 0; padding:.8rem 1.4rem; border-radius:.8rem;
    font:600 1rem "Noto Sans SC",system-ui,sans-serif; text-decoration:none; }
  .cta.primary { background:var(--navy); color:#fff; }
  .cta.ghost { border:1px solid var(--navy); color:var(--navy); background:var(--card); }
  table { border-collapse:collapse; width:100%; background:var(--card); border-radius:.75rem; overflow:hidden; margin:.6rem 0; }
  th, td { text-align:left; padding:.55rem .8rem; border-bottom:1px solid var(--rule); font-size:.88rem; }
  th { color:var(--muted); font-weight:600; }
  code { background:var(--card); border:1px solid var(--rule); border-radius:6px; padding:.05rem .35rem; font-size:.9em; }
  .safe { background:var(--card); border:1px solid var(--rule); border-radius:.75rem; padding:.8rem 1rem; }
  .home { color:var(--accent); text-decoration:none; font-weight:600; }
  .note { color:var(--muted); font-size:.85rem; }
</style>
</head>
<body>
<main>
  <div class="brand">OpenCool × SuPro</div>
  <h1>看完新闻，然后呢？</h1>
  <p class="meta">OpenCool 让你<b>看见</b>市场；<b>SuPro（supro.si）</b>让你<b>练手</b>市场。姐妹项目，一套生态。</p>

  <h2>SuPro — Super Professional · 苏坡</h2>
  <p>帮助用户<b>筛选、比较、选用</b> AI / Agent 产品的专业站点：America.gov 级别的品牌首页与 Composer、AI 产品目录（logo · 名称 · 周榜）、以及 <b>苏坡大模型 / Supro Model</b> —— DeepSeek AIaaS，按实际 tokens 折算 gold 计费（中文「苏坡」取自苏东坡，致敬大智能时代的从容乐观）。</p>
  <p>
    <a class="cta primary" href="${SUPRO_LINKS.landing}" target="_blank" rel="noopener">进入 supro.si →</a>
    <a class="cta ghost" href="https://fudan2026.github.io/Agenter/" target="_blank" rel="noopener">Pages 镜像</a>
  </p>

  <h2>从看报直接开始练</h2>
  <p class="meta">按你此刻要做的事选一个入口：</p>
  <p>
    <a class="cta ghost" href="${SUPRO_LINKS.timing}" target="_blank" rel="noopener">大盘择时 →</a>
    <a class="cta ghost" href="${SUPRO_LINKS.signals}" target="_blank" rel="noopener">今日信号 →</a>
    <a class="cta ghost" href="${SUPRO_LINKS.paper}" target="_blank" rel="noopener">纸盘演练 →</a>
    <a class="cta ghost" href="${SUPRO_LINKS.news}" target="_blank" rel="noopener">资讯一站 →</a>
  </p>
  <p class="note">纸盘模拟，非投资建议；行情以数据源为准。</p>

  <h2>产品版图</h2>
  <table>
    <thead><tr><th>路线</th><th>能力</th></tr></thead>
    <tbody>
      <tr><td><code>/</code></td><td>品牌首页 — Supro Composer → Supro Model · AI 目录 · 周榜 · Quant</td></tr>
      <tr><td><code>/fin</code></td><td><b>苏坡大模型 / Supro Model</b>（登录确认 + gold ≥20）— multifactor / e2e / transformer / report / allocate + 经典模式</td></tr>
      <tr><td><code>/quant</code></td><td>Factor Studio · Committee · screens→Paper · Strategy Lab（15 种模式 · 多年 OHLC）</td></tr>
      <tr><td><code>/paper</code></td><td>Paper Pro — brackets · 风控包 · Sim 对账 · TWAP/VWAP</td></tr>
      <tr><td><code>/sim</code></td><td>Sim Desk — 模拟炒股；与 <code>/paper?panel=reconcile</code> 衔接</td></tr>
      <tr><td><code>/news</code></td><td>AI · 公告 · 问财资讯一站页（<code>?section=ai|filings|iwencai</code>）</td></tr>
      <tr><td><code>/compare</code> · <code>/learn</code> · <code>/handbook</code></td><td>对比矩阵 · 引导教程 · 双语手册</td></tr>
      <tr><td><code>/asset/:symbol</code></td><td>K 线 + 均线 + 因子暴露</td></tr>
    </tbody>
  </table>

  <h2>纸盘与安全红线</h2>
  <div class="safe">
    <p>Paper：<b>¥100,000,000</b> 起始资金 · <b>3 bps</b> RT · 每手 100 股 · 信号 t → <b>t+1 开盘</b>成交；Sim：可编辑限价 @ 昨收。</p>
    <p><b>浏览器内零券商 API</b> —— 快速实盘 = 清单导出 + 纸盘，券商侧人工下单。Wave Loop V1 治理（shadow → semi_auto → full_auto，kill switch 永远最高优先），资金阶梯 T1 ¥10k → T3 ¥200k，晋升 AI 提议、人工批准。</p>
  </div>

  <h2>为什么是一条生态链</h2>
  <p>OpenCool 的三报、题材结构、情绪计回答「市场发生了什么」；SuPro 的因子工作室、策略实验室、纸盘回答「那我该怎么做」。两边数据与品牌互认：<b>看报 → 研究 → 纸盘实操 → 复盘</b>，一个闭环，无需在多个孤立工具间搬运。</p>

  <p style="margin-top:2rem"><a class="home" href="./index.html">← 回到最新一期</a>
   · <a class="home" href="./archive.html">历史归档</a>
   · <a class="home" href="./mcp-desk.html">机构数据台</a>
   · <a class="home" href="./supro.html">量化实操·SuPro</a>
   · <a class="home" href="./periods.html">趋势对比</a>
   · <a class="home" href="./subscribe.html">订阅</a></p>
</main>
</body>
</html>
`;
fs.writeFileSync(path.join(ROOT, "supro.html"), suproHtml, "utf8");
console.log(`[build-site] supro.html (sister-project funnel)`);

// Inject the news→practice CTA into every real edition page (06 / 13 / 19).
// Runs before index.html is derived, so the homepage inherits it too.
{
  let funnelCount = 0;
  for (const e of editions) {
    if (e.placeholder) continue;
    const fp = path.join(ROOT, e.rel);
    if (!fs.existsSync(fp)) continue;
    const src = fs.readFileSync(fp, "utf8");
    const { html, injected } = injectFunnelCta(src);
    if (!injected) continue;
    fs.writeFileSync(fp, html, "utf8");
    funnelCount += 1;
  }
  console.log(`[build-site] funnel CTA injected into ${funnelCount} edition page(s)`);
}

// periods.html — trend intelligence (WoW/MoM deltas over sentiment,
// themes, index moves). Iframe/embed-friendly: inline CSS, no fixed
// positioning, no external JS. Gated on daily_reports/periods.json
// (baked by npm run periods:bake).
if (fs.existsSync(path.join(ROOT, "periods.json"))) {
  const per = JSON.parse(fs.readFileSync(path.join(ROOT, "periods.json"), "utf8"));
  const bucketRows = (buckets) =>
    buckets
      .map((b) => {
        const arrow =
          b.deltaVsPrev == null ? "●" : b.deltaVsPrev > 0 ? "▲" : b.deltaVsPrev < 0 ? "▼" : "●";
        const cls =
          b.deltaVsPrev == null ? "d-meta" : b.deltaVsPrev > 0 ? "pos" : "neg";
        const ratio =
          b.posNegRatio == null ? "—" : `${Math.round(b.posNegRatio * 100)}% 多`;
        const themes = b.topThemes.length
          ? b.topThemes.map((t) => `${t.name}×${t.hits}`).join("、")
          : "—";
        const idx = b.avgIndexChangePct == null ? "—" : `${b.avgIndexChangePct >= 0 ? "+" : ""}${b.avgIndexChangePct.toFixed(2)}%`;
        return `<tr><td><b>${b.key}</b> ~ ${b.end}</td>
          <td>${b.editions}</td>
          <td><span class="${cls}">${arrow} ${b.avgSentiment ?? "—"}</span>${b.deltaVsPrev != null ? ` <span class="d-meta">(Δ${b.deltaVsPrev > 0 ? "+" : ""}${b.deltaVsPrev})</span>` : ""}</td>
          <td>${ratio}</td>
          <td class="d-src">${themes}</td>
          <td class="${idx.startsWith("-") ? "neg" : "pos"}">${idx}</td></tr>`;
      })
      .join("");
  const perHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCool · 趋势对比</title>
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
  main { max-width:820px; margin:0 auto; padding:3rem 1.5rem 4rem; }
  .brand { font-family:"DM Sans",sans-serif; font-weight:700; font-size:.85rem; letter-spacing:.12em;
    text-transform:uppercase; color:var(--accent); }
  h1 { font-size:2rem; margin:.4rem 0 .3rem; }
  h2 { font-size:1.05rem; margin:1.9rem 0 .6rem; }
  .meta { color:var(--muted); font-size:.9rem; }
  table { border-collapse:collapse; width:100%; background:var(--card); border-radius:.75rem; overflow:hidden; margin-bottom:.5rem; }
  th, td { text-align:left; padding:.55rem .8rem; border-bottom:1px solid var(--rule); font-size:.85rem; }
  th { color:var(--muted); font-weight:600; }
  .pos { color:#15803d; font-weight:600; } .neg { color:#b91c1c; font-weight:600; }
  .d-src { color:var(--muted); font-size:.78rem; max-width:14rem; }
  .d-meta { color:var(--muted); font-size:.78rem; }
  a { color:var(--accent); text-decoration:none; }
  .home { color:var(--accent); text-decoration:none; font-weight:600; }
</style>
</head>
<body>
<main>
  <div class="brand">OpenCool</div>
  <h1>趋势对比</h1>
  <p class="meta">${per.editions} 档 · 周一制 ISO 周 · Δ 为与前桶均值之差 · ${per.note}</p>
  <h2>周度趋势（近 ${per.weeks.length} 周）</h2>
  <table><thead><tr><th>周</th><th>档数</th><th>情绪均值</th><th>多空比</th><th>主题命中</th><th>指数均值</th></tr></thead><tbody>${bucketRows(per.weeks)}</tbody></table>
  <h2>月度趋势（近 ${per.months.length} 月）</h2>
  <table><thead><tr><th>月</th><th>档数</th><th>情绪均值</th><th>多空比</th><th>主题命中</th><th>指数均值</th></tr></thead><tbody>${bucketRows(per.months)}</tbody></table>
  <p style="margin-top:2rem"><a class="home" href="./index.html">← 回到最新一期</a>
   · <a class="home" href="./weekly.html">周报</a>
   · <a class="home" href="./status.html">运行状态</a></p>
</main>
</body>
</html>
`;
  fs.writeFileSync(path.join(ROOT, "periods.html"), perHtml, "utf8");
  console.log(`[build-site] periods.html (${per.weeks.length}w × ${per.months.length}m)`);
}

// subscribe.html — subscription foundation. Stores intent locally only;
// no email is sent anywhere unless the repo owner explicitly configures
// SUBSCRIBE_ENDPOINT. A future backend can be attached without a redesign.
const subscribeEndpoint = process.env.SUBSCRIBE_ENDPOINT || "";
const subscribeHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCool · 订阅</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Noto+Sans+SC:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg:#fff8f0; --fg:#1a1510; --muted:#7a6a5a; --accent:#e85d04; --card:#fff; --rule:#f0e0d0; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; font-family:"Noto Sans SC","DM Sans",system-ui,sans-serif;
    background: radial-gradient(ellipse 80% 50% at 10% -10%, #ffe8cc 0%, transparent 55%),
      radial-gradient(ellipse 60% 40% at 100% 0%, #ffd6e7 0%, transparent 50%), var(--bg);
    color:var(--fg); line-height:1.65; }
  main { max-width:720px; margin:0 auto; padding:3rem 1.5rem 4rem; }
  .brand { font-family:"DM Sans",sans-serif; font-weight:700; font-size:.85rem; letter-spacing:.12em;
    text-transform:uppercase; color:var(--accent); }
  h1 { font-size:2rem; margin:.4rem 0 .5rem; }
  .meta { color:var(--muted); font-size:.9rem; }
  form { background:var(--card); border:1px solid var(--rule); border-radius:.8rem; padding:1.2rem; margin-top:1.2rem; }
  label { display:block; margin:.6rem 0 .3rem; font-size:.9rem; font-weight:600; }
  input[type=email], select { width:100%; padding:.75rem .9rem; border:1px solid var(--rule); border-radius:.65rem;
    font:500 1rem "Noto Sans SC",system-ui,sans-serif; background:#fff; color:var(--fg); }
  input[type=email]:focus, select:focus { outline:2px solid var(--accent); outline-offset:1px; }
  .consent { display:flex; gap:.5rem; align-items:flex-start; font-size:.85rem; color:var(--muted); margin-top:.8rem; }
  .consent input { margin-top:.25rem; }
  button, .btn { display:inline-block; margin-top:1rem; padding:.7rem 1.1rem; border:0; border-radius:.65rem;
    background:var(--accent); color:#fff; font:600 .95rem "Noto Sans SC",system-ui,sans-serif; cursor:pointer; }
  button.secondary, .btn.secondary { background:var(--card); color:var(--accent); border:1px solid var(--accent); }
  .status { margin-top:.9rem; padding:.7rem .9rem; border-radius:.65rem; font-size:.85rem; }
  .status.ok { background:#ecfdf3; color:#15803d; }
  .status.err { background:#fef2f2; color:#b91c1c; }
  .privacy { margin-top:1rem; font-size:.8rem; color:var(--muted); }
  a { color:var(--accent); text-decoration:none; }
  .home { color:var(--accent); text-decoration:none; font-weight:600; }
</style>
</head>
<body>
<main>
  <div class="brand">OpenCool</div>
  <h1>订阅 OpenCool</h1>
  <p class="meta">留下邮箱，选择你想收的档位。当前版本<b>仅在本机保存订阅意向，不发送邮件、不上传任何信息</b>；后端开通后可无缝接入。</p>
  <form id="subscribe-form" data-endpoint="${subscribeEndpoint}" novalidate>
    <label for="email">邮箱 / Email</label>
    <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@example.com" inputmode="email">
    <label for="frequency">订阅内容 / Frequency</label>
    <select id="frequency" name="frequency">
      <option value="all">每日三报（06:00 / 13:00 / 19:00）</option>
      <option value="morning">只收早报 06:00</option>
      <option value="noon">只收午报 13:00</option>
      <option value="evening">只收晚报 19:00</option>
      <option value="weekly">每周复盘（weekly）</option>
    </select>
    <label class="consent"><input id="consent" type="checkbox" required>
      <span>我知道当前只保存到本机 localStorage；不会收到实际邮件，直到后端订阅服务开通。</span></label>
    <button type="submit">保存订阅意向</button>
    <button type="button" class="secondary" id="export-intent">导出我的意向 JSON</button>
    <div id="status" class="status" role="status" aria-live="polite" hidden></div>
  </form>
  <p class="privacy">隐私说明：邮箱只保存在你的浏览器里。点击「导出」可把意向 JSON 下载到本机；如需删除，清除浏览器站点数据即可。<br>
  现在也可以直接 <a href="./feed.xml">用 RSS 订阅</a>（无需邮箱）。未来 endpoint 开通后，表单才会按显式配置发送。</p>
  <p style="margin-top:2rem"><a class="home" href="./index.html">← 回到最新一期</a> · <a class="home" href="./archive.html">历史归档</a></p>
</main>
<script>
(function () {
  var KEY = 'opencool-subscription-intent';
  var form = document.getElementById('subscribe-form');
  var status = document.getElementById('status');
  function show(kind, text) {
    status.className = 'status ' + kind;
    status.textContent = text;
    status.hidden = false;
  }
  function readForm() {
    return {
      email: document.getElementById('email').value.trim(),
      frequency: document.getElementById('frequency').value,
      createdAt: new Date().toISOString(),
      delivery: 'local-intent-only'
    };
  }
  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    status.hidden = true;
    var data = readForm();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      show('err', '邮箱格式看起来不正确，请检查后再保存。');
      return;
    }
    if (!document.getElementById('consent').checked) {
      show('err', '请先勾选「只保存到本机」的知情确认。');
      return;
    }
    var endpoint = form.dataset.endpoint;
    if (!endpoint) {
      localStorage.setItem(KEY, JSON.stringify(data));
      show('ok', '订阅意向已保存到本机，未发送邮件、未上传服务器。可点击「导出我的意向 JSON」留存。');
      return;
    }
    try {
      var res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      show('ok', '已提交到订阅服务（endpoint 由站点配置）。');
    } catch (e) {
      show('err', '订阅服务暂不可用，意向未离开本机：' + e.message);
    }
  });
  document.getElementById('export-intent').addEventListener('click', function () {
    var raw = localStorage.getItem(KEY);
    if (!raw) { show('err', '本机还没有保存过订阅意向，请先提交。'); return; }
    var blob = new Blob([raw], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'opencool-subscription-intent.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
})();
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(ROOT, "subscribe.html"), subscribeHtml, "utf8");
console.log(`[build-site] subscribe.html${subscribeEndpoint ? " (endpoint configured)" : " (local-only)"}`);

// tools.json — the "Static MCP" manifest: every MCP tool mapped to its
// stable static endpoint, so agents without a local clone consume
// OpenCool via plain fetch. Uncontested per COMPETITIVE-ANALYSIS.md.
const latestSidecar = `/${latest.rel.replace(/\.html$/, ".json")}`;
const toolsManifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  note: "Static MCP: fetch these endpoints directly; a live stdio MCP server ships in the repo (mcp/) for local agents. See /ai-instructions.html.",
  tools: [
    {
      name: "sentiment_query",
      staticEndpoint: latestSidecar + "#sentiment",
      params: "date+hour -> /<YYYY-MM-DD>/<HH>.json#sentiment",
      returns: "{score,raw,label,sectors,percentile}",
    },
    {
      name: "sentiment_trend",
      staticEndpoint: "/sentiment-history.json",
      params: "limit -> slice items (newest last)",
      returns: "{count,cap,items:[{date,hour,score,label,percentile}]}",
    },
    {
      name: "search_editions",
      staticEndpoint: "/search-index.json",
      params: "q -> tokenize (CJK bigrams + ascii>=3, stopwords out), intersect postings",
      returns: "{docs:[{d,h,t}],postings:{token:[docIdx...]}}",
    },
    {
      name: "market_overview",
      staticEndpoint: latestSidecar + "#quant.market",
      params: "date+hour -> /<date>/<HH>.json#quant.market",
      returns: "{indices:[{code,name,price,changePct}],note}",
    },
    {
      name: "list_watchlist",
      staticEndpoint: "/llms.txt (watchlist section) — repo: lib/trading/watchlist.ts",
      params: "-",
      returns: "32 symbols with groups",
    },
    {
      name: "get_quote/get_kline",
      staticEndpoint: "/<date>/<HH>.json#trading.tickers[]",
      params: "symbol -> match trading.tickers[].symbol",
      returns: "indicators + closesSpark per ticker",
    },
    {
      name: "watchlist_events",
      staticEndpoint: latestSidecar + "#quant.events",
      params: "date+hour -> /<date>/<HH>.json#quant.events",
      returns: "[{symbol,displayName,title,url}]",
    },
    {
      name: "themes_query",
      staticEndpoint: "/themes.json",
      params: "minHeat -> filter themes",
      returns: "{themes:[{key,name,boardCode,boardChangePct,articleHits,constituents}]}",
    },
    {
      name: "lhb_query",
      staticEndpoint: "/lhb.json",
      params: "-",
      returns: "{tradeDate,rows:[{code,name,changePct,netAmtYi}]}",
    },
    {
      name: "periods_compare",
      staticEndpoint: "/periods.json",
      params: "-",
      returns: "{weeks:[{key,end,editions,avgSentiment,deltaVsPrev,...}],months:[...]}",
    },
  ],
};
fs.writeFileSync(
  path.join(ROOT, "tools.json"),
  JSON.stringify(toolsManifest, null, 2) + "\n",
  "utf8",
);
console.log(`[build-site] tools.json (static MCP manifest, 7 tools)`);

// ai-instructions.html — TLDR-pattern agent onboarding page.
const aiHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCool · AI Instructions</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Noto+Sans+SC:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg:#fff8f0; --fg:#1a1510; --muted:#7a6a5a; --accent:#e85d04; --card:#fff; --rule:#f0e0d0; }
  body { margin:0; min-height:100vh; font-family:"Noto Sans SC","DM Sans",system-ui,sans-serif; background:var(--bg); color:var(--fg); line-height:1.65; }
  main { max-width:760px; margin:0 auto; padding:3rem 1.5rem 4rem; }
  .brand { font-weight:700; font-size:.85rem; letter-spacing:.12em; text-transform:uppercase; color:var(--accent); }
  h1 { font-size:2rem; margin:.4rem 0 1rem; }
  h2 { font-size:1.1rem; margin:1.8rem 0 .5rem; }
  code { background:var(--card); border:1px solid var(--rule); border-radius:6px; padding:.1rem .4rem; font-size:.9em; }
  pre { background:var(--card); border:1px solid var(--rule); border-radius:.7rem; padding:.9rem 1rem; overflow:auto; font-size:.85rem; }
  a { color:var(--accent); }
</style>
</head>
<body>
<main>
  <div class="brand">OpenCool</div>
  <h1>AI Instructions</h1>
  <p>How to consume OpenCool programmatically. Start at <a href="./llms.txt">/llms.txt</a> (index), then use the surfaces below. Zero AI behind any endpoint; all times Asia/Shanghai.</p>
  <h2>1 · Read the contract</h2>
  <p>Field shapes are versioned in the repo at <code>docs/DATA-CONTRACT.md</code> and enforced by golden tests. Placeholders contain 尚未更新 and have no <code>.json</code> sidecar — always check the sidecar.</p>
  <h2>2 · Fetch data (Static MCP)</h2>
  <p><a href="./tools.json"><code>/tools.json</code></a> maps every MCP tool to a static endpoint. Example — latest sentiment:</p>
  <pre>fetch("https://fudan2026.github.io/opencool/tools.json")  // resolve latest edition path
fetch("https://fudan2026.github.io/opencool/&lt;date&gt;/&lt;HH&gt;.json")  // .sentiment / .quant.market / .trading</pre>
  <h2>3 · Search the archive</h2>
  <pre>const idx = await (await fetch("./search-index.json")).json();
// tokenize: CJK bigrams + ascii words >=3 chars (stopwords out);
// intersect idx.postings[t] lists; docs[idx] = {d,h,t} -> /d/h.html</pre>
  <h2>4 · Live MCP (local clones)</h2>
  <p>Clone the repo, <code>cd mcp && npm start</code> — 7 stdio tools (list_watchlist, get_quote, get_kline, market_overview, sentiment_query, sentiment_trend, search_editions). Watchlist is synced from the pipeline via <code>npm run mcp:sync-watchlist</code>.</p>
  <h2>5 · Refresh cadence & attribution</h2>
  <p>Editions publish 06:00 / 13:00 / 19:00 (Shanghai); data products rebake every publish. When citing OpenCool in agent output, attribute "OpenCool (URL)". License MIT.</p>
  <p style="margin-top:2rem"><a href="./index.html">← Latest edition</a></p>
</main>
</body>
</html>
`;
fs.writeFileSync(path.join(ROOT, "ai-instructions.html"), aiHtml, "utf8");
console.log(`[build-site] ai-instructions.html`);

// search.html — static shell; the page fetches search-index.json at
// runtime and runs the query client-side (tokenizer port of
// lib/search/tokenize.ts: CJK bigrams + ascii words >= 3, stopwords out).
if (fs.existsSync(path.join(ROOT, "search-index.json"))) {
  const searchHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCool · 搜索</title>
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
  main { max-width:720px; margin:0 auto; padding:3rem 1.5rem 4rem; }
  .brand { font-family:"DM Sans",sans-serif; font-weight:700; font-size:.85rem; letter-spacing:.12em;
    text-transform:uppercase; color:var(--accent); }
  h1 { font-size:2rem; margin:.4rem 0 .8rem; letter-spacing:-.03em; }
  input { width:100%; padding:.8rem 1rem; border:1px solid var(--rule); border-radius:.75rem;
    font:600 1rem "Noto Sans SC",system-ui,sans-serif; background:var(--card); color:var(--fg); }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  .meta { color:var(--muted); font-size:.85rem; margin-top:.5rem; }
  .grp { margin-top:1.4rem; }
  .grp h2 { font-size:.95rem; color:var(--muted); font-weight:600; margin:0 0 .5rem; }
  a.res { display:block; padding:.7rem .9rem; background:var(--card); border:1px solid var(--rule);
    border-radius:.7rem; margin-bottom:.45rem; text-decoration:none; color:inherit; }
  a.res:hover { border-color:var(--accent); }
  a.res b { display:block; }
  .home { color:var(--accent); text-decoration:none; font-weight:600; }
  .empty { color:var(--muted); margin-top:1.5rem; }
</style>
</head>
<body>
<main>
  <div class="brand">OpenCool</div>
  <h1>搜索档案</h1>
  <input id="q" type="search" placeholder="搜索历史档期：关键词 / 公司 / 事件…" autofocus aria-label="搜索">
  <p class="meta" id="stat"></p>
  <div id="out"></div>
  <p style="margin-top:2rem"><a class="home" href="./index.html">← 回到最新一期</a>
   · <a class="home" href="./archive.html">历史归档</a></p>
</main>
<script>
const STOP = new Set(["the","and","for","with","from","that","this","are","was","were","will","have","has","had","after","over","into","says","said","to","of","in","on","at","by","it","its","is","be","been","am","as","or","an","not","but","new","out","up","down","about","more","than","can","may","how","why","who","what","when","all","also","just","now","get","one","two","first","amid","via","po","com","www","http","https","中国","美国","市场","今日","报道","公司","企业","行业","问题","工作","进行","表示","记者"]);
function tokenize(s){
  const t=String(s||"");const out=[];const seen=new Set();
  for(const w of (t.toLowerCase().match(/[a-z0-9][a-z0-9.+^=-]{2,}/g)||[]))
    if(!STOP.has(w)&&!seen.has(w)){seen.add(w);out.push(w);}
  for(const run of (t.match(/[\u4e00-\u9fff]{2,}/g)||[]))
    for(let i=0;i<run.length-1;i++){const g=run.slice(i,i+2);if(!seen.has(g)){seen.add(g);out.push(g);}}
  return out;
}
function intersect(a,b){const o=[];let i=0,j=0;while(i<a.length&&j<b.length){if(a[i]===b[j]){o.push(a[i]);i++;j++;}else if(a[i]<b[j])i++;else j++;}return o;}
let IDX=null;
async function run(){
  IDX=await (await fetch("./search-index.json")).json();
  document.getElementById("stat").textContent="可检索 "+IDX.docs.length+" 期档案 · 零 AI 静态索引";
  const q=document.getElementById("q");
  const out=document.getElementById("out");
  const render=()=>{
    const terms=tokenize(q.value);
    if(!terms.length){out.innerHTML="";return;}
    const lists=terms.map(t=>IDX.postings[t]||[]).filter(l=>l.length);
    if(!lists.length){out.innerHTML='<p class="empty">无匹配结果。</p>';return;}
    let pool=lists[0];
    for(let i=1;i<lists.length;i++)pool=intersect(pool,lists[i]);
    if(!pool.length){
      const score=new Map();
      for(const l of lists)for(const idx of l)score.set(idx,(score.get(idx)||0)+1);
      pool=[...score.entries()].sort((a,b)=>b[1]-a[1]||b[0]-a[0]).map(e=>e[0]).slice(0,30);
    }
    const groups=new Map();
    for(const idx of pool.slice(0,60)){
      const doc=IDX.docs[idx];
      const k=doc.d;
      if(!groups.has(k))groups.set(k,[]);
      groups.get(k).push(doc);
    }
    out.innerHTML=[...groups.entries()].map(([d,docs])=>
      '<div class="grp"><h2>'+d+'</h2>'+docs.map(doc=>
        '<a class="res" href="./'+doc.d+'/'+doc.h+'.html"><b>'+doc.h+':00 · '+doc.t+'</b></a>').join("")+'</div>').join("");
  };
  q.addEventListener("input",render);
  render();
}
run().catch(e=>{document.getElementById("stat").textContent="索引加载失败："+e.message;});
</script>
</body>
</html>
`;
  fs.writeFileSync(path.join(ROOT, "search.html"), searchHtml, "utf8");
  console.log("[build-site] search.html");
}

// heatmap.html — Finviz-style sector heat grid baked from the latest real
// edition sidecar (trading.tickers). Tile width flexes with |pct1Day|;
// green (#15803d) when up, red (#b91c1c) when down, gray around flat.
// Emitted only when tickers carry a usable pct1Day — trees/fixtures
// without trading data skip the page so status/archive never link a 404.
const HEAT_GROUPS = [
  ["china-ashare", "A股蓝筹"],
  ["china-etf", "ETF"],
  ["china-equity", "中概港股"],
  ["us-equity", "美股"],
  ["crypto", "加密"],
  ["commodity-fx", "商品汇率"],
  ["macro", "宏观指数"],
];

function heatEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function heatSignedPct(v) {
  const abs = Math.abs(v).toFixed(2).replace(/\.?0+$/, "");
  return `${v > 0 ? "+" : ""}${v < 0 ? "-" : ""}${abs}%`;
}

function heatMix(c1, c2, t) {
  const ch = (c, i) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2]
    .map((i) =>
      Math.round(ch(c1, i) + (ch(c2, i) - ch(c1, i)) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function heatTileStyle(pct) {
  const a = Math.abs(pct);
  if (a < 0.05) return { bg: "#9ca3af", fg: "#1a1510" };
  const t = Math.min(1, a / 3);
  return {
    bg: pct > 0 ? heatMix("#86efac", "#15803d", t) : heatMix("#fca5a5", "#b91c1c", t),
    fg: t > 0.55 ? "#fff" : "#1a1510",
  };
}

let heatmapEmitted = false;
{
  const sidecarPath = path.join(ROOT, latest.rel.replace(/\.html$/, ".json"));
  let heatTickers = [];
  if (fs.existsSync(sidecarPath)) {
    try {
      const report = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
      heatTickers = (report?.trading?.tickers ?? []).filter(
        (t) =>
          t &&
          typeof t.pct1Day === "number" &&
          Number.isFinite(t.pct1Day) &&
          typeof t.displayName === "string" &&
          t.displayName.length > 0,
      );
    } catch {
      // unreadable sidecar — heatmap skipped below
    }
  }
  if (heatTickers.length === 0) {
    console.log("[build-site] heatmap skipped — no tickers data");
  } else {
    const byGroup = new Map(HEAT_GROUPS.map(([g]) => [g, []]));
    const unknownGroup = [];
    for (const t of heatTickers) {
      if (byGroup.has(t.group)) byGroup.get(t.group).push(t);
      else unknownGroup.push(t);
    }
    const heatSection = (label, rows) => {
      const tiles = rows
        .slice()
        .sort((x, y) => Math.abs(y.pct1Day) - Math.abs(x.pct1Day))
        .map((t) => {
          const { bg, fg } = heatTileStyle(t.pct1Day);
          const w = Math.max(0.3, Math.min(5, Math.abs(t.pct1Day)));
          return `          <div class="tile" style="flex:${w} 1 118px;background:${bg};color:${fg}" title="${heatEscape(t.symbol ?? "")} ${t.pct1Day.toFixed(2)}%"><b>${heatEscape(t.displayName)}</b><span>${heatSignedPct(t.pct1Day)}</span></div>`;
        })
        .join("\n");
      return `      <section class="grp">
        <h2>${heatEscape(label)} <span class="g-n">${rows.length}</span></h2>
        <div class="tiles">
${tiles}
        </div>
      </section>`;
    };
    const heatSections = [
      ...HEAT_GROUPS.filter(([g]) => (byGroup.get(g) ?? []).length > 0).map(
        ([g, label]) => heatSection(label, byGroup.get(g)),
      ),
      ...(unknownGroup.length ? [heatSection("其他", unknownGroup)] : []),
    ].join("\n");
    const hourLabel = latest.hour === "legacy" ? latest.hour : `${latest.hour}:00`;
    const heatmapHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCool · 热力图</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Noto+Sans+SC:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg:#fff8f0; --fg:#1a1510; --muted:#7a6a5a; --accent:#e85d04; --card:#fff; --rule:#f0e0d0; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; font-family:"Noto Sans SC","DM Sans",system-ui,sans-serif;
    background: radial-gradient(ellipse 80% 50% at 10% -10%, #ffe8cc 0%, transparent 55%),
      radial-gradient(ellipse 60% 40% at 100% 0%, #ffd6e7 0%, transparent 50%), var(--bg);
    color:var(--fg); line-height:1.5; }
  main { max-width:960px; margin:0 auto; padding:3rem 1.5rem 4rem; }
  .brand { font-family:"DM Sans",sans-serif; font-weight:700; font-size:.85rem; letter-spacing:.12em;
    text-transform:uppercase; color:var(--accent); }
  h1 { font-size:2rem; margin:.4rem 0 .3rem; letter-spacing:-.03em; }
  .meta { color:var(--muted); }
  .grp { margin-top:1.6rem; }
  .grp h2 { font-size:.95rem; color:var(--muted); font-weight:600; margin:0 0 .55rem; }
  .g-n { opacity:.55; font-weight:400; margin-left:.3rem; }
  .tiles { display:flex; flex-wrap:wrap; gap:4px; }
  .tile { min-width:112px; padding:.55rem .7rem; border-radius:.55rem; min-height:3.7rem;
    display:flex; flex-direction:column; justify-content:space-between; gap:.15rem; }
  .tile b { font-size:.85rem; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .tile span { font-family:"DM Sans",sans-serif; font-weight:700; font-size:1.05rem; }
  .home { color:var(--accent); text-decoration:none; font-weight:600; }
</style>
</head>
<body>
<main>
  <div class="brand">OpenCool</div>
  <h1>热力图</h1>
  <p class="meta">${heatTickers.length} 只标的 · 最新档 ${latest.date} ${hourLabel} · 绿涨红跌 · 宽度随 |pct1Day|</p>
${heatSections}
  <p style="margin-top:2.5rem"><a class="home" href="./index.html">← 回到最新一期</a>
   · <a class="home" href="./archive.html">历史归档</a>
   · <a class="home" href="./status.html">运行状态</a></p>
</main>
</body>
</html>
`;
    fs.writeFileSync(path.join(ROOT, "heatmap.html"), heatmapHtml, "utf8");
    heatmapEmitted = true;
    console.log(
      `[build-site] heatmap.html (${heatTickers.length} tickers · ${latest.date}/${latest.hour})`,
    );
  }
}

const latestPath = path.join(ROOT, latest.rel);
let latestHtml = fs.readFileSync(latestPath, "utf8");
latestHtml = latestHtml
  .replace(/href="\.\.\/archive\.html"/g, 'href="./archive.html"')
  .replace(/href="\.\/(\d{2})\.html"/g, `href="./${latest.date}/$1.html"`);
// Homepage-only entry to the trails favorites page (archive already links
// it). Injected only when trails.html exists, so a local build-site run
// without build-trails doesn't ship a dead link.
if (fs.existsSync(path.join(ROOT, "trails.html"))) {
  latestHtml = latestHtml.replace(
    "</body>",
    `  <a href="./trails.html" style="position:fixed;right:1rem;bottom:1rem;z-index:99;padding:0.5rem 0.95rem;border-radius:999px;background:#e85d04;color:#fff;font:600 0.85rem/1 'Noto Sans SC',system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.18)">🥾 徒步路线收藏</a>\n</body>`,
  );
  console.log(`[build-site] index.html += trails entry`);
}
if (fs.existsSync(path.join(ROOT, "weekly.html"))) {
  latestHtml = latestHtml.replace(
    "</body>",
    `  <a href="./weekly.html" style="position:fixed;right:1rem;bottom:3.6rem;z-index:99;padding:0.5rem 0.95rem;border-radius:999px;background:#0d9488;color:#fff;font:600 0.85rem/1 'Noto Sans SC',system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.18)">📊 周报</a>\n</body>`,
  );
  console.log(`[build-site] index.html += weekly entry`);
}
if (fs.existsSync(path.join(ROOT, "search.html"))) {
  latestHtml = latestHtml.replace(
    "</body>",
    `  <a href="./search.html" style="position:fixed;right:1rem;bottom:6.2rem;z-index:99;padding:0.5rem 0.95rem;border-radius:999px;background:#2563eb;color:#fff;font:600 0.85rem/1 'Noto Sans SC',system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.18)">🔍 搜索</a>\n</body>`,
  );
  console.log(`[build-site] index.html += search entry`);
}
latestHtml = latestHtml.replace(
  "</body>",
  `  <a href="${SUPRO_LINKS.badge}" target="_blank" rel="noopener" style="position:fixed;right:1rem;bottom:8.8rem;z-index:99;padding:0.5rem 0.95rem;border-radius:999px;background:#1e3a8a;color:#fff;font:600 0.85rem/1 'Noto Sans SC',system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.18)">🚀 量化实操·苏坡</a>\n</body>`,
);
console.log(`[build-site] index.html += supro entry`);
latestHtml = latestHtml.replace(
  "</body>",
  `  <a href="./subscribe.html" style="position:fixed;right:1rem;bottom:11.4rem;z-index:99;padding:0.5rem 0.95rem;border-radius:999px;background:#0f766e;color:#fff;font:600 0.85rem/1 'Noto Sans SC',system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.18)">✉️ 订阅</a>\n</body>`,
);
console.log(`[build-site] index.html += subscribe entry`);
fs.writeFileSync(path.join(ROOT, "index.html"), latestHtml, "utf8");
console.log(`[build-site] index.html  ← ${latest.rel}`);

const byDate = new Map();
for (const e of editions) {
  if (!byDate.has(e.date)) byDate.set(e.date, []);
  byDate.get(e.date).push(e);
}
const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));

// ---------------------------------------------------------------------------
// Archive governance: prune superseded *-articles.json sidecars older than
// PRUNE_ARTICLES_DAYS (default 30, 0 disables). gh-pages grows ~1.6MB/day
// and these re-fetchable sidecars are ~two thirds of it. Report JSONs and
// ALL HTML are never touched: gate catchup only checks today's sidecar,
// status.html reads 14 days, archive sizes are computed live.
// ---------------------------------------------------------------------------

const PRUNE_DAYS = Math.max(0, Number(process.env.PRUNE_ARTICLES_DAYS ?? 30) || 0);
const pruneStats = { removed: 0, bytes: 0, cutoff: "" };
if (PRUNE_DAYS > 0) {
  const cutoffMs = Date.now() - PRUNE_DAYS * 86_400_000;
  pruneStats.cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
  for (const d of dates) {
    const dayMs = Date.parse(`${d}T00:00:00+08:00`);
    if (!(dayMs < cutoffMs)) continue;
    const dir = path.join(ROOT, d);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith("-articles.json")) continue;
      const fp = path.join(dir, f);
      try {
        pruneStats.bytes += fs.statSync(fp).size;
        fs.unlinkSync(fp);
        pruneStats.removed++;
      } catch {
        // never fail the bake for cleanup
      }
    }
  }
  if (pruneStats.removed) {
    console.log(
      `[build-site] pruned ${pruneStats.removed} articles sidecars (< ${pruneStats.cutoff}, ${(pruneStats.bytes / 1048576).toFixed(1)} MB freed)`,
    );
  }
}


const dayBlocks = dates
  .map((d) => {
    const items = byDate
      .get(d)
      .slice()
      .sort((a, b) => {
        if (a.hour === "legacy") return 1;
        if (b.hour === "legacy") return -1;
        return a.hour.localeCompare(b.hour);
      });
    const links = items
      .map((e) => {
        const size = (fs.statSync(path.join(ROOT, e.rel)).size / 1024).toFixed(0);
        const name =
          e.hour === "legacy"
            ? "全日"
            : e.placeholder
              ? `${labelFor(e.hour)}（待更新）`
              : labelFor(e.hour);
        return `<a class="ed" href="./${e.rel}"><span class="ed-label">${name}</span><span class="ed-meta">${e.hour === "legacy" ? d : e.hour + ":00"} · ${size} KB</span></a>`;
      })
      .join("\n        ");
    return `    <section class="day">
      <h2>${d}</h2>
      <div class="eds">
        ${links}
      </div>
    </section>`;
  })
  .join("\n");

const archHeatLink = heatmapEmitted
  ? `\n   · <a class="home" href="./heatmap.html">热力图</a>`
  : "";
const archiveHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>OpenCool 归档</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Noto+Sans+SC:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg:#fff8f0; --fg:#1a1510; --muted:#7a6a5a; --accent:#e85d04; --card:#ffffff; --rule:#f0e0d0; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    font-family: "Noto Sans SC", "DM Sans", system-ui, sans-serif;
    background:
      radial-gradient(ellipse 80% 50% at 10% -10%, #ffe8cc 0%, transparent 55%),
      radial-gradient(ellipse 60% 40% at 100% 0%, #ffd6e7 0%, transparent 50%),
      var(--bg);
    color: var(--fg); line-height: 1.5;
  }
  main { max-width: 720px; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
  .brand { font-family: "DM Sans", sans-serif; font-weight: 700; font-size: 0.85rem;
    letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); }
  h1 { font-size: 2rem; margin: 0.4rem 0 0.3rem; letter-spacing: -0.03em; }
  .meta { color: var(--muted); margin-bottom: 2rem; }
  .day { margin-bottom: 1.75rem; }
  .day h2 { font-size: 0.95rem; color: var(--muted); font-weight: 600; margin: 0 0 0.6rem; }
  .eds { display: flex; flex-direction: column; gap: 0.45rem; }
  a.ed {
    display: flex; justify-content: space-between; align-items: baseline; gap: 1rem;
    padding: 0.85rem 1.1rem; background: var(--card); border-radius: 0.75rem;
    text-decoration: none; color: inherit; border: 1px solid var(--rule);
    box-shadow: 0 1px 0 rgba(232, 93, 4, 0.06);
  }
  a.ed:hover { border-color: var(--accent); }
  .ed-label { font-weight: 700; font-size: 1.05rem; }
  .ed-meta { font-size: 0.8rem; color: var(--muted); }
  .home { color: var(--accent); text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<main>
  <div class="brand">OpenCool</div>
  <h1>归档</h1>
  <p class="meta">${editions.length} 期 · 自 ${ARCHIVE_NORM_FROM} 起每日三报：早报 06:00 · 午报 13:00 · 晚报 19:00（上海时区）· 零 AI</p>
  <p><a class="home" href="./index.html">← 回到最新一期</a>
   · <a class="home" href="./trails.html">徒步路线收藏</a>
   · <a class="home" href="./weekly.html">周报</a>
   · <a class="home" href="./search.html">搜索</a>${archHeatLink}
   · <a class="home" href="./mcp-desk.html">机构数据台</a>
   · <a class="home" href="./supro.html">量化实操·SuPro</a>
   · <a class="home" href="./periods.html">趋势对比</a>
   · <a class="home" href="./subscribe.html">订阅</a>
   · <a class="home" href="./status.html">运行状态</a></p>
${dayBlocks}
</main>
</body>
</html>
`;

fs.writeFileSync(path.join(ROOT, "archive.html"), archiveHtml, "utf8");
console.log(`[build-site] archive.html (${dates.length} days, ${editions.length} editions)`);

// Trails page is generated by `npm run build-trails`. If it already exists
// (CI may run build-trails before build-site), keep it; otherwise leave a stub
// pointer so archive links do not 404 on fresh clones that skip trails.
const trailsPath = path.join(ROOT, "trails.html");
if (!fs.existsSync(trailsPath)) {
  console.log(
    `[build-site] trails.html missing — run \`npm run build-trails\` to generate favorites page`,
  );
}

// ---------------------------------------------------------------------------
// status.html — self-diagnostics dashboard (zero backend: reads the same
// daily_reports tree). Per-slot state = json sidecar (real edition) vs
// placeholder HTML vs missing; plus fetch_health telemetry from the latest
// real edition.
// ---------------------------------------------------------------------------

const STATE_META = {
  ok: { label: "已发布", color: "#15803d" },
  placeholder: { label: "占位/缺刊", color: "#d97706" },
  partial: { label: "HTML 无数据", color: "#b91c1c" },
  missing: { label: "未生成", color: "#9ca3af" },
};

function slotState(dir, hour) {
  if (fs.existsSync(path.join(ROOT, dir, `${hour}.json`))) return "ok";
  const htmlPath = path.join(ROOT, dir, `${hour}.html`);
  if (!fs.existsSync(htmlPath)) return "missing";
  return fs.readFileSync(htmlPath, "utf8").includes("尚未更新")
    ? "placeholder"
    : "partial";
}

function buildStatusHtml() {
  const dayDirs = dates.slice(0, 14);
  const matrixRows = dayDirs
    .map((d) => {
      const cells = slotHours
        .map((h) => {
          const st = slotState(d, h);
          const m = STATE_META[st];
          return `<td title="${d} ${h}:00 · ${m.label}" style="background:${m.color}"></td>`;
        })
        .join("");
      return `<tr><td class="s-date">${d}</td>${cells}</tr>`;
    })
    .join("\n");

  let healthBlock = `<p class="meta">暂无抓取遥测（今日尚未生成真实档）。</p>`;
  const healthPath = path.join(ROOT, latest.rel.replace(/\.html$/, ".json"));
  if (fs.existsSync(healthPath)) {
    try {
      const report = JSON.parse(fs.readFileSync(healthPath, "utf8"));
      const fh = report.fetch_health;
      if (fh?.entries?.length) {
        const okN = fh.entries.filter((e) => e.ok).length;
        const rows = [...fh.entries]
          .sort((a, b) => b.ms - a.ms)
          .map(
            (e) => `<tr>
              <td>${e.id}</td>
              <td class="${e.ok ? "" : "s-bad"}">${e.ok ? "✓" : "✗"}</td>
              <td>${(e.ms / 1000).toFixed(1)}s</td>
              <td>${e.count}</td>
              <td class="s-err">${e.error ? e.error.slice(0, 60) : ""}</td>
            </tr>`,
          )
          .join("\n");
        healthBlock = `
        <p class="meta">抓取遥测（最新一期 ${latest.date}/${latest.hour}）：${okN}/${fh.entries.length} 源成功。</p>
        <table class="s-table">
          <thead><tr><th>源</th><th>状态</th><th>耗时</th><th>条数</th><th>错误</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      }
    } catch {
      // health JSON unreadable — status page still renders the matrix
    }
  }

  // Sentiment trend block (from sentiment-history.json, if present)
  let sentiBlock = "";
  const historyPath = path.join(ROOT, "sentiment-history.json");
  if (fs.existsSync(historyPath)) {
    try {
      const hist = JSON.parse(fs.readFileSync(historyPath, "utf8"));
      const items = (hist.items ?? []).slice(-20);
      if (items.length) {
        const scores = items.map((i) => i.score);
        const w = 640;
        const hgt = 70;
        const min = Math.min(...scores, -20);
        const max = Math.max(...scores, 20);
        const span = Math.max(1, max - min);
        const pts = scores
          .map((v, i) => {
            const x = scores.length > 1 ? (i / (scores.length - 1)) * (w - 8) + 4 : w / 2;
            const y = hgt - 6 - ((v - min) / span) * (hgt - 12);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ");
        const stroke = scores[scores.length - 1] >= scores[0] ? "#15803d" : "#b91c1c";
        const recent = [...items]
          .reverse()
          .slice(0, 5)
          .map((i) => `${i.date.slice(5)} ${i.hour}:00 <b>${i.score > 0 ? "+" : ""}${i.score}</b>`)
          .join(" · ");
        sentiBlock = `<h2>情绪趋势（近 ${items.length} 档）</h2>
        <svg viewBox="0 0 ${w} ${hgt}" width="100%" height="${hgt}" role="img" aria-label="sentiment trend">
          <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
        </svg>
        <p class="meta">${recent}</p>`;
      }
    } catch {
      // unreadable history — block omitted
    }
  }

  const governanceLine = PRUNE_DAYS > 0
    ? `<p class="meta">归档治理：articles 侧车保留 ${PRUNE_DAYS} 天（截止 ${pruneStats.cutoff}，本次烘焙清理 ${pruneStats.removed} 个 / ${(pruneStats.bytes / 1048576).toFixed(1)} MB）。</p>`
    : `<p class="meta">归档治理：关闭（PRUNE_ARTICLES_DAYS=0）。</p>`;

  // Hot keywords block (reads keywords.json produced by npm run keywords:bake)
  let kwBlock = "";
  const kwPath = path.join(ROOT, "keywords.json");
  if (fs.existsSync(kwPath)) {
    try {
      const kw = JSON.parse(fs.readFileSync(kwPath, "utf8"));
      if (kw.items?.length) {
        const chips = kw.items
          .slice(0, 12)
          .map(
            (i) =>
              `<span class="senti-chip">${i.term} <b>${i.count}</b></span>`,
          )
          .join("");
        kwBlock = `<h2>近 ${kw.windowDays} 天热词（${kw.editions} 档）</h2>
        <div class="senti-drivers">${chips}</div>`;
      }
    } catch {
      // unreadable keywords.json — block omitted
    }
  }

  // Source health: consecutive all-fail days from sidecar fetch_health
  // (CI logs/ does not persist across runs — sidecars are the only
  // durable telemetry). >= SOURCE_STREAK_DISABLE days -> overlay file.
  const SOURCE_STREAK_DISABLE = 3;
  const srcStats = new Map(); // id -> {okDays, failDays, streak, lastErr}
  {
    const scanDays = dates.filter((d) => d >= new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
    const perDay = []; // newest first: Map(id -> {ok, fail})
    for (const d of scanDays) {
      const dayMap = new Map();
      for (const h of slotHours) {
        const fp = path.join(ROOT, d, `${h}.json`);
        if (!fs.existsSync(fp)) continue;
        try {
          const r = JSON.parse(fs.readFileSync(fp, "utf8"));
          for (const e of r?.fetch_health?.entries ?? []) {
            const cur = dayMap.get(e.id) ?? { ok: 0, fail: 0 };
            if (e.ok) cur.ok++;
            else cur.fail++;
            dayMap.set(e.id, cur);
          }
        } catch {
          // skip unreadable
        }
      }
      if (dayMap.size) perDay.push(dayMap);
    }
    for (const dayMap of perDay) {
      for (const [id, st] of dayMap) {
        const agg = srcStats.get(id) ?? { okDays: 0, failDays: 0, streak: 0, lastErr: "" };
        if (st.ok > 0) {
          agg.okDays++;
          agg.streak = 0;
        } else {
          agg.failDays++;
          agg.streak++;
        }
        srcStats.set(id, agg);
      }
    }
  }
  const srcRows = [...srcStats.entries()]
    .map(([id, st]) => ({ id, ...st }))
    .sort((a, b) => b.streak - a.streak || a.id.localeCompare(b.id));
  const overlayDisabled = srcRows
    .filter((r) => r.streak >= SOURCE_STREAK_DISABLE)
    .map((r) => ({ id: r.id, reason: `all-editions failed ${r.streak} straight days`, since: pruneStats.cutoff || new Date().toISOString().slice(0, 10) }));
  const overlayPayload = {
    generatedAt: new Date().toISOString(),
    note: "generated by build-site; delete entries (or the file) to re-enable — sources.config.json is never modified",
    disabled: overlayDisabled,
  };
  if (overlayDisabled.length) {
    fs.writeFileSync(
      path.join(ROOT, "source-overlay.json"),
      JSON.stringify(overlayPayload, null, 2) + "\n",
      "utf8",
    );
    console.log(
      `[build-site] source-overlay.json: disabled ${overlayDisabled.map((d) => d.id).join(",")}`,
    );
  } else if (fs.existsSync(path.join(ROOT, "source-overlay.json"))) {
    fs.rmSync(path.join(ROOT, "source-overlay.json"));
    console.log("[build-site] source-overlay.json cleared (no streaks)");
  }
  const srcTable = srcRows.length
    ? `<table class="s-table">
        <thead><tr><th>源</th><th>近7天</th><th>连续全败</th><th></th></tr></thead>
        <tbody>${srcRows
          .map(
            (r) => `<tr><td>${r.id}</td>
            <td>${r.okDays}好/${r.failDays}败</td>
            <td>${r.streak}</td>
            <td>${r.streak >= SOURCE_STREAK_DISABLE ? '<span class="s-bad">已入 overlay 禁用</span>' : r.streak >= 2 ? '<span style="color:#d97706">观察</span>' : ""}</td></tr>`,
          )
          .join("")}</tbody>
      </table>`
    : `<p class="meta">近 7 天无抓取遥测。</p>`;

  const legend = Object.values(STATE_META)
    .map((m) => `<span class="s-leg"><i style="background:${m.color}"></i>${m.label}</span>`)
    .join("");
  const headCells = slotHours.map((h) => `<th>${h}:00</th>`).join("");
  const statusHeatLink = heatmapEmitted
    ? `\n   · <a class="home" href="./heatmap.html">热力图</a>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCool · 运行状态</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Noto+Sans+SC:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg:#fff8f0; --fg:#1a1510; --muted:#7a6a5a; --accent:#e85d04; --card:#fff; --rule:#f0e0d0; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; font-family:"Noto Sans SC","DM Sans",system-ui,sans-serif;
    background: radial-gradient(ellipse 80% 50% at 10% -10%, #ffe8cc 0%, transparent 55%),
      radial-gradient(ellipse 60% 40% at 100% 0%, #ffd6e7 0%, transparent 50%), var(--bg);
    color:var(--fg); line-height:1.5; }
  main { max-width:760px; margin:0 auto; padding:3rem 1.5rem 4rem; }
  .brand { font-family:"DM Sans",sans-serif; font-weight:700; font-size:.85rem; letter-spacing:.12em;
    text-transform:uppercase; color:var(--accent); }
  h1 { font-size:2rem; margin:.4rem 0 .3rem; letter-spacing:-.03em; }
  h2 { font-size:1.05rem; margin:2rem 0 .7rem; }
  .meta { color:var(--muted); }
  .s-leg { display:inline-flex; align-items:center; gap:.35rem; margin-right:1rem; font-size:.85rem; color:var(--muted); }
  .s-leg i { width:.8rem; height:.8rem; border-radius:3px; display:inline-block; }
  .s-table { border-collapse:collapse; width:100%; background:var(--card); border-radius:.75rem; overflow:hidden; }
  .s-table th, .s-table td { text-align:left; padding:.5rem .8rem; border-bottom:1px solid var(--rule); font-size:.85rem; }
  .s-table th { color:var(--muted); font-weight:600; }
  .s-bad { color:#b91c1c; font-weight:700; }
  .s-err { color:var(--muted); max-width:14rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .m-table { border-collapse:collapse; background:var(--card); border-radius:.75rem; overflow:hidden; }
  .m-table th { color:var(--muted); font-weight:600; font-size:.8rem; padding:.4rem .7rem; }
  .m-table td { padding:0; }
  .m-table td[style] { width:3.2rem; height:1.5rem; }
  .s-date { font-size:.8rem; color:var(--muted); padding-right:.8rem !important; }
  .home { color:var(--accent); text-decoration:none; font-weight:600; }
</style>
</head>
<body>
<main>
  <div class="brand">OpenCool</div>
  <h1>运行状态</h1>
  <p class="meta">发布矩阵（近 ${dayDirs.length} 天 × ${slotHours.length} 档）· 数据侧车判定，占位页不冒充真档</p>
  ${governanceLine}
  <p>${legend}</p>
  <table class="m-table">
    <thead><tr><th></th>${headCells}</tr></thead>
    <tbody>${matrixRows}</tbody>
  </table>
  ${sentiBlock}
  ${kwBlock}
  <h2>抓取健康（最新一期）</h2>
  ${healthBlock}
  <h2>源健康（近 7 天趋势 + 自动禁用）</h2>
  ${srcTable}
  <p class="meta">连续 ${3} 天全档失败的源写入 source-overlay.json（运行时禁用，config 永不改动；删除条目即恢复）。</p>
  <p style="margin-top:2rem"><a class="home" href="./index.html">← 回到最新一期</a>
   · <a class="home" href="./archive.html">历史归档</a>
   · <a class="home" href="./trails.html">徒步路线收藏</a>${statusHeatLink}
   · <a class="home" href="./mcp-desk.html">机构数据台</a></p>
  <p class="meta tiny">本页由 build-site 自动生成 · ${new Date().toISOString()}</p>
</main>
</body>
</html>
`;
}

fs.writeFileSync(path.join(ROOT, "status.html"), buildStatusHtml(), "utf8");
console.log(`[build-site] status.html (${dates.slice(0, 14).length}-day matrix)`);

// ---------------------------------------------------------------------------
// sentiment-history.json — rolling sentiment scores (newest 60 real
// editions). The gh-pages restore step runs before `npm run daily`, so
// build-site sees the full restored tree; this file is the ecosystem
// data product (SuPro/agents read it directly).
// ---------------------------------------------------------------------------

const HISTORY_CAP = 60;
const historyItems = [];
// dates is newest-first; iterate oldest-first with in-day slot order so
// the array is truly chronological (golden test caught this ordering bug).
const ascDates = [...dates].reverse();
for (const d of ascDates) {
  if (historyItems.length >= HISTORY_CAP) break;
  for (const h of slotHours) {
    if (historyItems.length >= HISTORY_CAP) break;
    const sidecar = path.join(ROOT, d, `${h}.json`);
    if (!fs.existsSync(sidecar)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(sidecar, "utf8"));
      const sen = r?.sentiment;
      if (sen && typeof sen.score === "number") {
        historyItems.push({
          date: d,
          hour: h,
          score: sen.score,
          label: sen.label ?? null,
          posHits: sen.posHits ?? null,
          negHits: sen.negHits ?? null,
          scanned: sen.scanned ?? null,
          percentile: sen.percentile ?? null,
        });
      }
    } catch {
      // unreadable sidecar — skip
    }
  }
}
const historyPayload = {
  generatedAt: new Date().toISOString(),
  source: "build-site",
  cap: HISTORY_CAP,
  count: historyItems.length,
  items: historyItems,
};
// ---------------------------------------------------------------------------
// feed.xml (RSS 2.0, real editions only) + llms.txt (agent discovery)
// ---------------------------------------------------------------------------

const SITE_URL = "https://fudan2026.github.io/opencool";
const realForFeed = editions
  .filter((e) => !e.placeholder && e.hour !== "legacy")
  .slice(0, 30);
function rfc822(d, hour) {
  return new Date(`${d}T${hour}:00:00+08:00`).toUTCString();
}
const feedItems = realForFeed
  .map(
    (e) => `    <item>
      <title>OpenCool ${labelFor(e.hour)} · ${e.date} ${e.hour}:00</title>
      <link>${SITE_URL}/${e.rel}</link>
      <guid isPermaLink="true">${SITE_URL}/${e.rel}</guid>
      <pubDate>${rfc822(e.date, e.hour)}</pubDate>
    </item>`,
  )
  .join("\n");
const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>OpenCool 中文财经三报</title>
    <link>${SITE_URL}/</link>
    <description>零 AI · 零 API Token 的中文财经早/午/晚报（上海时区 06/13/19），含词典市场情绪计。</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <language>zh-CN</language>
${feedItems}
  </channel>
</rss>
`;
fs.writeFileSync(path.join(ROOT, "feed.xml"), feedXml, "utf8");
console.log(`[build-site] feed.xml (${realForFeed.length} real editions)`);

const llmsHeatRow = heatmapEmitted
  ? "- Sector heatmap: /heatmap.html — watchlist tiles colored by pct1Day (latest edition)\n"
  : "";
const llmsTxt = `# OpenCool

Zero-AI, zero-token CN finance triple brief (Shanghai 06:00/13:00/19:00),
statically published on GitHub Pages. Dictionary sentiment gauge included.
No LLM behind any endpoint.

## Data products (JSON)

- Latest edition: /<YYYY-MM-DD>/<HH>.json — DailyReport (hero_headline,
  daily_overview, finance/politics/tech_briefs, sentiment{score,label,
  sectors,percentile}, quant{market,fundFlows,events}, trading, fetch_health)
- Sentiment history: /sentiment-history.json — rolling newest-60 editions,
  chronological items {date,hour,score,label,posHits,negHits,scanned,percentile}
- Keyword heat: /keywords.json — 7-day keyword frequency
  {term,count,firstSeen,lastSeen}, stopword-cleaned
- Weekly review: /weekly.html + /weekly.json — 7-day sentiment curve,
  sector averages, top events, index averages (baked when >= 5 days)
- Search: /search.html + /search-index.json — inverted index
  {docs:[{d,h,t}],postings:{token:[docIdx...]}} over all real editions;
  tokens = CJK bigrams + ascii words (>=3 chars, stopword-filtered)
- MCP tools (local): list_watchlist (synced with the pipeline watchlist),
  get_quote, get_kline, market_overview, sentiment_query, sentiment_trend,
  search_editions
- Theme heat: /themes.json — 24 curated themes: board heat + top
  constituents + per-edition article hits
- Story ledger: /stories.json — point-in-time story records with a stable id,
  firstSeenAt (when WE observed it, not the feed's pubDate), every later
  sighting, headline revision trails, and a per-wire first-mover ranking
  (contestedFirsts = earliest AND followed; leads are measured between our
  fetches, so the granularity is the edition cadence)
- Dragon-tiger list: /lhb.json — top movers by net amount (previous
  trading day)
- MCP desk: /mcp-desk.html — operator-baked institutional snapshot
  (macro, index valuations, THS×Wind dual-source cross-check, funds,
  day headlines), every row source-attributed for verification
- Sister project: /supro.html — SuPro (supro.si): AI/Agent product
  directory, 苏坡大模型 DeepSeek AIaaS, quant + paper practice. The
  news→practice funnel: OpenCool informs, SuPro practices
- Trend comparison: /periods.html + /periods.json — WoW (6 Monday-based
  weeks) and MoM (3 months) buckets of sentiment/theme/index deltas
- Subscribe: /subscribe.html — local-only subscription intent (no email
  leaves the browser unless SUBSCRIBE_ENDPOINT is explicitly configured)
${llmsHeatRow}- Static MCP manifest: /tools.json — every MCP tool mapped to a static
  endpoint (see /ai-instructions.html for agent onboarding)
- Attribution: when citing, attribute "OpenCool (URL)". License MIT.
- Competitive analysis: docs/COMPETITIVE-ANALYSIS.md (repo source)
- Status dashboard: /status.html — publish matrix (14d) + fetch health
- RSS: /feed.xml — newest 30 real editions (placeholders never included)
- Archive: /archive.html · Home: /index.html

## Conventions

- Placeholder pages contain 尚未更新 and have NO <HH>.json sidecar —
  check the sidecar to distinguish real editions.
- REPORT_TZ=Asia/Shanghai. All times Shanghai.
- License MIT. Repo: https://github.com/Fudan2026/opencool
`;
fs.writeFileSync(path.join(ROOT, "llms.txt"), llmsTxt, "utf8");
console.log(`[build-site] llms.txt`);

fs.writeFileSync(
  path.join(ROOT, "sentiment-history.json"),
  JSON.stringify(historyPayload, null, 2) + "\n",
  "utf8",
);
console.log(
  `[build-site] sentiment-history.json (${historyItems.length} editions)`,
);
fs.writeFileSync(path.join(ROOT, ".nojekyll"), "", "utf8");
console.log(`[build-site] .nojekyll`);
