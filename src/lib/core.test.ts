import test from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig, normalizeProviderOrder } from "./core.js";

test("normalizes provider order and appends missing providers", () => {
  assert.deepEqual(normalizeProviderOrder(["ollama", "ollama", "unknown", "codex"]), ["ollama", "codex", "openrouter", "opencode-go"]);
});

test("uses the default provider order when no order is stored", () => {
  assert.deepEqual(normalizeConfig({}).providerOrder, ["codex", "openrouter", "opencode-go", "ollama"]);
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
