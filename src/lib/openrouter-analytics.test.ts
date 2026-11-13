import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { AnalyticsRateLimiter, fetchOpenRouterDay, fetchOpenRouterKeyId, openRouterDayRange, openRouterKeyHash } from "./openrouter-analytics.js";
import { summarizeUsage } from "./usage.js";

const KEY_ID = "a".repeat(64);
const row = (overrides: Record<string, unknown> = {}) => ({ model: "test/model", total_usage: 0.1, tokens_prompt: "100", cached_tokens: "20", tokens_completion: "50", reasoning_tokens: "10", ...overrides });

function mockAnalytics(data: unknown, inspect?: (body: any) => void) {
  mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    inspect?.(JSON.parse(String(init?.body)));
    return Response.json({ data });
  });
}

test("local day boundaries handle Singapore, fractional offsets and daylight saving", () => {
  assert.deepEqual(openRouterDayRange("2026-11-12", "Asia/Singapore"), { start: "2026-11-11T16:00:00.000Z", end: "2026-11-12T16:00:00.000Z" });
  assert.deepEqual(openRouterDayRange("2026-11-12", "Asia/Kathmandu"), { start: "2026-11-11T18:15:00.000Z", end: "2026-11-12T18:15:00.000Z" });
  assert.deepEqual(openRouterDayRange("2026-03-08", "America/New_York"), { start: "2026-03-08T05:00:00.000Z", end: "2026-03-09T04:00:00.000Z" });
  assert.deepEqual(openRouterDayRange("2026-11-01", "America/New_York"), { start: "2026-11-01T04:00:00.000Z", end: "2026-11-02T05:00:00.000Z" });
  assert.deepEqual(openRouterDayRange("2026-11-12", "UTC"), { start: "2026-11-12T00:00:00.000Z", end: "2026-11-13T00:00:00.000Z" });
  assert.deepEqual(openRouterDayRange("2026-11-12", "Pacific/Kiritimati"), { start: "2026-11-11T10:00:00.000Z", end: "2026-11-12T10:00:00.000Z" });
  assert.throws(() => openRouterDayRange("2026-02-30", "UTC"));
});

test("storage hash is stable, per secret and not the credential", () => {
  assert.equal(openRouterKeyHash("key"), openRouterKeyHash("key"));
  assert.notEqual(openRouterKeyHash("key"), openRouterKeyHash("other"));
  assert.match(openRouterKeyHash("key"), /^[a-f0-9]{64}$/);
  assert.ok(!openRouterKeyHash("key").includes("key"));
});

test("queries one local day filtered by OpenRouter's key hash", async () => {
  let request: any;
  let headers: Headers | undefined;
  mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://openrouter.ai/api/v1/analytics/query");
    request = JSON.parse(String(init?.body));
    headers = new Headers(init?.headers);
    return Response.json({ data: { data: [row()], metadata: { truncated: false } } });
  });
  try {
    await fetchOpenRouterDay("management", KEY_ID, "2026-11-12", "Asia/Singapore");
    assert.deepEqual(request.time_range, { start: "2026-11-11T16:00:00.000Z", end: "2026-11-12T16:00:00.000Z" });
    assert.deepEqual(request.filters, [{ field: "api_key_id", operator: "eq", value: KEY_ID }]);
    assert.deepEqual(request.dimensions, ["model"]);
    assert.equal(headers?.get("authorization"), "Bearer management");
  } finally { mock.restoreAll(); }
});

test("shared limiter spaces concurrent requests deterministically", async () => {
  let now = 0;
  const limiter = new AnalyticsRateLimiter(() => now, async (ms) => { now += ms; });
  const starts: number[] = [];
  await Promise.all(Array.from({ length: 70 }, async () => { await limiter.wait(); starts.push(now); }));
  assert.equal(starts.length, 70);
  assert.equal(now, 69_000);
});

test("null optional token breakdowns are zero", async () => {
  mockAnalytics({ data: [row({ cached_tokens: null, reasoning_tokens: null })], metadata: { truncated: false } });
  try {
    const [result] = await fetchOpenRouterDay("management", KEY_ID, "2026-11-12", "UTC");
    assert.equal(result.cachedInputTokens, 0);
    assert.equal(result.reasoningTokens, 0);
  } finally { mock.restoreAll(); }
});

test("derives the analytics key hash locally", async () => {
  assert.equal(await fetchOpenRouterKeyId("secret"), openRouterKeyHash("secret"));
});

test("accounts for cache and reasoning as subsets so tokens are never double counted", async () => {
  mockAnalytics({ data: [row()], metadata: { truncated: false } });
  try {
    const rows = await fetchOpenRouterDay("management", KEY_ID, "2026-11-12", "Asia/Singapore");
    assert.equal(rows[0].inputTokens, 80);
    assert.equal(rows[0].cachedInputTokens, 20);
    assert.equal(rows[0].outputTokens, 40);
    assert.equal(rows[0].reasoningTokens, 10);
    assert.equal(rows[0].costUsd, 0.1);
    assert.equal(rows[0].provider, "openrouter");
    // The dashboard sums all four fields, which must equal OpenRouter's prompt + completion exactly.
    assert.equal(summarizeUsage(rows).totalTokens, 150);
  } finally { mock.restoreAll(); }
});

test("returns a successful empty day and keeps independent models", async () => {
  mockAnalytics({ data: [], metadata: { truncated: false } });
  try { assert.deepEqual(await fetchOpenRouterDay("management", KEY_ID, "2026-11-12", "UTC"), []); } finally { mock.restoreAll(); }
  mockAnalytics({ data: [row(), row({ model: "other/model", total_usage: 1 })], metadata: { truncated: false } });
  try { assert.deepEqual((await fetchOpenRouterDay("management", KEY_ID, "2026-11-12", "UTC")).map((record) => record.model), ["test/model", "other/model"]); } finally { mock.restoreAll(); }
});

test("rejects truncated, warned, malformed, negative and inconsistent results without partial output", async () => {
  const cases: unknown[] = [
    { data: [row()], metadata: { truncated: true } },
    { data: [row()], metadata: {} },
    { data: [row()], metadata: { truncated: false }, warnings: ["Could not resolve api_key_id hash"] },
    { metadata: { truncated: false } },
    { data: [row({ model: "" })], metadata: { truncated: false } },
    { data: [row({ model: 5 })], metadata: { truncated: false } },
    { data: ["text"], metadata: { truncated: false } },
    { data: [row({ total_usage: -1 })], metadata: { truncated: false } },
    { data: [row({ tokens_prompt: "abc" })], metadata: { truncated: false } },
    { data: [row({ tokens_prompt: null })], metadata: { truncated: false } },
    { data: [row({ cached_tokens: 101 })], metadata: { truncated: false } },
    { data: [row({ reasoning_tokens: 51 })], metadata: { truncated: false } },
  ];
  try {
    for (const data of cases) {
      mockAnalytics(data);
      await assert.rejects(fetchOpenRouterDay("management", KEY_ID, "2026-11-12", "UTC"), Error, JSON.stringify(data));
      mock.restoreAll();
    }
    for (const status of [401, 403, 408, 429, 500]) {
      mock.method(globalThis, "fetch", async () => new Response("MANAGEMENT_SECRET", { status }));
      await assert.rejects(fetchOpenRouterDay("management", KEY_ID, "2026-11-12", "UTC"), (error: Error) => !/SECRET/.test(error.message) && error.message.includes(String(status)));
      mock.restoreAll();
    }
  } finally { mock.restoreAll(); }
});
