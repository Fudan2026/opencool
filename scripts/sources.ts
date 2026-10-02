/**
 * Source-config CLI. Jobs:
 *
 *   npm run sources           - list sources + source-health suggest-disable
 *   npm run sources:check     - validation only, exit 1 on schema errors
 *   npm run sources -- health - health report only (also runs as part of list)
 *
 * Adding / removing / disabling sources: edit sources.config.json directly.
 * This CLI NEVER mutates the registry.
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";

import { loadAllSources, REPORT_LOCALE } from "../lib/sources/registry";
import type { SourceDef } from "../lib/sources/types";

const arg = process.argv[2];
const STREAK_N = Number(process.env.SOURCE_FAIL_STREAK || 3) || 3;
const LOG_DIR = "logs";
const HEALTH_PATH = path.join(LOG_DIR, "source-health.json");

function pad(s: string | undefined, n: number): string {
  const v = s ?? "";
  if (v.length >= n) return v.slice(0, n);
  return v + " ".repeat(n - v.length);
}

function localesLabel(s: SourceDef): string {
  const ls = s.locales ?? ["zh", "en"];
  if (ls.length === 2) return "zh+en";
  return ls[0];
}

function statusIcon(s: SourceDef): string {
  if (s.enabled === false) return "✗";
  const ls = s.locales ?? ["zh", "en"];
  return ls.includes(REPORT_LOCALE) ? "✓" : "·";
}

function list(all: SourceDef[]): void {
  console.log("");
  console.log(`Source registry  (REPORT_LOCALE=${REPORT_LOCALE})`);
  console.log("");
  console.log(`  ✓ = active in current locale       ✗ = disabled`);
  console.log(`  · = enabled but filtered out by REPORT_LOCALE\n`);

  const byCat = new Map<string, SourceDef[]>();
  for (const s of all) {
    const arr = byCat.get(s.category) ?? [];
    arr.push(s);
    byCat.set(s.category, arr);
  }

  for (const [cat, list] of [...byCat.entries()].sort()) {
    console.log(`── ${cat} ─────────────────────────────────────`);
    console.log(
      `   ${pad("id", 24)} ${pad("name", 24)} ${pad("subcategory", 18)} ${pad("locales", 8)} type`,
    );
    for (const s of list) {
      console.log(
        `${statusIcon(s)}  ${pad(s.id, 24)} ${pad(s.name, 24)} ${pad(s.subcategory, 18)} ${pad(localesLabel(s), 8)} ${s.type}`,
      );
    }
    console.log("");
  }

  const total = all.length;
  const enabled = all.filter((s) => s.enabled !== false).length;
  const activeInLocale = all.filter((s) => {
    if (s.enabled === false) return false;
    const ls = s.locales ?? ["zh", "en"];
    return ls.includes(REPORT_LOCALE);
  }).length;

  console.log(`总计: ${total} 个 · enabled: ${enabled} · 当前 locale 有效: ${activeInLocale}`);
  console.log("");
  console.log(`改源配置: 直接编辑 sources.config.json（JSON 数组）`);
  console.log(`切 locale: 在 .env.local 设 REPORT_LOCALE=en (默认 zh)`);
  console.log("");
}

interface SourceHealthEntry {
  id: string;
  /** Chronological outcomes from newest log last: "ok" | "fail" */
  recent: ("ok" | "fail")[];
  failStreak: number;
  suggestDisable: boolean;
}

interface SourceHealthReport {
  generatedAt: string;
  streakThreshold: number;
  logsScanned: string[];
  sources: SourceHealthEntry[];
}

/**
 * Parse daily-*.log lines like:
 *   `  source-id             12`  → ok
 *   `  source-id             FAILED — ...` → fail
 */
function parseDailyLogs(allIds: Set<string>): {
  bySource: Map<string, ("ok" | "fail")[]>;
  logsScanned: string[];
} {
  const bySource = new Map<string, ("ok" | "fail")[]>();
  const logsScanned: string[] = [];
  if (!fs.existsSync(LOG_DIR)) {
    return { bySource, logsScanned };
  }
  const files = fs
    .readdirSync(LOG_DIR)
    .filter((f) => /^daily-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .sort();
  // Keep last 14 logs
  const recent = files.slice(-14);
  for (const f of recent) {
    logsScanned.push(f);
    const text = fs.readFileSync(path.join(LOG_DIR, f), "utf8");
    const seen = new Set<string>();
    for (const line of text.split("\n")) {
      // Match "  id...<spaces>N" or "  id...<spaces>FAILED"
      const m = line.match(/^\s{2}([a-z0-9][a-z0-9_-]+)\s+(FAILED|\d+)/i);
      if (!m) continue;
      const id = m[1];
      if (!allIds.has(id)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      const outcome: "ok" | "fail" = /FAILED/i.test(m[2]) ? "fail" : "ok";
      const arr = bySource.get(id) ?? [];
      arr.push(outcome);
      bySource.set(id, arr);
    }
  }
  return { bySource, logsScanned };
}

function buildHealth(all: SourceDef[]): SourceHealthReport {
  const ids = new Set(all.map((s) => s.id));
  const { bySource, logsScanned } = parseDailyLogs(ids);
  const sources: SourceHealthEntry[] = [];
  for (const s of all) {
    const recent = bySource.get(s.id) ?? [];
    let failStreak = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i] === "fail") failStreak++;
      else break;
    }
    sources.push({
      id: s.id,
      recent,
      failStreak,
      suggestDisable: failStreak >= STREAK_N && s.enabled !== false,
    });
  }
  sources.sort((a, b) => b.failStreak - a.failStreak || a.id.localeCompare(b.id));
  return {
    generatedAt: new Date().toISOString(),
    streakThreshold: STREAK_N,
    logsScanned,
    sources,
  };
}

function printHealth(report: SourceHealthReport): void {
  console.log("");
  console.log(
    `Source health  (streak≥${report.streakThreshold} → suggest-disable; never auto-edits config)`,
  );
  console.log(
    `  logs scanned: ${report.logsScanned.length ? report.logsScanned.join(", ") : "(none)"}`,
  );
  console.log("");
  const suggest = report.sources.filter((s) => s.suggestDisable);
  if (suggest.length === 0) {
    console.log("  (no suggest-disable candidates)");
  } else {
    for (const s of suggest) {
      console.log(
        `  suggest-disable  ${pad(s.id, 24)} failStreak=${s.failStreak}  recent=[${s.recent.slice(-5).join(",")}]`,
      );
    }
  }
  console.log("");
  console.log(`  sidecar: ${HEALTH_PATH}`);
  console.log("");
}

function writeHealth(report: SourceHealthReport): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify(report, null, 2), "utf8");
  } catch (e) {
    console.warn(
      `[sources] could not write ${HEALTH_PATH}: ${e instanceof Error ? e.message : e}`,
    );
  }
}

async function main(): Promise<void> {
  let all: SourceDef[];
  try {
    all = loadAllSources();
  } catch (e) {
    console.error(`✗ sources.config.json validation failed:`);
    console.error(`  ${(e as Error).message}`);
    process.exit(1);
  }

  if (arg === "check") {
    console.log(`✓ sources.config.json OK (${all.length} sources)`);
    return;
  }

  if (arg !== "health") {
    list(all);
  }

  const report = buildHealth(all);
  writeHealth(report);
  printHealth(report);
}

main();
