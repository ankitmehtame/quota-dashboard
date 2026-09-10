import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";

import { fetchCodex, parseCodexQuota, parseCodexResetCredits, parseOllamaUsage, parseOpenCodeGo } from "./providers.js";

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

test("parses Ollama session and weekly usage with epoch-anchored resets", () => {
  const now = Date.parse("2026-08-19T10:30:00Z");
  const windows = parseOllamaUsage({ limits: { session: { usage: 0.003 }, weekly: { usage: 0.001 } } }, now);
  assert.deepEqual(windows.map((window) => ({ name: window.name, usedPercent: window.usedPercent, resetAt: window.resetAt })), [
    { name: "session", usedPercent: 0.3, resetAt: "2026-08-19T14:00:00.000Z" },
    { name: "weekly", usedPercent: 0.1, resetAt: "2026-08-24T00:00:00.000Z" },
  ]);
});

test("uses the next five-hour Ollama session window", () => {
  const windows = parseOllamaUsage({ limits: { session: { usage: 0.003 } } }, Date.parse("2026-08-19T19:30:00Z"));
  assert.equal(windows[0].resetAt, "2026-08-20T00:00:00.000Z");
  assert.equal(windows[0].windowSeconds, 18_000);
});

test("anchors Ollama session windows to the global epoch", () => {
  const windows = parseOllamaUsage({ limits: { session: { usage: 0.003 } } }, Date.parse("1970-01-02T08:30:00Z"));
  assert.equal(windows[0].resetAt, "1970-01-02T11:00:00.000Z");
  assert.equal(windows[0].windowSeconds, 18_000);
});

test("ignores malformed Ollama usage windows", () => {
  assert.deepEqual(parseOllamaUsage({ limits: { session: { usage: "unknown" } } }), []);
});

test("rounds Ollama percentages for API consumers", () => {
  const windows = parseOllamaUsage({ limits: { session: { usage: 0.00123456 } } });
  assert.equal(windows[0].usedPercent, 0.12);
});

test("parses Ollama percentage usage and provider reset timestamps", () => {
  const windows = parseOllamaUsage({ limits: {
    session: { used_percent: 12.5, reset_at: "2026-08-19T15:00:00Z" },
    weekly: { used: 34, resetAt: 1787616000 },
  } }, Date.parse("2026-08-19T10:30:00Z"));
  assert.deepEqual(windows.map((window) => ({ name: window.name, usedPercent: window.usedPercent, resetAt: window.resetAt })), [
    { name: "session", usedPercent: 12.5, resetAt: "2026-08-19T15:00:00.000Z" },
    { name: "weekly", usedPercent: 34, resetAt: "2026-08-25T00:00:00.000Z" },
  ]);
});

test("falls back for invalid Ollama values and handles percentage edge cases", () => {
  const windows = parseOllamaUsage({ limits: {
    session: { used_percent: null, usage: 0.5, reset: null },
    weekly: { used: 1, reset: false },
  } }, Date.parse("2026-08-19T10:30:00Z"));
  assert.deepEqual(windows.map((window) => ({ name: window.name, usedPercent: window.usedPercent, resetAt: window.resetAt })), [
    { name: "session", usedPercent: 50, resetAt: "2026-08-19T14:00:00.000Z" },
    { name: "weekly", usedPercent: 1, resetAt: "2026-08-24T00:00:00.000Z" },
  ]);
});
