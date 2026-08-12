import test from "node:test";
import assert from "node:assert/strict";

import { parseCcusage } from "./usage.js";

test("normalizes ccusage model breakdowns", () => {
  const records = parseCcusage({ daily: [{ date: "2026-08-12", modelBreakdowns: [{ modelName: "gpt-5", inputTokens: 10, cacheReadTokens: 4, outputTokens: 6, cost: 0.25 }] }] });
  assert.deepEqual(records, [{ date: "2026-08-12", provider: "unknown", model: "gpt-5", inputTokens: 10, cachedInputTokens: 4, cacheCreationTokens: 0, outputTokens: 6, reasoningTokens: 0, costUsd: 0.25 }]);
});

test("normalizes Hermes and OpenCode records using the same parser", () => {
  const document = { daily: [{ date: "2026-08-12", provider: "hermes", modelBreakdowns: [{ modelName: "model-a", inputTokens: 3, outputTokens: 2, cost: 0.1 }] }, { date: "2026-08-12", provider: "opencode", modelBreakdowns: [{ modelName: "model-b", inputTokens: 4, outputTokens: 1, cost: 0.2 }] }] };
  const records = parseCcusage(document);
  assert.equal(records[0].provider, "hermes");
  assert.equal(records[1].provider, "opencode");
  assert.equal(records[1].costUsd, 0.2);
});

test("uses ccusage metadata agents when rows are aggregated", () => {
  const records = parseCcusage({ daily: [{ period: "2026-08-12", agent: "all", metadata: { agents: ["hermes", "opencode"] }, modelBreakdowns: [{ modelName: "model-a", cost: 1 }] }] });
  assert.equal(records[0].provider, "shared");
});

test("prefers ccusage per-agent rows over the combined parent row", () => {
  const records = parseCcusage({ daily: [{ period: "2026-08-12", agent: "all", modelBreakdowns: [{ modelName: "combined", cost: 99 }], agents: [{ agent: "hermes", modelBreakdowns: [{ modelName: "h-model", cost: 1 }] }, { agent: "opencode", modelBreakdowns: [{ modelName: "o-model", cost: 2 }] }] }] });
  assert.deepEqual(records.map((record) => [record.provider, record.costUsd]), [["hermes", 1], ["opencode", 2]]);
});
