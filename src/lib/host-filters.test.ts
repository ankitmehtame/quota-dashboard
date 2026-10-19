import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const renderer = app.slice(app.indexOf('$("#usage-hosts").innerHTML ='), app.indexOf('document.querySelectorAll("#usage-hosts .usage-host-alert")'));
const escape = app.slice(app.indexOf("const escapeHtml ="), app.indexOf("const usageSourceNames ="));

function render(hosts: Array<{ hostId: string; severity?: string; status?: string; usable?: boolean }>, selected: string[]) {
  const target = { innerHTML: "" };
  runInNewContext(`${escape}\n${renderer}`, {
    hosts, usage: {}, selectedHostIds: new Set(selected),
    $: () => target,
    hostUsable: (_usage: unknown, host: { usable?: boolean }) => host.usable !== false,
    hostHasRecords: () => true,
    hostHealthy: (host: { status?: string }) => host.status !== "offline",
    missingUsageDetails: () => "",
  });
  return target.innerHTML;
}

test("machine filters expose independent pressed states with decorative plain checkmarks", () => {
  const html = render([{ hostId: "workstation" }, { hostId: "macbook-pro", status: "offline", severity: "warning" }], ["workstation", "macbook-pro"]);
  assert.match(html, /class="usage-hosts-label" aria-hidden="true">Machines/);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 2);
  assert.equal((html.match(/class="host-check" aria-hidden="true">✓/g) || []).length, 2);
  assert.match(html, /class="usage-host-alert"[^>]*aria-label="Show status for macbook-pro/);
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
  assert.match(html, /<svg width="18" height="18"[^>]*stroke-linecap="round"/);
  assert.match(html, /<circle cx="12" cy="12" r="9"\/>/);
  assert.doesNotMatch(html, /M8 2 15 14H1Z/);
  assert.doesNotMatch(html, /type="checkbox"|role="tab"/);
  const unselected = render([{ hostId: "workstation" }], []);
  assert.match(unselected, /aria-pressed="false"/);
});

test("unavailable machines keep a separate status control and names stay escaped", () => {
  const html = render([{ hostId: '<host>"', usable: false, status: "offline" }], []);
  assert.match(html, /class="host-name">&lt;host&gt;&quot;/);
  assert.match(html, /aria-pressed="false" disabled/);
  assert.match(html, /class="usage-host-alert"/);
  assert.doesNotMatch(html, /<host>/);
  assert.equal(render([], []), '<span class="usage-hosts-empty">No usage hosts</span>');
});
