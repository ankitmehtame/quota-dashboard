import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRouterKeyHash } from "./openrouter-analytics.js";
import { OpenRouterUsageStore } from "./openrouter-usage-store.js";

test("keeps independent private per-key and timezone snapshots and replaces successful days", async () => {
  const root = await mkdtemp(join(tmpdir(), "openrouter-usage-"));
  try {
    const store = new OpenRouterUsageStore(join(root, "data"));
    const key = openRouterKeyHash("key");
    const other = openRouterKeyHash("other");
    const record = { date: "2026-11-12", provider: "openrouter", model: "test", inputTokens: 1, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0.01, missingPricing: false };
    await store.write(key, record.date, "Asia/Singapore", [record]);
    assert.equal((await store.read(key, record.date, "Asia/Singapore"))?.records.length, 1);
    assert.equal(await store.read(other, record.date, "Asia/Singapore"), null);
    assert.equal(await store.read(key, record.date, "UTC"), null);
    await store.write(key, record.date, "Asia/Singapore", []);
    assert.deepEqual((await store.read(key, record.date, "Asia/Singapore"))?.records, []);
    assert.equal((await stat(join(root, "data"))).mode & 0o777, 0o700);
    await assert.rejects(store.write("../unsafe", record.date, "UTC", []));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reports retained history per timezone, rejects corrupt snapshots and leaves no temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "openrouter-usage-"));
  try {
    const store = new OpenRouterUsageStore(join(root, "data"));
    const key = openRouterKeyHash("key");
    const record = { date: "2026-11-12", provider: "openrouter", model: "test", inputTokens: 1, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0.01, missingPricing: false };
    assert.equal(await store.has(key, "UTC"), false);
    await store.write(key, record.date, "UTC", [record]);
    assert.equal(await store.has(key, "UTC"), true);
    assert.equal(await store.has(key, "Asia/Singapore"), false);
    await assert.rejects(store.write(key, "2026-11-13", "UTC", [record]), /Invalid/);
    await assert.rejects(store.write(key, "../2026-11", "UTC", []));
    // The key hash and date, not the credential or label, identify the file; contents hold no hash.
    const [timezoneDirectory] = await readdir(join(root, "data", key));
    assert.deepEqual((await readdir(join(root, "data", key, timezoneDirectory))).sort(), ["2026-11-12.json"]);
    const path = join(root, "data", key, timezoneDirectory, "2026-11-12.json");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(key));
    await writeFile(path, "{not json");
    await assert.rejects(store.read(key, record.date, "UTC"));
    await writeFile(path, JSON.stringify({ version: 1, date: "2026-11-13", timezone: "UTC", fetchedAt: new Date().toISOString(), records: [] }));
    await assert.rejects(store.read(key, record.date, "UTC"), /Invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
