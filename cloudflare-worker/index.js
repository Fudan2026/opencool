/**
 * OpenCool optional external dispatcher.
 *
 * GitHub's scheduled triggers measurably drop most ticks, so the Daily Brief
 * workflow already accepts `workflow_dispatch` (the gate inside no-ops when
 * every due slot is published). This Worker simply fires that API every 15
 * minutes from Cloudflare's cron, which is not subject to GitHub's scheduled
 * queue. It is owner-activated infrastructure: nothing in the repo depends on
 * it, and deploying or deleting it changes no behavior of the site itself.
 *
 * Env (wrangler.toml [vars]):
 *   GITHUB_REPO    owner/repo, default Fudan2026/opencool
 *   WORKFLOW_FILE  workflow file name, default daily.yml
 * Secret:
 *   DISPATCH_PAT   fine-grained PAT with Actions: Read and write on the repo
 */

const API = "https://api.github.com";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function dispatchWorkflow(env) {
  const repo = env.GITHUB_REPO || "Fudan2026/opencool";
  const workflow = env.WORKFLOW_FILE || "daily.yml";
  const token = env.DISPATCH_PAT;
  if (!token) {
    return { ok: false, status: 0, error: "DISPATCH_PAT secret is not set (npx wrangler secret put DISPATCH_PAT)" };
  }
  const res = await fetch(`${API}/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "opencool-dispatcher",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  return { ok: res.ok, status: res.status, error: res.ok ? null : `GitHub API returned ${res.status}` };
}

export default {
  async scheduled(_event, env, ctx) {
    const result = await dispatchWorkflow(env);
    const line = `[dispatcher] workflow_dispatch ${result.ok ? "accepted" : "rejected"}: ${JSON.stringify(result)}`;
    console.log(line);
    env.LAST_DISPATCH = { at: new Date().toISOString(), ...result };
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/") {
      return json({ error: "not found" }, 404);
    }
    return json({
      worker: "opencool-dispatcher",
      repo: env.GITHUB_REPO || "Fudan2026/opencool",
      workflow: env.WORKFLOW_FILE || "daily.yml",
      patConfigured: Boolean(env.DISPATCH_PAT),
      note: "fires workflow_dispatch every 15 minutes via cron trigger; see cloudflare-worker/README.md",
    });
  },
};
