import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const helpers = app.slice(app.indexOf("function recordTokens("), app.indexOf("function emptyUsageDay("));
const todaySpend = app.slice(app.indexOf("function todaySpend("), app.indexOf("function renderSpendMetrics("));
const renderer = app.slice(app.indexOf("function renderTopModels("), app.indexOf("function renderUsage("));
const record = (date: string, model: string, costUsd: number, hostId = "one", provider = "codex") => ({ date, model, costUsd, hostId, provider, inputTokens: 10, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 });
type Host = { hostId: string; status: string; usable: boolean; complete?: boolean };

function dashboard(records = [record("2026-10-08", "Yesterday", 20), record("2026-10-09", "Today A", 2), record("2026-10-09", "Today B", 5)], hosts: Host[] = [{ hostId: "one", status: "ok", usable: true }], selected = ["one"], providers = ["codex"]) {
  const state = { range: "relative-7", modelsRange: "today", hostSelections: new Map(hosts.map((host) => [host.hostId, selected.includes(host.hostId)])) };
  const elements = new Map<string, { hidden: boolean; textContent: string; innerHTML: string }>();
  const buttons = ["today", "selected"].map((value) => ({ dataset: { modelsRange: value }, active: false, pressed: "", onclick: () => {}, classList: { toggle(_name: string, active: boolean) { buttons.find((button) => button.dataset.modelsRange === value)!.active = active; } }, setAttribute(_name: string, value: string) { this.pressed = value; } }));
  const context = {
    state, usage: { records, hosts, providers, to: "2026-10-09" },
    document: { querySelectorAll: () => buttons },
    $: (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, { hidden: false, textContent: "", innerHTML: "" });
      return elements.get(selector);
    },
    usageSourceNames: { codex: "Codex" }, escapeHtml: (value: string) => value.replace(/</g, "&lt;"), money: (value: number) => `$${value.toFixed(2)}`,
  };
  const render = () => runInNewContext(`${helpers}\n${todaySpend}\n${renderer}\n{ const { hosts, usableHosts, selectedHostIds } = reconcileHostSelections(usage); renderTopModels(usage, hosts, usableHosts, filterUsageByHosts(usage, selectedHostIds), selectedHostIds); }`, context);
  render();
  return { state, buttons, render, list: () => elements.get("#models-list")!.innerHTML, picker: () => elements.get("#models-range-picker")!, status: () => elements.get("#models-status")! };
}

test("top models default to today, sorted by spend, and switch without changing the page range", () => {
  const view = dashboard();
  assert.doesNotMatch(view.list(), /Yesterday/);
  assert.ok(view.list().indexOf("Today B") < view.list().indexOf("Today A"));
  assert.match(view.list(), /Codex/);
  assert.equal(view.buttons[0].pressed, "true");
  view.buttons[1].onclick();
  assert.match(view.list(), /Yesterday/);
  assert.equal(view.state.range, "relative-7");
  assert.equal(view.buttons[1].pressed, "true");
});

test("hidden tabs retain their choice across range changes and refreshes, but a new page defaults to today", () => {
  const view = dashboard();
  view.buttons[1].onclick();
  view.state.range = "today";
  view.render();
  assert.equal(view.picker().hidden, true);
  assert.doesNotMatch(view.list(), /Yesterday/);
  assert.equal(view.state.modelsRange, "selected");
  view.state.range = "calendar-month";
  view.render();
  view.render();
  assert.equal(view.picker().hidden, false);
  assert.match(view.list(), /Yesterday/);
  assert.equal(view.buttons[1].active, true);
  assert.equal(dashboard().state.modelsRange, "today");
  assert.match(app, /modelsRange: "today"/);
  assert.doesNotMatch(app, /(?:localStorage|sessionStorage)\.[^\n]*modelsRange/);
});

test("today models respect host and enabled-source filters and include zero-cost models", () => {
  const view = dashboard([
    record("2026-10-09", "Included", 0), record("2026-10-09", "Other host", 100, "two"),
    record("2026-10-09", "Disabled source", 100, "one", "hermes"), record("2026-10-08", "Older", 100),
  ], [{ hostId: "one", status: "ok", usable: true }, { hostId: "two", status: "ok", usable: true }]);
  assert.match(view.list(), /Included/);
  assert.match(view.list(), /\$0\.00/);
  assert.doesNotMatch(view.list(), /Other host|Disabled source|Older/);
});

test("today models distinguish healthy zero, unavailable data, and explicit deselection", () => {
  assert.match(dashboard([]).list(), /No model usage today/);
  assert.match(dashboard([], []).list(), /Today's usage is unavailable/);
  assert.match(dashboard([], [{ hostId: "one", status: "offline", usable: true }]).list(), /Today's usage is unavailable/);
  assert.match(dashboard([], [{ hostId: "one", status: "ok", usable: true }], []).list(), /No hosts selected/);
});

test("incomplete today data displays a warning alongside available rows, only on today's view", () => {
  const view = dashboard([record("2026-10-09", "Available", 3)], [{ hostId: "one", status: "offline", usable: true, complete: false }]);
  assert.match(view.list(), /Available/);
  assert.equal(view.status().hidden, false);
  assert.match(view.status().textContent, /incomplete/);
  view.buttons[1].onclick();
  assert.equal(view.status().hidden, true);
  view.buttons[0].onclick();
  assert.equal(view.status().hidden, false);
});
