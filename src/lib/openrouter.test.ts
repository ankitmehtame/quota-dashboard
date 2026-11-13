import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchOpenRouter, filterInactiveOpenRouterKeys, parseOpenRouterUsage, resolveOpenRouterKeys, resolveOpenRouterUsageSelection, selectOpenRouterKeys } from "./openrouter.js";
import { isProviderConfigured } from "./providers.js";

const payload = { data: { usage: 100, usage_daily: 0, usage_weekly: 4, usage_monthly: 8,
  limit: 20, limit_remaining: 9, limit_reset: "monthly", include_byok_in_limit: true,
  byok_usage: 10, byok_usage_daily: 0, byok_usage_weekly: 1, byok_usage_monthly: 3,
  label: "sk-or-v1-SECRET_UPSTREAM_LABEL", hash: "PRIVATE_HASH" } };

test("selectors default to all, reject unknown keys and inactivity overrides duplicate credentials", async () => {
  const entries = await resolveOpenRouterKeys({ OPENROUTER_API_KEY: "default", OPENROUTER_KEY_1: "same",
    OPENROUTER_KEY_1_LABEL: "Home", OPENROUTER_KEY_2: "same", OPENROUTER_KEY_2_LABEL: "Home",
    OPENROUTER_KEY_3: "other", OPENROUTER_KEY_3_LABEL: "Other" });
  assert.deepEqual(selectOpenRouterKeys(entries, "", "numbered").map((e) => e.id), ["key-1", "key-2", "key-3"]);
  assert.deepEqual(selectOpenRouterKeys(entries, "default,3", "all").map((e) => e.id), ["default", "key-3"]);
  assert.deepEqual(selectOpenRouterKeys(entries, "none", "all"), []);
  assert.throws(() => selectOpenRouterKeys(entries, "9", "all"));
  assert.deepEqual(filterInactiveOpenRouterKeys(entries, "1").map((e) => e.id), ["default", "key-3"]);
  const selection = resolveOpenRouterUsageSelection(entries, "1,2,3", "1");
  assert.deepEqual(selection.visible.map((e) => e.id), ["key-1", "key-3"]);
  assert.deepEqual(selection.active.map((e) => e.id), ["key-3"]);
  assert.equal(selection.incomplete, 0);
  const partial = resolveOpenRouterUsageSelection([...entries, { id: "key-4", label: "Key 4", key: null, error: "missing" }], "", "");
  assert.deepEqual(partial.visible.map((e) => e.id), ["key-1", "key-3"]);
  assert.equal(partial.incomplete, 1);
  // Only selected entries can conflict; the unselected default may differ.
  assert.equal(resolveOpenRouterUsageSelection([{ id: "default", label: "Default", key: "same", error: null }, ...entries], "", "").visible.length, 2);
  assert.throws(() => resolveOpenRouterUsageSelection(entries.map((e) => e.id === "key-2" ? { ...e, label: "Different" } : e), "", ""));
});

test("discovers numbered keys and incomplete pairs, in numeric order, alongside the default", async () => {
  const entries = await resolveOpenRouterKeys({ OPENROUTER_API_KEY: " default-secret ",
    OPENROUTER_KEY_10_LABEL: " Automations ", OPENROUTER_KEY_10: " ten-secret ",
    OPENROUTER_KEY_2_LABEL: "Home Assistant", OPENROUTER_KEY_2: "two-secret",
    OPENROUTER_KEY_3_LABEL: "Missing key", OPENROUTER_KEY_4: "four-secret",
    OPENROUTER_KEY_5_LABEL: " ", OPENROUTER_KEY_5: " ", OPENROUTER_KEY_NO: "ignored" });
  assert.deepEqual(entries.map(({ id, label, error }) => ({ id, label, error })), [
    { id: "default", label: "Default", error: null },
    { id: "key-2", label: "Home Assistant", error: null },
    { id: "key-3", label: "Missing key", error: "OPENROUTER_KEY_3 is missing or empty" },
    { id: "key-4", label: "Key 4", error: "OPENROUTER_KEY_4_LABEL is missing or empty" },
    { id: "key-5", label: "Key 5", error: "OPENROUTER_KEY_5 is missing or empty" },
    { id: "key-10", label: "Automations", error: null },
  ]);
  assert.equal(entries[0].key, "default-secret");
  assert.equal(entries[5].key, "ten-secret");
});

test("preserves the legacy OpenCode fallback and prefers the explicit default key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quota-openrouter-auth-"));
  const path = join(directory, "auth.json");
  try {
    for (const entry of ["fallback", { key: "fallback" }, { token: "fallback" }, { apiKey: "fallback" }]) {
      await writeFile(path, JSON.stringify({ openrouter: entry }));
      assert.equal((await resolveOpenRouterKeys({ OPENCODE_AUTH_PATH: path }))[0].key, "fallback");
    }
    assert.equal((await resolveOpenRouterKeys({ OPENCODE_AUTH_PATH: path, OPENROUTER_API_KEY: "explicit" }))[0].key, "explicit");
    await writeFile(path, "invalid JSON");
    assert.deepEqual(await resolveOpenRouterKeys({ OPENCODE_AUTH_PATH: path }), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("redacts accidental credentials in operator labels", async () => {
  const entries = await resolveOpenRouterKeys({ OPENROUTER_API_KEY: "default-secret",
    OPENROUTER_KEY_1_LABEL: "default-secret sk-or-v1-partial-secret\nHome Assistant", OPENROUTER_KEY_1: "key-secret" });
  assert.equal(entries[1].label, "[redacted] [redacted] Home Assistant");
});

test("parses credit periods and separate BYOK usage without confusing lifetime usage and monthly limits", () => {
  const result = parseOpenRouterUsage(payload)!;
  assert.deepEqual(result.windows.map((window) => [window.name, window.usedValue, window.unit, window.usedPercent]), [
    ["total", 100, "USD", null], ["daily (UTC)", 0, "USD", null], ["weekly (UTC)", 4, "USD", null], ["monthly (UTC)", 8, "USD", null],
  ]);
  assert.deepEqual(result.byokWindows?.map((window) => window.usedValue), [10, 0, 1, 3]);
  assert.deepEqual(result.spendingLimit, { limitUsd: 20, remainingUsd: 9, reset: "monthly", includesByok: true });
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE_HASH|label|hash/);
});

test("preserves missing amounts as unknown and rejects malformed usage rather than reporting zero", () => {
  for (const value of [undefined, null, false, "", "0", -1, Infinity, {}, []]) {
    const result = parseOpenRouterUsage({ data: { usage: 0, usage_daily: value } })!;
    assert.equal(result.windows[0].usedValue, 0);
    assert.equal(result.windows[1].usedValue, null);
    assert.equal(result.windows[1].valueLabel, "Not reported");
    assert.equal(result.spendingLimit, undefined);
    assert.equal(result.byokWindows, undefined);
    assert.equal(parseOpenRouterUsage({ data: { usage: value } }), null);
  }
  for (const value of [null, {}, [], { data: null }, { data: [] }]) assert.equal(parseOpenRouterUsage(value), null);
});

test("reports sub-cent credit and BYOK usage and allowlisted effective budget fields", () => {
  const result = parseOpenRouterUsage({ data: { usage: 0.004, byok_usage: 0.00001, limit: null,
    effective_budget: { scope: "workspace", limit_usd: 50, remaining_usd: -0.2, guardrail_id: "PRIVATE_SECRET" } } })!;
  assert.equal(result.windows[0].valueLabel, "<$0.01 spent");
  assert.equal(result.byokWindows![0].valueLabel, "<$0.01 spent");
  assert.deepEqual(result.effectiveBudget, { scope: "workspace", limitUsd: 50, remainingUsd: -0.2 });
  assert.equal(result.spendingLimit, undefined);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET/);
  assert.equal(parseOpenRouterUsage({ data: { usage: 0, effective_budget: { scope: "SECRET", limit_usd: 2 } } })!.effectiveBudget?.scope, "unknown");
});

test("handles null, zero, exhausted and unknown-period limits without inventing remaining balances", () => {
  for (const limit of [null, undefined, false, "20", -1]) {
    assert.equal(parseOpenRouterUsage({ data: { usage: 5, limit } })!.spendingLimit, undefined);
  }
  for (const limit of [0, 20]) {
    assert.deepEqual(parseOpenRouterUsage({ data: { usage: 100, limit } })!.spendingLimit,
      { limitUsd: limit, remainingUsd: null, reset: "unknown", includesByok: null });
  }
  for (const reset of [null, "daily", "weekly", "monthly"]) {
    assert.equal(parseOpenRouterUsage({ data: { usage: 1, limit: 10, limit_reset: reset } })!.spendingLimit?.reset, reset);
  }
  assert.deepEqual(parseOpenRouterUsage({ data: { usage: 100, limit: 20, limit_remaining: -5, limit_reset: "unexpected-secret" } })!.spendingLimit,
    { limitUsd: 20, remainingUsd: -5, reset: "unknown", includesByok: null });
});

test("isolates key failures, queries only current-key endpoints, and never exposes raw errors or credentials", async () => {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("OPENROUTER_") || name === "OPENCODE_AUTH_PATH"));
  for (const name of Object.keys(saved)) delete process.env[name];
  Object.assign(process.env, { OPENROUTER_API_KEY: "DEFAULT_SECRET", OPENCODE_AUTH_PATH: "/nonexistent/quota-test-auth.json",
    OPENROUTER_KEY_1_LABEL: "Home Assistant", OPENROUTER_KEY_1: "VALID_SECRET",
    OPENROUTER_KEY_2_LABEL: "Unauthorized", OPENROUTER_KEY_2: "INVALID_SECRET",
    OPENROUTER_KEY_3_LABEL: "Network", OPENROUTER_KEY_3: "NETWORK_SECRET",
    OPENROUTER_KEY_4_LABEL: "Incomplete", OPENROUTER_KEY_5: "INCOMPLETE_SECRET" });
  const calls: string[] = [];
  let status = 200;
  let malformed = false;
  mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://openrouter.ai/api/v1/key");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    const auth = new Headers(init?.headers).get("authorization")!;
    calls.push(auth);
    if (auth.includes("INVALID_SECRET")) return new Response("INVALID_SECRET RAW_BODY_SECRET", { status: 401 });
    if (auth.includes("NETWORK_SECRET")) throw new Error("NETWORK_SECRET RAW_EXCEPTION_SECRET");
    return new Response(malformed ? "invalid-json-secret" : JSON.stringify(payload), { status });
  });
  try {
    assert.equal(await isProviderConfigured("openrouter"), true);
    const result = await fetchOpenRouter();
    assert.equal(calls.length, 4);
    assert.equal(result.status, "partial");
    assert.equal(result.openrouterKeys?.length, 6);
    assert.deepEqual(result.openrouterKeys?.map((entry) => entry.status), ["ok", "ok", "error", "error", "error", "error"]);
    assert.equal(result.openrouterKeys?.[1].windows[0].usedValue, 100);
    assert.match(result.openrouterKeys![2].error!, /authentication failed/);
    assert.deepEqual(result.windows, result.openrouterKeys![0].windows);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|RAW_BODY|RAW_EXCEPTION|sk-or|authorization|PRIVATE_HASH/);
    for (status of [429, 500, 503]) {
      const failed = await fetchOpenRouter();
      assert.equal(failed.status, "error");
      assert.match(failed.openrouterKeys![0].error!, new RegExp(`HTTP ${status}`));
      assert.deepEqual(failed.openrouterKeys![0].windows, []);
    }
    status = 200; malformed = true;
    assert.equal((await fetchOpenRouter()).openrouterKeys![0].error, "OpenRouter returned invalid JSON");
    mock.restoreAll();
    mock.method(globalThis, "fetch", async () => Response.json({ data: { label: "RAW_SECRET" } }));
    assert.equal((await fetchOpenRouter()).openrouterKeys![0].error, "OpenRouter response did not include valid usage");
    for (const name of Object.keys(process.env)) if (name.startsWith("OPENROUTER_")) delete process.env[name];
    assert.equal(await isProviderConfigured("openrouter"), false);
    assert.equal((await fetchOpenRouter()).configured, false);
    process.env.OPENROUTER_KEY_1 = "INCOMPLETE_SECRET";
    assert.equal(await isProviderConfigured("openrouter"), false);
    assert.equal((await fetchOpenRouter()).openrouterKeys![0].configured, false);
  } finally {
    mock.restoreAll();
    for (const name of Object.keys(process.env)) if (name.startsWith("OPENROUTER_") || name === "OPENCODE_AUTH_PATH") delete process.env[name];
    Object.assign(process.env, saved);
  }
});
