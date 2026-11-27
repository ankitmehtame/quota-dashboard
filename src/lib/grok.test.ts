import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQuotaCache } from "./quota-cache.js";
import { fetchGrok, isProviderConfigured, parseGrokQuota, resolveGrokCredentials } from "./providers.js";

const now = Date.parse("2026-11-27T12:00:00Z");
// Shape of a live https://cli-chat-proxy.grok.com/v1/billing?format=credits response, with fake values.
const billing = { config: {
  currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-11-27T01:20:13.017+00:00", end: "2026-12-04T01:20:13.017+00:00" },
  creditUsagePercent: 3.0,
  productUsage: [{ product: "Cursor", usagePercent: 2.0 }, { product: "GrokBuild", usagePercent: 1.0 }],
  isUnifiedBillingUser: true,
  prepaidBalance: { val: 0 },
  topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
  billingPeriodStart: "2026-11-27T01:20:13.017+00:00",
  billingPeriodEnd: "2026-12-04T01:20:13.017+00:00",
} };

async function home(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "quota-grok-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".grok"));
  return root;
}

function login(key: string, expiresAt = "2026-11-27T17:32:12.547484870Z") {
  return { key, auth_mode: "oidc", expires_at: expiresAt, user_id: "user", email: "person@example.com", refresh_token: "FAKE_REFRESH_TOKEN" };
}

test("Grok weekly pool keeps fractions, period dates, and the per-product split", () => {
  const [window] = parseGrokQuota(billing);
  assert.equal(window.name, "Weekly");
  assert.equal(window.usedPercent, 3);
  assert.equal(window.windowStart, "2026-11-27T01:20:13.017Z");
  assert.equal(window.windowEnd, "2026-12-04T01:20:13.017Z");
  assert.equal(window.resetAt, "2026-12-04T01:20:13.017Z");
  assert.equal(window.windowSeconds, 604_800);
  assert.equal(window.valueLabel, "Cursor 2% · Grok Build 1%");
  const fractional = parseGrokQuota({ config: { ...billing.config, creditUsagePercent: 41.27, productUsage: [{ product: "NewSurface", usagePercent: 0.25 }] } });
  assert.equal(fractional[0].usedPercent, 41.27);
  assert.equal(fractional[0].valueLabel, "NewSurface 0.3%");
  assert.equal(parseGrokQuota({ config: { ...billing.config, creditUsagePercent: 0 } })[0].usedPercent, 0);
});

test("Grok periods without valid dates or a known type stay unknown instead of guessed", () => {
  const monthly = parseGrokQuota({ config: { creditUsagePercent: 10, currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", start: "bad", end: "2026-12-01T00:00:00Z" } } });
  assert.equal(monthly[0].name, "Monthly");
  assert.equal(monthly[0].resetAt, null);
  assert.equal(monthly[0].windowSeconds, 2_592_000);
  const backwards = parseGrokQuota({ config: { creditUsagePercent: 10, currentPeriod: { type: "SOMETHING_ELSE", start: "2026-12-04T00:00:00Z", end: "2026-11-27T00:00:00Z" } } });
  assert.equal(backwards[0].name, "Usage");
  assert.equal(backwards[0].resetAt, null);
  assert.equal(backwards[0].windowSeconds, null);
  assert.equal(backwards[0].valueLabel, null);
});

test("Grok product names are trimmed and never read inherited object properties", () => {
  const [window] = parseGrokQuota({ config: { creditUsagePercent: 4, productUsage: [{ product: "toString", usagePercent: 1 }, { product: " GrokBuild ", usagePercent: 2 }, { product: "__proto__", usagePercent: 1 }] } });
  assert.equal(window.valueLabel, "toString 1% · Grok Build 2% · __proto__ 1%");
});

test("Grok rejects impossible calendar dates and offsets instead of rolling them over", () => {
  for (const [start, end] of [["2026-02-31T00:00:00Z", "2026-03-07T00:00:00Z"], ["2026-11-27T24:00:00Z", "2026-12-04T00:00:00Z"],
    ["2026-11-27T00:00:00+24:00", "2026-12-04T00:00:00Z"], ["2026-13-01T00:00:00Z", "2026-12-04T00:00:00Z"], ["2026-11-27T00:00:60Z", "2026-12-04T00:00:00Z"]]) {
    const [window] = parseGrokQuota({ config: { creditUsagePercent: 5, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start, end } } });
    assert.equal(window.resetAt, null, start);
    assert.equal(window.windowStart, null, start);
  }
  const [leap] = parseGrokQuota({ config: { creditUsagePercent: 5, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2028-02-29T00:00:00.123456789+08:00", end: "2028-03-07T00:00:00Z" } } });
  assert.equal(leap.windowStart, "2028-02-28T16:00:00.123Z");
});

test("Grok null, absent, and malformed usage never becomes zero", () => {
  for (const payload of [null, {}, { config: {} }, { config: { creditUsagePercent: null } }, { config: { creditUsagePercent: "3" } }, { config: { creditUsagePercent: Number.NaN } }]) {
    assert.deepEqual(parseGrokQuota(payload), []);
  }
  const products = parseGrokQuota({ config: { creditUsagePercent: 5, productUsage: [{ product: "", usagePercent: 1 }, { product: "Cursor", usagePercent: "2" }, null] } });
  assert.equal(products[0].valueLabel, null);
});

test("Grok credentials come from the CLI login file, pick the newest login, and never expose secrets", async (t) => {
  const root = await home(t);
  const path = join(root, ".grok", "auth.json");
  assert.match((await resolveGrokCredentials({}, now, root)).error!, /missing, unreadable, or invalid/);
  await writeFile(path, JSON.stringify({ "https://auth.x.ai::a": login("FAKE_OLD_TOKEN", "2026-11-27T13:00:00Z"), "https://auth.x.ai::b": login("FAKE_NEW_TOKEN") }));
  const credentials = await resolveGrokCredentials({}, now, root);
  assert.equal(credentials.configured, true);
  assert.equal(credentials.accessToken, "FAKE_NEW_TOKEN");
  assert.doesNotMatch(credentials.identity, /FAKE_|person@example\.com/);
  // A rotated token for the same login is a new identity, so the quota cache never mixes measurements across tokens.
  await writeFile(path, JSON.stringify({ "https://auth.x.ai::b": login("FAKE_ROTATED_TOKEN") }));
  assert.notEqual((await resolveGrokCredentials({}, now, root)).identity, credentials.identity);
  const expired = await resolveGrokCredentials({}, Date.parse("2026-11-27T18:00:00Z"), root);
  assert.equal(expired.errorKind, "authentication");
  assert.equal(expired.configured, true);
  assert.equal(expired.accessToken, undefined);
  assert.match(expired.error!, /expired.*grok login/);
  await writeFile(path, JSON.stringify({ "https://auth.x.ai::b": login("FAKE_TOKEN", "tomorrow") }));
  assert.match((await resolveGrokCredentials({}, now, root)).error!, /expiry metadata is invalid/);
  await writeFile(path, JSON.stringify({ "https://auth.x.ai::b": login("bad token") }));
  assert.equal((await resolveGrokCredentials({}, now, root)).accessToken, undefined);
  await writeFile(path, JSON.stringify({ other: { refresh_token: "x" } }));
  assert.match((await resolveGrokCredentials({}, now, root)).error!, /no login/);
  const custom = join(root, "custom.json");
  await writeFile(custom, JSON.stringify({ "https://auth.x.ai::c": login("FAKE_CUSTOM_TOKEN") }));
  assert.equal((await resolveGrokCredentials({ GROK_AUTH_PATH: custom }, now, root)).accessToken, "FAKE_CUSTOM_TOKEN");
  assert.equal((await resolveGrokCredentials({ GROK_AUTH_PATH: "" }, now, root)).errorKind, "configuration");
});

test("Grok requests use the CLI billing endpoint and safe structured failures without exposing secrets", async (t) => {
  const secret = "FAKE_GROK_SECRET";
  const credentials = { configured: true, identity: "private-fingerprint", accessToken: secret };
  let status = 200;
  let body = JSON.stringify(billing);
  let calls = 0;
  let throwNetwork = false;
  const originalVersion = process.env.GROK_CLIENT_VERSION;
  delete process.env.GROK_CLIENT_VERSION;
  t.after(() => { if (originalVersion === undefined) delete process.env.GROK_CLIENT_VERSION; else process.env.GROK_CLIENT_VERSION = originalVersion; });
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(String(url), "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    assert.equal(init?.method ?? "GET", "GET");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${secret}`);
    assert.equal(headers.get("x-grok-client-version"), process.env.GROK_CLIENT_VERSION ?? "1.0.92");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    if (throwNetwork) throw new Error(secret);
    return new Response(body, { status, headers: { "retry-after": "7200" } });
  });
  const ok = await fetchGrok(credentials);
  assert.equal(ok.status, "ok");
  assert.equal(ok.windows[0].usedPercent, 3);
  for (const [code, kind] of [[401, "authentication"], [403, "authentication"], [429, "rate_limit"], [500, "server"], [400, "response"]] as const) {
    status = code;
    body = secret;
    const result = await fetchGrok(credentials);
    assert.equal(result.errorKind, kind);
    assert.ok(result.cooldownUntil! > Date.now() + 7_000_000);
    assert.doesNotMatch(JSON.stringify(result), /FAKE_GROK_SECRET|private-fingerprint|authorization/i);
  }
  status = 200;
  for (const badBody of ["not JSON", "{}", '{"config":{"creditUsagePercent":null}}']) {
    body = badBody;
    assert.equal((await fetchGrok(credentials)).errorKind, "response");
  }
  body = JSON.stringify({ config: { isUnifiedBillingUser: false, monthlyLimit: { val: 0 } } });
  assert.match((await fetchGrok(credentials)).error!, /not on The X Subscription/);
  // Zero values are serialized for absent data, so a 0% pool must not be shown for a login outside The X Subscription.
  body = JSON.stringify({ config: { ...billing.config, isUnifiedBillingUser: false, creditUsagePercent: 0 } });
  const outside = await fetchGrok(credentials);
  assert.equal(outside.errorKind, "response");
  assert.deepEqual(outside.windows, []);
  assert.match(outside.error!, /not on The X Subscription/);
  throwNetwork = true;
  const failed = await fetchGrok(credentials);
  assert.equal(failed.errorKind, "network");
  assert.doesNotMatch(JSON.stringify(failed), /FAKE_GROK_SECRET/);
  const before = calls;
  for (const version of ["", "1.0 beta", "x".repeat(65)]) {
    process.env.GROK_CLIENT_VERSION = version;
    assert.equal((await fetchGrok(credentials)).errorKind, "configuration");
  }
  assert.equal((await fetchGrok({ configured: true, identity: "expired", error: "Grok login token has expired", errorKind: "authentication" })).errorKind, "authentication");
  assert.equal(calls, before);
});

test("Grok results flow through the quota cache, keeping stale measurements only for transient failures", async (t) => {
  let status = 200;
  t.mock.method(globalThis, "fetch", async () => new Response(status === 200 ? JSON.stringify(billing) : "{}", { status }));
  const credentials = { configured: true, identity: "grok-identity", accessToken: "FAKE_TOKEN" };
  let time = now;
  const cache = createQuotaCache({ prepare: async () => ({ configured: true, identity: credentials.identity, fetch: () => fetchGrok(credentials) }), now: () => time, ttl: () => 0 });
  assert.equal((await cache.get("grok")).windows[0].usedPercent, 3);
  status = 503;
  time += 1;
  const stale = await cache.get("grok");
  assert.equal(stale.stale, true);
  assert.equal(stale.windows[0].usedPercent, 3);
  status = 401;
  time += 1;
  const rejected = await cache.get("grok");
  assert.equal(rejected.errorKind, "authentication");
  assert.deepEqual(rejected.windows, []);
});

test("an expired Grok login still counts as configured so settings point to renewal, not missing credentials", async (t) => {
  const root = await home(t);
  const path = join(root, "auth.json");
  const original = process.env.GROK_AUTH_PATH;
  t.after(() => { if (original === undefined) delete process.env.GROK_AUTH_PATH; else process.env.GROK_AUTH_PATH = original; });
  process.env.GROK_AUTH_PATH = path;
  assert.equal(await isProviderConfigured("grok"), false);
  await writeFile(path, JSON.stringify({ "https://auth.x.ai::a": login("FAKE_EXPIRED_TOKEN", "2020-01-01T00:00:00Z") }));
  assert.equal(await isProviderConfigured("grok"), true);
  const expired = await resolveGrokCredentials();
  assert.equal(expired.accessToken, undefined);
  assert.equal(expired.errorKind, "authentication");
  await writeFile(path, JSON.stringify({ "https://auth.x.ai::a": login("bad token") }));
  assert.equal(await isProviderConfigured("grok"), false);
});
