import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenRouterUsageCollector } from "./openrouter-usage-collector.js";
import { openRouterKeyHash } from "./openrouter-analytics.js";
import { OpenRouterUsageStore } from "./openrouter-usage-store.js";
import { summarizeUsage, type UsageRecord } from "./usage.js";

const DATE = "2026-11-12";
const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({ date: DATE, provider: "openrouter", model: "test", inputTokens: 80, cachedInputTokens: 20,
  cacheCreationTokens: 0, outputTokens: 40, reasoningTokens: 10, costUsd: 0.1, missingPricing: false, ...overrides });

async function fixture(env: NodeJS.ProcessEnv = {}, options: { now?: () => number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "openrouter-collector-"));
  const environment: NodeJS.ProcessEnv = { OPENCODE_AUTH_PATH: join(root, "missing-auth.json"), OPENROUTER_MANAGEMENT_API_KEY: "management", ...env };
  const queried: string[] = [];
  const keyLookups: string[] = [];
  const behaviour: { fail: Set<string>; rows: Map<string, UsageRecord[]> } = { fail: new Set(), rows: new Map() };
  const store = new OpenRouterUsageStore(join(root, "store"));
  const collector = new OpenRouterUsageCollector(store, environment,
    async (management, keyId, date) => {
      assert.equal(management, "management");
      queried.push(`${keyId}:${date}`);
      if (behaviour.fail.has(keyId)) throw new Error("upstream management secret");
      return (behaviour.rows.get(keyId) ?? [record()]).map((row) => ({ ...row, date }));
    },
    async (secret) => { keyLookups.push(secret); return `id-of-${secret}`; }, options.now);
  return { root, env: environment, queried, keyLookups, behaviour, store, collector, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("refresh queries by OpenRouter key id once resolved, stores by local hash and isolates failures", async () => {
  const f = await fixture({ OPENROUTER_KEY_1: "secret-one", OPENROUTER_KEY_1_LABEL: "Home", OPENROUTER_KEY_2: "secret-two", OPENROUTER_KEY_2_LABEL: "Work" });
  try {
    f.behaviour.fail.add("id-of-secret-two");
    assert.deepEqual(await f.collector.refresh(DATE, "UTC"), { attempted: 2, succeeded: 1, failed: 1, error: "One or more OpenRouter usage keys could not be refreshed" });
    assert.deepEqual(f.queried.sort(), [`id-of-secret-one:${DATE}`, `id-of-secret-two:${DATE}`]);
    assert.equal((await f.store.read(openRouterKeyHash("secret-one"), DATE, "UTC"))?.records.length, 1);
    assert.equal(await f.store.read(openRouterKeyHash("secret-two"), DATE, "UTC"), null);
    f.behaviour.fail.clear();
    await f.collector.refresh(DATE, "UTC");
    // The key id is resolved once per secret, not once per refresh.
    assert.deepEqual(f.keyLookups.sort(), ["secret-one", "secret-two"]);
  } finally { await f.cleanup(); }
});

test("a failed or inconsistent refresh preserves the last successful snapshot, while an empty success replaces it", async () => {
  const f = await fixture({ OPENROUTER_KEY_1: "secret-one", OPENROUTER_KEY_1_LABEL: "Home" });
  try {
    await f.collector.refresh(DATE, "UTC");
    f.behaviour.fail.add("id-of-secret-one");
    assert.equal((await f.collector.refresh(DATE, "UTC")).failed, 1);
    assert.equal((await f.collector.read([DATE], "UTC")).entries[0].records[0].costUsd, 0.1);
    f.behaviour.fail.clear();
    f.behaviour.rows.set("id-of-secret-one", []);
    assert.equal((await f.collector.refresh(DATE, "UTC")).error, null);
    assert.deepEqual((await f.collector.read([DATE], "UTC")).entries, [{ label: "Home", records: [] }]);
  } finally { await f.cleanup(); }
});

test("a failing key-id lookup is a per-key failure and does not write", async () => {
  const f = await fixture({ OPENROUTER_KEY_1: "secret-one", OPENROUTER_KEY_1_LABEL: "Home" });
  const collector = new OpenRouterUsageCollector(f.store, f.env, async () => [record()], async () => { throw new Error("secret-one leaked"); });
  try {
    const result = await collector.refresh(DATE, "UTC");
    assert.deepEqual(result, { attempted: 1, succeeded: 0, failed: 1, error: "One or more OpenRouter usage keys could not be refreshed" });
    assert.doesNotMatch(JSON.stringify(result), /secret/);
    assert.equal(await f.store.read(openRouterKeyHash("secret-one"), DATE, "UTC"), null);
  } finally { await f.cleanup(); }
});

test("inactive keys are never queried, even through duplicate credentials, but selected inactive history stays visible", async () => {
  const f = await fixture({ OPENROUTER_KEY_1: "shared", OPENROUTER_KEY_1_LABEL: "Home", OPENROUTER_KEY_2: "shared", OPENROUTER_KEY_2_LABEL: "Home",
    OPENROUTER_KEY_3: "live", OPENROUTER_KEY_3_LABEL: "Live" });
  try {
    await f.collector.refresh(DATE, "UTC");
    assert.deepEqual(f.queried.sort(), [`id-of-live:${DATE}`, `id-of-shared:${DATE}`]);
    f.queried.length = 0;
    f.keyLookups.length = 0;
    // Marking either duplicate inactive silences the shared credential.
    f.env.OPENROUTER_INACTIVE_KEYS = "2";
    f.behaviour.fail.add("id-of-shared");
    assert.deepEqual(await f.collector.refresh(DATE, "UTC"), { attempted: 1, succeeded: 1, failed: 0, error: null });
    assert.deepEqual(f.queried, [`id-of-live:${DATE}`]);
    assert.deepEqual(f.keyLookups, []);
    assert.deepEqual((await f.collector.read([DATE], "UTC")).entries.map((entry) => [entry.label, entry.records.length]), [["Home", 1], ["Live", 1]]);
    // Narrowing usage to the inactive key keeps showing it; narrowing it away hides it.
    f.env.OPENROUTER_USAGE_KEYS = "1";
    assert.deepEqual((await f.collector.read([DATE], "UTC")).entries.map((entry) => entry.label), ["Home"]);
    f.env.OPENROUTER_USAGE_KEYS = "3";
    assert.deepEqual((await f.collector.read([DATE], "UTC")).entries.map((entry) => entry.label), ["Live"]);
    f.env.OPENROUTER_USAGE_KEYS = "none";
    assert.deepEqual((await f.collector.read([DATE], "UTC")).entries, []);
    assert.deepEqual(await f.collector.refresh(DATE, "UTC"), { attempted: 0, succeeded: 0, failed: 0, error: null });
    assert.equal(await f.collector.enabled(), false);
    // All keys inactive: nothing is queried at all.
    delete f.env.OPENROUTER_USAGE_KEYS;
    f.env.OPENROUTER_INACTIVE_KEYS = "1,2,3";
    f.queried.length = 0;
    assert.equal(await f.collector.enabled(), false);
    await f.collector.refresh(DATE, "UTC");
    assert.deepEqual(f.queried, []);
  } finally { await f.cleanup(); }
});

test("groups by the exact current label, combining keys, and relabelling preserves history", async () => {
  const f = await fixture({ OPENROUTER_KEY_1: "one", OPENROUTER_KEY_1_LABEL: "Home", OPENROUTER_KEY_2: "two", OPENROUTER_KEY_2_LABEL: "Home",
    OPENROUTER_KEY_3: "three", OPENROUTER_KEY_3_LABEL: "home" });
  try {
    f.behaviour.rows.set("id-of-one", [record({ costUsd: 1 }), record({ model: "other", costUsd: 5, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 })]);
    f.behaviour.rows.set("id-of-two", [record({ costUsd: 2 })]);
    f.behaviour.rows.set("id-of-three", [record({ costUsd: 4 })]);
    await f.collector.refresh(DATE, "UTC");
    const grouped = (await f.collector.read([DATE], "UTC")).entries;
    // Labels are case-sensitive and exact: "Home" combines two keys, "home" stays separate.
    assert.deepEqual(grouped.map((entry) => entry.label), ["Home", "home"]);
    const home = grouped[0].records;
    assert.equal(home.length, 2);
    assert.equal(home.find((row) => row.model === "test")?.costUsd, 3);
    assert.equal(home.find((row) => row.model === "test")?.inputTokens, 160);
    assert.equal(summarizeUsage(home).totalTokens, 2 * 150 + 1);
    assert.equal(grouped[1].records[0].costUsd, 4);
    // A rename regroups existing history without rewriting snapshots.
    f.env.OPENROUTER_KEY_2_LABEL = "Renamed";
    f.env.OPENROUTER_KEY_3_LABEL = "Home";
    const renamed = (await f.collector.read([DATE], "UTC")).entries;
    assert.deepEqual(renamed.map((entry) => [entry.label, entry.records.reduce((sum, row) => sum + row.costUsd, 0)]), [["Home", 10], ["Renamed", 2]]);
  } finally { await f.cleanup(); }
});

test("conflicting labels for one credential are an error, while unselected duplicates are not", async () => {
  const f = await fixture({ OPENROUTER_API_KEY: "same", OPENROUTER_KEY_1: "same", OPENROUTER_KEY_1_LABEL: "Home", OPENROUTER_KEY_2: "other", OPENROUTER_KEY_2_LABEL: "Other" });
  try {
    // The default key is not selected by default, so its different label does not matter.
    assert.equal((await f.collector.refresh(DATE, "UTC")).error, null);
    f.env.OPENROUTER_USAGE_KEYS = "default,1,2";
    assert.deepEqual(await f.collector.refresh(DATE, "UTC"), { attempted: 0, succeeded: 0, failed: 1, error: "Invalid OpenRouter usage key configuration" });
    await assert.rejects(f.collector.read([DATE], "UTC"), /conflicting labels/);
    assert.equal(await f.collector.enabled(), false);
    f.env.OPENROUTER_KEY_1_LABEL = "Default";
    assert.equal((await f.collector.refresh(DATE, "UTC")).error, null);
    // The shared credential is counted once.
    assert.equal((await f.collector.read([DATE], "UTC")).entries.length, 2);
  } finally { await f.cleanup(); }
});

test("rejects unknown selectors instead of silently selecting or silencing keys", async () => {
  const f = await fixture({ OPENROUTER_KEY_1: "one", OPENROUTER_KEY_1_LABEL: "Home" });
  try {
    for (const [name, value] of [["OPENROUTER_USAGE_KEYS", "9"], ["OPENROUTER_USAGE_KEYS", "one"], ["OPENROUTER_USAGE_KEYS", "1,,2"], ["OPENROUTER_INACTIVE_KEYS", "7"]]) {
      f.env[name] = value;
      await assert.rejects(f.collector.read([DATE], "UTC"), Error, `${name}=${value}`);
      assert.equal((await f.collector.refresh(DATE, "UTC")).error, "Invalid OpenRouter usage key configuration");
      f.queried.length = 0;
      delete f.env[name];
    }
    assert.deepEqual(f.queried, []);
  } finally { await f.cleanup(); }
});

test("an incomplete pair is skipped and reported without hiding complete keys", async () => {
  const f = await fixture({ OPENROUTER_KEY_1: "one", OPENROUTER_KEY_1_LABEL: "Home", OPENROUTER_KEY_2: "orphan", OPENROUTER_KEY_3_LABEL: "No secret" });
  try {
    assert.deepEqual(await f.collector.refresh(DATE, "UTC"), { attempted: 1, succeeded: 1, failed: 0, error: "One or more OpenRouter usage keys are incomplete" });
    assert.deepEqual(f.queried, [`id-of-one:${DATE}`]);
    const result = await f.collector.read([DATE], "UTC");
    assert.deepEqual(result.entries.map((entry) => entry.label), ["Home"]);
    assert.equal(result.error, "One or more OpenRouter usage keys are incomplete");
  } finally { await f.cleanup(); }
});

test("without a management key history stays readable but nothing is queried; keys without data stay hidden", async () => {
  const f = await fixture({ OPENROUTER_KEY_1: "one", OPENROUTER_KEY_1_LABEL: "Home", OPENROUTER_KEY_2: "two", OPENROUTER_KEY_2_LABEL: "Never used" });
  try {
    await f.collector.refresh(DATE, "UTC");
    delete f.env.OPENROUTER_MANAGEMENT_API_KEY;
    f.queried.length = 0;
    assert.deepEqual(await f.collector.refresh(DATE, "UTC"), { attempted: 0, succeeded: 0, failed: 2, error: "OpenRouter management key is not configured" });
    assert.equal(await f.collector.enabled(), false);
    assert.equal(await f.collector.needsRefresh("2020-01-01", "UTC"), false);
    assert.deepEqual(f.queried, []);
    assert.deepEqual((await f.collector.read([DATE], "UTC")).entries.map((entry) => entry.label), ["Home", "Never used"]);
    // History retained for a different timezone is not mixed in.
    assert.deepEqual((await f.collector.read([DATE], "Asia/Singapore")).entries, []);
    const bare = await fixture({ OPENROUTER_KEY_1: "one", OPENROUTER_KEY_1_LABEL: "Home" });
    delete bare.env.OPENROUTER_MANAGEMENT_API_KEY;
    try { assert.deepEqual((await bare.collector.read([DATE], "UTC")).entries, []); } finally { await bare.cleanup(); }
  } finally { await f.cleanup(); }
});

test("quota-only incomplete and duplicate pairs do not produce analytics errors", async () => {
  const f = await fixture({ OPENROUTER_KEY_1: "same", OPENROUTER_KEY_1_LABEL: "One", OPENROUTER_KEY_2: "same", OPENROUTER_KEY_2_LABEL: "Two", OPENROUTER_KEY_3: "incomplete" });
  delete f.env.OPENROUTER_MANAGEMENT_API_KEY;
  try { assert.deepEqual(await f.collector.read([DATE], "UTC"), { entries: [], error: null }); } finally { await f.cleanup(); }
});

test("a corrupt snapshot is reported while other snapshots and keys are still returned", async () => {
  const f = await fixture({ OPENROUTER_KEY_1: "one", OPENROUTER_KEY_1_LABEL: "Home" });
  try {
    await f.collector.refresh(DATE, "UTC");
    await f.collector.refresh("2026-11-11", "UTC");
    const corrupt = join(f.root, "store", openRouterKeyHash("one"));
    const { readdir } = await import("node:fs/promises");
    const [timezoneDirectory] = await readdir(corrupt);
    await writeFile(join(corrupt, timezoneDirectory, "2026-11-11.json"), "{bad");
    const result = await f.collector.read(["2026-11-11", DATE], "UTC");
    assert.equal(result.error, "OpenRouter usage data could not be fully read");
    assert.equal(result.entries[0].records.length, 1);
    // Corrupt data is refetched by cold backfill rather than trusted.
    f.queried.length = 0;
    assert.equal(await f.collector.needsRefresh("2026-11-11", "UTC"), true);
  } finally { await f.cleanup(); }
});

test("cold backfill needs missing days and days last fetched before they settled, using the local day end", async () => {
  let now = Date.parse("2026-11-12T12:00:00Z");
  const f = await fixture({ OPENROUTER_KEY_1: "one", OPENROUTER_KEY_1_LABEL: "Home" }, { now: () => now });
  try {
    // Singapore's 2026-11-12 ends at 16:00Z: before that, and for 15 minutes after, the hot job owns it.
    assert.equal(await f.collector.needsRefresh(DATE, "Asia/Singapore"), false);
    now = Date.parse("2026-11-12T16:10:00Z");
    assert.equal(await f.collector.needsRefresh(DATE, "Asia/Singapore"), false);
    now = Date.parse("2026-11-12T16:20:00Z");
    assert.equal(await f.collector.needsRefresh(DATE, "Asia/Singapore"), true);
    // Fetched during the day (hot), then needs one final pass after the day settled.
    now = Date.parse("2026-11-12T15:00:00Z");
    await f.collector.refresh(DATE, "Asia/Singapore");
    now = Date.parse("2026-11-12T16:20:00Z");
    assert.equal(await f.collector.needsRefresh(DATE, "Asia/Singapore"), true);
    await f.store.write(openRouterKeyHash("one"), DATE, "Asia/Singapore", [], new Date(now).toISOString());
    assert.equal(await f.collector.needsRefresh(DATE, "Asia/Singapore"), false);
    // The same date in UTC is a different local day, with its own snapshot.
    assert.equal(await f.collector.needsRefresh(DATE, "UTC"), false);
    now = Date.parse("2026-11-13T00:20:00Z");
    assert.equal(await f.collector.needsRefresh(DATE, "UTC"), true);
  } finally { await f.cleanup(); }
});

test("concurrent refreshes of one day share a single upstream query", async () => {
  const f = await fixture({ OPENROUTER_KEY_1: "one", OPENROUTER_KEY_1_LABEL: "Home" });
  try {
    const [a, b] = await Promise.all([f.collector.refresh(DATE, "UTC"), f.collector.refresh(DATE, "UTC")]);
    assert.deepEqual(a, b);
    assert.equal(f.queried.length, 1);
    await f.collector.refresh(DATE, "Asia/Singapore");
    assert.equal(f.queried.length, 2);
  } finally { await f.cleanup(); }
});
