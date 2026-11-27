import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const renderer = app.slice(app.indexOf("function formatFileSize("), app.indexOf("function renderColdUsageSettings("));
const escape = app.slice(app.indexOf("const escapeHtml ="), app.indexOf("const usageSourceNames ="));
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("Usage settings place the Cursor import above Load older usage", () => {
  assert.ok(html.indexOf('id="usage-import-settings"') > 0);
  assert.ok(html.indexOf('id="usage-import-settings"') < html.indexOf('id="usage-cold-settings"'));
});

test("Cursor import defaults to the local machine, posts the CSV to the chosen machine and shows an escaped summary", async () => {
  const hostId = 'odd-"<host>';
  const trigger = { textContent: "" };
  const result = { innerHTML: "", hidden: true };
  const fileName = { textContent: "" };
  const fileMeta = { textContent: "" };
  const callbacks: Array<() => void> = [];
  const items = ["controller", hostId].map((value, index) => ({
    dataset: { importHost: value }, textContent: index ? hostId : "controller (local)",
    addEventListener(_event: string, callback: () => void) { callbacks[index] = callback; },
    classList: { toggle() {} }, setAttribute() {},
  }));
  const settings = { innerHTML: "", querySelectorAll: () => items };
  const file = { name: "usage.csv", size: 2048 };
  let onChange!: () => void;
  const fileInput = { files: [file], addEventListener(_event: string, callback: () => void) { onChange = callback; } };
  let submit!: (event: { preventDefault(): void }) => Promise<void>;
  const form = { addEventListener(_event: string, callback: typeof submit) { submit = callback; }, querySelector: () => ({ disabled: false }) };
  const elements: Record<string, unknown> = {
    "#usage-import-settings": settings, "#import-host-button": trigger, "#import-file": fileInput,
    "#import-file-name": fileName, "#import-file-meta": fileMeta, "#cursor-import-form": form, "#import-result": result,
  };
  const requests: Array<{ url: string; body: unknown; contentType: string }> = [];
  let reloaded = 0;
  const response = { hostId, rows: 3, cursorRows: 2, added: 2, updated: 0, moved: 1, skipped: 1, skippedByProduct: { "grok-build": 1 }, invalid: 0, from: "2026-11-27", to: "2026-11-27", unpricedModels: [{ model: "<model>", rows: 1 }] };
  runInNewContext(`${escape}\n${renderer}\nrenderCursorImportSettings(usage);`, {
    usage: { hosts: [{ hostId: "controller", local: true }, { hostId }] },
    bindRangeMenus() {}, closeRangeMenus() {}, showToast() {}, loadDashboard: async () => { reloaded++; },
    fetch: async (url: string, options: { body: unknown; headers: Record<string, string> }) => {
      requests.push({ url, body: options.body, contentType: options.headers["Content-Type"] });
      return { ok: true, json: async () => response };
    },
    $: (selector: string) => elements[selector],
  });
  assert.match(settings.innerHTML, /aria-checked="true" class="active" data-import-host="controller"/);
  assert.match(settings.innerHTML, /data-import-host="odd-&quot;&lt;host&gt;"/);
  assert.match(settings.innerHTML, /type="file" accept="\.csv,text\/csv"/);
  onChange();
  assert.equal(fileName.textContent, "usage.csv");
  assert.equal(fileMeta.textContent, "2.0 KB");
  await submit({ preventDefault() {} });
  assert.deepEqual(requests[0], { url: "/api/v1/usage/import?hostId=controller", body: file, contentType: "text/csv" });
  callbacks[1]();
  assert.equal(trigger.textContent, hostId);
  await submit({ preventDefault() {} });
  assert.equal(requests[1].url, `/api/v1/usage/import?hostId=${encodeURIComponent(hostId)}`);
  assert.equal(result.hidden, false);
  assert.equal(reloaded, 2);
  assert.match(result.innerHTML, /Imported 2 Cursor rows for 2026-11-27 on odd-&quot;&lt;host&gt;/);
  assert.match(result.innerHTML, /1 skipped: grok-build \(counted by ccusage\)/);
  assert.match(result.innerHTML, /import-stat import-warning"><span class="import-stat-value">1<\/span><span class="import-stat-label">moved host/);
  assert.match(result.innerHTML, /1 row unpriced: &lt;model&gt;\. Add it to ccusage pricingOverrides\./);
  assert.doesNotMatch(result.innerHTML, /<model>|<host>/);
});
