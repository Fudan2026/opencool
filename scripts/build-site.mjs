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
   · <a class="home" href="./trails.html">徒步路线收藏</a></p>
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
