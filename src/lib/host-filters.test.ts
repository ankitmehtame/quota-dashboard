import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const renderer = app.slice(app.indexOf('$("#usage-hosts").innerHTML ='), app.indexOf('document.querySelectorAll("#usage-hosts .usage-host-alert")'));
const escape = app.slice(app.indexOf("const escapeHtml ="), app.indexOf("const usageSourceNames ="));

function render(hosts: Array<{ hostId: string; severity?: string; status?: string; usable?: boolean; warning?: string | null; complete?: boolean; error?: string | null }>, selected: string[]) {
  const target = { innerHTML: "" };
  runInNewContext(`${escape}\n${renderer}`, {
    hosts, usage: {}, selectedHostIds: new Set(selected),
    $: () => target,
    hostUsable: (_usage: unknown, host: { usable?: boolean }) => host.usable !== false,
    hostHasRecords: () => true,
    hostHealthy: (host: { status?: string; complete?: boolean }) => host.status !== "offline" && host.complete !== false,
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

const hostHealthySource = app.slice(app.indexOf("function hostHealthy("), app.indexOf("function enabledUsageProviders("));
const pricingWarning = "Pricing fetch failed; using cached pricing";

test("a pricing warning does not affect host health or completeness", () => {
  const healthy = runInNewContext(`${hostHealthySource}\nhostHealthy`) as (host: unknown) => boolean;
  assert.equal(healthy({ status: "ok", warning: pricingWarning, severity: "warning", complete: true }), true);
  assert.equal(healthy({ status: "ok", warning: pricingWarning, complete: false }), false);
});

test("a healthy host with a pricing warning shows the warning in an alert popover with warning styling", () => {
  const html = render([{ hostId: "workstation", status: "ok", severity: "warning", warning: pricingWarning }], ["workstation"]);
  assert.match(html, /class="usage-host-pill selected healthy warning /);
  assert.match(html, /class="usage-host-alert"/);
  assert.match(html, /<strong>workstation<\/strong><span>Pricing fetch failed; using cached pricing<\/span>/);
  assert.doesNotMatch(html, /informational/);
  assert.match(html, /aria-label="workstation: selected, healthy, Pricing fetch failed/);
});

test("a pricing warning stays visible next to a separate coverage error", () => {
  const html = render([{ hostId: "workstation", status: "ok", severity: "error", complete: false, warning: pricingWarning }], ["workstation"]);
  assert.match(html, /Range incomplete/);
  assert.match(html, /<span>Pricing fetch failed; using cached pricing<\/span>/);
});
