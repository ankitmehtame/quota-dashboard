import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const helpers = app.slice(app.indexOf("function recordTokens("), app.indexOf("function emptyUsageDay("));
const today = app.slice(app.indexOf("function todaySpend("), app.indexOf("function renderSpendMetrics("));
const record = (provider: string, hostId: string, costUsd: number) => ({ provider, hostId, costUsd, model: provider, date: "2026-10-19", inputTokens: 10, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 });

test("source filters default on and combine with machine filters across all aggregates", () => {
  const state = { sourceSelections: new Map<string, boolean>() };
  const usage = { providers: ["codex", "opencode"], to: "2026-10-19", records: [record("codex", "one", 2), record("opencode", "one", 3), record("codex", "two", 10)] };
  const render = () => runInNewContext(`${helpers}\n${today}\nconst filtered = filterUsageBySources(usage, new Set(usage.providers)); const selected = filterUsageByHosts(filtered, new Set(['one'])); const hosts = [{hostId: 'one', status: 'ok'}]; ({selected, today: todaySpend(filtered, hosts, hosts, new Set(['one']))});`, { state, usage });
  assert.equal(render().selected.totalCostUsd, 5);
  state.sourceSelections.set("codex", false);
  for (let refresh = 0; refresh < 2; refresh++) {
    const { selected, today } = render();
    assert.equal(selected.totalCostUsd, 3);
    assert.equal(selected.daily[0].costUsd, 3);
    assert.equal(selected.byModel[0].provider, "opencode");
    assert.equal(selected.byProvider.length, 1);
    assert.equal(selected.totalTokens, 10);
    assert.equal(today.amount, 3);
  }
  state.sourceSelections.set("opencode", false);
  const empty = render();
  assert.equal(empty.selected.totalCostUsd, 0);
  assert.equal(empty.selected.byModel.length, 0);
  assert.equal(empty.today.amount, 0);
  assert.equal(empty.today.known, true);
  state.sourceSelections.set("codex", true);
  assert.equal(render().selected.totalCostUsd, 2);
});

test("source click toggles off and on, preserves chart scroll, and restores keyboard focus", () => {
  const renderer = app.slice(app.indexOf("function renderUsage("));
  const handler = renderer.slice(renderer.indexOf('document.querySelectorAll("[data-usage-source]")'), renderer.indexOf('bindSourceTooltips(usage, selectedHostIds);'));
  let click = () => {};
  let focused = 0;
  const state = { sourceSelections: new Map<string, boolean>() };
  const button = { dataset: { usageSource: "codex" }, addEventListener(_event: string, listener: () => void) { click = listener; }, focus() { focused++; } };
  const renders: string[] = [];
  runInNewContext(handler, { state, usage: {}, document: { querySelectorAll: () => [button] }, renderUsage(_usage: unknown, mode: string) { renders.push(mode); } });
  click();
  assert.equal(state.sourceSelections.get("codex"), false);
  click();
  assert.equal(state.sourceSelections.get("codex"), true);
  assert.deepEqual(renders, ["preserve", "preserve"]);
  assert.equal(focused, 2);
});

test("shared usage can be toggled independently and new sources default on", () => {
  const total = runInNewContext(`${helpers}\nfilterUsageByHosts(filterUsageBySources(usage, new Set(['codex', 'shared', 'new-agent'])), new Set(['one'])).totalCostUsd`, {
    state: { sourceSelections: new Map([["shared", false]]) },
    usage: { providers: ["codex", "new-agent"], records: [record("codex", "one", 2), record("shared", "one", 20), record("new-agent", "one", 3)] },
  });
  assert.equal(total, 5);
  assert.match(app, /sourceSelections: new Map\(\)/);
  assert.doesNotMatch(app, /(?:localStorage|sessionStorage)\.[^\n]*sourceSelections/);
});
