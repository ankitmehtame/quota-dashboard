import test from "node:test";
import assert from "node:assert/strict";

import { parseCodexQuota, parseOpenCodeGo } from "./providers.js";

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
