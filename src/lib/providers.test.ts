import test from "node:test";
import assert from "node:assert/strict";

import { parseCodexQuota, parseOllamaUsage, parseOpenCodeGo } from "./providers.js";

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
  assert.equal(windows[0].usedPercent, 97);
  assert.equal(windows[0].windowSeconds, 604800);
});

test("parses Ollama session and weekly usage with daily session resets", () => {
  const now = Date.parse("2026-08-19T10:30:00Z");
  const windows = parseOllamaUsage({ limits: { session: { usage: 0.003 }, weekly: { usage: 0.001 } } }, now);
  assert.deepEqual(windows.map((window) => ({ name: window.name, usedPercent: window.usedPercent, resetAt: window.resetAt })), [
    { name: "session", usedPercent: 0.3, resetAt: "2026-08-19T14:00:00.000Z" },
    { name: "weekly", usedPercent: 0.1, resetAt: "2026-08-24T00:00:00.000Z" },
  ]);
});

test("uses the next day for the final Ollama session", () => {
  const windows = parseOllamaUsage({ limits: { session: { usage: 0.003 } } }, Date.parse("2026-08-19T19:30:00Z"));
  assert.equal(windows[0].resetAt, "2026-08-20T00:00:00.000Z");
  assert.equal(windows[0].windowSeconds, 18_000);
});

test("ignores malformed Ollama usage windows", () => {
  assert.deepEqual(parseOllamaUsage({ limits: { session: { usage: "unknown" } } }), []);
});

test("rounds Ollama percentages for API consumers", () => {
  const windows = parseOllamaUsage({ limits: { session: { usage: 0.00123456 } } });
  assert.equal(windows[0].usedPercent, 0.12);
});
