/**
 * Unit tests for scripts/watchdog-issue.mjs — the watchdog's alert surface.
 *
 * The weekend of 2026-11-14 shipped the defect these tests pin: both red
 * watchdog runs posted "the slot is still missing" into issue #73 while the
 * slot had in fact PUBLISHED — the run went red on the publish-lag assert,
 * which by design fails the run AFTER the gh-pages push. A failure entry must
 * therefore be PROBED, not assumed: the comment says what the sidecar probe
 * saw, "unknown" stays hedged, and the probe state rides the dedupe marker so
 * a missing→live transition re-pings instead of being deduped away.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  composeEvent,
  outcomeNote,
  probeSidecarLive,
  type SlotProbe,
} from "../../scripts/watchdog-issue.mjs";

const ENV_KEYS = [
  "WATCHDOG_SHOULD_RUN",
  "WATCHDOG_RESULT",
  "WATCHDOG_REASON",
  "WATCHDOG_EDITION_DATE",
  "WATCHDOG_EDITION_HOUR",
  "GITHUB_RUN_ID",
  "GITHUB_SERVER_URL",
] as const;

type EnvMap = Partial<Record<(typeof ENV_KEYS)[number], string>>;

/** Set exactly the env the test wants, restoring the previous values after. */
function withEnv(env: EnvMap, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const LIVE: SlotProbe = { status: "live", generatedAt: "2026-11-15T07:41:00.000Z" };
const MISSING: SlotProbe = { status: "missing", generatedAt: null };
const UNKNOWN: SlotProbe = { status: "unknown", generatedAt: null };

const TICK = {
  WATCHDOG_SHOULD_RUN: "true",
  WATCHDOG_RESULT: "failure",
  WATCHDOG_REASON: "catchup",
  WATCHDOG_EDITION_DATE: "2026-11-15",
  WATCHDOG_EDITION_HOUR: "06",
} satisfies EnvMap;

test("watchdog issue — quiet tick reports nothing", () => {
  withEnv({ WATCHDOG_SHOULD_RUN: "false", WATCHDOG_RESULT: "success" }, () => {
    assert.equal(composeEvent(), null);
  });
});

test("watchdog issue — failure entries are probed, not assumed", async (t) => {
  await t.test("a lag-breach failure (slot live) says the slot DID publish", () => {
    withEnv(TICK, () => {
      const event = composeEvent(LIVE)!;
      assert.ok(event, "a failure tick with a slot must produce an event");
      const did = event.lines.find((l) => l.includes("What this run did"))!;
      assert.match(did, /the slot DID publish/);
      assert.match(did, /publish-lag assert/);
      assert.match(did, /generated_at = 2026-11-15T07:41:00\.000Z/);
      assert.match(event.marker, /failure live$/);
    });
  });

  await t.test("a genuine miss (slot missing) keeps the retry wording", () => {
    withEnv(TICK, () => {
      const event = composeEvent(MISSING)!;
      const did = event.lines.find((l) => l.includes("What this run did"))!;
      assert.match(did, /still missing/);
      assert.match(did, /keep retrying/);
      assert.match(event.marker, /failure missing$/);
    });
  });

  await t.test("an unreadable probe stays hedged, never guesses", () => {
    withEnv(TICK, () => {
      const event = composeEvent(UNKNOWN)!;
      const did = event.lines.find((l) => l.includes("What this run did"))!;
      assert.match(did, /could not be verified/);
      assert.doesNotMatch(did, /still missing/);
      assert.match(event.marker, /failure unknown$/);
    });
  });

  await t.test("a failure with no probe (no slot named) hedges", () => {
    withEnv({ WATCHDOG_SHOULD_RUN: "false", WATCHDOG_RESULT: "failure", WATCHDOG_REASON: "-" }, () => {
      const event = composeEvent()!;
      assert.equal(event.kind, "pipeline-failure");
      const did = event.lines.find((l) => l.includes("What this run did"))!;
      assert.match(did, /check the run log/);
      assert.doesNotMatch(did, /still missing/);
      // No probe → no state suffix on the marker.
      assert.doesNotMatch(event.marker, /(live|missing|unknown)$/);
    });
  });

  await t.test("a live generated_at that is unreadable still reports live", () => {
    withEnv(TICK, () => {
      const event = composeEvent({ status: "live", generatedAt: null })!;
      const did = event.lines.find((l) => l.includes("What this run did"))!;
      assert.match(did, /the slot DID publish/);
      assert.doesNotMatch(did, /generatedAt = /);
    });
  });
});

test("watchdog issue — success and cancelled entries", async (t) => {
  await t.test("success keeps the rebuilt-and-published claim and the bare marker", () => {
    withEnv({ ...TICK, WATCHDOG_RESULT: "success" }, () => {
      const event = composeEvent()!;
      const did = event.lines.find((l) => l.includes("What this run did"))!;
      assert.match(did, /rebuilt and published/);
      assert.equal(event.marker, "watchdog-event: edition-built 2026-11-15/06 catchup success");
    });
  });

  await t.test("cancelled explains the concurrency takeover and appends the probe fact", () => {
    withEnv({ ...TICK, WATCHDOG_RESULT: "cancelled" }, () => {
      const live = composeEvent(LIVE)!;
      assert.match(live.lines.join("\n"), /concurrency group; the slot is live as of this comment/);
      assert.match(live.marker, /cancelled live$/);
      const noProbe = composeEvent()!;
      const did = noProbe.lines.find((l) => l.includes("What this run did"))!;
      assert.match(did, /concurrency group$/);
    });
  });
});

test("watchdog issue — the sidecar probe follows the gate's 200-only rule", async (t) => {
  const fake = (status: number, body?: unknown, throwErr = false) =>
    (async (..._args: unknown[]) => {
      if (throwErr) throw new Error("ENOTFOUND");
      return {
        status,
        json: async () => body,
      } as unknown as Response;
    }) as unknown as typeof fetch;

  await t.test("200 with a readable sidecar → live with generated_at", async () => {
    const body = {
      type: "file",
      encoding: "base64",
      content: Buffer.from(
        JSON.stringify({ fetch_health: { generated_at: "2026-11-15T07:41:00.000Z" } }),
      ).toString("base64"),
    };
    const r = await probeSidecarLive({
      repo: "Fudan2026/opencool",
      token: "t",
      date: "2026-11-15",
      hour: "06",
      fetchImpl: fake(200, body),
    });
    assert.deepEqual(r, { status: "live", generatedAt: "2026-11-15T07:41:00.000Z" });
  });

  await t.test("200 without readable content → live, generated_at null (large-file case)", async () => {
    const r = await probeSidecarLive({
      repo: "Fudan2026/opencool",
      token: "t",
      date: "2026-11-15",
      hour: "06",
      fetchImpl: fake(200, { type: "file", content: "" }),
    });
    assert.deepEqual(r, { status: "live", generatedAt: null });
  });

  await t.test("404 → missing; anything else → unknown, never a guess", async () => {
    const base = { repo: "Fudan2026/opencool", token: "t", date: "2026-11-15", hour: "06" } as const;
    assert.deepEqual(await probeSidecarLive({ ...base, fetchImpl: fake(404) }), MISSING);
    assert.deepEqual(await probeSidecarLive({ ...base, fetchImpl: fake(403) }), UNKNOWN);
    assert.deepEqual(await probeSidecarLive({ ...base, fetchImpl: fake(429) }), UNKNOWN);
    assert.deepEqual(await probeSidecarLive({ ...base, fetchImpl: fake(500) }), UNKNOWN);
    assert.deepEqual(await probeSidecarLive({ ...base, fetchImpl: fake(0, null, true) }), UNKNOWN);
    // No credentials / no slot → unknown, not a silent "missing".
    assert.deepEqual(await probeSidecarLive({ repo: "", token: "", date: "", hour: "" }), UNKNOWN);
  });

  await t.test("the hour is zero-padded like the archive names it", async () => {
    const seen: string[] = [];
    const r = await probeSidecarLive({
      repo: "Fudan2026/opencool",
      token: "t",
      date: "2026-11-15",
      hour: "6",
      fetchImpl: (async (url: string | URL | Request) => {
        seen.push(String(url));
        return {
          status: 404,
          json: async () => null,
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    assert.equal(r.status, "missing");
    assert.match(seen[0], /contents\/2026-11-15\/06\.json\?ref=gh-pages$/);
  });
});

test("watchdog issue — outcomeNote branches", () => {
  assert.equal(outcomeNote("success"), " — the slot was rebuilt and published");
  assert.match(outcomeNote("failure", LIVE), /DID publish/);
  assert.match(outcomeNote("failure", MISSING), /still missing/);
  assert.match(outcomeNote("failure", UNKNOWN), /could not be verified/);
  assert.match(outcomeNote("failure"), /check the run log/);
  assert.match(outcomeNote("cancelled", LIVE), /the slot is live as of this comment/);
  assert.equal(outcomeNote("cancelled"), " — most likely a concurrent Daily Brief build took over via the build concurrency group");
  assert.equal(outcomeNote("weird"), "");
});
