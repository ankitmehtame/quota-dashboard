import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const presentation = app.slice(app.indexOf("const usageSourceNames ="), app.indexOf("const HOT_USAGE_POLL_INTERVAL_MS"));
const behavior = app.slice(app.indexOf("function markFailedIcon("), app.indexOf("bindHeaderRefreshTooltip();", app.indexOf("function markFailedIcon(")));

test("opening and visibility checks use only the server and update icons from the opening snapshot", async () => {
  const listeners = new Map<string, (event?: unknown) => void>();
  const calls: string[] = [];
  const classes = new Set<string>();
  class Image {
    dataset = { icon: "openai" };
    complete = false;
    naturalWidth = 0;
    src = "/icons/openai.svg";
    getAttribute() { return this.src; }
    matches() { return true; }
    closest() { return { classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name), contains: (name: string) => classes.has(name) } }; }
  }
  const image = new Image();
  const document = { visibilityState: "visible", querySelectorAll: () => [image], addEventListener: (name: string, listener: (event?: unknown) => void, capture?: boolean) => {
    listeners.set(name, listener);
    if (name === "error") assert.equal(capture, true);
  } };
  const context = { document, HTMLImageElement: Image, escapeHtml: String, fetch: async (url: string, init: RequestInit) => {
    assert.equal(init.method, "POST");
    calls.push(url);
    return { ok: true, json: async () => ({ icons: { openai: "a".repeat(64) } }) };
  } };
  await runInNewContext(`${presentation}\n${behavior}\ncheckProviderIcons();`, context);
  assert.equal(image.src, `/icons/openai.svg?v=${"a".repeat(64)}`);
  assert.ok(calls.every((url) => url === "/api/v1/icons/refresh"));
  listeners.get("error")!({ target: image });
  assert.ok(classes.has("icon-failed"));
  const count = calls.length;
  document.visibilityState = "hidden";
  listeners.get("visibilitychange")!();
  assert.equal(calls.length, count);
  document.visibilityState = "visible";
  listeners.get("visibilitychange")!();
  assert.equal(calls.length, count + 1);
});

test("offline opening and invalid revision data leave local fallbacks available without UI errors", async () => {
  const images: unknown[] = [];
  const document = { querySelectorAll: () => images, addEventListener() {} };
  await runInNewContext(`${presentation}\n${behavior}\ncheckProviderIcons();`, { document, fetch: async () => { throw new Error("Offline"); } });
  const result = await runInNewContext(`${presentation}\n${behavior}\ncheckProviderIcons().then(() => sourceIcon('codex'));`, {
    document, fetch: async () => ({ ok: true, json: async () => ({ icons: { openai: '"><script>' } }) }),
  });
  assert.match(result, /src="\/icons\/openai.svg"/);
  assert.doesNotMatch(result, /<script>/);
});

test("day detail breakdowns use icons for known sources and squares for unknown sources", () => {
  const details = app.slice(app.indexOf("function openUsageDetails("), app.indexOf("function ", app.indexOf("function openUsageDetails(") + 10));
  const elements = new Map<string, { innerHTML: string; textContent: string; showModal: () => void; classList: { add: () => void } }>();
  const bucket = { date: "2026-10-04", costUsd: 1, totalTokens: 10, byModel: [
    { provider: "hermes", models: [{ model: "example", costUsd: 1, totalTokens: 10 }] },
    { provider: "new-tool", models: [{ model: "example", costUsd: 0, totalTokens: 0 }] },
  ] };
  runInNewContext(`${presentation}\n${details}\nopenUsageDetails(bucket, 'day');`, {
    bucket, state: { dashboard: { usage: {} } }, activeDetailsTrigger: null, activeChartTooltip: null,
    $: (selector: string) => { if (!elements.has(selector)) elements.set(selector, { innerHTML: "", textContent: "", showModal() {}, classList: { add() {} } }); return elements.get(selector); },
    document: { activeElement: null },
    selectedUsage: () => ({}), filterUsageByHosts: () => ({}), reconcileHostSelections: () => ({ selectedHostIds: new Set() }),
    activeRepresentation: () => "day", usageBuckets: () => [bucket], usageBucketLabel: () => bucket.date,
    escapeHtml: String, money: String, formatTokens: String, spend: String, modelSpend: () => "$1.00",
  });
  const html = [...elements.values()].map((element) => element.innerHTML).join("");
  assert.match(html, /data-icon="hermes"[^>]*width="14" height="14"/);
  assert.match(html, /class="legend-key \w+"><\/span>New Tool/);
});
