/**
 * Generate the static Trails page (favorites via localStorage).
 * Writes daily_reports/trails.html — safe to run without a daily edition.
 */
import "./_env.ts";
import fs from "node:fs";
import path from "node:path";
import { renderTrailsPage } from "../lib/trails/page";

const ROOT = "daily_reports";
fs.mkdirSync(ROOT, { recursive: true });
const out = path.join(ROOT, "trails.html");
fs.writeFileSync(out, renderTrailsPage(), "utf8");
console.log(`[build-trails] ${out}`);
