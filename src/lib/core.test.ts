import test from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig, normalizeProviderOrder } from "./core.js";
import { isUsageSourceId } from "./usage-source-id.js";

test("normalizes provider order and appends missing providers", () => {
  assert.deepEqual(normalizeProviderOrder(["ollama", "ollama", "unknown", "codex"]), ["ollama", "codex", "openrouter", "opencode-go", "claude"]);
});

test("uses the default provider order when no order is stored", () => {
  assert.deepEqual(normalizeConfig({}).providerOrder, ["codex", "openrouter", "opencode-go", "ollama", "claude"]);
});

test("Claude quota is opt-in and migration preserves existing settings and order", () => {
  const config = normalizeConfig({ providers: { codex: { enabled: false }, ollama: { enabled: false } },
    providerOrder: ["ollama", "opencode-go", "openrouter", "codex"], usageSources: { codex: { enabled: false } } });
  assert.equal(config.providers.claude.enabled, false);
  assert.equal(config.providers.codex.enabled, false);
  assert.equal(config.providers.ollama.enabled, false);
  assert.deepEqual(config.providerOrder, ["ollama", "opencode-go", "openrouter", "codex", "claude"]);
  assert.equal(config.usageSources.codex.enabled, false);
  assert.equal(normalizeConfig({ providers: { claude: { enabled: true } } }).providers.claude.enabled, true);
});

test("enables new usage sources when normalizing an existing config", () => {
  const config = normalizeConfig({ usageSources: { codex: { enabled: false }, opencode: { enabled: false }, hermes: { enabled: false } } });
  assert.deepEqual(config.usageSources, {
    codex: { enabled: false },
    opencode: { enabled: false },
    hermes: { enabled: false },
    antigravity: { enabled: true },
  });
});

test("preserves dynamic source preferences while rejecting unsafe keys and malformed settings", () => {
  const config = normalizeConfig(JSON.parse('{"usageSources":{"new-tool":{"enabled":false},"claude":{"enabled":true},"raw":{"enabled":true},"../tool":{"enabled":true},"__proto__":{"enabled":true},"constructor":{"enabled":true},"shared":{"enabled":true},"bad":{"enabled":"false"}}}'));
  assert.deepEqual(config.usageSources["new-tool"], { enabled: false });
  assert.deepEqual(config.usageSources.claude, { enabled: true });
  for (const id of ["raw", "../tool", "__proto__", "constructor", "shared", "bad"]) assert.equal(Object.hasOwn(config.usageSources, id), false);
  assert.deepEqual(normalizeConfig(JSON.parse(JSON.stringify(config))), config);
  for (const id of ["new-tool", "tool_v2", "tool.v3", "tool~4"]) assert.equal(isUsageSourceId(id), true);
  for (const id of ["NEW", " new ", "raw.archive", "a/b", "a\\b", "a..b", "", "a".repeat(129)]) assert.equal(isUsageSourceId(id), false);
});
