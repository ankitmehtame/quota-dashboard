import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { filterUsageRecords, mergeUsageRecords, parseCcusage, readUsageSources, summarizeUsage } from "./usage.js";
import { claudeUsageDocument } from "./fixtures/claude-usage.js";

test("normalizes ccusage model breakdowns", () => {
  const records = parseCcusage({ daily: [{ date: "2026-08-12", modelBreakdowns: [{ modelName: "gpt-5", inputTokens: 10, cacheReadTokens: 4, outputTokens: 6, cost: 0.25 }] }] });
  assert.deepEqual(records, [{ date: "2026-08-12", provider: "unknown", model: "gpt-5", inputTokens: 10, cachedInputTokens: 4, cacheCreationTokens: 0, outputTokens: 6, reasoningTokens: 0, costUsd: 0.25 }]);
});

test("Claude tool records preserve token categories, model names, and per-agent totals without counting the parent", () => {
  const all = parseCcusage(claudeUsageDocument());
  const claude = filterUsageRecords(["claude"], all);
  assert.equal(all.length, 5);
  assert.equal(claude.length, 4);
  assert.equal(claude[0].date, "2026-05-03");
  assert.deepEqual([claude[0].inputTokens, claude[0].cachedInputTokens, claude[0].cacheCreationTokens, claude[0].outputTokens], [100, 20, 5, 10]);
  assert.equal(claude[1].provider, "claude");
  assert.equal(claude[1].model, "other-vendor/example");
  assert.equal(claude[2].missingPricing, true);
  assert.equal(claude[3].missingPricing, undefined);
  const summary = summarizeUsage(claude);
  assert.equal(summary.totalCostUsd, 1.75);
  assert.equal(summary.totalTokens, 150);
  assert.equal(summary.missingPricing, true);
  assert.equal(summary.byModel.find((model) => model.model === "unpriced-example")?.missingPricing, true);
  assert.equal(summary.daily[0].byModel[0].models.find((model) => model.model === "unpriced-example")?.missingPricing, true);
  assert.equal(summarizeUsage(filterUsageRecords(["opencode"], all)).totalCostUsd, 9);
  assert.deepEqual(filterUsageRecords([], all), []);
  assert.equal(summarizeUsage(all).totalCostUsd, 10.75);
  assert.equal(summarizeUsage(all).totalTokens, 155);
});

test("Claude metadata and legacy mixed-agent rows use existing shared filtering", () => {
  const records = parseCcusage({ daily: [
    { period: "2026-05-03", agent: "all", metadata: { agents: ["claude"] }, totalCost: 2, inputTokens: 3 },
    { period: "2026-05-03", agent: "all", metadata: { agents: ["claude", "opencode"] }, totalCost: 4, inputTokens: 5 },
  ] });
  assert.deepEqual(records.map((record) => record.provider), ["claude", "shared"]);
  assert.equal(filterUsageRecords(["claude"], records).length, 2);
  assert.equal(filterUsageRecords(["codex"], records).length, 0);
});

test("missing pricing survives normalization but known zero costs remain zero", () => {
  for (const cost of [undefined, null, "", " ", false, true, [], {}, -1, "NaN"]) {
    const [record] = parseCcusage({ daily: [{ date: "2026-05-03", agent: "claude", modelBreakdowns: [{ modelName: "unknown", cost }] }] });
    assert.equal(record.costUsd, 0);
    assert.equal(record.missingPricing, true);
  }
  const document = claudeUsageDocument();
  delete document.daily[0].agents[0].modelBreakdowns[2].missingPricing;
  assert.equal(parseCcusage(document)[2].missingPricing, true, "top-level pricing hints are recognized");
  assert.equal(parseCcusage({ daily: [{ period: "2026-05-03", agent: "claude", totalCost: 0 }] })[0].missingPricing, undefined);
});

test("Claude local and remote usage respect source, host, date, and timezone boundaries", () => {
  const range = { from: "2026-05-03", to: "2026-05-03", timeZone: "Asia/Singapore" };
  const remote = { hostId: "remote-fixture", generatedAt: "2026-05-03T12:00:00Z", timezone: range.timeZone,
    range, status: "ok", error: null, stale: false, data: claudeUsageDocument() };
  const local = parseCcusage(claudeUsageDocument());
  const merged = mergeUsageRecords(["claude"], range, local, [remote, { ...remote, hostId: "wrong-timezone", timezone: "UTC" }], "local-fixture");
  assert.equal(merged.records.length, 8);
  assert.equal(summarizeUsage(merged.records).totalCostUsd, 3.5);
  assert.equal(summarizeUsage(merged.records).totalTokens, 300);
  assert.deepEqual([...new Set(merged.records.map((record) => record.hostId))], ["local-fixture", "remote-fixture"]);
  assert.equal(merged.hosts[1].included, false);
  assert.deepEqual(mergeUsageRecords(["claude"], { ...range, from: "2026-05-04", to: "2026-05-04" }, [], [remote]).records, []);
  assert.deepEqual(mergeUsageRecords(["codex"], range, local, [remote]).records, []);
});

test("normalizes Hermes and OpenCode records using the same parser", () => {
  const document = { daily: [{ date: "2026-08-12", provider: "hermes", modelBreakdowns: [{ modelName: "model-a", inputTokens: 3, outputTokens: 2, cost: 0.1 }] }, { date: "2026-08-12", provider: "opencode", modelBreakdowns: [{ modelName: "model-b", inputTokens: 4, outputTokens: 1, cost: 0.2 }] }] };
  const records = parseCcusage(document);
  assert.equal(records[0].provider, "hermes");
  assert.equal(records[1].provider, "opencode");
  assert.equal(records[1].costUsd, 0.2);
});

test("normalizes Antigravity records from ccusage per-agent output", () => {
  const records = parseCcusage({ daily: [{ period: "2026-09-04", agent: "all", agents: [{ agent: "antigravity", modelBreakdowns: [{ modelName: "gemini-3-pro", inputTokens: 8, cacheReadTokens: 3, outputTokens: 5, reasoningTokens: 2, cost: 0.4 }] }] }] });
  assert.deepEqual(records, [{ date: "2026-09-04", provider: "antigravity", model: "gemini-3-pro", inputTokens: 8, cachedInputTokens: 3, cacheCreationTokens: 0, outputTokens: 5, reasoningTokens: 2, costUsd: 0.4 }]);
});

test("uses ccusage metadata agents when rows are aggregated", () => {
  const records = parseCcusage({ daily: [{ period: "2026-08-12", agent: "all", metadata: { agents: ["hermes", "opencode"] }, modelBreakdowns: [{ modelName: "model-a", cost: 1 }] }] });
  assert.equal(records[0].provider, "shared");
});

test("prefers ccusage per-agent rows over the combined parent row", () => {
  const records = parseCcusage({ daily: [{ period: "2026-08-12", agent: "all", modelBreakdowns: [{ modelName: "combined", cost: 99 }], agents: [{ agent: "hermes", modelBreakdowns: [{ modelName: "h-model", cost: 1 }] }, { agent: "opencode", modelBreakdowns: [{ modelName: "o-model", cost: 2 }] }] }] });
  assert.deepEqual(records.map((record) => [record.provider, record.costUsd]), [["hermes", 1], ["opencode", 2]]);
});

test("ignores malformed agent entries", () => {
  const records = parseCcusage({ daily: [{ date: "2026-08-12", agent: "codex", totalCost: 1, agents: [null, "invalid"] }] });
  assert.equal(records.length, 1);
  assert.equal(records[0].provider, "codex");
});

test("combines local and remote ccusage while enforcing range and timezone", () => {
  const local = parseCcusage({ daily: [{ date: "2026-09-13", agent: "codex", modelBreakdowns: [{ modelName: "local-model", inputTokens: 10, cost: 1 }] }] });
  const remoteData = { daily: [
    { date: "2026-09-13", agent: "opencode", modelBreakdowns: [{ modelName: "remote-model", outputTokens: 7, cost: 2 }] },
    { date: "2025-01-01", agent: "opencode", modelBreakdowns: [{ modelName: "old-model", outputTokens: 99, cost: 9 }] },
  ] };
  const merged = mergeUsageRecords(["codex", "opencode"], { from: "2026-09-01", to: "2026-09-13", timeZone: "Asia/Singapore" }, local, [
    { hostId: "macbook", generatedAt: "2026-09-13T00:00:00Z", timezone: "Asia/Singapore", range: { from: "2025-09-09", to: "2026-09-13" }, status: "ok", error: null, stale: false, data: remoteData },
    { hostId: "debian", generatedAt: "2026-09-13T00:00:00Z", timezone: "UTC", range: { from: "2025-09-09", to: "2026-09-13" }, status: "ok", error: null, stale: false, data: remoteData },
  ]);
  assert.deepEqual(merged.records.map((record) => record.hostId), ["local", "macbook"]);
  assert.deepEqual(merged.records.map((record) => record.model), ["local-model", "remote-model"]);
  assert.equal(merged.hosts[0].included, true);
  assert.equal(merged.hosts[0].usable, true);
  assert.equal(merged.hosts[1].included, false);
  assert.equal(merged.hosts[1].usable, false);
  assert.match(merged.hosts[1].error || "", /Timezone UTC/);
  assert.deepEqual(summarizeUsage(merged.records.filter((record) => record.hostId === "macbook")).byModel, [{ provider: "opencode", model: "remote-model", costUsd: 2, totalTokens: 7 }]);
  assert.deepEqual(summarizeUsage(merged.records), {
    daily: [{ date: "2026-09-13", costUsd: 3, totalTokens: 17, byProvider: { codex: { costUsd: 1, totalTokens: 10 }, opencode: { costUsd: 2, totalTokens: 7 } }, byModel: [{ provider: "codex", models: [{ model: "local-model", costUsd: 1, totalTokens: 10 }] }, { provider: "opencode", models: [{ model: "remote-model", costUsd: 2, totalTokens: 7 }] }] }],
    byModel: [{ provider: "opencode", model: "remote-model", costUsd: 2, totalTokens: 7 }, { provider: "codex", model: "local-model", costUsd: 1, totalTokens: 10 }],
    byProvider: [{ provider: "opencode", costUsd: 2, totalTokens: 7 }, { provider: "codex", costUsd: 1, totalTokens: 10 }],
    totalCostUsd: 3,
    totalTokens: 17,
  });
});

test("includes available records but flags a remote snapshot with incomplete range coverage", () => {
  const merged = mergeUsageRecords(["opencode"], { from: "2026-09-01", to: "2026-09-13", timeZone: "UTC" }, [], [{
    hostId: "short-history",
    generatedAt: "2026-09-13T00:00:00Z",
    timezone: "UTC",
    range: { from: "2026-09-10", to: "2026-09-13" },
    status: "ok",
    error: null,
    stale: false,
    data: { daily: [{ date: "2026-09-12", agent: "opencode", totalCost: 1 }] },
  }]);
  assert.equal(merged.records.length, 1);
  assert.equal(merged.hosts[0].included, true);
  assert.equal(merged.hosts[0].complete, false);
  assert.equal(merged.hosts[0].usable, true);
  assert.match(merged.hosts[0].error || "", /does not cover/);
});

test("keeps a healthy host with no selected-provider records available", () => {
  const merged = mergeUsageRecords(["opencode"], { from: "2026-09-01", to: "2026-09-13", timeZone: "UTC" }, [], [{
    hostId: "empty-host",
    generatedAt: "2026-09-13T00:00:00Z",
    timezone: "UTC",
    range: { from: "2026-09-01", to: "2026-09-13" },
    status: "ok",
    error: null,
    stale: false,
    data: { daily: [{ date: "2026-09-12", agent: "codex", totalCost: 1 }] },
  }]);
  assert.equal(merged.records.length, 0);
  assert.equal(merged.hosts[0].usable, true);
  assert.match(merged.hosts[0].disabledReason || "", /No usable/);
});

test("keeps a host with no usage unavailable when its report is unhealthy", () => {
  const merged = mergeUsageRecords(["opencode"], { from: "2026-09-01", to: "2026-09-13", timeZone: "UTC" }, [], [{
    hostId: "offline-host",
    generatedAt: "2026-09-13T00:00:00Z",
    timezone: "UTC",
    range: { from: "2026-09-01", to: "2026-09-13" },
    status: "error",
    error: "Report failed",
    stale: false,
    data: { daily: [] },
  }]);
  assert.equal(merged.hosts[0].usable, false);
  assert.equal(merged.hosts[0].error, "Report failed");
});

test("keeps healthy usage status when the current range has no records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quota-dashboard-usage-"));
  const binary = join(directory, "ccusage");
  const originalBinary = process.env.CCUSAGE_BIN;
  await writeFile(binary, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ daily: [] }));\n", { mode: 0o755 });
  process.env.CCUSAGE_BIN = binary;
  try {
    const result = await readUsageSources(["opencode"], { from: "2026-09-01", to: "2026-09-13", timeZone: "UTC" }, [{
      hostId: "empty-host",
      generatedAt: "2026-09-13T00:00:00Z",
      timezone: "UTC",
      range: { from: "2026-09-01", to: "2026-09-13" },
      status: "ok",
      error: null,
      stale: false,
      data: { daily: [{ date: "2026-09-12", agent: "codex", totalCost: 1 }] },
    }]);
    assert.equal(result.records.length, 0);
    assert.equal(result.hosts[0].usable, true);
    assert.equal(result.status, "ok");
  } finally {
    if (originalBinary === undefined) delete process.env.CCUSAGE_BIN;
    else process.env.CCUSAGE_BIN = originalBinary;
    await rm(directory, { recursive: true, force: true });
  }
});
