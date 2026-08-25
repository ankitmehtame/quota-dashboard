import test from "node:test";
import assert from "node:assert/strict";

import { parseCodexQuota, parseCodexResetCredits, parseOllamaUsage, parseOpenCodeGo } from "./providers.js";

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
