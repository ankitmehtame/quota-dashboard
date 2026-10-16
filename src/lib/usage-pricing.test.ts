import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { claudeUsageDocument } from "./fixtures/claude-usage.js";
import { filterUsageRecords, parseCcusage, summarizeUsage } from "./usage.js";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const helpers = app.slice(app.indexOf("function recordTokens("), app.indexOf("function renderUsage("));
const details = app.slice(app.indexOf("function openUsageDetails("), app.indexOf("function renderStatus("));
const costFormatter = app.slice(app.indexOf("function formatUsageCost("), app.indexOf("function hostHealthy("));
const records = filterUsageRecords(["claude"], parseCcusage(claudeUsageDocument())).map((record) => ({ ...record, hostId: "fixture" }));

function renderMetrics(selectedRecords = records) {
  const elements = new Map<string, { textContent: string; hidden: boolean }>();
  const state = { range: "relative-7" };
  const context = {
    state,
    usage: { from: "2026-05-01", to: "2026-05-03", records: selectedRecords, providers: ["claude"] },
    hosts: [{ hostId: "fixture", status: "ok", included: true, complete: true }],
    selectedUsage: { ...summarizeUsage(selectedRecords), records: selectedRecords },
    $: (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, { textContent: "", hidden: false });
      return elements.get(selector);
    },
    money: (value: number) => Number.isFinite(value) ? `$${value.toFixed(2)}` : "—",
    compactUsageDateRange: () => "May 1 to May 3", usagePresetLabel: () => "7 days",
  };
  runInNewContext(`${helpers}\nrenderSpendMetrics(usage, hosts, hosts, selectedUsage, new Set(["fixture"]));`, context);
  return elements;
}

test("unpriced Claude usage makes spend totals partial, not a fabricated zero", () => {
  const mixed = renderMetrics();
  assert.equal(mixed.get("#usage-total")?.textContent, "$1.75+");
  assert.equal(mixed.get("#today-total")?.textContent, "$1.75+");
  assert.equal(mixed.get("#usage-pricing-status")?.hidden, false);
  assert.match(mixed.get("#usage-pricing-status")!.textContent, /unpriced usage is not free/);
  const unpriced = renderMetrics(records.filter((record) => record.missingPricing));
  assert.equal(unpriced.get("#usage-total")?.textContent, "—");
  assert.equal(unpriced.get("#today-total")?.textContent, "—");
  const zero = renderMetrics(records.filter((record) => record.model === "priced-zero-example"));
  assert.equal(zero.get("#usage-total")?.textContent, "$0.00");
  assert.equal(zero.get("#usage-pricing-status")?.hidden, true);
});

test("pricing warnings follow selected records, not unselected hosts or disabled sources", () => {
  const selected = records.filter((record) => !record.missingPricing);
  const view = renderMetrics(selected);
  assert.equal(view.get("#usage-total")?.textContent, "$1.75");
  assert.equal(view.get("#usage-pricing-status")?.hidden, true);
});

test("day, week, and month details retain Claude pricing flags and token counts", () => {
  const summary = summarizeUsage(records);
  for (const representation of ["day", "week", "month"]) {
    const elements = new Map<string, { innerHTML: string; textContent: string; classList: { add: () => void }; showModal: () => void }>();
    runInNewContext(`${costFormatter}\n${details}\nopenUsageDetails(bucket, representation);`, {
      representation,
      bucket: { ...summary.daily[0], from: "2026-05-03", to: "2026-05-03", days: summary.daily },
      $: (selector: string) => {
        if (!elements.has(selector)) elements.set(selector, { innerHTML: "", textContent: "", classList: { add() {} }, showModal() {} });
        return elements.get(selector);
      },
      usageBucketLabel: () => "May 3", usageSourceNames: { claude: "Claude" }, escapeHtml: String,
      money: (value: number) => `$${value.toFixed(2)}`, formatTokens: String,
    });
    assert.match(elements.get("#day-details-summary")!.innerHTML, /\$1\.75\+ · pricing incomplete/);
    assert.match(elements.get("#day-details-summary")!.innerHTML, /150/);
    const html = elements.get("#day-details-content")!.innerHTML;
    assert.match(html, /<h3>Claude<\/h3>/);
    assert.match(html, /unpriced-example<\/span><span>Pricing unavailable · 5 tokens/);
    assert.match(html, /priced-zero-example<\/span><span>\$0\.00 · 0 tokens/);
    if (representation !== "day") assert.match(html, /By day/);
  }
});
