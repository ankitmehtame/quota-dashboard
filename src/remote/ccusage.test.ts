import test from "node:test";
import assert from "node:assert/strict";

import { ccusageArgs, rollingDateRange, runCcusage, sliceCcusageDocument } from "./ccusage.js";

test("uses daily JSON by-agent with the configured date range and timezone", () => {
  assert.deepEqual(ccusageArgs({ from: "2025-09-09", to: "2026-09-13", timezone: "Asia/Singapore" }), [
    "daily", "--json", "--by-agent", "--since", "2025-09-09", "--until", "2026-09-13", "--timezone", "Asia/Singapore",
  ]);
});

test("adds offline mode only when requested", () => {
  const range = { from: "2026-09-13", to: "2026-09-13", timezone: "UTC" };
  assert.equal(ccusageArgs(range).at(-1), "UTC");
  assert.equal(ccusageArgs(range, { offline: true }).at(-1), "--offline");
});

test("calculates an inclusive rolling 370-day range in the configured timezone", () => {
  assert.deepEqual(rollingDateRange("Asia/Singapore", new Date("2026-09-13T00:30:00.000Z")), {
    from: "2025-09-09",
    to: "2026-09-13",
    timezone: "Asia/Singapore",
  });
});

test("parses stdout without modifying the JSON document", async () => {
  const stdout = '{"daily":[{"date":"2026-09-13","newField":[1,null,false]}],"metadata":{"x":"y"}}';
  const result = await runCcusage({
    binary: "ccusage-test",
    range: { from: "2025-09-09", to: "2026-09-13", timezone: "UTC" },
    runner: (_file, args, options, callback) => {
      assert.deepEqual(args, ["daily", "--json", "--by-agent", "--since", "2025-09-09", "--until", "2026-09-13", "--timezone", "UTC"]);
      assert.equal(options.timeout, 30_000);
      assert.equal(options.maxBuffer, 32 * 1024 * 1024);
      callback(null, stdout, "");
    },
  });
  assert.deepEqual(result.document, JSON.parse(stdout));
});

test("slices a multi-day document and synthesizes missing dates", () => {
  const document = {
    metadata: { source: "test" },
    totalCost: 4,
    daily: [
      { date: "2026-09-11", cost: 1 },
      { date: "2026-09-13", cost: 3 },
    ],
  };

  assert.deepEqual(sliceCcusageDocument(document, "2026-09-11"), {
    daily: [{ date: "2026-09-11", cost: 1 }],
  });
  assert.deepEqual(sliceCcusageDocument(document, "2026-09-12"), {
    daily: [],
  });
});

test("passes offline mode and the caller timeout through to ccusage", async () => {
  await runCcusage({
    binary: "ccusage-test",
    range: { from: "2026-09-13", to: "2026-09-13", timezone: "UTC" },
    timeoutMs: 30 * 60 * 1000,
    maxBuffer: 1234,
    offline: true,
    runner: (_file, args, options, callback) => {
      assert.equal(args.at(-1), "--offline");
      assert.equal(options.timeout, 30 * 60 * 1000);
      assert.equal(options.maxBuffer, 1234);
      callback(null, "{}", "");
    },
  });
});

test("retries ccusage failures twice with exponential backoff", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await runCcusage({
    binary: "ccusage-test",
    range: { from: "2026-09-11", to: "2026-09-13", timezone: "UTC" },
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    runner: (_file, _args, _options, callback) => {
      attempts += 1;
      if (attempts < 3) {
        callback(new Error(`failure ${attempts}`) as NodeJS.ErrnoException, "", "");
        return;
      }
      callback(null, '{"daily":[]}', "");
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [500, 1000]);
  assert.deepEqual(result.document, { daily: [] });
});

test("rejects after the third ccusage failure", async () => {
  let attempts = 0;
  await assert.rejects(runCcusage({
    binary: "ccusage-test",
    range: { from: "2026-09-13", to: "2026-09-13", timezone: "UTC" },
    sleep: async () => undefined,
    runner: (_file, _args, _options, callback) => {
      attempts += 1;
      callback(new Error("still failing") as NodeJS.ErrnoException, "", "");
    },
  }), /still failing/);
  assert.equal(attempts, 3);
});
