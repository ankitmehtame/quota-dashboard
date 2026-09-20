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
