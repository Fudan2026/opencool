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

const latestPath = path.join(ROOT, latest.rel);
let latestHtml = fs.readFileSync(latestPath, "utf8");
latestHtml = latestHtml
  .replace(/href="\.\.\/archive\.html"/g, 'href="./archive.html"')
  .replace(/href="\.\/(\d{2})\.html"/g, `href="./${latest.date}/$1.html"`);
fs.writeFileSync(path.join(ROOT, "index.html"), latestHtml, "utf8");
console.log(`[build-site] index.html  ← ${latest.rel}`);

const byDate = new Map();
for (const e of editions) {
  if (!byDate.has(e.date)) byDate.set(e.date, []);
  byDate.get(e.date).push(e);
}
const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));

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
  <p><a class="home" href="./index.html">← 回到最新一期</a></p>
${dayBlocks}
</main>
</body>
</html>
`;

fs.writeFileSync(path.join(ROOT, "archive.html"), archiveHtml, "utf8");
console.log(`[build-site] archive.html (${dates.length} days, ${editions.length} editions)`);

fs.writeFileSync(path.join(ROOT, ".nojekyll"), "", "utf8");
console.log(`[build-site] .nojekyll`);
