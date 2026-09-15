/**
 * LLM_MODE controls whether the daily pipeline calls an LLM.
 *
 *   LLM_MODE=off   — fetch + heuristic digest + markets data only (no API key)
 *   LLM_MODE=on    — full enrichment / digest / trading commentary (default when a key is present)
 *   unset          — treated as "on" unless no credentials can be resolved in CI
 *
 * GitHub Actions sets LLM_MODE=off automatically when no provider key is configured.
 */

export function isLlmOff(): boolean {
  const raw = (process.env.LLM_MODE ?? "").trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false" || raw === "no";
}
