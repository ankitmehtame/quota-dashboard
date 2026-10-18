import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parseCcusage, summarizeUsage } from "./usage.js";
import { sliceCcusageDocument } from "../remote/ccusage.js";

test("missing, invalid, flagged, and hinted prices stay distinct from reported zero", () => {
  const costs = [undefined, null, NaN, Infinity, -1, "invalid", "", false, {}, 0, 1.75];
  const records = parseCcusage({ daily: [{ date: "2026-10-09", modelBreakdowns: costs.map((cost, index) => ({ modelName: String(index), cost })) }] });
  assert.deepEqual(records.map((record) => record.missingPricing), costs.map((_, index) => index < 9));
  assert.deepEqual(records.map((record) => record.costUsd), costs.map((_, index) => index === 10 ? 1.75 : 0));
  assert.equal(summarizeUsage(records.slice(9)).missingPricing, false);
  assert.equal(summarizeUsage([]).missingPricing, false);
  const hinted = parseCcusage({ totals: { unpricedModels: ["hinted"] }, daily: [{ date: "2026-10-09", modelBreakdowns: [
    { modelName: "hinted", cost: 0 }, { modelName: "flagged", cost: 1.75, missingPricing: true }, { modelName: "free", cost: 0 },
  ] }] });
  assert.deepEqual(hinted.map((record) => record.missingPricing), [true, true, false]);
  assert.equal(summarizeUsage(hinted).totalCostUsd, 1.75);
  const fallback = parseCcusage({ daily: [{ date: "2026-10-09", totalCost: 1.75, missingPricing: true }] });
  assert.equal(fallback[0].missingPricing, true);
  assert.equal(fallback[0].costUsd, 1.75);
});

test(":free suffix overrides missing pricing hints and flags, regardless of case or whitespace", () => {
  const costs = [undefined, null, NaN, Infinity, -1, "invalid", "", false, {}, 0, 1.75];
  const modelName = "nvidia/nemotron-3-nano-30b-a3b:FrEe";
  const records = parseCcusage({ totals: { unpricedModels: [modelName] }, daily: [{ date: "2026-10-09", modelBreakdowns: costs.map((cost) => ({
    modelName: `  ${modelName}  `, cost, missingPricing: true,
  })) }] });
  assert.deepEqual(records.map((record) => record.model), costs.map(() => modelName));
  assert.deepEqual(records.map((record) => record.missingPricing), costs.map(() => false));
  assert.deepEqual(records.map((record) => record.costUsd), costs.map((_, index) => index === 10 ? 1.75 : 0));
  assert.equal(summarizeUsage(records).missingPricing, false);
});

test("free models stay distinct from genuinely unpriced models", () => {
  const modelNames = ["model:free", "model", "model:free-preview", "free"];
  const records = parseCcusage({ totals: { unpricedModels: modelNames }, daily: [{ date: "2026-10-09", modelBreakdowns: modelNames.map((modelName) => ({ modelName })) }] });
  assert.deepEqual(records.map((record) => record.missingPricing), [false, true, true, true]);
  const summary = summarizeUsage(records);
  assert.equal(summary.missingPricing, true);
  assert.equal(summary.byModel.find((model) => model.model === "model:free")?.missingPricing, false);
});

const collector = {
  totals: { totalCost: 999, totalTokens: 99999, unpricedModels: ["unknown-price"] },
  daily: [
    { date: "2026-10-08", agent: "codex", modelBreakdowns: [{ modelName: "known", cost: 1.75, inputTokens: 10 }] },
    { date: "2026-10-09", agent: "codex", modelBreakdowns: [{ modelName: "unknown-price", cost: 0, inputTokens: 20 }, { modelName: "free", cost: 0, inputTokens: 1 }] },
  ],
};

test("daily slicing keeps only pricing hints and does not contaminate daily amounts", () => {
  const slice = sliceCcusageDocument(collector, "2026-10-09");
  assert.deepEqual(slice, { daily: [collector.daily[1]], totals: { unpricedModels: ["unknown-price"] } });
  const summary = summarizeUsage(parseCcusage(slice));
  assert.equal(summary.totalCostUsd, 0);
  assert.equal(summary.totalTokens, 21);
  assert.equal(summary.missingPricing, true);
  assert.equal(summary.daily[0].missingPricing, true);
  assert.equal(summary.daily[0].byProvider.codex.missingPricing, true);
  assert.equal(summary.daily[0].byModel[0].models[0].missingPricing, true);
  assert.equal(summary.byProvider[0].missingPricing, true);
  assert.equal(summary.byModel[0].missingPricing, true);
  assert.equal(summary.byModel[1].missingPricing, false);
  assert.equal(summarizeUsage(parseCcusage(sliceCcusageDocument(collector, "2026-10-08"))).missingPricing, false);
  assert.deepEqual(parseCcusage(sliceCcusageDocument(collector, "2026-10-10")), []);
});

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const presentation = app.slice(app.indexOf("const usageSourceNames ="), app.indexOf("const HOT_USAGE_POLL_INTERVAL_MS"));
const formatting = app.slice(app.indexOf("function money("), app.indexOf("function relativeTime("));
const rendering = app.slice(app.indexOf("function recordTokens("), app.indexOf("function renderStatus("));
const dates = app.slice(app.indexOf("function shiftDate("), app.indexOf("function validDateInput("));

test("model formatting retains a reported subtotal without claiming pricing is complete", () => {
  assert.equal(runInNewContext(`${formatting}\nmodelSpend({ costUsd: 1.75, missingPricing: true });`), "$1.75+ · Pricing unavailable");
  assert.equal(runInNewContext(`${formatting}\nmodelSpend({ costUsd: 0, missingPricing: true });`), "Pricing unavailable");
  assert.equal(runInNewContext(`${formatting}\nmodelSpend({ costUsd: 0, missingPricing: false });`), "$0.00");
});

test("aggregation keeps missing pricing when the same model also has priced usage", () => {
  for (const missingFirst of [true, false]) {
    const records = parseCcusage({ daily: [true, false].map((first) => ({ date: first ? "2026-10-08" : "2026-10-09", agent: "codex", modelBreakdowns: [{ modelName: "mixed", cost: 1, missingPricing: first === missingFirst }] })) });
    const summary = summarizeUsage(records);
    assert.equal(summary.totalCostUsd, 2);
    assert.equal(summary.byModel[0].missingPricing, true);
    const bucket = runInNewContext(`${formatting}\n${dates}\n${rendering}\nusageBuckets(summarizeSelectedRecords(records), "week")[0];`, { records });
    assert.equal(bucket.costUsd, 2);
    assert.equal(bucket.missingPricing, true);
    assert.equal(bucket.byProvider.codex.missingPricing, true);
    assert.equal(bucket.byModel[0].models[0].missingPricing, true);
  }
});

for (const representation of ["day", "week", "month"]) {
  test(`${representation} rendering treats hinted free usage as complete pricing`, () => {
    const freeModel = "nvidia/nemotron-3-nano-30b-a3b:free";
    const records = parseCcusage({ totals: { unpricedModels: [freeModel] }, daily: [{ date: "2026-10-09", agent: "codex", modelBreakdowns: [
      { modelName: freeModel, inputTokens: 20, missingPricing: true },
      { modelName: "paid", cost: 1.75, inputTokens: 10 },
    ] }] }).map((record) => ({ ...record, hostId: "local" }));
    const usage = { records, from: "2026-10-09", to: "2026-10-09", providers: ["codex"], hosts: [{ hostId: "local", status: "ok", usable: true }] };
    const elements = new Map<string, { textContent: string; innerHTML: string; hidden: boolean }>();
    const get = (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, { textContent: "", innerHTML: "", hidden: false });
      return elements.get(selector)!;
    };
    const context = {
      usage, state: { range: "relative-7", modelsRange: "selected", representation, days: 1, chartScrollLeft: 0, hostSelections: new Map() },
      document: { querySelector: () => null, querySelectorAll: () => [] },
      $: (selector: string) => Object.assign(get(selector), { querySelectorAll: () => [], setAttribute() {}, classList: { add() {} }, showModal() {} }),
      escapeHtml: String, closeHostStatusPopover() {}, bindChartTooltips() {}, activeChartTooltip: null, activeModelDetails: null,
    };
    runInNewContext(`${presentation}\n${formatting}\n${dates}\n${rendering}\nrenderUsage(usage);`, context);
    assert.equal(get("#usage-total").textContent, "$1.75");
    assert.equal(get("#today-total").textContent, "$1.75");
    assert.equal(get("#pricing-status").hidden, true);
    assert.match(get("#models-list").innerHTML, /nemotron-3-nano-30b-a3b:free.*\$0\.00/);
    assert.doesNotMatch(get("#models-list").innerHTML, /Pricing unavailable/);
    assert.doesNotMatch(get("#usage-chart").innerHTML, /Pricing unavailable|\$[\d.]+\+/);
    runInNewContext(`openUsageDetails(usageBuckets(summarizeSelectedRecords(usage.records), "${representation}")[0], "${representation}");`, context);
    assert.doesNotMatch(get("#day-details-content").innerHTML, /Pricing unavailable|\$[\d.]+\+/);
  });

  test(`${representation} rendering retains pricing warnings in totals, models, charts, and details`, () => {
    const records = parseCcusage(collector).map((record) => ({ ...record, hostId: record.missingPricing ? "unpriced" : "priced" }));
    const usage = { records, from: "2026-10-08", to: "2026-10-09", providers: ["codex"], hosts: ["priced", "unpriced"].map((hostId) => ({ hostId, status: "ok", usable: true })) };
    const elements = new Map<string, { textContent: string; innerHTML: string; hidden: boolean }>();
    const get = (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, { textContent: "", innerHTML: "", hidden: false });
      return elements.get(selector)!;
    };
    const state = { range: "relative-7", modelsRange: "selected", representation, days: 2, chartScrollLeft: 0, hostSelections: new Map() };
    const context = {
      usage, state, document: { querySelector: () => null, querySelectorAll: () => [] },
      $: (selector: string) => Object.assign(get(selector), { querySelectorAll: () => [], setAttribute() {}, classList: { add() {} }, showModal() {} }),
      escapeHtml: String, closeHostStatusPopover() {}, bindChartTooltips() {}, activeChartTooltip: null, activeModelDetails: null,
    };
    runInNewContext(`${presentation}\n${formatting}\n${dates}\n${rendering}\nrenderUsage(usage);`, context);
    assert.equal(get("#usage-total").textContent, "$1.75+");
    assert.equal(get("#today-total").textContent, "$0.00+");
    assert.equal(get("#pricing-status").hidden, false);
    assert.match(get("#pricing-status").textContent, /reported costs only/);
    assert.match(get("#models-list").innerHTML, /unknown-price.*Pricing unavailable/);
    assert.match(get("#models-list").innerHTML, /free.*\$0\.00/);
    assert.match(get("#usage-chart").innerHTML, /aria-label="[^"]*\+, Pricing unavailable/);
    assert.match(get("#usage-chart").innerHTML, representation === "day" ? /\$0\.00\+.*Pricing unavailable/ : /\$1\.75\+.*Pricing unavailable/);
    runInNewContext(`openUsageDetails(usageBuckets(filterUsageByHosts(usage, new Set(["priced", "unpriced"])), "${representation}").at(-1), "${representation}");`, context);
    assert.match(get("#day-details-summary").innerHTML, representation === "day" ? /\$0\.00\+/ : /\$1\.75\+/);
    assert.match(get("#day-details-content").innerHTML, /unknown-price.*Pricing unavailable/);
    if (representation !== "day") assert.match(get("#day-details-content").innerHTML, /2026-10-09.*\$0\.00\+/);
    state.hostSelections.set("unpriced", false);
    runInNewContext("renderUsage(usage);", context);
    assert.equal(get("#pricing-status").hidden, true);
    assert.equal(get("#usage-total").textContent, "$1.75");
    assert.equal(get("#today-total").textContent, "$0.00");
    assert.doesNotMatch(get("#models-list").innerHTML, /Pricing unavailable/);
    state.hostSelections.set("priced", false);
    runInNewContext("renderUsage(usage);", context);
    assert.equal(get("#usage-total").textContent, "$0.00");
    assert.equal(get("#pricing-status").hidden, true);
  });
}
