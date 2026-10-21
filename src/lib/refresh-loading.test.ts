import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const lifecycle = app.slice(app.indexOf("function setRefreshStatus("), app.indexOf("async function loadUsage("));

function setup() {
  const buttons = ["refresh-button", "usage-refresh-button"].map((id) => ({
    id, disabled: false, refreshing: false, completed: false, attributes: new Map<string, string>(),
    classList: { toggle(name: string, value: boolean) {
      const button = buttons.find((button) => button.id === id)!;
      if (name === "is-refreshing") button.refreshing = value;
      if (name === "is-refreshed") button.completed = value;
    } },
    setAttribute(name: string, value: string) { this.attributes.set(name, value); },
    querySelector() { return { setAttribute() {} }; },
  }));
  const messages: string[] = [];
  const status = { textContent: "", hidden: true };
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  const context = {
    document: { querySelectorAll: () => buttons },
    window: {
      clearTimeout(id: number) { timers.delete(id); },
      setTimeout(callback: () => void, delay: number) { timers.set(++timerId, { callback, delay }); return timerId; },
    },
    Date, Set, Map, messages, showToast: (message: string) => messages.push(message),
    $: (selector: string) => selector === "#usage-refresh-status" ? status : { textContent: "" },
    HOT_USAGE_RETRY_GRACE_PERIOD_MS: 15_000,
    HOT_USAGE_POLL_TIMEOUT_MS: 120_000,
    HOT_USAGE_POLL_INTERVAL_MS: 5_000,
  };
  const api = runInNewContext(`
    let activeRefreshes = 0;
    let activeRefreshButton = null;
    let completedRefreshButton = null;
    let refreshCompletionTimer = null;
    let hotUsagePoller = null;
    ${lifecycle}
    ({ beginRefresh, endRefresh, stopHotUsagePolling, startHotUsagePolling,
       evaluate: (usage) => evaluateHotUsagePoll(hotUsagePoller, usage) });
  `, context);
  return { api, buttons, messages, status, timers };
}

for (const buttonId of ["refresh-button", "usage-refresh-button"]) {
  test(`${buttonId} stays animated through host polling and resets on completion`, () => {
    const { api, buttons, status, timers } = setup();
    const clicked = buttons.find((button) => button.id === buttonId)!;
    assert.equal(api.beginRefresh(buttonId), true);
    assert.equal(status.textContent, "Loading saved usage…");
    assert.equal(status.hidden, false);
    assert.ok(buttons.every((button) => button.disabled));
    assert.equal(clicked.refreshing, true);
    assert.equal(clicked.attributes.get("aria-busy"), "true");
    assert.equal(buttons.filter((button) => button.refreshing).length, 1);
    const host = { hostId: "local", category: "hot", generatedAt: "2026-10-21T12:00:00Z", status: "online" };
    api.startHotUsagePolling(new Map([["local", { generatedAt: Date.parse(host.generatedAt), error: null }]]), { hosts: [host] }, Date.now(), new Set(["local"]));
    api.endRefresh();
    assert.equal(status.textContent, "Waiting for fresh usage from hosts…");
    assert.equal(clicked.refreshing, true);
    assert.ok(buttons.every((button) => button.disabled));
    assert.equal(api.beginRefresh(buttonId), false);
    api.evaluate({ hosts: [{ ...host, generatedAt: "2026-10-21T12:01:00Z" }] });
    assert.ok(buttons.every((button) => !button.disabled && !button.refreshing));
    assert.equal(clicked.attributes.get("aria-busy"), "false");
    assert.equal(status.textContent, "Usage refresh complete");
    assert.equal(clicked.completed, true);
    assert.match(clicked.attributes.get("aria-label")!, /Refresh complete/);
    const completionTimer = [...timers.values()].find((timer) => timer.delay === 3_000);
    assert.ok(completionTimer);
    completionTimer.callback();
    assert.equal(clicked.completed, false);
    assert.doesNotMatch(clicked.attributes.get("aria-label")!, /Refresh complete/);
    assert.equal(api.beginRefresh(buttonId), true);
    assert.equal(clicked.completed, false);
  });
}

test("starting another refresh cancels the previous completion timer", () => {
  const { api, buttons, timers } = setup();
  api.beginRefresh("refresh-button");
  api.startHotUsagePolling(new Map(), { hosts: [{ hostId: "local", category: "hot", generatedAt: new Date().toISOString(), status: "online" }] }, Date.now(), new Set(["local"]));
  api.endRefresh();
  assert.equal(buttons[0].completed, true);
  assert.ok([...timers.values()].some((timer) => timer.delay === 3_000));
  api.beginRefresh("usage-refresh-button");
  assert.equal(buttons[0].completed, false);
  assert.equal(buttons[1].refreshing, true);
  assert.ok(![...timers.values()].some((timer) => timer.delay === 3_000));
});

test("failed requests, missing hosts, host failures, and polling timeouts clear loading", () => {
  for (const outcome of ["request failure", "no hosts", "host failure", "timeout"]) {
    const { api, buttons, status } = setup();
    api.beginRefresh("refresh-button");
    if (outcome !== "request failure") {
      const startedAt = Date.now() - (outcome === "timeout" ? 120_001 : 0);
      api.startHotUsagePolling(new Map(), null, startedAt, new Set(outcome === "no hosts" ? [] : ["local"]));
    }
    api.endRefresh();
    if (outcome === "host failure") api.evaluate({ hosts: [{ hostId: "local", error: "Collection failed" }] });
    assert.ok(buttons.every((button) => !button.disabled && !button.refreshing), outcome);
    if (outcome === "no hosts") assert.match(status.textContent, /No active hosts/);
    if (outcome === "host failure") assert.match(status.textContent, /failed: Collection failed/);
    if (outcome === "timeout") assert.match(status.textContent, /still running/);
  }
});

test("both refresh controls use decorative icons and motion respects user preferences", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.equal((html.match(/class="refresh-icon"/g) || []).length, 2);
  assert.match(css, /\.is-refreshing \.refresh-icon\s*\{ animation: refresh-spin \.9s linear infinite;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/);
  assert.match(css, /\.usage-refresh-status\s*\{ position: absolute; width: 1px; height: 1px;/);
});
