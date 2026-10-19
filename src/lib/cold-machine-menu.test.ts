import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const renderer = app.slice(app.indexOf("function renderColdUsageSettings("), app.indexOf("async function loadSettings("));
const escape = app.slice(app.indexOf("const escapeHtml ="), app.indexOf("const usageSourceNames ="));

test("custom machine menu escapes names, updates selection, and submits the selected machine", async () => {
  const hostId = 'odd-"<host>';
  const hidden = { value: "" };
  const trigger = { textContent: "All machines" };
  const requests: Array<Record<string, unknown>> = [];
  const callbacks: Array<() => void> = [];
  const selected = [true, false];
  const items = ["", hostId].map((value, index) => ({
    dataset: { coldHost: value }, textContent: index ? `${hostId} (local)` : "All machines",
    addEventListener(_event: string, callback: () => void) { callbacks[index] = callback; },
    classList: { toggle(_name: string, value: boolean) { selected[index] = value; } },
    setAttribute() {},
  }));
  const settings = { innerHTML: "", querySelectorAll: () => items };
  let submit!: (event: { preventDefault(): void }) => Promise<void>;
  const form = {
    addEventListener(_event: string, callback: typeof submit) { submit = callback; },
    querySelector: (selector: string) => selector === ".cold-submit" ? { disabled: false } : { value: "offline" },
  };
  const elements: Record<string, unknown> = {
    "#usage-cold-settings": settings, "#cold-host": hidden, "#cold-host-button": trigger,
    "#cold-usage-form": form, "#cold-from": { value: "2026-10-13" }, "#cold-to": { value: "2026-10-19" },
  };
  let bound = false;
  runInNewContext(`${escape}\n${renderer}\nrenderColdUsageSettings(usage);`, {
    usage: { to: "2026-10-19", hosts: [{ hostId, local: true }] },
    validDateInput: () => true, shiftDate: () => "2026-10-13",
    bindRangeMenus(root: unknown) { bound = root === settings; }, closeRangeMenus() {}, showToast() {},
    fetch: async (_url: string, options: { body: string }) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({}) };
    },
    $: (selector: string) => elements[selector],
  });
  assert.ok(bound);
  assert.doesNotMatch(settings.innerHTML, /<select|<option/);
  assert.match(settings.innerHTML, /class="range-menu-button"[^>]*aria-haspopup="menu"/);
  assert.match(settings.innerHTML, /data-cold-host="odd-&quot;&lt;host&gt;"/);
  callbacks[1]();
  assert.equal(hidden.value, hostId);
  assert.equal(trigger.textContent, `${hostId} (local)`);
  assert.deepEqual(selected, [false, true]);
  await submit({ preventDefault() {} });
  assert.deepEqual(requests[0], { hostId, from: "2026-10-13", to: "2026-10-19", mode: "offline" });
  callbacks[0]();
  await submit({ preventDefault() {} });
  assert.equal(hidden.value, "");
  assert.equal(Object.hasOwn(requests[1], "hostId"), false);
});
