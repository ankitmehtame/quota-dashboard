import test from "node:test";
import assert from "node:assert/strict";
import { createQuotaCache, type QuotaAttempt } from "./quota-cache.js";
import { type ProviderResult, usageWindow } from "./core.js";

const start = Date.parse("2026-10-16T12:00:00Z");
const success = (): ProviderResult => ({ configured: true, status: "ok", error: null, fetchedAt: new Date(start).toISOString(), windows: [usageWindow({ name: "5-hour", usedPercent: 12.5 })] });
const failure = (errorKind: ProviderResult["errorKind"], cooldownUntil?: number): ProviderResult => ({
  configured: errorKind !== "configuration", status: "error", error: "safe error", errorKind, cooldownUntil, fetchedAt: new Date(start + 1000).toISOString(), windows: [],
});
function harness() {
  let time = start;
  let identity = "source-A:private-token-hash-A";
  let value = success();
  let calls = 0;
  let changes = 0;
  const cache = createQuotaCache({ now: () => time, onChange: () => changes++, prepare: async () => ({ configured: value.configured, identity, fetch: async () => { calls++; return value; } }) });
  return { cache, setTime: (next: number) => { time = next; }, setIdentity: (next: string) => { identity = next; }, setValue: (next: ProviderResult) => { value = next; },
    calls: () => calls, changes: () => changes };
}

test("Claude TTL is 300 seconds, existing defaults and configured TTLs remain independent", async () => {
  const h = harness();
  await h.cache.get("claude");
  assert.equal(h.cache.expiresAt("claude"), start + 300_000);
  h.setTime(start + 299_999);
  assert.equal((await h.cache.get("claude")).cached, true);
  assert.equal(h.calls(), 1);
  h.setTime(start + 300_000);
  assert.equal((await h.cache.get("claude")).cached, undefined);
  assert.equal(h.calls(), 2);
  await h.cache.get("codex");
  h.setTime(start + 420_000);
  await h.cache.get("codex");
  assert.equal(h.calls(), 4);
  let calls = 0;
  let now = start;
  const custom = createQuotaCache({ now: () => now, ttl: (id) => id === "claude" ? 300_000 : 42_000,
    prepare: async () => ({ configured: true, fetch: async () => { calls++; return success(); } }) });
  await custom.get("ollama");
  now += 41_999;
  await custom.get("ollama");
  assert.equal(calls, 1);
  now++;
  await custom.get("ollama");
  assert.equal(calls, 2);
  const uncached = createQuotaCache({ ttl: () => 0, prepare: async () => ({ configured: true, fetch: async () => { calls++; return success(); } }) });
  await uncached.get("ollama");
  await uncached.get("ollama");
  assert.equal(calls, 4);
});

test("concurrent requests share the whole pipeline, including forced and provider-test requests", async () => {
  let calls = 0;
  let release!: (value: ProviderResult) => void;
  const deferred = new Promise<ProviderResult>((resolve) => { release = resolve; });
  const cache = createQuotaCache({ prepare: async () => ({ configured: true, fetch: () => { calls++; return deferred; } }) });
  const a = cache.get("claude");
  const b = cache.get("claude", true);
  const c = cache.get("claude");
  assert.equal(a, b);
  assert.equal(a, c);
  release(success());
  const values = await Promise.all([a, b, c]);
  assert.equal(calls, 1);
  assert.equal(values[0], values[1]);
  assert.equal(values[1], values[2]);
});

test("synchronous throws and rejected promises are safe, clean up, and allow later retry", async () => {
  for (const sync of [true, false]) {
    let shouldFail = true;
    let calls = 0;
    const cache = createQuotaCache({ prepare: async () => ({ configured: false, fetch: () => {
      calls++;
      if (shouldFail) { if (sync) throw new Error("RAW_TOKEN_SECRET"); return Promise.reject(new Error("RAW_TOKEN_SECRET")); }
      return Promise.resolve(success());
    } }) });
    const results = await Promise.all([cache.get("claude"), cache.get("claude", true)]);
    assert.equal(calls, 1);
    assert.equal(results[0].configured, false);
    assert.equal(results[0].errorKind, "internal");
    assert.doesNotMatch(JSON.stringify(results), /RAW_TOKEN_SECRET/);
    shouldFail = false;
    assert.equal((await cache.get("claude", true)).status, "ok");
    assert.equal(calls, 2);
  }
  const resolverError = createQuotaCache({ prepare: async () => { throw new Error("PRIVATE_PATH"); } });
  assert.equal((await resolverError.get("claude")).configured, false);
  assert.doesNotMatch(JSON.stringify(await resolverError.get("claude")), /PRIVATE_PATH/);
});

test("repeated transient failures retain original measurement time, never an old error or cooldown", async () => {
  const h = harness();
  await h.cache.get("claude");
  for (const kind of ["network", "server", "rate_limit"] as const) {
    h.setValue(failure(kind));
    const result = await h.cache.get("claude", true);
    assert.equal(result.status, "error");
    assert.equal(result.errorKind, kind);
    assert.equal(result.error, "safe error");
    assert.equal(result.stale, true);
    assert.equal(result.fetchedAt, new Date(start).toISOString());
    assert.equal(result.windows[0].usedPercent, 12.5);
    if (kind === "rate_limit") assert.equal(result.cooldownUntil, start + 300_000);
  }
});

test("auth, configuration, schema, and internal errors clear retained success", async () => {
  for (const kind of ["authentication", "configuration", "response", "internal"] as const) {
    const h = harness();
    await h.cache.get("claude");
    h.setValue(failure(kind));
    const rejected = await h.cache.get("claude", true);
    assert.deepEqual(rejected.windows, []);
    assert.equal(rejected.configured, kind !== "configuration");
    h.setValue(failure("network"));
    const network = await h.cache.get("claude", true);
    assert.deepEqual(network.windows, []);
    assert.notEqual(network.stale, true);
  }
});

test("429 fallback backoff caps at one hour, force cannot bypass it, expiry does not add a TTL", async () => {
  const h = harness();
  h.setValue(failure("rate_limit"));
  let time = start;
  for (const delay of [300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000]) {
    h.setTime(time);
    const result = await h.cache.get("claude", true);
    assert.equal(result.cooldownUntil, time + delay);
    assert.equal(h.cache.expiresAt("claude"), time + delay);
    const calls = h.calls();
    h.setTime(time + delay - 1);
    assert.equal((await h.cache.get("claude", true)).cached, true);
    await h.cache.get("claude");
    assert.equal(h.calls(), calls);
    time += delay;
  }
  h.setTime(time);
  h.setValue(success());
  assert.equal((await h.cache.get("claude")).status, "ok");
  h.setValue(failure("rate_limit"));
  assert.equal((await h.cache.get("claude", true)).cooldownUntil, time + 300_000);
});

test("server Retry-After longer than fallback is honored, including auth and success responses", async () => {
  for (const kind of ["rate_limit", "authentication", "server", undefined] as const) {
    const h = harness();
    h.setValue(kind ? failure(kind, start + 7_200_000) : { ...success(), cooldownUntil: start + 7_200_000 });
    const first = await h.cache.get("claude");
    assert.equal(first.cooldownUntil, start + 7_200_000);
    if (kind) assert.equal(first.errorKind, kind);
    h.setTime(start + 7_199_999);
    assert.equal((await h.cache.get("claude", true)).cached, true);
    assert.equal(h.calls(), 1);
    h.setTime(start + 7_200_000);
    h.setValue(success());
    assert.equal((await h.cache.get("claude")).status, "ok");
    assert.equal(h.calls(), 2);
  }
});

test("zero and past cooldowns use 429 fallback, but do not impose a cooldown for other failures", async () => {
  for (const deadline of [undefined, start, start - 1000]) {
    const h = harness();
    h.setValue(failure("rate_limit", deadline));
    assert.equal((await h.cache.get("claude")).cooldownUntil, start + 300_000);
    const other = harness();
    other.setValue(failure("server", deadline));
    await other.cache.get("claude");
    await other.cache.get("claude", true);
    assert.equal(other.calls(), 2);
  }
});

test("credential changes clear quota and invalidate aggregate snapshots without exposing identity", async () => {
  for (const identity of ["source-B:private-token-hash-A", "source-A:private-token-hash-B"]) {
    const h = harness();
    await h.cache.get("claude");
    const oldChanges = h.changes();
    h.setIdentity(identity);
    h.setValue(failure("network"));
    const result = await h.cache.get("claude", true);
    assert.deepEqual(result.windows, []);
    assert.notEqual(result.stale, true);
    assert.ok(h.changes() > oldChanges);
    assert.doesNotMatch(JSON.stringify(result), /source-|private-token-hash|identity/);
  }
});

test("late invalidated requests cannot restore quota or delete a newer in-flight request", async () => {
  const releases: Array<(value: ProviderResult) => void> = [];
  let identity = "old";
  const cache = createQuotaCache({ prepare: async (): Promise<QuotaAttempt> => ({ configured: true, identity,
    fetch: () => new Promise((resolve) => releases.push(resolve)) }) });
  const old = cache.get("claude");
  // Drain the prepare and fetch microtasks without any wall-clock sleeps.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  cache.invalidate("claude");
  identity = "new";
  const newer = cache.get("claude", true);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(releases.length, 2);
  releases[0](success());
  assert.deepEqual((await old).windows, []);
  assert.equal(cache.get("claude", true), newer);
  releases[1]({ ...success(), windows: [usageWindow({ name: "Weekly", usedPercent: 80 })] });
  await newer;
  assert.equal((await cache.get("claude")).windows[0].usedPercent, 80);
});

test("changing credentials or toggling a provider cannot erase a cooldown", async () => {
  const h = harness();
  await h.cache.get("claude");
  h.setValue(failure("rate_limit"));
  await h.cache.get("claude", true);
  h.setIdentity("new-source:new-hash");
  h.cache.invalidate("claude");
  const result = await h.cache.get("claude", true);
  assert.equal(h.calls(), 2);
  assert.deepEqual(result.windows, []);
  assert.equal(result.cooldownUntil, start + 300_000);
  h.setTime(start + 300_000);
  h.setValue(failure("network"));
  assert.deepEqual((await h.cache.get("claude")).windows, []);
  assert.equal(h.calls(), 3);
});

test("settings credential observations invalidate old snapshots and preserve cooldown diagnostics", async () => {
  const h = harness();
  const live = await h.cache.get("claude");
  const cached = await h.cache.get("claude");
  assert.equal(h.cache.isCurrent("claude", live), true);
  assert.equal(h.cache.isCurrent("claude", cached), true);
  const changes = h.changes();
  h.setIdentity("source-B:private-token-hash-B");
  h.cache.observe("claude", "source-B:private-token-hash-B");
  assert.equal(h.cache.isCurrent("claude", live), false);
  assert.equal(h.cache.isCurrent("claude", cached), false);
  assert.ok(h.changes() > changes);
  h.setValue(failure("network"));
  assert.deepEqual((await h.cache.get("claude")).windows, []);
  h.setValue(success());
  await h.cache.get("claude", true);
  h.setValue(failure("rate_limit"));
  await h.cache.get("claude", true);
  h.cache.observe("claude", "source-B:private-token-hash-B", failure("authentication"));
  const auth = await h.cache.get("claude", true);
  assert.equal(auth.errorKind, "authentication");
  assert.deepEqual(auth.windows, []);
  assert.equal(auth.cooldownUntil, start + 300_000);
  assert.equal(auth.cached, true);
});

test("invalidating a successful response with Retry-After cannot report cached success for another account", async () => {
  const h = harness();
  h.setValue({ ...success(), cooldownUntil: start + 600_000 });
  await h.cache.get("claude");
  h.cache.observe("claude", "new-source:new-token");
  const paused = await h.cache.get("claude", true);
  assert.equal(paused.status, "error");
  assert.deepEqual(paused.windows, []);
  assert.equal(paused.cooldownUntil, start + 600_000);
  assert.equal(h.calls(), 1);
});
