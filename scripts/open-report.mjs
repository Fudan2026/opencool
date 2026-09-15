#!/usr/bin/env node
/**
 * Open the latest edition HTML in a browser.
 *
 * Usage:
 *   node scripts/open-report.mjs
 *   node scripts/open-report.mjs 2026-09-15
 *   node scripts/open-report.mjs 2026-09-15 13
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const reportsDir = path.join(projectRoot, "daily_reports");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function listEditionsInDir(dateDir, date) {
  if (!fs.existsSync(dateDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dateDir)) {
    if (!f.endsWith(".html")) continue;
    const base = f.slice(0, -5);
    if (/^\d{2}$/.test(base)) {
      out.push({ hour: base, file: path.join(dateDir, f) });
    } else if (base === date) {
      out.push({ hour: "legacy", file: path.join(dateDir, f) });
    }
  }
  return out.sort((a, b) => b.hour.localeCompare(a.hour));
}

function pickReport(dateArg, hourArg) {
  if (!fs.existsSync(reportsDir)) {
    throw new Error(`No daily_reports directory at ${reportsDir}`);
  }
  if (dateArg) {
    const dateDir = path.join(reportsDir, dateArg);
    const eds = listEditionsInDir(dateDir, dateArg);
    if (eds.length === 0) {
      throw new Error(`No report for ${dateArg}`);
    }
    if (hourArg) {
      const slot = String(hourArg).padStart(2, "0");
      const hit = eds.find((e) => e.hour === slot);
      if (!hit) throw new Error(`No ${slot} edition for ${dateArg}`);
      return hit.file;
    }
    return eds[0].file;
  }
  const dates = fs
    .readdirSync(reportsDir)
    .filter((f) => DATE_RE.test(f))
    .sort((a, b) => b.localeCompare(a));
  for (const d of dates) {
    const eds = listEditionsInDir(path.join(reportsDir, d), d);
    if (eds.length > 0) return eds[0].file;
  }
  throw new Error(`No HTML reports in ${reportsDir}. Run \`npm run daily\` first.`);
}

function findChromeWindows() {
  const candidates = [
    process.env.ProgramFiles &&
      path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] &&
      path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LocalAppData &&
      path.join(process.env.LocalAppData, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

function openInBrowser(file) {
  const fileUrl = "file:///" + file.replace(/\\/g, "/");
  if (process.platform === "win32") {
    const chrome = findChromeWindows();
    if (chrome) {
      spawn(chrome, [fileUrl], { detached: true, stdio: "ignore" }).unref();
      console.log(`Opened in Chrome: ${file}`);
      return;
    }
    console.warn("Chrome not found, using default file association.");
    spawn("cmd", ["/c", "start", "", file], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", ["-a", "Google Chrome", file], { detached: true, stdio: "ignore" })
      .on("error", () => {
        spawn("open", [file], { detached: true, stdio: "ignore" }).unref();
      })
      .unref();
    console.log(`Opened: ${file}`);
  } else {
    spawn("xdg-open", [file], { detached: true, stdio: "ignore" }).unref();
    console.log(`Opened: ${file}`);
  }
}

try {
  const target = pickReport(process.argv[2], process.argv[3]);
  openInBrowser(target);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
