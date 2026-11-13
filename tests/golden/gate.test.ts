/**
 * Unit tests for scripts/gate.mjs — the "which date/slot should we build?"
 * decision that used to live as inline bash inside .github/workflows/daily.yml.
 *
 * The bash version could only ever look at TODAY, so a slot missed before
 * midnight was unreachable forever (11-04, 11-09, 11-11 lost their 19 edition
 * that way). These tests pin the fixed behaviour: scan a lookback window,
 * oldest missing due slot wins, and only HTTP 200 means "published".
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  addDays,
  civilNow,
  dayMatches,
  dayOfWeek,
  decideEdition,
  decideTape,
  dueSlots,
  hasBuildInFlight,
  isTradingWeekday,
  latestDueSlot,
  makeContentsProbe,
  parseHours,
  TAPE_SLOTS,
} from "../../scripts/gate.mjs";
import {
  isValidDateKey,
  resolveEditionDate,
  todayKey,
} from "../../lib/utils";

const SH = "Asia/Shanghai";
const HOURS = [6, 13, 19];

/** Fake clock: wall time inside REPORT_TZ for an ISO instant. */
function nowAt(iso: string) {
  return civilNow(new Date(iso), SH);
}

type Probe = ((date: string, slot: string) => Promise<number>) & {
  calls: string[];
};

/** Probe backed by a `date/slot → HTTP status` map; absent = 404. */
function probeFrom(published: Record<string, number>): Probe {
  const calls: string[] = [];
  const fn = (async (date: string, slot: string) => {
    calls.push(`${date}/${slot}`);
    const status = published[`${date}/${slot}`];
    return status === undefined ? 404 : status;
  }) as Probe;
  fn.calls = calls;
  return fn;
}

test("gate — slot selection", async (t) => {
  await t.test("exact slot hit: run lands inside the 06 hour → 06 today", async () => {
    const now = nowAt("2026-11-12T22:20:00Z"); // 2026-11-13 06:20 SH
    assert.equal(now.date, "2026-11-13");
    assert.equal(now.hour, 6);
    const probe = probeFrom({});
    const r = await decideEdition({
      now,
      hours: HOURS,
      lookbackDays: 0,
      daysSpec: "*",
      probe,
    });
    assert.equal(r.shouldRun, true);
    assert.equal(r.reason, "exact");
    assert.equal(r.date, "2026-11-13");
    assert.equal(r.hour, "06");
    assert.deepEqual(probe.calls, ["2026-11-13/06"]);
  });

  await t.test("same-day catchup: 06 published, 13 due-ish → 13 today", async () => {
    const now = nowAt("2026-11-13T06:05:00Z"); // 14:05 SH, 13 due
    const probe = probeFrom({
      "2026-11-11/06": 200,
      "2026-11-11/13": 200,
      "2026-11-11/19": 200,
      "2026-11-12/06": 200,
      "2026-11-12/13": 200,
      "2026-11-12/19": 200,
      "2026-11-13/06": 200,
    });
    const r = await decideEdition({
      now,
      hours: HOURS,
      lookbackDays: 2,
      daysSpec: "*",
      probe,
    });
    assert.equal(r.shouldRun, true);
    assert.equal(r.reason, "catchup");
    assert.equal(r.date, "2026-11-13");
    assert.equal(r.hour, "13");
  });

  await t.test("cross-midnight catchup: yesterday's 19 missing → backfill it, not today", async () => {
    // 2026-11-13 00:20 SH — before today's earliest slot, so today has
    // nothing due. The old gate looked at TODAY only and no-op'd, stranding
    // 11-12/19 forever.
    const now = nowAt("2026-11-12T16:20:00Z");
    assert.equal(now.date, "2026-11-13");
    assert.equal(now.hour, 0);
    assert.deepEqual(dueSlots(now, now.date, HOURS), []);

    const probe = probeFrom({
      "2026-11-11/06": 200,
      "2026-11-11/13": 200,
      "2026-11-11/19": 200,
      "2026-11-12/06": 200,
      "2026-11-12/13": 200,
      // 2026-11-12/19 deliberately absent
    });
    const r = await decideEdition({
      now,
      hours: HOURS,
      lookbackDays: 2,
      daysSpec: "*",
      probe,
    });
    assert.equal(r.shouldRun, true);
    assert.equal(r.reason, "backfill");
    assert.equal(r.date, "2026-11-12");
    assert.equal(r.hour, "19");
  });

  await t.test("oldest missing wins across multiple gaps", async () => {
    const now = nowAt("2026-11-13T16:20:00Z"); // 2026-11-14 00:20 SH
    const probe = probeFrom({
      "2026-11-12/06": 200,
      // 11-12/13 + 11-12/19 missing
      "2026-11-13/06": 200,
      // 11-13/13 missing too
      "2026-11-13/19": 200,
    });
    const r = await decideEdition({
      now,
      hours: HOURS,
      lookbackDays: 2,
      daysSpec: "*",
      probe,
    });
    assert.equal(r.shouldRun, true);
    assert.equal(r.date, "2026-11-12");
    assert.equal(r.hour, "13");
  });

  await t.test("lookback window is honoured: a gap older than it is not fetched", async () => {
    const now = nowAt("2026-11-12T16:20:00Z"); // 2026-11-13 00:20 SH
    const probe = probeFrom({
      "2026-11-12/06": 200,
      "2026-11-12/13": 200,
      "2026-11-12/19": 200,
      // 2026-11-11 has nothing, but lookback=1 must never look at it.
    });
    const r = await decideEdition({
      now,
      hours: HOURS,
      lookbackDays: 1,
      daysSpec: "*",
      probe,
    });
    assert.equal(r.shouldRun, false);
    assert.deepEqual(probe.calls, ["2026-11-12/06", "2026-11-12/13", "2026-11-12/19"]);
    assert.ok(!probe.calls.some((c) => c.startsWith("2026-11-11")));
  });

  await t.test("all published → no-op", async () => {
    const now = nowAt("2026-11-13T12:30:00Z"); // 20:30 SH, all three due
    const published: Record<string, number> = {};
    for (const d of ["2026-11-11", "2026-11-12", "2026-11-13"]) {
      for (const s of ["06", "13", "19"]) published[`${d}/${s}`] = 200;
    }
    const r = await decideEdition({
      now,
      hours: HOURS,
      lookbackDays: 2,
      daysSpec: "*",
      probe: probeFrom(published),
    });
    assert.equal(r.shouldRun, false);
    assert.equal(r.reason, "all-published");
    assert.equal(r.date, "");
    assert.equal(r.hour, "");
  });

  await t.test("only a clean 200 counts: 403/429/000/500 → treated as missing", async () => {
    for (const status of [403, 429, 500, 0, 302, 404]) {
      const now = nowAt("2026-11-13T00:20:00Z");
      const r = await decideEdition({
        now,
        hours: HOURS,
        lookbackDays: 0,
        daysSpec: "*",
        probe: async () => status,
      });
      assert.equal(r.shouldRun, true, `HTTP ${status} must trigger a rebuild`);
      assert.equal(r.hour, "06");
      assert.equal(r.checks.at(-1)?.status, status);
    }
  });

  await t.test("a throwing probe degrades to missing, never crashes the gate", async () => {
    const r = await decideEdition({
      now: nowAt("2026-11-13T00:20:00Z"),
      hours: HOURS,
      lookbackDays: 0,
      daysSpec: "*",
      probe: async () => {
        throw new Error("ETIMEDOUT");
      },
    });
    assert.equal(r.shouldRun, true);
    assert.equal(r.checks.at(-1)?.status, 0);
  });

  await t.test("REPORT_DAYS filter skips excluded days without probing them", async () => {
    // 2026-11-13 is a Friday (dow 5). Only Mon-Fri (1-5) allowed → 11-11 (Wed)
    // and 11-12 (Thu) stay due, 11-14/11-15 (weekend) would be skipped later.
    const now = nowAt("2026-11-13T00:20:00Z");
    assert.equal(dayOfWeek("2026-11-13"), 5);
    assert.equal(dayMatches("2026-11-13", "1-5"), true);
    assert.equal(dayMatches("2026-11-13", "0,6"), false);
    assert.equal(dayMatches("2026-11-13", "*"), true);
    assert.equal(dayMatches("2026-11-13", ""), true);

    const probe = probeFrom({
      "2026-11-11/06": 200, "2026-11-11/13": 200, "2026-11-11/19": 200,
      "2026-11-12/06": 200, "2026-11-12/13": 200, "2026-11-12/19": 200,
      "2026-11-13/06": 200,
    });
    const r = await decideEdition({
      now,
      hours: HOURS,
      lookbackDays: 2,
      daysSpec: "1-5",
      probe,
    });
    assert.equal(r.shouldRun, false);
    assert.equal(r.reason, "all-published");
  });

  await t.test("a future date has no due slots", () => {
    const now = nowAt("2026-11-13T00:20:00Z");
    assert.deepEqual(dueSlots(now, "2026-11-14", HOURS), []);
    assert.deepEqual(dueSlots(now, "2026-11-12", HOURS), ["06", "13", "19"]);
    assert.deepEqual(dueSlots(now, "2026-11-13", HOURS), ["06"]);
  });
});

test("gate — helpers", async (t) => {
  await t.test("parseHours: sorted, deduped, junk-tolerant, defaulted", () => {
    assert.deepEqual(parseHours("19,6,13,6"), [6, 13, 19]);
    assert.deepEqual(parseHours(" 7 , 24, -1, abc"), [7]);
    assert.deepEqual(parseHours(""), [6, 13, 19]);
    assert.deepEqual(parseHours(undefined), [6, 13, 19]);
  });

  await t.test("addDays crosses months and years", () => {
    assert.equal(addDays("2026-11-13", -2), "2026-11-11");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(addDays("2026-01-01", -1), "2025-12-31");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  });

  await t.test("latestDueSlot: before all slots, mid-day, after all", () => {
    assert.equal(latestDueSlot({ date: "2026-11-13", hour: 3, minute: 0, dow: 5 }, HOURS), "06");
    assert.equal(latestDueSlot({ date: "2026-11-13", hour: 15, minute: 0, dow: 5 }, HOURS), "13");
    assert.equal(latestDueSlot({ date: "2026-11-13", hour: 23, minute: 0, dow: 5 }, HOURS), "19");
  });

  await t.test("contents probe: exact path on gh-pages, network error → 0", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url: String(url), auth: headers.Authorization });
      return { status: 200 } as Response;
    }) as unknown as typeof fetch;

    const ok = makeContentsProbe({
      repo: "Fudan2026/opencool",
      token: "t",
      fetchImpl: fakeFetch,
    });
    assert.equal(await ok("2026-11-12", "19"), 200);
    assert.match(
      seen[0].url,
      /^https:\/\/api\.github\.com\/repos\/Fudan2026\/opencool\/contents\/2026-11-12\/19\.json\?ref=gh-pages$/,
    );
    assert.equal(seen[0].auth, "Bearer t");

    const broken = makeContentsProbe({
      repo: "Fudan2026/opencool",
      token: "t",
      fetchImpl: (async () => {
        throw new Error("ENOTFOUND");
      }) as unknown as typeof fetch,
    });
    assert.equal(await broken("2026-11-12", "19"), 0);
    // No credentials → never probe (0 = missing, err on the side of building).
    assert.equal(await makeContentsProbe({ repo: "", token: "" })("2026-11-12", "19"), 0);
  });

  await t.test("in-flight guard: a running build suppresses a second one", async () => {
    // Without this the build group's cancel-in-progress would kill and
    // restart a slow build on every 15-minute tick.
    const fakeFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/runs?status=")) {
        return {
          status: 200,
          json: async () => ({ workflow_runs: [{ id: 111 }, { id: 222 }] }),
        } as unknown as Response;
      }
      if (u.includes("/actions/runs/111/jobs")) {
        return {
          status: 200,
          json: async () => ({ jobs: [{ name: "Time gate", status: "completed" }] }),
        } as unknown as Response;
      }
      return {
        status: 200,
        json: async () => ({ jobs: [{ name: "Build & publish", status: "in_progress" }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const r = await hasBuildInFlight({
      repo: "Fudan2026/opencool",
      token: "t",
      selfRunId: "999",
      fetchImpl: fakeFetch,
    });
    assert.equal(r.inFlight, true);
    assert.equal(r.checked, true);
    assert.match(r.detail ?? "", /Build & publish in_progress/);
  });

  await t.test("in-flight guard ignores our own run and idle builds", async () => {
    const fakeFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/runs?status=")) {
        // The only active run is this very gate run.
        return {
          status: 200,
          json: async () => ({ workflow_runs: [{ id: 999 }] }),
        } as unknown as Response;
      }
      return {
        status: 200,
        json: async () => ({ jobs: [{ name: "Build & publish", status: "completed" }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const r = await hasBuildInFlight({
      repo: "Fudan2026/opencool",
      token: "t",
      selfRunId: "999",
      fetchImpl: fakeFetch,
    });
    assert.equal(r.inFlight, false);
    assert.equal(r.checked, true);
  });

  await t.test("in-flight guard fails open when the API errors", async () => {
    const r = await hasBuildInFlight({
      repo: "Fudan2026/opencool",
      token: "t",
      fetchImpl: (async () => ({ status: 500 })) as unknown as typeof fetch,
    });
    assert.equal(r.inFlight, false);
    assert.equal(r.checked, false);
  });
});

test("gate — tape mode decides capture without touching the edition path", async (t) => {
  await t.test("inside a session slot → capture that slot", async () => {
    const asked: string[] = [];
    const r = await decideTape({
      now: nowAt("2026-11-13T01:35:00Z"), // 09:35 SH
      graceMin: 20,
      probe: async (p: string) => {
        asked.push(p);
        return 404;
      },
    });
    assert.equal(r.shouldRun, true);
    assert.equal(r.slot, "09:35");
    assert.equal(r.reason, "capture");
    assert.deepEqual(asked, ["tape/2026-11-13/0935.json"]);
  });

  await t.test("an already-captured slot is a no-op", async () => {
    const r = await decideTape({
      now: nowAt("2026-11-13T01:35:00Z"),
      probe: async () => 200,
    });
    assert.equal(r.shouldRun, false);
    assert.equal(r.reason, "already-captured");
    assert.equal(r.slot, "09:35");
  });

  await t.test("a flaky probe status is treated as missing, like the edition gate", async () => {
    for (const status of [403, 429, 500, 0, 302]) {
      const r = await decideTape({
        now: nowAt("2026-11-13T01:35:00Z"),
        probe: async () => status,
      });
      assert.equal(r.shouldRun, true, `HTTP ${status} must capture`);
    }
  });

  await t.test("outside the session window nothing is captured", async () => {
    for (const iso of [
      "2026-11-13T01:00:00Z", // 09:00 SH, before the open
      "2026-11-13T04:00:00Z", // 12:00 SH, lunch break
      "2026-11-13T09:00:00Z", // 17:00 SH, after the close
    ]) {
      const r = await decideTape({ now: nowAt(iso), probe: async () => 404 });
      assert.equal(r.shouldRun, false, iso);
      assert.equal(r.reason, "outside-session-window");
    }
  });

  await t.test("a weekend never captures", async () => {
    const r = await decideTape({
      now: nowAt("2026-11-14T01:35:00Z"), // Saturday 09:35 SH
      probe: async () => 404,
    });
    assert.equal(r.shouldRun, false);
    assert.equal(r.reason, "weekend");
  });

  await t.test("the force slot is honoured and validated against the schedule", async () => {
    const forced = await decideTape({
      now: nowAt("2026-11-13T09:00:00Z"),
      forceSlot: "1405",
      probe: async () => 404,
    });
    assert.equal(forced.shouldRun, true);
    assert.equal(forced.slot, "14:05");
    assert.equal(forced.reason, "forced");

    const bad = await decideTape({
      now: nowAt("2026-11-13T09:00:00Z"),
      forceSlot: "12:00",
      probe: async () => 404,
    });
    assert.equal(bad.shouldRun, false);
    assert.equal(bad.reason, "slot-not-in-schedule");
  });

  await t.test("the tape decision never moves an edition decision", async () => {
    // Same clock: the edition gate has an edition due, the tape gate has a
    // capture due, and the two run as separate steps off the same gate job.
    const now = nowAt("2026-11-13T01:35:00Z");
    const edition = await decideEdition({
      now,
      hours: HOURS,
      lookbackDays: 0,
      daysSpec: "*",
      probe: async () => 404,
    });
    const tape = await decideTape({ now, probe: async () => 404 });
    assert.equal(edition.shouldRun, true);
    assert.equal(edition.hour, "06");
    assert.equal(tape.shouldRun, true);
    assert.equal(tape.slot, "09:35");
  });

  await t.test("TAPE_SLOTS is the ten session slots", () => {
    assert.deepEqual(TAPE_SLOTS, [
      "09:35",
      "10:05",
      "10:35",
      "11:05",
      "11:35",
      "13:05",
      "13:35",
      "14:05",
      "14:35",
      "15:05",
    ]);
    assert.equal(isTradingWeekday("2026-11-13"), true);
    assert.equal(isTradingWeekday("2026-11-14"), false);
  });
});

test("gate — EDITION_DATE validation", async (t) => {
  await t.test("unset/blank leaves the normal path untouched", () => {
    const prev = process.env.EDITION_DATE;
    delete process.env.EDITION_DATE;
    try {
      assert.equal(resolveEditionDate("2026-11-13", undefined), "2026-11-13");
      assert.equal(resolveEditionDate("2026-11-13", ""), "2026-11-13");
      assert.equal(resolveEditionDate("2026-11-13", "   "), "2026-11-13");
      // Env unset: the helper must not invent an override from anywhere.
      assert.equal(resolveEditionDate("2026-11-13"), "2026-11-13");
    } finally {
      if (prev === undefined) delete process.env.EDITION_DATE;
      else process.env.EDITION_DATE = prev;
    }
  });

  await t.test("a valid past date is accepted verbatim", () => {
    assert.equal(resolveEditionDate("2026-11-13", "2026-11-11"), "2026-11-11");
    assert.equal(resolveEditionDate("2026-11-13", " 2026-11-11 "), "2026-11-11");
    assert.equal(resolveEditionDate("2026-11-13", "2026-11-13"), "2026-11-13");
  });

  await t.test("malformed or impossible forms are rejected loudly", () => {
    const bad = [
      "2026-11-1", // unpadded
      "26-11-11", // short year
      "2026/11/11", // wrong separators
      "20261111", // no separators
      "2026-13-01", // month 13
      "2026-02-30", // no such day
      "2026-11-31", // no such day
      "yesterday",
      "2026-11-11T00:00:00Z",
      "2026-11-11 ",
    ];
    for (const raw of bad) {
      // Trailing-space case is trimmed to a valid date; skip it here.
      if (raw.trim() === "2026-11-11") continue;
      assert.throws(
        () => resolveEditionDate("2026-11-13", raw),
        /EDITION_DATE/,
        `expected "${raw}" to be rejected`,
      );
    }
  });

  await t.test("a future date is rejected — there is nothing to backfill", () => {
    assert.throws(
      () => resolveEditionDate("2026-11-13", "2026-11-14"),
      /future/,
    );
  });

  await t.test("todayKey() only applies the override when it is set", () => {
    const prevTz = process.env.REPORT_TZ;
    const prevDate = process.env.EDITION_DATE;
    try {
      process.env.REPORT_TZ = "Asia/Shanghai";
      delete process.env.EDITION_DATE;
      const at = new Date("2026-11-13T00:20:00Z"); // 2026-11-13 08:20 SH
      // With nothing set, the key follows the clock — never a pinned date.
      assert.equal(todayKey(at), "2026-11-13");

      process.env.EDITION_DATE = "2026-11-11";
      assert.equal(todayKey(at), "2026-11-11");

      process.env.EDITION_DATE = "not-a-date";
      assert.throws(() => todayKey(at), /EDITION_DATE/);
    } finally {
      if (prevTz === undefined) delete process.env.REPORT_TZ;
      else process.env.REPORT_TZ = prevTz;
      if (prevDate === undefined) delete process.env.EDITION_DATE;
      else process.env.EDITION_DATE = prevDate;
    }
  });

  await t.test("isValidDateKey accepts real dates only", () => {
    assert.equal(isValidDateKey("2026-02-28"), true);
    assert.equal(isValidDateKey("2024-02-29"), true);
    assert.equal(isValidDateKey("2026-02-29"), false);
    assert.equal(isValidDateKey("2026-2-8"), false);
    assert.equal(isValidDateKey(20261111), false);
  });
});
