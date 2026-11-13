/**
 * Regression guard for the Eastmoney 302 (survey defect #2).
 *
 * `push2.eastmoney.com/api/qt/clist/get` started answering `302` with a
 * protocol-relative `Location: //push2delay.eastmoney.com/...`. The old
 * baker-local `fetchJson` treated any non-2xx as failure, so it returned
 * `null` and `bake-themes` silently wrote `boards=0` for two days — theme
 * board heat and every theme's constituents went empty while CI stayed green.
 *
 * These tests pin the redirect contract against a stubbed `fetchImpl`, since
 * the live host cannot be depended on from CI.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchJson,
  looksLikeJson,
  resolveRedirectTarget,
} from "./http-json";

interface StubReply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/** Build a `fetch` stub from a URL -> reply table and record the calls made. */
function stubFetch(table: Record<string, StubReply>) {
  const calls: Array<{ url: string; redirect?: string }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, redirect: init?.redirect });
    const reply = table[url];
    if (!reply) throw new Error(`unstubbed URL: ${url}`);
    const headers = new Headers(reply.headers ?? {});
    const body = reply.body ?? "";
    return new Response(body, { status: reply.status, headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const noSleep = () => Promise.resolve();

test("resolveRedirectTarget", async (t) => {
  await t.test("resolves the protocol-relative form Eastmoney emits", () => {
    assert.equal(
      resolveRedirectTarget(
        "//push2delay.eastmoney.com/api/qt/clist/get?pn=1",
        "https://push2.eastmoney.com/api/qt/clist/get?pn=1",
      ),
      "https://push2delay.eastmoney.com/api/qt/clist/get?pn=1",
    );
  });

  await t.test("resolves an absolute target and a relative path", () => {
    assert.equal(
      resolveRedirectTarget("https://b.example/x", "https://a.example/y"),
      "https://b.example/x",
    );
    assert.equal(
      resolveRedirectTarget("/moved", "https://a.example/api/qt/clist/get"),
      "https://a.example/moved",
    );
  });
});

test("looksLikeJson", async (t) => {
  await t.test("accepts objects and arrays, rejects an nginx error page", () => {
    assert.equal(looksLikeJson('{"data":{}}'), true);
    assert.equal(looksLikeJson("  \n[1,2]"), true);
    assert.equal(looksLikeJson("<html>\n<head><title>502 Bad Gateway</title>"), false);
  });
});

test("fetchJson follows a 302 to the delay host", async () => {
  const start = "https://push2.eastmoney.com/api/qt/clist/get?pn=1&fs=m:90+t:3";
  const target = "https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&fs=m:90+t:3";
  const { impl, calls } = stubFetch({
    [start]: {
      status: 302,
      headers: { location: `//push2delay.eastmoney.com/api/qt/clist/get?pn=1&fs=m:90+t:3` },
    },
    [target]: { status: 200, body: '{"data":{"total":554,"diff":[{"f12":"BK0882"}]}}' },
  });

  const out = await fetchJson<{ data?: { total?: number } }>(start, {
    fetchImpl: impl,
    sleepImpl: noSleep,
  });

  assert.equal(out?.data?.total, 554, "redirect was not followed — boards would be 0");
  assert.equal(calls.length, 2);
  // Redirects are followed by hand, never by the fetch implementation.
  assert.equal(calls[0].redirect, "manual");
  assert.equal(calls[1].url, target, "protocol-relative Location mis-resolved");
});

test("fetchJson retries a transient 502 and then succeeds", async () => {
  const url = "https://push2delay.eastmoney.com/api/qt/clist/get";
  let attempt = 0;
  const impl = (async () => {
    attempt += 1;
    if (attempt === 1) {
      return new Response("<html><head><title>502 Bad Gateway</title></head></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response('{"data":{"diff":[{"f12":"BK0882"}]}}', { status: 200 });
  }) as unknown as typeof fetch;

  const out = await fetchJson<{ data?: { diff?: unknown[] } }>(url, {
    fetchImpl: impl,
    sleepImpl: noSleep,
    attempts: 3,
  });

  assert.equal(attempt, 2, "should have retried exactly once");
  assert.equal(out?.data?.diff?.length, 1);
});

test("fetchJson returns null instead of throwing on a non-JSON body", async () => {
  const url = "https://push2.eastmoney.com/api/qt/clist/get";
  const { impl } = stubFetch({
    [url]: { status: 200, body: "<html>not json</html>" },
  });

  const out = await fetchJson(url, {
    fetchImpl: impl,
    sleepImpl: noSleep,
    attempts: 1,
  });
  assert.equal(out, null);
});

test("fetchJson falls back to the next host when the first is erroring", async () => {
  const primary = "https://push2.eastmoney.com/api/qt/clist/get?fs=m:90+t:3";
  const fallback = "https://push2delay.eastmoney.com/api/qt/clist/get?fs=m:90+t:3";
  const { impl, calls } = stubFetch({
    // push2 302s to the delay host, which is itself 502 right now.
    [primary]: { status: 302, headers: { location: "//push2delay.eastmoney.com/api/qt/clist/get?fs=m:90+t:3" } },
    [fallback]: { status: 502, body: "<html>502 Bad Gateway</html>" },
  });

  const out = await fetchJson(primary, {
    fetchImpl: impl,
    sleepImpl: noSleep,
    attempts: 1,
  });
  assert.equal(out, null, "a 502 through the redirect must not parse");
  assert.ok(calls.length >= 1);
});

test("fetchJson walks a host list in order and stops at the first success", async () => {
  const dead = "https://push2.eastmoney.com/api/qt/clist/get";
  const live = "https://push2delay.eastmoney.com/api/qt/clist/get";
  const { impl, calls } = stubFetch({
    [dead]: { status: 502, body: "<html>502 Bad Gateway</html>" },
    [live]: { status: 200, body: '{"data":{"total":554}}' },
  });

  const out = await fetchJson<{ data?: { total?: number } }>([dead, live], {
    fetchImpl: impl,
    sleepImpl: noSleep,
    attempts: 1,
  });

  assert.equal(out?.data?.total, 554);
  assert.deepEqual(
    calls.map((c) => c.url),
    [dead, live],
    "hosts must be tried in the declared order",
  );
});

test("fetchJson returns null when every host in the list fails", async () => {
  const a = "https://push2.eastmoney.com/x";
  const b = "https://push2delay.eastmoney.com/x";
  const { impl } = stubFetch({
    [a]: { status: 502, body: "<html>502</html>" },
    [b]: { status: 503, body: "<html>503</html>" },
  });

  const out = await fetchJson([a, b], {
    fetchImpl: impl,
    sleepImpl: noSleep,
    attempts: 1,
  });
  assert.equal(out, null);
});

test("fetchJson gives up on a redirect chain that exceeds the hop budget", async () => {
  const a = "https://a.example/x";
  const b = "https://b.example/x";
  const { impl, calls } = stubFetch({
    // A cycle: both keep redirecting to each other.
    [a]: { status: 302, headers: { location: b } },
    [b]: { status: 302, headers: { location: a } },
  });

  const out = await fetchJson(a, {
    fetchImpl: impl,
    sleepImpl: noSleep,
    attempts: 1,
    maxRedirects: 3,
  });

  assert.equal(out, null, "an unbounded redirect loop must terminate");
  assert.ok(calls.length <= 5, `redirect loop ran away: ${calls.length} calls`);
});
