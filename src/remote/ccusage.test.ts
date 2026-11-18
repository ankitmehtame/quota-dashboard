import test from "node:test";
import assert from "node:assert/strict";

import { ccusageArgs, isOfflineRecoverableFailure, rollingDateRange, runCcusage, runHotCcusage, sliceCcusageDocument } from "./ccusage.js";

test("uses daily JSON by-agent with the configured date range and timezone", () => {
  assert.deepEqual(ccusageArgs({ from: "2025-09-09", to: "2026-09-13", timezone: "Asia/Singapore" }), [
    "daily", "--json", "--by-agent", "--since", "2025-09-09", "--until", "2026-09-13", "--timezone", "Asia/Singapore", "--no-offline",
  ]);
});

test("always sets offline mode explicitly", () => {
  const range = { from: "2026-09-13", to: "2026-09-13", timezone: "UTC" };
  assert.equal(ccusageArgs(range).at(-1), "--no-offline");
  assert.equal(ccusageArgs(range, { offline: false }).at(-1), "--no-offline");
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
      assert.deepEqual(args, ["daily", "--json", "--by-agent", "--since", "2025-09-09", "--until", "2026-09-13", "--timezone", "UTC", "--no-offline"]);
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

const hotRange = { from: "2026-09-12", to: "2026-09-13", timezone: "UTC" };
type Call = { offline: boolean; timeout?: number };
const hotRunner = (calls: Call[], onlineFailure?: NodeJS.ErrnoException, offlineFailure?: NodeJS.ErrnoException) =>
  (_file: string, args: string[], options: { timeout?: number }, callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
    const offline = args.at(-1) === "--offline";
    calls.push({ offline, timeout: options.timeout });
    const failure = offline ? offlineFailure : onlineFailure;
    if (failure) callback(failure, "", "");
    else callback(null, JSON.stringify({ daily: [], marker: offline ? "offline" : "online" }), "");
  };
const exitFailure = () => Object.assign(new Error("exit 1"), { code: 1 }) as unknown as NodeJS.ErrnoException;
const timeoutFailure = () => Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }) as NodeJS.ErrnoException;

test("hot usage stays online and does not retry offline when the online run succeeds", async () => {
  const calls: Call[] = [];
  const result = await runHotCcusage({ binary: "ccusage-test", range: hotRange, runner: hotRunner(calls) as never, sleep: async () => undefined });
  assert.deepEqual(calls, [{ offline: false, timeout: 120_000 }]);
  assert.equal(result.fallback, undefined);
});

test("hot usage falls back to cached pricing after one fast online failure", async () => {
  for (const failure of [exitFailure(), timeoutFailure()]) {
    const calls: Call[] = [];
    const fallbacks: unknown[] = [];
    const result = await runHotCcusage({
      binary: "ccusage-test", range: hotRange, timeoutMs: 600_000, onlineTimeoutMs: 90_000,
      runner: hotRunner(calls, failure) as never, sleep: async () => undefined, onFallback: (error) => fallbacks.push(error),
    });
    assert.deepEqual(calls, [{ offline: false, timeout: 90_000 }, { offline: true, timeout: 600_000 }], "one online attempt without retries, then offline");
    assert.deepEqual(fallbacks, [failure]);
    assert.equal(result.fallback?.warning, "Pricing fetch failed; using cached pricing");
    assert.deepEqual(result.document, { daily: [], marker: "offline" });
  }
});

test("hot usage never lets the online timeout exceed the hot timeout", async () => {
  const calls: Call[] = [];
  await runHotCcusage({ binary: "ccusage-test", range: hotRange, timeoutMs: 30_000, runner: hotRunner(calls) as never });
  assert.equal(calls[0].timeout, 30_000);
});

test("hot usage does not fall back for failures offline would repeat", async () => {
  const failures = [
    Object.assign(new Error("not found"), { code: "ENOENT" }),
    Object.assign(new Error("maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }),
  ] as NodeJS.ErrnoException[];
  for (const failure of failures) {
    const calls: Call[] = [];
    await assert.rejects(runHotCcusage({ binary: "ccusage-test", range: hotRange, runner: hotRunner(calls, failure) as never, sleep: async () => undefined }), failure);
    assert.deepEqual(calls.map((call) => call.offline), [false]);
  }
  const calls: Call[] = [];
  await assert.rejects(runHotCcusage({
    binary: "ccusage-test", range: hotRange, sleep: async () => undefined,
    runner: ((_file: string, _args: string[], _options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => { calls.push({ offline: false }); callback(null, "{not json", ""); }) as never,
  }), SyntaxError);
  assert.equal(calls.length, 1);
  assert.equal(isOfflineRecoverableFailure("string"), false);
  assert.equal(isOfflineRecoverableFailure(new Error("plain")), false);
});

test("hot usage rethrows the offline error when the fallback also fails", async () => {
  const calls: Call[] = [];
  const offlineFailure = Object.assign(new Error("cache missing"), { code: 2 }) as unknown as NodeJS.ErrnoException;
  await assert.rejects(runHotCcusage({
    binary: "ccusage-test", range: hotRange, runner: hotRunner(calls, exitFailure(), offlineFailure) as never, sleep: async () => undefined,
  }), /cache missing/);
  assert.deepEqual(calls.map((call) => call.offline), [false, true, true, true], "the offline fallback keeps its normal retries");
});

test("an explicit offline hot run is not retried online", async () => {
  const calls: Call[] = [];
  const result = await runHotCcusage({ binary: "ccusage-test", range: hotRange, offline: true, runner: hotRunner(calls) as never });
  assert.deepEqual(calls, [{ offline: true, timeout: 600_000 }]);
  assert.equal(result.fallback, undefined);
});
