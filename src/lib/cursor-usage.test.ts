import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateCursorEvents, ccusageConfigPaths, eventCost, loadCcusagePricing, parseCsv, parseUnifiedUsageCsv, UnifiedUsageCsvError, type CursorUsageEvent, type PricingTable } from "./cursor-usage.js";

const HEADER = "Billing Item ID,Event Time,Product,Charge Category,Usage Type,Principal Type,Principal ID,Usage,Pricing Currency,Pricing Contracted,Model,User Email";
const cursorUsage = (prompt: number, cached: number, completion: number, write = 0) =>
  `"{""cache-write-text-tokens"":""${write}"",""cached-prompt-text-tokens"":""${cached}"",""completion-text-tokens"":""${completion}"",""prompt-text-tokens"":""${prompt}""}"`;
const grokUsage = `"{""Cached prompt text tokens"":""125824"",""Completion text tokens"":""1384"",""Prompt text tokens"":""1587""}"`;
const sampleCsv = [
  HEADER,
  `aaaaaaaa-0000-5000-8000-000000000001,2026-11-27T10:49:05.142Z,cursor,usage,included,user,someone,${cursorUsage(2815, 117248, 578)},USD,0.0000000000,grok-4.7-medium,person@example.com`,
  `aaaaaaaa-0000-5000-8000-000000000002,2026-11-27T10:48:56.476Z,cursor,usage,credits,user,someone,${cursorUsage(9768, 107520, 2636, 10)},USD,0.0000000000,gemini-4-neon-medium,person@example.com`,
  `aaaaaaaa-0000-5000-8000-000000000003,2026-11-27T13:05:31.661Z,grok-build,usage,included,user,someone,${grokUsage},USD,0.0000000000,,person@example.com`,
].join("\r\n") + "\r\n";

const event = (overrides: Partial<CursorUsageEvent> = {}): CursorUsageEvent => ({ id: "a", time: "2026-11-27T10:00:00.000Z", model: "m", usageType: "included", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...overrides });

test("parses quoted CSV fields with doubled quotes, embedded newlines, a BOM and CRLF", () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x ""y""","line\nbreak"\r\n\r\n'), [["a", "b"], ['x "y"', "line\nbreak"]]);
  assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
  assert.throws(() => parseCsv('a\n"open'), UnifiedUsageCsvError);
});

test("keeps only Cursor rows, maps the four token counts and drops personal columns", () => {
  const parsed = parseUnifiedUsageCsv(sampleCsv);
  assert.equal(parsed.rows, 3);
  assert.deepEqual(parsed.skipped, { "grok-build": 1 });
  assert.equal(parsed.invalid, 0);
  assert.deepEqual(parsed.events[0], { id: "aaaaaaaa-0000-5000-8000-000000000001", time: "2026-11-27T10:49:05.142Z", model: "grok-4.7-medium", usageType: "included", inputTokens: 2815, outputTokens: 578, cacheReadTokens: 117248, cacheWriteTokens: 0 });
  assert.equal(parsed.events[1].usageType, "credits");
  assert.equal(parsed.events[1].cacheWriteTokens, 10);
  assert.doesNotMatch(JSON.stringify(parsed), /person@example\.com|someone/);
});

test("rejects files that are not unified usage exports and counts unreadable Cursor rows", () => {
  assert.throws(() => parseUnifiedUsageCsv(""), /empty/);
  assert.throws(() => parseUnifiedUsageCsv("Date,Model,Cost\n2026-11-27,x,1\n"), /Missing columns: Billing Item ID/);
  const rows = [
    HEADER,
    `../escape,2026-11-27T10:00:00Z,cursor,usage,included,user,x,${cursorUsage(1, 1, 1)},USD,0,m,x`,
    `ok-1,not-a-date,cursor,usage,included,user,x,${cursorUsage(1, 1, 1)},USD,0,m,x`,
    `ok-2,2026-11-27T10:00:00Z,cursor,usage,included,user,x,not json,USD,0,m,x`,
    `ok-3,2026-11-27T10:00:00Z,cursor,usage,included,user,x,"{""prompt-text-tokens"":""-4""}",USD,0,m,x`,
    `ok-4,2026-11-27T10:00:00Z,cursor,usage,included,user,x,"{""prompt-text-tokens"":""7""}",USD,0,,x`,
    `ok-4,2026-11-27T10:00:00Z,cursor,usage,included,user,x,"{""prompt-text-tokens"":""8""}",USD,0,,x`,
    `ok-5,2026-11-27T10:00:00Z,,usage,included,user,x,{},USD,0,,x`,
  ].join("\n");
  const parsed = parseUnifiedUsageCsv(rows);
  assert.equal(parsed.invalid, 4);
  assert.deepEqual(parsed.skipped, { "(blank)": 1 });
  // A billing ID repeated within one file keeps its last row.
  assert.deepEqual(parsed.events.map((item) => [item.id, item.model, item.inputTokens, item.outputTokens]), [["ok-4", "unknown", 8, 0]]);
});

test("reads ccusage pricingOverrides with commands.daily over defaults and the XDG file first", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-pricing-"));
  try {
    await mkdir(join(root, ".config", "ccusage"), { recursive: true });
    await mkdir(join(root, ".ccusage"));
    await writeFile(join(root, ".config", "ccusage", "config.json"), JSON.stringify({ defaults: { pricingOverrides: { a: { inputCostPerToken: 1 }, b: { inputCostPerToken: 1, outputCostPerToken: "bad" } } }, commands: { daily: { pricingOverrides: { b: { inputCostPerToken: 3 } } } } }));
    await writeFile(join(root, ".ccusage", "ccusage.json"), JSON.stringify({ defaults: { pricingOverrides: { a: { inputCostPerToken: 9 }, c: { outputCostPerToken: 2 } } } }));
    const pricing = await loadCcusagePricing(ccusageConfigPaths({}, root));
    assert.deepEqual(Object.fromEntries(pricing), { a: { inputCostPerToken: 1 }, b: { inputCostPerToken: 3 }, c: { outputCostPerToken: 2 } });
    assert.deepEqual(ccusageConfigPaths({ CCUSAGE_CONFIG_PATH: "/x.json" }, root), ["/x.json"]);
    assert.equal((await loadCcusagePricing([join(root, "missing.json")])).size, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prices each token bucket with ccusage's 200k tiers and flags unknown models", () => {
  const pricing: PricingTable = new Map([["m", { inputCostPerToken: 1e-6, outputCostPerToken: 1e-5, cacheReadInputTokenCost: 1e-7, cacheCreationInputTokenCost: 2e-6, cacheReadInputTokenCostAbove200kTokens: 2e-7 }]]);
  assert.equal(eventCost(event({ model: "other" }), pricing), null);
  const cost = eventCost(event({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 300_000, cacheWriteTokens: 10 }), pricing)!;
  assert.ok(Math.abs(cost - (1000e-6 + 100e-5 + 200_000e-7 + 100_000 * 2e-7 + 10 * 2e-6)) < 1e-12);
  // Without an above-200k price the base rate applies to every token.
  assert.ok(Math.abs(eventCost(event({ inputTokens: 300_000 }), pricing)! - 0.3) < 1e-12);
});

test("groups events by local date, host and model and keeps the date range", () => {
  const pricing: PricingTable = new Map([["priced", { inputCostPerToken: 0.5 }]]);
  const events = [
    { ...event({ id: "1", time: "2026-11-27T15:59:59.000Z", model: "priced", inputTokens: 2, cacheReadTokens: 5 }), hostId: "a" },
    { ...event({ id: "2", time: "2026-11-27T16:00:00.000Z", model: "priced", inputTokens: 2 }), hostId: "a" },
    { ...event({ id: "3", time: "2026-11-27T10:00:00.000Z", model: "priced", inputTokens: 4, cacheWriteTokens: 1, outputTokens: 3 }), hostId: "a" },
    { ...event({ id: "4", time: "2026-11-27T10:00:00.000Z", model: "free-text", inputTokens: 4 }), hostId: "b" },
  ];
  const records = aggregateCursorEvents(events, { from: "2026-11-27", to: "2026-11-27" }, "Asia/Singapore", pricing);
  assert.deepEqual(records, [
    { hostId: "a", date: "2026-11-27", provider: "cursor", model: "priced", inputTokens: 6, cachedInputTokens: 5, cacheCreationTokens: 1, outputTokens: 3, reasoningTokens: 0, costUsd: 3, missingPricing: false },
    { hostId: "b", date: "2026-11-27", provider: "cursor", model: "free-text", inputTokens: 4, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, missingPricing: true },
  ]);
  assert.deepEqual(aggregateCursorEvents(events, { from: "2026-11-28", to: "2026-11-28" }, "Asia/Singapore", pricing).map((record) => record.inputTokens), [2]);
});
