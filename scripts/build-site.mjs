#!/usr/bin/env node
/**
 * Build the static site for GitHub Pages.
 * Run AFTER `npm run daily` has produced at least one edition.
 *
 * Discovers:
 *   - New: daily_reports/<YYYY-MM-DD>/(06|13|19).html  (triple brief)
 *   - Legacy: daily_reports/<YYYY-MM-DD>/<YYYY-MM-DD>.html
 *
 * Writes:
 *   - index.html   = latest edition
 *   - archive.html = grouped list (早报/午报/晚报)
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = "daily_reports";
const SLOT_RE = /^(0[6]|13|19|\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const LABEL = {
  "06": "早报",
  13: "午报",
  19: "晚报",
};

function labelFor(hour) {
  return LABEL[hour] || `${hour}:00`;
}

if (!fs.existsSync(ROOT)) {
  console.error(`[build-site] ${ROOT}/ doesn't exist — run \`npm run daily\` first.`);
  process.exit(1);
}

/** @type {{ date: string, hour: string, rel: string, mtime: number }[]} */
const editions = [];

for (const d of fs.readdirSync(ROOT)) {
  if (!DATE_RE.test(d)) continue;
  const dir = path.join(ROOT, d);
  if (!fs.statSync(dir).isDirectory()) continue;

  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".html")) continue;
    const base = f.slice(0, -5);
    // slot file: 06.html / 13.html / 19.html
    if (/^\d{2}$/.test(base) && base !== d) {
      const full = path.join(dir, f);
      editions.push({
        date: d,
        hour: base,
        rel: `${d}/${f}`,
        mtime: fs.statSync(full).mtimeMs,
      });
      continue;
    }
    // legacy single-day file
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

if (editions.length === 0) {
  console.error(`[build-site] no edition HTML found in ${ROOT}/`);
  process.exit(1);
}

const latest = editions[0];
const latestPath = path.join(ROOT, latest.rel);
let latestHtml = fs.readFileSync(latestPath, "utf8");
// When copied to site root, fix archive + sibling links that assume ../
latestHtml = latestHtml
  .replace(/href="\.\.\/archive\.html"/g, 'href="./archive.html"')
  .replace(/href="\.\/(\d{2})\.html"/g, `href="./${latest.date}/$1.html"`);
fs.writeFileSync(path.join(ROOT, "index.html"), latestHtml, "utf8");
console.log(`[build-site] index.html  ← ${latest.rel}`);

// Group by date for archive
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
          e.hour === "legacy" ? "全日" : labelFor(e.hour);
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
  :root {
    --bg: #fff8f0;
    --fg: #1a1510;
    --muted: #7a6a5a;
    --accent: #e85d04;
    --card: #ffffff;
    --rule: #f0e0d0;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    font-family: "Noto Sans SC", "DM Sans", system-ui, sans-serif;
    background:
      radial-gradient(ellipse 80% 50% at 10% -10%, #ffe8cc 0%, transparent 55%),
      radial-gradient(ellipse 60% 40% at 100% 0%, #ffd6e7 0%, transparent 50%),
      var(--bg);
    color: var(--fg);
    line-height: 1.5;
  }
  main { max-width: 720px; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
  .brand {
    font-family: "DM Sans", sans-serif;
    font-weight: 700;
    font-size: 0.85rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
  }
  h1 { font-size: 2rem; margin: 0.4rem 0 0.3rem; letter-spacing: -0.03em; }
  .meta { color: var(--muted); margin-bottom: 2rem; }
  .day { margin-bottom: 1.75rem; }
  .day h2 {
    font-size: 0.95rem;
    color: var(--muted);
    font-weight: 600;
    margin: 0 0 0.6rem;
  }
  .eds { display: flex; flex-direction: column; gap: 0.45rem; }
  a.ed {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    padding: 0.85rem 1.1rem;
    background: var(--card);
    border-radius: 0.75rem;
    text-decoration: none;
    color: inherit;
    border: 1px solid var(--rule);
    box-shadow: 0 1px 0 rgba(232, 93, 4, 0.06);
    transition: transform 0.15s ease, border-color 0.15s ease;
  }
  a.ed:hover { transform: translateY(-1px); border-color: var(--accent); }
  .ed-label { font-weight: 700; font-size: 1.05rem; }
  .ed-meta { font-size: 0.8rem; color: var(--muted); }
  .home { color: var(--accent); text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<main>
  <div class="brand">OpenCool</div>
  <h1>归档</h1>
  <p class="meta">${editions.length} 期 · 早报 06:00 · 午报 13:00 · 晚报 19:00（上海时区）</p>
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
