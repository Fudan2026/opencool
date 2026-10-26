/**
 * LLM_MODE controls whether the daily pipeline calls an LLM.
 *
 *   LLM_MODE=off   — fetch + heuristic digest + markets data only (no API key)
 *   LLM_MODE=on    — full enrichment / digest / trading commentary
 *   LLM_MODE=auto  — "on" if any provider key is present, else "off".
 *                    Free-first resolution: zhipu (GLM-4-Flash, free tier)
 *                    before paid providers; also exports LLM_BACKEND when
 *                    unset so runLlm() targets the resolved provider.
 *   unset          — treated as "on" (local claude-cli default)
 *
 * GitHub Actions sets LLM_MODE=auto: the pipeline stays zero-AI / zero-token
 * unless a ZHIPU_API_KEY secret is configured — then free GLM-4-Flash
 * enrichment lights up at no cost. The repo's "no paid LLM" promise holds
 * in every state.
 */

/** Provider-specific key env per backend, in auto-resolution priority order. */
const AUTO_ORDER: Readonly<{ backend: string; key: string }[]> = [
  { backend: "zhipu", key: "ZHIPU_API_KEY" },
  { backend: "anthropic", key: "ANTHROPIC_API_KEY" },
  { backend: "openai", key: "OPENAI_API_KEY" },
  { backend: "deepseek", key: "DEEPSEEK_API_KEY" },
  { backend: "minimax", key: "MINIMAX_API_KEY" },
];

let autoResolved = false;

/**
 * Resolve LLM_MODE=auto exactly once: pick the first provider whose
 * provider-specific key is present (free zhipu first) and export
 * LLM_BACKEND, or downgrade LLM_MODE to "off" when no key exists.
 * Idempotent — safe to call from the isLlmOff() hot path.
 */
export function resolveAutoLlm(): void {
  if (autoResolved) return;
  autoResolved = true;
  const raw = (process.env.LLM_MODE ?? "").trim().toLowerCase();
  if (raw !== "auto") return;
  const found = AUTO_ORDER.find((c) => !!process.env[c.key]);
  if (!found) {
    process.env.LLM_MODE = "off";
    return;
  }
  if (!process.env.LLM_BACKEND) process.env.LLM_BACKEND = found.backend;
}

export function isLlmOff(): boolean {
  resolveAutoLlm();
  const raw = (process.env.LLM_MODE ?? "").trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false" || raw === "no";
}
