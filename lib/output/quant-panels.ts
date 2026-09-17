/**
 * Retail quant / school / knowledge HTML panels (zero LLM).
 */

import type { QuantSection } from "../invest/types";
import { SCHOOL_LESSONS } from "../invest/school";
import { KNOWLEDGE } from "../invest/knowledge";
import { RISK_GATES, BACKTEST_VERDICT_TEMPLATE } from "../invest/risk-gates";
import { PERSONAS } from "../invest/personas";
import type { TickerAnalysis } from "../trading/signals";
import type { TradingSection } from "../ai/pipeline";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function sparklineSvg(closes: number[] | undefined): string {
  if (!closes || closes.length < 2) return "";
  const w = 120;
  const h = 36;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const pts = closes
    .map((c, i) => {
      const x = (i / (closes.length - 1)) * w;
      const y = h - ((c - min) / span) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = closes[closes.length - 1] >= closes[0];
  const stroke = up ? "#15803d" : "#b91c1c";
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline fill="none" stroke="${stroke}" stroke-width="1.5" points="${pts}"/></svg>`;
}

export function renderReviewPanel(quant?: QuantSection): string {
  if (!quant) {
    return `<p class="empty">今日复盘数据尚未生成。</p>`;
  }
  const idx = quant.market?.indices ?? [];
  const idxHtml = idx.length
    ? `<div class="idx-grid">${idx
        .map((i) => {
          const cls = i.changePct >= 0 ? "positive" : "negative";
          const sign = i.changePct >= 0 ? "+" : "";
          return `<div class="idx-card"><div class="idx-name">${esc(i.name)}</div>
            <div class="idx-price">${i.price.toFixed(2)}</div>
            <div class="ticker-pct ${cls}">${sign}${i.changePct.toFixed(2)}%</div></div>`;
        })
        .join("")}</div>
        <p class="muted">${esc(quant.market?.note ?? "")}</p>`
    : `<p class="empty">指数快照暂不可用（免费接口失败时跳过）。</p>`;

  const ev = quant.events;
  const evHtml = ev.length
    ? `<ul class="event-list">${ev
        .map(
          (e) =>
            `<li><span class="ev-sym">${esc(e.displayName)}</span>
            <a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>
            <span class="muted">· ${esc(e.source)} · 命中「${esc(e.matched)}」</span></li>`,
        )
        .join("")}</ul>`
    : `<p class="empty">今日新闻标题未命中观察池简称/代码 —— 空栏不灌娱乐。</p>`;

  return `<div class="quant-block">
    <h2 class="panel-h">大盘快照</h2>${idxHtml}
    <h2 class="panel-h">事件驱动（标题命中观察池）</h2>${evHtml}
  </div>`;
}

export function renderTechReadPanel(trading?: TradingSection): string {
  if (!trading?.tickers?.length) {
    return `<p class="empty">技术面数据尚未生成。</p>`;
  }
  const focus = trading.tickers.filter(
    (t) =>
      t.group === "china-ashare" ||
      t.group === "china-etf" ||
      t.group === "macro",
  );
  const list = (focus.length ? focus : trading.tickers).slice(0, 16);
  const cards = list
    .map((t) => {
      const spark = sparklineSvg(t.closesSpark);
      const sig = t.signals
        .slice(0, 4)
        .map((s) => `<span class="signal-pill">${esc(s.label)}</span>`)
        .join("");
      return `<article class="ticker-card">
        <h3>${esc(t.displayName)} <span class="muted">${esc(t.symbol)}</span></h3>
        ${spark}
        <p>收盘 ${t.currentPrice.toFixed(2)} · RSI ${t.rsi14?.toFixed(1) ?? "—"} · 趋势 ${esc(t.trend)}</p>
        <div>${sig}</div>
        <p class="muted tiny">仅用历史收盘计算 · 无未来函数 · 非投资建议</p>
      </article>`;
    })
    .join("");
  return `<div class="quant-block">
    <p class="lede">迷你走势帮助散户建立「位置感」：金叉/死叉/超买是描述词，不是自动买卖指令。详见散户学堂。</p>
    <div class="ticker-grid">${cards}</div>
  </div>`;
}

export function renderPersonasPanel(quant?: QuantSection): string {
  if (!quant?.personas?.length) {
    return `<p class="empty">大师视角尚未生成（需行情数据）。</p>`;
  }
  const intro = `<p class="lede">规则化人格对照（蒸馏公开投资 checklist），<strong>零 LLM</strong>。字段有限时分数仅供教学，不是荐股。</p>
    <div class="persona-legend">${PERSONAS.map((p) => `<span title="${esc(p.blurb)}">${esc(p.name)}</span>`).join(" · ")}</div>`;
  const byP = new Map<string, typeof quant.personas>();
  for (const s of quant.personas) {
    const arr = byP.get(s.personaId) ?? [];
    arr.push(s);
    byP.set(s.personaId, arr);
  }
  const blocks = [...byP.entries()]
    .map(([id, rows]) => {
      const name = rows[0]?.personaName ?? id;
      const lis = rows
        .map(
          (r) =>
            `<li><span class="verdict v-${r.verdict}">${r.verdict}</span>
            ${esc(r.displayName)} <b>${r.score}</b>
            <span class="muted">${esc(r.notes[0] ?? "")}</span></li>`,
        )
        .join("");
      return `<div class="persona-block"><h3>${esc(name)}</h3><ul>${lis}</ul></div>`;
    })
    .join("");
  return `<div class="quant-block">${intro}${blocks}</div>`;
}

export function renderRiskPanel(): string {
  const gates = RISK_GATES.map(
    (g) =>
      `<article class="risk-card v-${g.level}">
        <header><span class="verdict v-${g.level}">${g.level}</span> <strong>${esc(g.title)}</strong></header>
        <p class="th">${esc(g.threshold)}</p>
        <p class="muted">${esc(g.why)}</p>
      </article>`,
  ).join("");
  const tmpl = `<div class="risk-template"><h3>${esc(BACKTEST_VERDICT_TEMPLATE.title)}</h3>
    <ul>${BACKTEST_VERDICT_TEMPLATE.fields.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
    <p class="muted">${esc(BACKTEST_VERDICT_TEMPLATE.note)}</p></div>`;
  return `<div class="quant-block"><p class="lede">蒸馏自量化风控 Skill · 教学向 · 本站不代下单。</p>
    <div class="risk-grid">${gates}</div>${tmpl}</div>`;
}

export function renderSchoolPanel(): string {
  return `<div class="quant-block school">
    ${SCHOOL_LESSONS.map(
      (l) =>
        `<article class="lesson"><span class="lvl">${esc(l.level)}</span>
        <h3>${esc(l.title)}</h3><p>${esc(l.body)}</p></article>`,
    ).join("")}
  </div>`;
}

export function renderKnowledgePanel(): string {
  const data = JSON.stringify(
    KNOWLEDGE.map((k) => ({
      id: k.id,
      term: k.term,
      aliases: k.aliases ?? [],
      body: k.body,
      tags: k.tags,
    })),
  ).replace(/</g, "\\u003c");
  return `<div class="quant-block knowledge">
    <p class="lede">内置投研词条 · 客户端检索 · 无付费实时流。</p>
    <input type="search" id="kb-q" placeholder="搜索：PE、北向、未来函数…" autocomplete="off"/>
    <div id="kb-results" class="kb-results"></div>
    <script type="application/json" id="kb-data">${data}</script>
  </div>`;
}

export function renderMcpHelpPanel(): string {
  return `<div class="quant-block">
    <h2 class="panel-h">开放 MCP（本地）</h2>
    <p>GitHub Pages 只托管静态简报。若要让 Cursor / Claude 调 A 股工具，在仓库根目录启动：</p>
    <pre class="code">cd mcp && npm install && npm start</pre>
    <p>工具：<code>list_watchlist</code> · <code>get_quote</code> · <code>get_kline</code> · <code>market_overview</code></p>
    <p class="muted">蒸馏东方财富/公开行情思路 · 免费延时 · 需本机网络 · 不构成投资建议。</p>
  </div>`;
}

/** Attach sparkline markup helper for trading ticker cards. */
export function sparklineForTicker(t: TickerAnalysis): string {
  return sparklineSvg(t.closesSpark);
}
