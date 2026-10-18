import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const recordTokens = app.slice(app.indexOf("function recordTokens("), app.indexOf("function hostHealthy("));
const hostHealth = app.slice(app.indexOf("function hostHealthy("), app.indexOf("function enabledUsageProviders("));
const summary = app.slice(app.indexOf("function summarizeSelectedRecords("), app.indexOf("function hostUsable("));
const hostFilter = app.slice(app.indexOf("function enabledUsageProviders("), app.indexOf("function emptyUsageDay("));
const pricing = app.slice(app.indexOf("function spend("), app.indexOf("function formatTokens("));
const formatTokens = app.slice(app.indexOf("function formatTokens("), app.indexOf("function relativeTime("));
const details = app.slice(app.indexOf("function modelUsageDetails("), app.indexOf("function renderUsage("));
const topModels = app.slice(app.indexOf("function renderTopModels("), app.indexOf("function renderUsage("));
const todaySpend = app.slice(app.indexOf("function todaySpend("), app.indexOf("function renderSpendMetrics("));

type UsageRecord = {
  date: string; model: string; provider: string; hostId: string; costUsd: number;
  inputTokens: number; cachedInputTokens: number; cacheCreationTokens: number; outputTokens: number; reasoningTokens: number;
  missingPricing?: boolean;
};

const row = (date: string, model: string, provider: string, hostId: string, costUsd: number, tokenBase = 1, missingPricing = false): UsageRecord => ({
  date, model, provider, hostId, costUsd, inputTokens: tokenBase, cachedInputTokens: tokenBase + 1,
  cacheCreationTokens: tokenBase + 2, outputTokens: tokenBase + 3, reasoningTokens: tokenBase + 4, missingPricing,
});
const host = (hostId: string) => ({ hostId, status: "ok", usable: true });

function directContext() {
  const context = { usageSourceName: (provider: string) => provider, sourceIcon: () => "", compactUsageDateRange: (from: string, to: string) => `${from} – ${to}`,
    escapeHtml: (value: string) => value, money: (value: number) => `$${value.toFixed(2)}` };
  const evaluate = (expression: string, values: Record<string, unknown> = {}) => {
    Object.assign(context, values);
    return runInNewContext(`{ ${recordTokens}\n${hostHealth}\n${summary}\n${hostFilter}\n${pricing}\n${formatTokens}\n${details}\n${expression} }`, context);
  };
  return { context, evaluate };
}

test("model details group by model and provider identity and sum all five token categories", () => {
  const { evaluate } = directContext();
  const records = [row("2026-10-07", "model-x", "codex", "a", 2, 1), row("2026-10-08", "model-x", "codex", "a", 3, 10),
    row("2026-10-08", "model-x", "claude", "a", 100, 20), row("2026-10-08", "other", "codex", "a", 100, 30)];
  const result = evaluate(`modelUsageDetails({ records, from: "2026-10-07", to: "2026-10-08" }, { model: "model-x", provider: "codex" }, false)`, { records });
  assert.equal(result.totalCostUsd, 5);
  assert.equal(result.totalTokens, 75);
  assert.deepEqual(Array.from(result.daily, (day: { date: string }) => day.date), ["2026-10-07", "2026-10-08"]);
});

test("today details use usage.to; selected details honor both inclusive range bounds", () => {
  const { evaluate } = directContext();
  const records = [row("2026-10-06", "model-x", "codex", "a", 1), row("2026-10-07", "model-x", "codex", "a", 2),
    row("2026-10-08", "model-x", "codex", "a", 3), row("2026-10-09", "model-x", "codex", "a", 4)];
  const usage = { records, from: "2026-10-07", to: "2026-10-08" };
  const today = evaluate(`modelUsageDetails(usage, { model: "model-x", provider: "codex" }, true)`, { usage });
  assert.equal(today.totalCostUsd, 3);
  assert.deepEqual(Array.from(today.daily, (day: { date: string }) => day.date), ["2026-10-08"]);
  const selected = evaluate(`modelUsageDetails(usage, { model: "model-x", provider: "codex" }, false)`, { usage });
  assert.equal(selected.totalCostUsd, 5);
  assert.deepEqual(Array.from(selected.daily, (day: { date: string }) => day.date), ["2026-10-07", "2026-10-08"]);
});

test("details respect existing host and enabled-provider filtering", () => {
  const { evaluate } = directContext();
  const records = [row("2026-10-08", "model-x", "codex", "a", 1), row("2026-10-08", "model-x", "codex", "b", 2),
    row("2026-10-08", "model-x", "hermes", "a", 4)];
  const result = evaluate(`modelUsageDetails(filterUsageByHosts({ records, providers: ["codex"] }, new Set(["a"])), { model: "model-x", provider: "codex" }, false)`, { records });
  assert.equal(result.totalCostUsd, 1);
  assert.equal(result.daily.length, 1);
});

test("missing pricing reaches daily and total details; unavailable records differ from an empty zero", () => {
  const { evaluate } = directContext();
  const record = row("2026-10-08", "model-x", "codex", "a", 0, 1, true);
  const priced = evaluate(`modelUsageDetails({ records: [record], from: "2026-10-08", to: "2026-10-08" }, { model: "model-x", provider: "codex" }, false)`, { record });
  const absent = evaluate(`modelUsageDetails({ records: undefined, from: "2026-10-08", to: "2026-10-08" }, { model: "model-x", provider: "codex" }, false)`);
  const empty = evaluate(`modelUsageDetails({ records: [], from: "2026-10-08", to: "2026-10-08" }, { model: "model-x", provider: "codex" }, false)`);
  assert.equal(priced.missingPricing, true);
  assert.equal(priced.daily[0].missingPricing, true);
  assert.equal(priced.totalCostUsd, 0);
  assert.equal(absent, null);
  assert.equal(empty.totalCostUsd, 0);
  assert.deepEqual(Array.from(empty.daily), []);
});

function integration(records: UsageRecord[]) {
  type FakeElement = { hidden: boolean; textContent: string; innerHTML: string; open?: boolean; dataset?: Record<string, string>; listeners: Record<string, ((event: any) => void)[]>; focusCount: number; showCount: number; closeCount: number; addEventListener: (type: string, listener: (event: any) => void) => void; focus: () => void; showModal?: () => void; close?: () => void; getBoundingClientRect?: () => { left: number; right: number; top: number; bottom: number } };
  const elements = new Map<string, FakeElement>();
  const makeElement = (selector: string): FakeElement => ({ hidden: false, textContent: "", innerHTML: "", listeners: {}, focusCount: 0, showCount: 0, closeCount: 0,
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }, focus() { this.focusCount++; },
    ...(selector === "#model-details-dialog" ? { open: false, showModal() { this.showCount++; this.open = true; }, close() { this.closeCount++; this.open = false; for (const listener of this.listeners.close || []) listener({ target: this }); }, getBoundingClientRect: () => ({ left: 100, right: 500, top: 100, bottom: 500 }) } : {}) });
  const get = (selector: string) => { if (!elements.has(selector)) elements.set(selector, makeElement(selector)); return elements.get(selector)!; };
  let currentRows: FakeElement[] = [];
  Object.defineProperty(get("#models-list"), "innerHTML", { get() { return this._html || ""; }, set(html: string) {
    this._html = html;
    currentRows = [...html.matchAll(/<button class="model-row"[^>]*data-model="([^"]*)"[^>]*data-provider="([^"]*)"[^>]*data-model-index="(\d+)"/g)].map((match) => {
      const button = makeElement("row"); button.dataset = { model: match[1], provider: match[2], modelIndex: match[3] }; return button;
    });
  } });
  const rangeButtons = ["today", "selected"].map((value) => Object.assign(makeElement("range"), { dataset: { modelsRange: value }, classList: { toggle() {} }, setAttribute() {} }));
  const scopeToggle = makeElement("scope"); scopeToggle.dataset = { modelsRange: "selected" };
  const todayButton = makeElement("today-button");
  const document = { querySelectorAll: (selector: string) => selector === "[data-models-range]" ? rangeButtons : selector === "#models-list .model-row" ? currentRows : [],
    querySelector: (selector: string) => selector === '[data-range="today"]' ? todayButton : selector === '[data-models-range="selected"]' ? scopeToggle : null };
  const state = { range: "relative-7", modelsRange: "selected" };
  const usage: any = { records, hosts: [host("a")], providers: ["codex"], from: "2026-10-07", to: "2026-10-08", totalCostUsd: 0 };
  const context: any = { state, usage, activeModelDetails: null, document, $: get, usageSourceName: (provider: string) => provider.toUpperCase(), sourceIcon: () => "", escapeHtml: (value: string) => value,
    money: (value: number) => `$${value.toFixed(2)}`, compactUsageDateRange: (from: string, to: string) => `${from} – ${to}` };
  const run = (body: string) => runInNewContext(`{ ${recordTokens}\n${hostHealth}\n${summary}\n${hostFilter}\n${pricing}\n${formatTokens}\n${todaySpend}\n${details}\n${topModels}\n${body} }`, context);
  run(`bindModelDetailsDialog(); renderTopModels(usage, usage.hosts, usage.hosts, filterUsageByHosts(usage, new Set(["a"])), new Set(["a"]));`);
  return { context, run, get, document, rows: () => currentRows, scopeToggle, todayButton, dialog: () => get("#model-details-dialog") };
}

test("model row click opens details; refresh updates active details without reopening and tracks changing date and missing model", () => {
  const view = integration([row("2026-10-07", "model-x", "codex", "a", 2), row("2026-10-08", "model-x", "codex", "a", 3)]);
  const firstRow = view.rows()[0];
  firstRow.listeners.click[0]({});
  const dialog = view.dialog();
  assert.equal(dialog.showCount, 1);
  assert.equal(view.get("#model-details-title").textContent, "model-x");
  assert.match(view.get("#model-details-stats").innerHTML, /\$5\.00/);
  const initialDaily = view.get("#model-details-content").innerHTML;
  assert.ok(initialDaily.indexOf("2026-10-08") < initialDaily.indexOf("2026-10-07"));
  const closeHandler = view.get("#close-model-details").listeners.click[0];
  const initialScope = view.get("#model-details-scope").textContent;
  view.context.usage.to = "2026-10-09";
  view.context.usage.records.push(row("2026-10-09", "model-x", "codex", "a", 7));
  view.run(`renderTopModels(usage, usage.hosts, usage.hosts, filterUsageByHosts(usage, new Set(["a"])), new Set(["a"]));`);
  assert.equal(dialog.showCount, 1);
  assert.equal(view.get("#close-model-details").listeners.click[0], closeHandler);
  assert.notEqual(view.get("#model-details-scope").textContent, initialScope);
  assert.match(view.get("#model-details-scope").textContent, /9/);
  assert.match(view.get("#model-details-stats").innerHTML, /\$12\.00/);
  view.context.usage.records = [];
  view.run(`renderTopModels(usage, usage.hosts, usage.hosts, filterUsageByHosts(usage, new Set(["a"])), new Set(["a"]));`);
  assert.equal(dialog.showCount, 1);
  assert.match(view.get("#model-details-content").innerHTML, /No usage in the current scope/);
});

test("dialog close restores focus to replacement model row or the current scope/today fallback", () => {
  const view = integration([row("2026-10-08", "model-x", "codex", "a", 2)]);
  const original = view.rows()[0];
  original.listeners.click[0]({});
  view.run(`renderTopModels(usage, usage.hosts, usage.hosts, filterUsageByHosts(usage, new Set(["a"])), new Set(["a"]));`);
  const replacement = view.rows()[0];
  assert.notEqual(replacement, original);
  view.dialog().close!();
  assert.equal(replacement.focusCount, 1);
  assert.equal(original.focusCount, 0);
  view.run(`openModelDetails({ model: "model-x", provider: "codex" }, usage);`);
  view.context.usage.records = [];
  view.run(`renderTopModels(usage, usage.hosts, usage.hosts, filterUsageByHosts(usage, new Set(["a"])), new Set(["a"]));`);
  view.dialog().close!();
  assert.equal(view.scopeToggle.focusCount, 1);
  view.context.state.range = "today";
  view.run(`openModelDetails({ model: "model-x", provider: "codex" }, usage);`);
  view.dialog().close!();
  assert.equal(view.todayButton.focusCount, 1);
});

test("live Today details follow usage.to rather than retaining the opening date", () => {
  const view = integration([row("2026-10-08", "model-x", "codex", "a", 2)]);
  view.context.state.modelsRange = "today";
  view.rows()[0].listeners.click[0]({});
  view.context.usage.to = "2026-10-09";
  view.context.usage.records.push(row("2026-10-09", "model-x", "codex", "a", 7));
  view.run(`renderTopModels(usage, usage.hosts, usage.hosts, filterUsageByHosts(usage, new Set(["a"])), new Set(["a"]));`);
  assert.equal(view.dialog().showCount, 1);
  assert.match(view.get("#model-details-stats").innerHTML, /\$7\.00/);
  assert.match(view.get("#model-details-content").innerHTML, /2026-10-09/);
  assert.doesNotMatch(view.get("#model-details-content").innerHTML, /2026-10-08/);
});

test("live details distinguish empty unavailable hosts, healthy zero, and absent records", () => {
  const view = integration([row("2026-10-08", "model-x", "codex", "a", 2)]);
  view.rows()[0].listeners.click[0]({});
  view.context.usage.records = [];
  view.context.usage.hosts[0].status = "offline";
  const refresh = () => view.run(`renderTopModels(usage, usage.hosts, usage.hosts, filterUsageByHosts(usage, new Set(["a"])), new Set(["a"]));`);
  refresh();
  assert.match(view.get("#model-details-stats").innerHTML, /Cost unavailable/);
  assert.match(view.get("#model-details-content").innerHTML, /Daily breakdown unavailable/);
  view.context.usage.hosts[0].status = "ok";
  refresh();
  assert.match(view.get("#model-details-stats").innerHTML, /\$0\.00/);
  assert.match(view.get("#model-details-content").innerHTML, /No usage in the current scope/);
  view.context.usage.records = undefined;
  refresh();
  assert.match(view.get("#model-details-stats").innerHTML, /Token count unavailable/);
  assert.match(view.get("#model-details-content").innerHTML, /Daily breakdown unavailable/);
});

test("one healthy host cannot confirm zero while another selected host has incomplete data", () => {
  const view = integration([row("2026-10-08", "model-x", "codex", "a", 2)]);
  view.context.state.modelsRange = "today";
  view.rows()[0].listeners.click[0]({});
  view.context.usage.to = "2026-10-09";
  view.context.usage.hosts = [
    { hostId: "a", status: "offline", usable: true, complete: false },
    { hostId: "b", status: "ok", usable: true, complete: true },
  ];
  const refresh = (ids: string[]) => {
    view.context.selectedIds = new Set(ids);
    view.run(`renderTopModels(usage, usage.hosts, usage.hosts, filterUsageByHosts(usage, selectedIds), selectedIds);`);
  };
  refresh(["a", "b"]);
  assert.equal(view.dialog().showCount, 1);
  assert.match(view.get("#model-details-stats").innerHTML, /Cost unavailable/);
  assert.match(view.get("#model-details-content").innerHTML, /Daily breakdown unavailable/);
  assert.doesNotMatch(view.get("#model-details-content").innerHTML, /No usage in the current scope/);

  // An unhealthy host outside the selection must not prevent a confirmed zero.
  refresh(["b"]);
  assert.match(view.get("#model-details-stats").innerHTML, /\$0\.00/);
  assert.match(view.get("#model-details-content").innerHTML, /No usage in the current scope/);

  // Explicit deselection remains a known zero rather than unavailable data.
  refresh([]);
  assert.match(view.get("#model-details-stats").innerHTML, /\$0\.00/);

  view.context.usage.hosts[0] = { hostId: "a", status: "ok", usable: true, complete: true };
  refresh(["a", "b"]);
  assert.match(view.get("#model-details-stats").innerHTML, /\$0\.00/);
  assert.match(view.get("#model-details-content").innerHTML, /No usage in the current scope/);
});

test("dialog close control, Escape, and actual backdrop gestures use native dialog close", () => {
  const view = integration([row("2026-10-08", "model-x", "codex", "a", 2)]);
  const dialog = view.dialog();
  view.get("#close-model-details").listeners.click[0]({});
  assert.equal(dialog.closeCount, 1);
  // Escape is provided by the native dialog cancel behavior; don't synthesize a competing handler.
  assert.equal((dialog.listeners.cancel || []).length, 0);
  const pointer = (type: string, x: number, y: number) => { for (const listener of dialog.listeners[type] || []) listener({ target: dialog, clientX: x, clientY: y }); };
  pointer("pointerdown", 120, 120); pointer("click", 120, 120);
  pointer("pointerdown", 90, 120); pointer("click", 90, 120);
  assert.equal(dialog.closeCount, 2);
  pointer("pointerdown", 90, 120); pointer("click", 120, 120);
  assert.equal(dialog.closeCount, 2);
  pointer("pointerdown", 120, 120); pointer("click", 90, 120);
  assert.equal(dialog.closeCount, 2);
});
