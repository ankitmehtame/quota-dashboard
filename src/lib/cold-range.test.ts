import test from "node:test";
import assert from "node:assert/strict";

import { processColdDays, reverseDateList } from "./cold-range.js";

test("server cold ranges run newest-first", () => {
  assert.deepEqual(reverseDateList("2026-09-01", "2026-09-03"), ["2026-09-03", "2026-09-02", "2026-09-01"]);
});

test("server cold processing continues after failures and invokes callbacks", async () => {
  const calls: string[] = [];
  const failures: string[] = [];
  const result = await processColdDays({
    from: "2026-09-01",
    to: "2026-09-03",
    onStart: (date) => calls.push(`start:${date}`),
    onSuccess: (date) => calls.push(`end:${date}`),
    onFailure: (date) => failures.push(date),
    run: async (date) => {
      if (date === "2026-09-02") throw new Error("failed");
    },
  });
  assert.deepEqual(calls, ["start:2026-09-03", "end:2026-09-03", "start:2026-09-02", "start:2026-09-01", "end:2026-09-01"]);
  assert.deepEqual(failures, ["2026-09-02"]);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failures.length, 1);
});

test("server cold processing stops before the next date when requested", async () => {
  const calls: string[] = [];
  let stopping = false;
  const result = await processColdDays({
    from: "2026-09-01",
    to: "2026-09-03",
    shouldStop: () => stopping,
    run: async (date) => {
      calls.push(date);
      stopping = true;
    },
  });
  assert.deepEqual(calls, ["2026-09-03"]);
  assert.equal(result.succeeded, 1);
  assert.deepEqual(result.failures, []);
});

test("an onSuccess failure does not count a date as both succeeded and failed", async () => {
  const result = await processColdDays({
    from: "2026-09-01",
    to: "2026-09-01",
    run: async () => undefined,
    onSuccess: () => { throw new Error("callback failed"); },
  });
  assert.equal(result.succeeded, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].date, "2026-09-01");
});
