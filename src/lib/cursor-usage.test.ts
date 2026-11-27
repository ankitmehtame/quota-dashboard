import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { aggregateCursorEvents, applyCcusagePrices, localDate, parseCsv, parseUnifiedUsageCsv, priceWithCcusage, recordKey, UnifiedUsageCsvError, type CursorUsageEvent } from "./cursor-usage.js";

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

test("rejects event times whose year cannot name a month file", () => {
  const csv = [HEADER,
    `far-1,+010000-01-01T00:00:00.000Z,cursor,usage,included,user,x,${cursorUsage(1, 0, 0)},USD,0,m,x`,
    `neg-1,-000001-01-01T00:00:00.000Z,cursor,usage,included,user,x,${cursorUsage(1, 0, 0)},USD,0,m,x`,
    `ok-1,2026-11-27T10:00:00.000Z,cursor,usage,included,user,x,${cursorUsage(1, 0, 0)},USD,0,m,x`,
  ].join("\n");
  const parsed = parseUnifiedUsageCsv(csv);
  assert.equal(parsed.invalid, 2);
  assert.deepEqual(parsed.events.map((item) => item.id), ["ok-1"]);
});

test("groups tokens by local date, host and model and leaves them unpriced until ccusage prices them", () => {
  const events = [
    { ...event({ id: "1", time: "2026-11-27T15:59:59.000Z", model: "priced", inputTokens: 2, cacheReadTokens: 5 }), hostId: "a" },
    { ...event({ id: "2", time: "2026-11-27T16:00:00.000Z", model: "priced", inputTokens: 2 }), hostId: "a" },
    { ...event({ id: "3", time: "2026-11-27T10:00:00.000Z", model: "priced", inputTokens: 4, cacheWriteTokens: 1, outputTokens: 3 }), hostId: "a" },
    { ...event({ id: "4", time: "2026-11-27T10:00:00.000Z", model: "other", inputTokens: 4 }), hostId: "b" },
  ];
  const records = aggregateCursorEvents(events, { from: "2026-11-27", to: "2026-11-27" }, "Asia/Singapore");
  assert.deepEqual(records, [
    { hostId: "a", date: "2026-11-27", provider: "cursor", model: "priced", inputTokens: 6, cachedInputTokens: 5, cacheCreationTokens: 1, outputTokens: 3, reasoningTokens: 0, costUsd: 0, missingPricing: true },
    { hostId: "b", date: "2026-11-27", provider: "cursor", model: "other", inputTokens: 4, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, missingPricing: true },
  ]);
  assert.deepEqual(aggregateCursorEvents(events, { from: "2026-11-28", to: "2026-11-28" }, "Asia/Singapore").map((record) => record.inputTokens), [2]);
  const prices = new Map([[recordKey("2026-11-27", "a", "priced"), { costUsd: 1.5, missingPricing: false }]]);
  assert.deepEqual(applyCcusagePrices(records, prices).map((record) => [record.model, record.costUsd, record.missingPricing]), [["priced", 1.5, false], ["other", 0, true]]);
  assert.equal(localDate("2026-11-27T16:00:00.000Z", "Asia/Singapore"), "2026-11-28");
  assert.equal(localDate("2026-11-27T16:00:00.000Z", "UTC"), "2026-11-27");
});

test("prices events with ccusage as one Claude request each, one private project per host", async () => {
  const events = [
    { ...event({ id: "bill-1", time: "2026-11-27T04:00:00.000Z", model: "grok-4.7-medium", inputTokens: 10, outputTokens: 2, cacheReadTokens: 300, cacheWriteTokens: 1 }), hostId: "zeta" },
    { ...event({ id: "bill-2", time: "2026-11-27T05:00:00.000Z", model: "new-model", inputTokens: 1 }), hostId: "alpha" },
    { ...event({ id: "bill-3", time: "2026-11-28T05:00:00.000Z", model: "grok-4.7-medium", inputTokens: 1 }), hostId: "zeta" },
  ];
  let seen: { args: string[]; files: Record<string, string>; mode: number } | null = null;
  const prices = await priceWithCcusage(events, {
    binary: "fake-ccusage", timeZone: "Asia/Singapore", timeoutMs: 1000, maxBuffer: 1024 * 1024,
    runner: async (binary, args, options) => {
      assert.equal(binary, "fake-ccusage");
      const root = options.env.CLAUDE_CONFIG_DIR!;
      const projects = (await readdir(join(root, "projects"))).sort();
      const files = Object.fromEntries(await Promise.all(projects.map(async (project) => [project, await readFile(join(root, "projects", project, "cursor.jsonl"), "utf8")])));
      seen = { args, files, mode: (await stat(root)).mode & 0o777 };
      return JSON.stringify({
        projects: {
          "host-0": [{ date: "2026-11-27", modelBreakdowns: [{ modelName: "new-model", cost: 0, missingPricing: true }] }],
          "host-1": [{ date: "2026-11-27", modelBreakdowns: [{ modelName: "grok-4.7-medium", cost: 0.25 }] }, { date: "2026-11-28", modelBreakdowns: [{ modelName: "grok-4.7-medium", cost: 0.5 }] }],
          "unknown-project": [{ date: "2026-11-27", modelBreakdowns: [{ modelName: "x", cost: 9 }] }],
        },
        totals: { unpricedModels: ["new-model"] },
      });
    },
  });
  assert.ok(seen);
  const { args, files, mode } = seen as { args: string[]; files: Record<string, string>; mode: number };
  assert.deepEqual(args, ["claude", "daily", "--json", "--instances", "--breakdown", "--offline", "--mode", "calculate", "--timezone", "Asia/Singapore", "--since", "20261127", "--until", "20261128"]);
  assert.equal(mode, 0o700);
  // Hosts map to opaque project names, so machine names never become paths.
  assert.deepEqual(Object.keys(files), ["host-0", "host-1"]);
  const line = JSON.parse(files["host-1"].split("\n")[0]);
  assert.deepEqual(line.message, { id: "bill-1", model: "grok-4.7-medium", role: "assistant", usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 300, cache_creation_input_tokens: 1 } });
  assert.equal(line.requestId, "bill-1");
  assert.equal(line.timestamp, "2026-11-27T04:00:00.000Z");
  assert.deepEqual(Object.fromEntries(prices), {
    [recordKey("2026-11-27", "alpha", "new-model")]: { costUsd: 0, missingPricing: true },
    [recordKey("2026-11-27", "zeta", "grok-4.7-medium")]: { costUsd: 0.25, missingPricing: false },
    [recordKey("2026-11-28", "zeta", "grok-4.7-medium")]: { costUsd: 0.5, missingPricing: false },
  });
  assert.equal((await priceWithCcusage([], { binary: "unused", timeZone: "UTC", timeoutMs: 1, maxBuffer: 1, runner: async () => { throw new Error("not called"); } })).size, 0);
  await assert.rejects(priceWithCcusage(events, { binary: "x", timeZone: "UTC", timeoutMs: 1, maxBuffer: 1, runner: async () => "{}" }), /per-project/);
});
