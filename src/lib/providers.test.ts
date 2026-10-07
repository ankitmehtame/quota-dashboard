import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";

import { fetchCodex, fetchOllama, parseCodexQuota, parseCodexResetCredits, parseOllamaBalance, parseOllamaCreditBalance, parseOpenCodeGo } from "./providers.js";

test("parses OpenCode Go rolling usage and reset time", () => {
  const now = Date.parse("2026-08-12T00:00:00Z");
  const windows = parseOpenCodeGo('{"rollingUsage":{"usagePercent":42,"resetInSec":3600}}', now);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].usedPercent, 42);
  assert.equal(windows[0].resetAt, "2026-08-12T01:00:00.000Z");
});

test("ignores malformed OpenCode Go windows", () => {
  assert.deepEqual(parseOpenCodeGo('{"rollingUsage":{"usagePercent":"unknown"}}'), []);
});

test("parses Codex ChatGPT weekly quota", () => {
  const windows = parseCodexQuota({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 97, limit_window_seconds: 604800, reset_at: 1787012669 } } });
  assert.equal(windows[0].name, "weekly");
  assert.equal(windows[0].usedPercent, 97);
  assert.equal(windows[0].windowSeconds, 604800);
});

test("parses Codex ChatGPT five-hour and weekly quota windows", () => {
  const windows = parseCodexQuota({ rate_limit: {
    primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1787012669 },
    secondary_window: { used_percent: 34, limit_window_seconds: 604_800, reset_at: 1787617469 },
  } });
  assert.deepEqual(windows.map((window) => ({ name: window.name, usedPercent: window.usedPercent, windowSeconds: window.windowSeconds })), [
    { name: "5-hour", usedPercent: 12, windowSeconds: 18_000 },
    { name: "weekly", usedPercent: 34, windowSeconds: 604_800 },
  ]);
});

test("parses available Codex rate-limit reset credits", () => {
  const credits = parseCodexResetCredits({ credits: [
    { id: "available", status: "available", title: "Full reset", description: "One reset", expires_at: "2026-09-21T05:34:22.867265Z" },
    { id: "redeemed", status: "redeemed", title: "Full reset", expires_at: null },
  ] });
  assert.deepEqual(credits, [{ id: "available", title: "Full reset", description: "One reset", expiresAt: "2026-09-21T05:34:22.867265Z" }]);
});

test("ignores malformed Codex reset credits payloads", () => {
  assert.deepEqual(parseCodexResetCredits(null), []);
  assert.deepEqual(parseCodexResetCredits({}), []);
  assert.deepEqual(parseCodexResetCredits({ credits: null }), []);
  assert.deepEqual(parseCodexResetCredits({ credits: [{ id: 123, status: "available" }, "invalid"] }), []);
});

test("refreshes Codex credentials after an unauthorized quota response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quota-dashboard-codex-"));
  const authPath = join(directory, "auth.json");
  const originalAuthPath = process.env.CODEX_AUTH_PATH;
  await writeFile(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: {
    access_token: "expired-access",
    refresh_token: "old-refresh",
    id_token: "old-id",
    account_id: "account-id",
  } }));
  process.env.CODEX_AUTH_PATH = authPath;
  const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    requests.push({ url: String(input), headers, body: typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "" });
    if (String(input) === "https://chatgpt.com/backend-api/wham/usage" && requests.filter((request) => request.url === String(input)).length === 1) {
      return new Response(null, { status: 401 });
    }
    if (String(input) === "https://auth.openai.com/oauth/token") {
      return new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "rotated-refresh", id_token: "fresh-id" }), { status: 200 });
    }
    if (String(input) === "https://chatgpt.com/backend-api/wham/usage") {
      return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1787012669 } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ credits: [] }), { status: 200 });
  });
  try {
    const result = await fetchCodex();
    assert.equal(result.error, null);
    assert.equal(result.windows[0].usedPercent, 12);
    assert.equal(requests[0].headers.authorization, "Bearer expired-access");
    assert.equal(requests[1].headers["content-type"], "application/x-www-form-urlencoded");
    assert.match(requests[1].body, /grant_type=refresh_token/);
    assert.match(requests[1].body, /client_id=app_EMoamEEZ73f0CkXaXp7hrann/);
    assert.equal(requests[2].headers.authorization, "Bearer fresh-access");
    assert.equal(requests[2].headers.originator, "codex_cli_rs");
    const savedAuth = JSON.parse(await readFile(authPath, "utf8"));
    assert.equal(savedAuth.tokens.access_token, "fresh-access");
    assert.equal(savedAuth.tokens.refresh_token, "rotated-refresh");
    assert.equal(savedAuth.tokens.id_token, "fresh-id");
  } finally {
    mock.restoreAll();
    if (originalAuthPath === undefined) delete process.env.CODEX_AUTH_PATH;
    else process.env.CODEX_AUTH_PATH = originalAuthPath;
    await rm(directory, { recursive: true, force: true });
  }
});

const ollamaBalance = {
  included: { balance_usd: 2.06662, allowance_usd: 2.5, period: { from: "2026-09-19T00:50:25.281112Z", until: "2026-10-19T00:50:25.281112Z" } },
  purchased: { balance_usd: 0 },
};

test("calculates Ollama monthly quota from included credit balance", () => {
  const [window] = parseOllamaBalance(ollamaBalance);
  assert.equal(window.name, "monthly");
  assert.equal(window.usedPercent, 17.34);
  assert.ok(Math.abs(window.usedValue! - 0.43338) < 1e-10);
  assert.equal(window.limitValue, 2.5);
  assert.equal(window.valueLabel, "$2.07 remaining · $0.43 used");
  assert.equal(window.windowStart, "2026-09-19T00:50:25.281Z");
  assert.equal(window.resetAt, "2026-10-19T00:50:25.281Z");
  assert.equal(window.windowSeconds, 30 * 86400);
});

test("keeps purchased credits separate from monthly quota", () => {
  const windows = parseOllamaBalance({ ...ollamaBalance, purchased: { balance_usd: 25 } });
  assert.equal(windows[0].usedPercent, 17.34);
  assert.equal(windows.length, 1);
  assert.deepEqual(parseOllamaCreditBalance({ ...ollamaBalance, purchased: { balance_usd: 25 } }), { includedUsd: 2.06662, purchasedUsd: 25 });
  assert.deepEqual(parseOllamaCreditBalance(ollamaBalance), { includedUsd: 2.06662, purchasedUsd: 0 });
  assert.deepEqual(parseOllamaCreditBalance({ included: ollamaBalance.included }), { includedUsd: 2.06662, purchasedUsd: null });
  assert.equal(parseOllamaCreditBalance({}), undefined);
});

test("handles empty and exhausted Ollama allowances without dividing by zero", () => {
  for (const [balance, allowance, expected] of [[0, 0, null], [0, 2.5, 100], [2.5, 2.5, 0], [-1, 2.5, 100], [3, 2.5, 0]] as const) {
    const [window] = parseOllamaBalance({ included: { balance_usd: balance, allowance_usd: allowance } });
    assert.equal(window.usedPercent, expected);
  }
});

test("does not infer Ollama reset dates for malformed billing periods", () => {
  for (const period of [{}, { from: "invalid", until: "2026-10-19" }, { from: "2026-10-19", until: "2026-09-19" }]) {
    const [window] = parseOllamaBalance({ included: { ...ollamaBalance.included, period } });
    assert.equal(window.usedPercent, 17.34);
    assert.equal(window.resetAt, null);
    assert.equal(window.windowSeconds, null);
  }
});

test("rejects malformed balances and old Ollama usage responses", () => {
  for (const payload of [null, {}, { included: {} }, { included: { balance_usd: null, allowance_usd: 2.5 } },
    { included: { balance_usd: false, allowance_usd: 2.5 } }, { included: { balance_usd: 1, allowance_usd: -1 } },
    { limits: { monthly: { usage: 0.5 } } }, { totals: { usage_usd: 0.1841 } }]) {
    assert.deepEqual(parseOllamaBalance(payload), []);
  }
});

test("fetches only Ollama balance and never falls back to usage", async () => {
  const originalKey = process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_API_KEY = "test-key";
  const urls: string[] = [];
  let status = 200;
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
    return new Response(JSON.stringify(ollamaBalance), { status });
  });
  try {
    const fetched = await fetchOllama();
    assert.equal(fetched.windows[0].usedPercent, 17.34);
    assert.deepEqual(fetched.creditBalance, { includedUsd: 2.06662, purchasedUsd: 0 });
    status = 503;
    const failed = await fetchOllama();
    assert.equal(failed.status, "error");
    assert.equal(failed.error, "Ollama returned HTTP 503");
    assert.deepEqual(urls, ["https://ollama.com/api/balance", "https://ollama.com/api/balance"]);
  } finally {
    mock.restoreAll();
    if (originalKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalKey;
  }
});
