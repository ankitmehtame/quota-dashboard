import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQuotaCache } from "./quota-cache.js";
import { fetchClaude, parseClaudeQuota, parseClaudeResetCredits, parseRetryAfter, resolveClaudeCredentials } from "./providers.js";

const now = Date.parse("2026-10-16T12:00:00Z");

const resetGrant = { id: "full-reset", label: "One full limit reset", resets_left: 1, ends_at: "2026-12-10T22:00:00+00:00", paused: false, usable_now: true };
const resetPayload = { cedar_ember: { eligible: true, grants: [resetGrant] } };

function testUserAgents(t: TestContext) {
  for (const key of ["CLAUDE_USER_AGENT", "CLAUDE_RESET_USER_AGENT"]) {
    const original = process.env[key];
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
  }
  process.env.CLAUDE_USER_AGENT = "claude-code/test";
  delete process.env.CLAUDE_RESET_USER_AGENT;
}

test("Claude reset grants normalize expiry, sort, and show remaining counts without requiring a current limit", () => {
  assert.deepEqual(parseClaudeResetCredits({ cedar_ember: { eligible: true, exhausted: [], grants: [resetGrant,
    { ...resetGrant, id: "launch", label: "Launch reset", resets_left: 2, ends_at: "2026-11-17T09:59:00.123456+02:00", usable_now: false, use_requires_limit: true },
  ] } }, now), [
    { id: "launch", title: "Launch reset (2 resets remaining)", description: null, expiresAt: "2026-11-17T07:59:00.123Z" },
    { id: "full-reset", title: "One full limit reset", description: null, expiresAt: "2026-12-10T22:00:00.000Z" },
  ]);
});

test("Claude reset grants reject malformed blocks and omit ineligible, exhausted, paused, and expired grants", () => {
  for (const payload of [null, [], {}, { cedar_ember: null }, { cedar_ember: [] }, { cedar_ember: { eligible: true } },
    { cedar_ember: { eligible: true, grants: {} } }]) assert.equal(parseClaudeResetCredits(payload, now), undefined);
  assert.deepEqual(parseClaudeResetCredits({ cedar_ember: { eligible: false, ineligible_reason: "surface", grants: [resetGrant] } }, now), []);
  assert.deepEqual(parseClaudeResetCredits({ cedar_ember: { eligible: true, grants: [] } }, now), []);
  const invalid = [null, {}, { ...resetGrant, paused: true },
    ...[0, -1, null, "1", 1.5, Infinity].map((resets_left) => ({ ...resetGrant, resets_left })),
    ...[null, "invalid", "2026-02-30T00:00:00Z", "2026-10-16T12:00:00Z", "2026-10-15T12:00:00Z", "2026-12-10"].map((ends_at) => ({ ...resetGrant, ends_at })),
    { ...resetGrant, id: "" }, { ...resetGrant, label: null }];
  assert.deepEqual(parseClaudeResetCredits({ cedar_ember: { eligible: true, grants: invalid } }, now), []);
});

test("Claude reset checks are hourly per identity, share pending checks, and retain grants between checks", async (t) => {
  let time = now;
  t.mock.method(Date, "now", () => time);
  testUserAgents(t);
  process.env.CLAUDE_RESET_USER_AGENT = "claude-cli/test (external, cli)";
  let usageCalls = 0;
  let resetCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const grants = String(url).includes("?");
    assert.equal(String(url), `https://api.anthropic.com/api/oauth/usage${grants ? "?cedar_ember=1&skip_spend=1" : ""}`);
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer FAKE_RESET_TOKEN");
    assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("user-agent"), grants ? "claude-cli/test (external, cli)" : "claude-code/test");
    if (grants) resetCalls++; else usageCalls++;
    return Response.json(grants ? resetPayload : { five_hour: { utilization: usageCalls } });
  });
  const credentials = { configured: true, identity: "hourly-account-a", accessToken: "FAKE_RESET_TOKEN" };
  const first = await fetchClaude(credentials);
  assert.equal(first.resetCredits?.length, 1);
  assert.doesNotMatch(JSON.stringify(first), /FAKE_RESET_TOKEN|hourly-account/);
  time += 3_599_999;
  assert.deepEqual((await fetchClaude(credentials)).resetCredits, first.resetCredits);
  assert.equal(resetCalls, 1);
  time++;
  const concurrent = await Promise.all([fetchClaude(credentials), fetchClaude(credentials)]);
  assert.equal(resetCalls, 2);
  assert.deepEqual(concurrent[0].resetCredits, concurrent[1].resetCredits);
  await fetchClaude({ ...credentials, identity: "hourly-account-b" });
  assert.equal(resetCalls, 3);
  await fetchClaude(credentials);
  assert.equal(resetCalls, 3);
  assert.equal(usageCalls, 6);
  time = Date.parse(resetGrant.ends_at);
  assert.deepEqual((await fetchClaude(credentials)).resetCredits, []);
});

test("Claude reset failures keep known grants and successful windows until the next hourly check", async (t) => {
  let time = now;
  t.mock.method(Date, "now", () => time);
  testUserAgents(t);
  let failure: string | undefined;
  let resetCalls = 0;
  let percent = 10;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (!String(url).includes("?")) return Response.json({ five_hour: { utilization: percent }, seven_day: { utilization: 20 } });
    resetCalls++;
    if (failure === "network") throw new Error("FAKE_TOKEN_AND_REQUEST_ID");
    if (failure === "json") return new Response("bad JSON");
    if (failure === "body") {
      const response = Response.json({});
      Object.defineProperty(response, "json", { value: async () => { throw new TypeError("FAKE_TOKEN_AND_REQUEST_ID"); } });
      return response;
    }
    if (failure === "null") return Response.json({ cedar_ember: null });
    if (failure === "schema") return Response.json({ cedar_ember: { eligible: true } });
    if (failure === "ineligible") return Response.json({ cedar_ember: { eligible: false, ineligible_reason: "surface", grants: [] } });
    if (failure === "empty") return Response.json({ cedar_ember: { eligible: true, grants: [] } });
    if (failure) return new Response("FAKE_TOKEN_AND_REQUEST_ID", { status: Number(failure) });
    return Response.json(resetPayload);
  });
  const credentials = { configured: true, identity: "failure-isolation", accessToken: "FAKE_TOKEN" };
  const first = await fetchClaude(credentials);
  for (const kind of ["network", "500", "401", "403", "400", "json", "body", "null", "schema"]) {
    failure = kind;
    time += 3_600_000;
    percent++;
    const result = await fetchClaude(credentials);
    assert.equal(result.status, "ok", kind);
    assert.equal(result.error, null);
    assert.equal(result.errorKind, undefined);
    assert.equal(result.stale, undefined);
    assert.deepEqual(result.windows.map((w) => w.usedPercent), [percent, 20]);
    assert.deepEqual(result.resetCredits, first.resetCredits);
    assert.doesNotMatch(JSON.stringify(result), /FAKE_TOKEN|REQUEST_ID|failure-isolation/);
    const before = resetCalls;
    assert.deepEqual((await fetchClaude(credentials)).resetCredits, first.resetCredits);
    assert.equal(resetCalls, before);
  }
  for (const kind of ["ineligible", undefined, "empty"]) {
    failure = kind;
    time += 3_600_000;
    const credits = (await fetchClaude(credentials)).resetCredits;
    assert.deepEqual(credits, kind ? [] : first.resetCredits);
    const before = resetCalls;
    assert.deepEqual((await fetchClaude(credentials)).resetCredits, credits);
    assert.equal(resetCalls, before);
  }
});

test("Claude reset 429 honors Retry-After without changing card status or retrying every refresh", async (t) => {
  let time = now;
  t.mock.method(Date, "now", () => time);
  testUserAgents(t);
  let resetCalls = 0;
  let retryAfter: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (!String(url).includes("?")) return Response.json({ five_hour: { utilization: 15 } });
    resetCalls++;
    return resetCalls === 1 ? Response.json(resetPayload) : new Response("", { status: 429, headers: retryAfter ? { "retry-after": retryAfter } : {} });
  });
  const credentials = { configured: true, identity: "reset-rate-limit", accessToken: "FAKE_TOKEN" };
  const first = await fetchClaude(credentials);
  for (const header of ["7200", new Date(now + 10 * 3_600_000).toUTCString(), "invalid", undefined]) {
    time += 3_600_000;
    retryAfter = header;
    const before = resetCalls;
    const result = await fetchClaude(credentials);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.resetCredits, first.resetCredits);
    assert.equal(resetCalls, before + 1);
    const deadline = Math.max(time + 3_600_000, parseRetryAfter(header ?? null, time) ?? 0);
    time = deadline - 1;
    await fetchClaude(credentials);
    assert.equal(resetCalls, before + 1);
    time = deadline;
    await fetchClaude(credentials);
    assert.equal(resetCalls, before + 2);
    time = Math.max(time + 3_600_000, parseRetryAfter(header ?? null, time) ?? 0);
  }
});

test("Claude reset checks skip usage errors and cooldowns, and validate the separate user agent", async (t) => {
  t.mock.method(Date, "now", () => now);
  testUserAgents(t);
  let status = 200;
  let retryAfter: string | undefined;
  let malformed = false;
  let resetCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("?")) {
      resetCalls++;
      assert.equal(new Headers(init?.headers).get("user-agent"), "claude-cli/2.1.280 (external, cli)");
      return Response.json(resetPayload);
    }
    return Response.json(malformed ? {} : { five_hour: { utilization: 0 } }, { status, headers: retryAfter ? { "retry-after": retryAfter } : {} });
  });
  const credentials = { configured: true, identity: "skip-usage-errors", accessToken: "FAKE_TOKEN" };
  for (const code of [429, 500, 401]) {
    status = code;
    assert.equal((await fetchClaude(credentials)).status, "error");
  }
  status = 200; malformed = true;
  assert.equal((await fetchClaude(credentials)).status, "error");
  malformed = false; retryAfter = "7200";
  assert.equal((await fetchClaude(credentials)).status, "ok");
  assert.equal(resetCalls, 0);
  retryAfter = undefined;
  for (const userAgent of ["", " ", "bad\nagent", "é"]) {
    process.env.CLAUDE_RESET_USER_AGENT = userAgent;
    assert.equal((await fetchClaude({ ...credentials, identity: `invalid-reset-agent-${userAgent}` })).status, "ok");
  }
  assert.equal(resetCalls, 0);
  process.env.CLAUDE_RESET_USER_AGENT = "claude-cli/2.1.280 (external, cli)";
  assert.equal((await fetchClaude(credentials)).resetCredits?.length, 1);
  assert.equal(resetCalls, 1);
});

test("Claude reset grants clear on explicit ineligibility even without grants, and break expiry ties by title then id", () => {
  assert.deepEqual(parseClaudeResetCredits({ cedar_ember: { eligible: false, ineligible_reason: "surface" } }, now), []);
  const tied = [{ ...resetGrant, id: "b", label: "Same" }, { ...resetGrant, id: "a", label: "Same" }, { ...resetGrant, id: "z", label: "Alpha" }];
  assert.deepEqual(parseClaudeResetCredits({ cedar_ember: { eligible: true, grants: tied } }, now)?.map((credit) => credit.id), ["z", "a", "b"]);
});

test("Claude reset throttle and cooldown survive same-account token rotation without sharing grants", async (t) => {
  let time = now;
  t.mock.method(Date, "now", () => time);
  testUserAgents(t);
  let resetCalls = 0;
  let usageCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (!String(url).includes("?")) { usageCalls++; return Response.json({ five_hour: { utilization: 5 } }); }
    resetCalls++;
    return resetCalls === 1 ? Response.json(resetPayload) : new Response("", { status: 429, headers: { "retry-after": "7200" } });
  });
  const file = { configured: true, account: "default:/fake/.credentials.json" };
  const first = await fetchClaude({ ...file, identity: `${file.account}:token-1`, accessToken: "FAKE_TOKEN_1" });
  assert.equal(first.resetCredits?.length, 1);
  time += 60_000;
  // A rotated token gets one early recheck; it is rate limited, so no grants are shown for it.
  const rotated = await fetchClaude({ ...file, identity: `${file.account}:token-2`, accessToken: "FAKE_TOKEN_2" });
  assert.equal(resetCalls, 2);
  assert.equal(rotated.status, "ok");
  assert.equal(rotated.resetCredits, undefined, "the previous token's grants are not shown to another token until it is checked");
  assert.equal(rotated.cooldownUntil, time + 7_200_000);
  time += 3_600_000;
  const limited = await fetchClaude({ ...file, identity: `${file.account}:token-3`, accessToken: "FAKE_TOKEN_3" });
  assert.equal(resetCalls, 2, "rotation cannot bypass the cooldown");
  // Windows are only replayed for the token that fetched them, so a token refreshed during the pause is paused instead.
  assert.equal(limited.errorKind, "rate_limit");
  assert.equal(limited.cooldownUntil, rotated.cooldownUntil);
  // A different credential source has its own throttle.
  await fetchClaude({ configured: true, identity: "other:token", account: "config-dir:/other", accessToken: "FAKE_OTHER" });
  assert.equal(resetCalls, 3);
  assert.equal(usageCalls > 0, true);
});

test("Claude grants reappear after a routine token refresh with one early recheck per window", async (t) => {
  let time = now;
  t.mock.method(Date, "now", () => time);
  testUserAgents(t);
  let resetCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (!String(url).includes("?")) return Response.json({ five_hour: { utilization: 5 } });
    resetCalls++;
    return Response.json(resetPayload);
  });
  const file = { configured: true, account: "default:/fake/refresh/.credentials.json" };
  const token = (n: number) => ({ ...file, identity: `${file.account}:token-${n}`, accessToken: `FAKE_TOKEN_${n}` });
  assert.equal((await fetchClaude(token(1))).resetCredits?.length, 1);
  time += 60_000;
  const refreshed = await fetchClaude(token(2));
  assert.equal(resetCalls, 2);
  assert.equal(refreshed.resetCredits?.length, 1);
  await fetchClaude(token(2));
  assert.equal(resetCalls, 2, "the same token is not rechecked before the hourly interval");
  // A second refresh in the same window waits for the scheduled check instead of adding a request.
  time += 60_000;
  await fetchClaude(token(3));
  assert.equal(resetCalls, 2);
  time += 3_600_000;
  assert.equal((await fetchClaude(token(3))).resetCredits?.length, 1);
  assert.equal(resetCalls, 3);
});

test("alternating tokens cannot exceed one early grants recheck per window, even after failed rechecks", async (t) => {
  let time = now;
  t.mock.method(Date, "now", () => time);
  testUserAgents(t);
  let resetCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (!String(url).includes("?")) return Response.json({ five_hour: { utilization: 5 } });
    resetCalls++;
    return new Response("", { status: 500 });
  });
  const file = { configured: true, account: "default:/fake/alternate/.credentials.json" };
  const token = (name: string) => ({ ...file, identity: `${file.account}:${name}`, accessToken: `FAKE_TOKEN_${name}` });
  for (const name of ["A", "B", "A", "B", "A", "B"]) {
    await fetchClaude(token(name));
    time += 60_000;
  }
  assert.equal(resetCalls, 2, "one scheduled check plus at most one early recheck");
  time += 3_600_000;
  await fetchClaude(token("A"));
  await fetchClaude(token("B"));
  assert.equal(resetCalls, 4, "the next window gets its scheduled check plus a single early recheck");
  await fetchClaude(token("A"));
  await fetchClaude(token("B"));
  assert.equal(resetCalls, 4);
});

test("a late grants 429 never resurrects a good card after plain usage has failed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let time = now;
  t.mock.method(Date, "now", () => time);
  testUserAgents(t);
  let usageStatus = 200;
  let release: (response: Response) => void = () => {};
  t.mock.method(globalThis, "fetch", (url: string | URL | Request) => {
    if (!String(url).includes("?")) return Promise.resolve(usageStatus === 200 ? Response.json({ five_hour: { utilization: 3 } }) : new Response("", { status: usageStatus }));
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  const credentials = { configured: true, identity: "late-401", accessToken: "FAKE_TOKEN" };
  const pending = fetchClaude(credentials);
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(3_000);
  assert.equal((await pending).status, "ok");
  // Plain usage now fails with 401, and only afterwards does the slow grants request return 429.
  time += 60_000;
  usageStatus = 401;
  const rejected = await fetchClaude({ ...credentials });
  assert.equal(rejected.status, "error");
  assert.equal(rejected.errorKind, "authentication");
  release(new Response("", { status: 429, headers: { "retry-after": "7200" } }));
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  time += 60_000;
  const paused = await fetchClaude(credentials);
  assert.equal(paused.status, "error");
  assert.deepEqual(paused.windows, []);
  assert.equal(paused.resetCredits, undefined);
});

test("a grants 429 without a usable Retry-After still pauses plain usage through the quota cache", async (t) => {
  let time = now;
  t.mock.method(Date, "now", () => time);
  testUserAgents(t);
  let usageCalls = 0;
  let header: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (!String(url).includes("?")) { usageCalls++; return Response.json({ five_hour: { utilization: 9 } }); }
    return new Response("", { status: 429, headers: header === undefined ? {} : { "retry-after": header } });
  });
  for (const [index, value] of [undefined, "soon", "0"].entries()) {
    header = value;
    const credentials = { configured: true, identity: `no-retry-after-${index}`, accessToken: "FAKE_TOKEN" };
    const cache = createQuotaCache({ now: () => time, prepare: async () => ({ configured: true, identity: credentials.identity, fetch: () => fetchClaude(credentials) }) });
    const before = usageCalls;
    const first = await cache.get("claude");
    assert.equal(first.status, "ok");
    assert.equal(first.cooldownUntil, time + 300_000);
    time += 60_000;
    const forced = await cache.get("claude", true);
    assert.equal(usageCalls, before + 1);
    assert.equal(forced.status, "ok");
    assert.deepEqual(forced.windows.map((window) => window.usedPercent), [9]);
    time += 300_000;
  }
});

test("Claude resolver keeps one account key across file token rotation but separates environment tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-account-"));
  try {
    const path = join(root, "credentials.json");
    await writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: "FAKE_TOKEN_A" } }));
    const a = await resolveClaudeCredentials({ CLAUDE_AUTH_PATH: path }, now, root);
    await writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: "FAKE_TOKEN_B" } }));
    const b = await resolveClaudeCredentials({ CLAUDE_AUTH_PATH: path }, now, root);
    assert.notEqual(a.identity, b.identity);
    assert.equal(a.account, b.account);
    assert.doesNotMatch(String(a.account), /FAKE_TOKEN/);
    const envA = await resolveClaudeCredentials({ CLAUDE_OAUTH_TOKEN: "FAKE_ENV_A" }, now, root);
    const envB = await resolveClaudeCredentials({ CLAUDE_OAUTH_TOKEN: "FAKE_ENV_B" }, now, root);
    assert.notEqual(envA.account, envB.account);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Claude grants 429 Retry-After pauses plain usage through the quota cache and keeps the card ok", async (t) => {
  let time = now;
  t.mock.method(Date, "now", () => time);
  testUserAgents(t);
  let usageCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (!String(url).includes("?")) { usageCalls++; return Response.json({ five_hour: { utilization: 9 } }); }
    return new Response("", { status: 429, headers: { "retry-after": "7200" } });
  });
  const credentials = { configured: true, identity: "cooldown-account", accessToken: "FAKE_TOKEN" };
  const cache = createQuotaCache({ now: () => time, prepare: async () => ({ configured: true, identity: credentials.identity, fetch: () => fetchClaude(credentials) }) });
  const first = await cache.get("claude");
  assert.equal(first.status, "ok");
  assert.equal(first.cooldownUntil, time + 7_200_000);
  time += 60_000;
  const forced = await cache.get("claude", true);
  assert.equal(usageCalls, 1);
  assert.equal(forced.status, "ok");
  assert.deepEqual(forced.windows.map((window) => window.usedPercent), [9]);
  time = first.cooldownUntil!;
  await cache.get("claude", true);
  assert.equal(usageCalls, 2);
});

test("a slow grants check does not delay the usage result and a late 429 pauses the next usage request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let time = now;
  t.mock.method(Date, "now", () => time);
  testUserAgents(t);
  let usageCalls = 0;
  let release: (response: Response) => void = () => {};
  t.mock.method(globalThis, "fetch", (url: string | URL | Request) => {
    if (!String(url).includes("?")) { usageCalls++; return Promise.resolve(Response.json({ five_hour: { utilization: 3 } })); }
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  const credentials = { configured: true, identity: "slow-grants", accessToken: "FAKE_TOKEN" };
  const pending = fetchClaude(credentials);
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(3_000);
  const result = await pending;
  assert.equal(result.status, "ok");
  assert.deepEqual(result.windows.map((window) => window.usedPercent), [3]);
  assert.equal(result.resetCredits, undefined);
  release(new Response("", { status: 429, headers: { "retry-after": "7200" } }));
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  time += 60_000;
  const paused = await fetchClaude(credentials);
  assert.equal(usageCalls, 1);
  assert.equal(paused.status, "ok");
  assert.deepEqual(paused.windows.map((window) => window.usedPercent), [3]);
  assert.equal(paused.cooldownUntil, now + 7_200_000);
});

test("a late grants 429 keeps the cached card ok through the quota cache", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let time = now;
  t.mock.method(Date, "now", () => time);
  testUserAgents(t);
  let usageCalls = 0;
  let release: (response: Response) => void = () => {};
  t.mock.method(globalThis, "fetch", (url: string | URL | Request) => {
    if (!String(url).includes("?")) { usageCalls++; return Promise.resolve(Response.json({ five_hour: { utilization: 3 } })); }
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  const credentials = { configured: true, identity: "late-cache", accessToken: "FAKE_TOKEN" };
  const cache = createQuotaCache({ now: () => time, prepare: async () => ({ configured: true, identity: credentials.identity, fetch: () => fetchClaude(credentials) }) });
  const pending = cache.get("claude");
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(3_000);
  assert.equal((await pending).status, "ok");
  release(new Response("", { status: 429, headers: { "retry-after": "7200" } }));
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  time += 60_000;
  const forced = await cache.get("claude", true);
  assert.equal(usageCalls, 1);
  assert.equal(forced.status, "ok");
  assert.equal(forced.stale, undefined);
  assert.equal(forced.errorKind, undefined);
  assert.deepEqual(forced.windows.map((window) => window.usedPercent), [3]);
  assert.equal(forced.cooldownUntil, now + 7_200_000);
  time += 60_000;
  assert.equal((await cache.get("claude", true)).status, "ok");
  assert.equal(usageCalls, 1);
});

test("Claude windows preserve fractions, real zero, model order, durations, and microsecond reset times", () => {
  const windows = parseClaudeQuota({ seven_day_opus: { utilization: 101 }, seven_day_sonnet: { utilization: 7.25 },
    five_hour: { utilization: 0, resets_at: "2026-04-11T07:00:00.528743+00:00" }, seven_day: { utilization: 33.123 },
    limits: [{ unknown: "not a verified schema" }], extra_usage: { utilization: 100 } });
  assert.deepEqual(windows.map((w) => [w.name, w.usedPercent, w.windowSeconds]), [
    ["5-hour", 0, 18_000], ["Weekly", 33.123, 604_800], ["Sonnet (Weekly)", 7.25, 604_800], ["Opus (Weekly)", 100, 604_800] ]);
  assert.equal(windows[0].resetAt, "2026-04-11T07:00:00.528Z");
  assert.equal(windows[0].windowEnd, windows[0].resetAt);
  assert.equal(windows[0].windowStart, "2026-04-11T02:00:00.528Z");
  assert.equal(windows[1].windowStart, null);
  assert.equal(windows[1].usedValue, null);
  assert.equal(windows[1].limitValue, null);
  assert.equal(parseClaudeQuota({ seven_day: { utilization: 12, resets_at: "2026-10-20T00:00:00Z" } })[0].windowStart, "2026-10-13T00:00:00.000Z");
});

test("Claude null, absent, and malformed data never becomes zero", () => {
  for (const payload of [null, [], {}, { five_hour: null }, { five_hour: [] }, { limits: [] }]) assert.deepEqual(parseClaudeQuota(payload), []);
  for (const utilization of [null, undefined, "", "2", false, NaN, Infinity]) {
    const [window] = parseClaudeQuota({ five_hour: { utilization, resets_at: "2026-10-16T18:00:00Z" } });
    assert.equal(window.usedPercent, null);
  }
  for (const resets_at of [null, 123, "garbage", "2026-02-30T00:00:00Z", "2026-10-16", "2026-10-16T00:00:00", "2026-10-16T24:00:00Z"]) {
    const [window] = parseClaudeQuota({ five_hour: { utilization: 15.5, resets_at } });
    assert.equal(window.usedPercent, 15.5);
    assert.equal(window.resetAt, null);
    assert.equal(window.windowStart, null);
    assert.equal(window.windowEnd, null);
  }
});

test("Claude credential precedence, source identity, and file rotation are read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-claude-"));
  try {
    const configDir = join(root, "alternate");
    await mkdir(configDir);
    await mkdir(join(root, ".claude"));
    const path = join(root, "explicit.json");
    const original = JSON.stringify({ claudeAiOauth: { accessToken: "file-token", refreshToken: "never-use-refresh" } });
    await writeFile(path, original);
    await writeFile(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { access_token: "directory-token" } }));
    await writeFile(join(root, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "default-token" } }));
    assert.equal((await resolveClaudeCredentials({ CLAUDE_OAUTH_TOKEN: " direct-token ", CLAUDE_AUTH_PATH: "/not-present" }, now, root)).accessToken, "direct-token");
    assert.equal((await resolveClaudeCredentials({ CLAUDE_AUTH_PATH: path, CLAUDE_CONFIG_DIR: configDir }, now, root)).accessToken, "file-token");
    assert.equal((await resolveClaudeCredentials({ CLAUDE_CONFIG_DIR: configDir }, now, root)).accessToken, "directory-token");
    assert.equal((await resolveClaudeCredentials({}, now, root)).accessToken, "default-token");
    for (const env of [{ CLAUDE_AUTH_PATH: "/not-present", CLAUDE_CONFIG_DIR: configDir }, { CLAUDE_AUTH_PATH: "" }, { CLAUDE_CONFIG_DIR: "" }, { CLAUDE_OAUTH_TOKEN: "bad\ntoken", CLAUDE_AUTH_PATH: path }]) {
      const result = await resolveClaudeCredentials(env, now, root);
      assert.equal(result.accessToken, undefined);
      assert.equal(result.errorKind, "configuration");
      assert.doesNotMatch(result.error!, /not-present|bad\ntoken/);
    }
    const first = await resolveClaudeCredentials({ CLAUDE_AUTH_PATH: path }, now, root);
    assert.equal(await readFile(path, "utf8"), original);
    await writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: "rotated-token" } }));
    const rotated = await resolveClaudeCredentials({ CLAUDE_AUTH_PATH: path }, now, root);
    assert.notEqual(first.identity, rotated.identity);
    await writeFile(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "rotated-token" } }));
    assert.notEqual(rotated.identity, (await resolveClaudeCredentials({ CLAUDE_CONFIG_DIR: configDir }, now, root)).identity);
    const sameFile = join(configDir, ".credentials.json");
    assert.notEqual((await resolveClaudeCredentials({ CLAUDE_AUTH_PATH: sameFile }, now, root)).identity,
      (await resolveClaudeCredentials({ CLAUDE_CONFIG_DIR: configDir }, now, root)).identity);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Claude metadata aliases, scopes, and expiry validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-claude-metadata-"));
  const path = join(root, "credentials.json");
  const resolve = async (oauth: unknown) => {
    await writeFile(path, JSON.stringify({ claudeAiOauth: oauth }));
    return resolveClaudeCredentials({ CLAUDE_AUTH_PATH: path }, now, root);
  };
  try {
    for (const expiresAt of [now + 60_000, (now + 60_000) / 1000, new Date(now + 60_000).toISOString()]) {
      for (const scopes of [["user:inference", "user:profile"], "user:inference user:profile"]) {
        assert.equal((await resolve({ accessToken: "token", expiresAt, scopes })).accessToken, "token");
        assert.equal((await resolve({ access_token: "token", expires_at: expiresAt, scopes })).accessToken, "token");
      }
    }
    assert.equal((await resolve({ accessToken: "first", access_token: "second", expiresAt: now + 1000, expires_at: 0 })).accessToken, "first");
    assert.equal((await resolve({ accessToken: "token" })).accessToken, "token");
    for (const expiresAt of [null, "", "garbage", "2026-02-30T00:00:00Z", 0, -1, 1e30, {}, "1900000000"]) {
      assert.equal((await resolve({ accessToken: "token", expiresAt })).errorKind, "configuration");
    }
    for (const expiresAt of [now, (now - 1000) / 1000, "2026-10-15T12:00:00Z"]) {
      const expired = await resolve({ accessToken: "token", expiresAt });
      assert.equal(expired.errorKind, "authentication");
      assert.match(expired.error!, /expired/);
    }
    for (const scopes of [null, {}, 1, [1], ["user:profile", null]]) {
      assert.equal((await resolve({ accessToken: "token", scopes })).errorKind, "configuration");
    }
    for (const scopes of [[], "", ["user:inference"], "user:inference"]) {
      const missingScope = await resolve({ accessToken: "token", scopes });
      assert.equal(missingScope.errorKind, "authentication");
      assert.match(missingScope.error!, /subscription.*inference-only/);
    }
    await writeFile(path, "not JSON");
    assert.equal((await resolveClaudeCredentials({ CLAUDE_AUTH_PATH: path }, now, root)).errorKind, "configuration");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Retry-After has strict HTTP syntax and bounded timestamp arithmetic", () => {
  assert.equal(parseRetryAfter(" 120 ", now), now + 120_000);
  assert.equal(parseRetryAfter("0", now), now);
  assert.equal(parseRetryAfter("Fri, 16 Oct 2026 13:00:00 GMT", now), now + 3_600_000);
  assert.equal(parseRetryAfter("Fri, 16 Oct 2026 11:00:00 GMT", now), now - 3_600_000);
  for (const value of [null, "", " ", "-1", "+1", "1.5", "1e3", "0x10", "Infinity", "9999999999999999999999", "8640000000000",
    "2026-10-16T13:00:00Z", "Tue, 30 Feb 2027 13:00:00 GMT", "Sat, 16 Oct 2026 13:00:00 GMT", "garbage"]) {
    assert.equal(parseRetryAfter(value, now), undefined, String(value));
  }
});

test("Claude requests use OAuth headers and safe structured failures without exposing secrets", async (t) => {
  const secret = "FAKE_CLAUDE_SECRET";
  const credentials = { configured: true, identity: "private-fingerprint", accessToken: secret };
  let status = 200;
  let body = JSON.stringify({ five_hour: { utilization: 0 } });
  let challenge = false;
  let calls = 0;
  let throwNetwork = false;
  let interruptBody = false;
  const originalAgent = process.env.CLAUDE_USER_AGENT;
  delete process.env.CLAUDE_USER_AGENT;
  t.after(() => { if (originalAgent === undefined) delete process.env.CLAUDE_USER_AGENT; else process.env.CLAUDE_USER_AGENT = originalAgent; });
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(String(url), "https://api.anthropic.com/api/oauth/usage");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${secret}`);
    assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("user-agent"), process.env.CLAUDE_USER_AGENT ?? "claude-code/2.1.69");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    if (throwNetwork) throw new Error(secret);
    if (interruptBody) {
      const response = new Response("{}", { status: 200 });
      Object.defineProperty(response, "json", { value: async () => { throw new TypeError(secret); } });
      return response;
    }
    return new Response(body, { status, headers: { "retry-after": "7200", ...(challenge ? { "cf-mitigated": "challenge" } : {}) } });
  });
  assert.equal((await fetchClaude(credentials)).windows[0].usedPercent, 0);
  process.env.CLAUDE_USER_AGENT = "claude-code/test";
  assert.equal((await fetchClaude(credentials)).status, "ok");
  for (const [code, kind] of [[401, "authentication"], [403, "authentication"], [429, "rate_limit"], [500, "server"], [502, "server"], [400, "response"]] as const) {
    status = code;
    body = secret;
    const result = await fetchClaude(credentials);
    assert.equal(result.errorKind, kind);
    assert.ok(result.cooldownUntil! > Date.now() + 7_000_000);
    assert.doesNotMatch(JSON.stringify(result), /FAKE_CLAUDE_SECRET|private-fingerprint|authorization/i);
  }
  status = 403; challenge = true;
  const blocked = await fetchClaude(credentials);
  assert.match(blocked.error!, /Cloudflare/);
  assert.doesNotMatch(blocked.error!, /expired|Sign in/);
  status = 200; challenge = false;
  for (const badBody of ["not JSON", "{}", '{"five_hour":{"utilization":null}}', '{"limits":[]}']) {
    body = badBody;
    assert.equal((await fetchClaude(credentials)).errorKind, "response");
  }
  interruptBody = true;
  assert.equal((await fetchClaude(credentials)).errorKind, "network");
  interruptBody = false;
  throwNetwork = true;
  const failed = await fetchClaude(credentials);
  assert.equal(failed.errorKind, "network");
  assert.doesNotMatch(JSON.stringify(failed), /FAKE_CLAUDE_SECRET/);
  const before = calls;
  for (const userAgent of ["", "bad\nagent", "é"]) {
    process.env.CLAUDE_USER_AGENT = userAgent;
    assert.equal((await fetchClaude(credentials)).errorKind, "configuration");
  }
  assert.equal((await fetchClaude({ configured: false, identity: "invalid", error: "Missing credentials", errorKind: "configuration" })).errorKind, "configuration");
  assert.equal(calls, before);
});

test("a late grants 429 never resurrects a good card after a credential metadata failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let time = now;
  t.mock.method(Date, "now", () => time);
  testUserAgents(t);
  let release: (response: Response) => void = () => {};
  t.mock.method(globalThis, "fetch", (url: string | URL | Request) => {
    if (!String(url).includes("?")) return Promise.resolve(Response.json({ five_hour: { utilization: 3 } }));
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  const dir = await mkdtemp(join(tmpdir(), "claude-meta-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, ".credentials.json");
  const env = { CLAUDE_AUTH_PATH: path } as NodeJS.ProcessEnv;
  await writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: "FAKE_TOKEN", scopes: ["user:profile"] } }));
  const pending = fetchClaude(await resolveClaudeCredentials(env, time));
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(3_000);
  assert.equal((await pending).status, "ok");
  // Credential metadata now fails before any usage request, and only afterwards does the slow grants request return 429.
  time += 60_000;
  await writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: "FAKE_TOKEN", scopes: [42] } }));
  const invalid = await fetchClaude(await resolveClaudeCredentials(env, time));
  assert.equal(invalid.status, "error");
  release(new Response("", { status: 429, headers: { "retry-after": "7200" } }));
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  time += 60_000;
  await writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: "FAKE_TOKEN", scopes: ["user:profile"] } }));
  const paused = await fetchClaude(await resolveClaudeCredentials(env, time));
  assert.equal(paused.status, "error");
  assert.deepEqual(paused.windows, []);
});
