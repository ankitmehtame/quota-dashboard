import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const axes = app.slice(app.indexOf("const max = Math.max(...buckets.map"), app.indexOf("const usageTooltip ="));

function renderAxes(buckets: Array<{ from: string; costUsd: number }>) {
  const elements = new Map<string, { innerHTML: string }>();
  runInNewContext(axes, {
    buckets, escapeHtml: String, money: (value: number) => `$${value.toFixed(2)}`,
    $: (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, { innerHTML: "" });
      return elements.get(selector);
    },
  });
  return elements;
}

test("chart axes clear safely when no hosts or records are selected", () => {
  const elements = renderAxes([]);
  assert.equal(elements.get("#chart-scale")!.innerHTML, "");
  assert.equal(elements.get("#chart-dates")!.innerHTML, "");
});

test("chart dollar ticks share the bars' maximum and dates include an intermediate tick", () => {
  const elements = renderAxes([
    { from: "2026-10-01", costUsd: 12 },
    { from: "2026-10-02", costUsd: 20 },
    { from: "2026-10-03", costUsd: 8 },
  ]);
  assert.equal(elements.get("#chart-scale")!.innerHTML, "<span>$20.00</span><span>$15.00</span><span>$10.00</span><span>$5.00</span><span>$0.00</span>");
  assert.equal((elements.get("#chart-dates")!.innerHTML.match(/<span>/g) || []).length, 3);
  assert.match(elements.get("#chart-dates")!.innerHTML, /Oct 2/);
  const single = renderAxes([{ from: "2026-10-01", costUsd: 0 }]);
  assert.equal((single.get("#chart-dates")!.innerHTML.match(/<span>/g) || []).length, 1);
  assert.equal(single.get("#chart-scale")!.innerHTML, "");
});

test("dashboard has one period control, no promotional hero, and collapsed maintenance", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<h1>Your AI accounts<\/h1>/);
  assert.equal((html.match(/id="usage-range"/g) || []).length, 1);
  assert.doesNotMatch(html, /class="hero"|class="live-dot"|id="now-time"|id="last-refresh"/);
  assert.doesNotMatch(html, /pacing-key|The fill shows quota used/);
  assert.match(html, /<details class="maintenance-settings"><summary>Load older usage<\/summary>/);
});

test("tooltip and machine-status backgrounds use the shared raised surface", () => {
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(styles, /#202925/i);
  for (const selector of ["chart-tooltip", "quota-now-tooltip", "usage-host-status-popover"]) {
    const rules = [...styles.matchAll(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`, "g"))];
    assert.ok(rules.length > 0);
    for (const rule of rules) {
      if (/background:/.test(rule[1])) assert.match(rule[1], /background:\s*var\(--surface-raised\)/);
    }
  }
});

test("period and grouping use the same custom menu controls", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const controls = html.slice(html.indexOf('<div class="usage-controls">'), html.indexOf('<div class="usage-layout">'));
  assert.doesNotMatch(controls, /<select|<option/);
  for (const id of ["usage-range", "representation-menu-button"]) {
    assert.match(controls, new RegExp(`<button class="range-menu-button" id="${id}"[^>]*aria-haspopup="menu"`));
  }
  assert.equal((controls.match(/class="range-menu-items"/g) || []).length, 2);
  assert.equal((controls.match(/role="menuitemradio"/g) || []).length, 14);
});

test("dropdown interaction colors use blue action tokens, not provider mint", () => {
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((rule) => /\.range-menu|\.range-tab|\.range-picker\.loading/.test(rule[1]));
  assert.ok(rules.length > 0);
  for (const rule of rules) assert.doesNotMatch(rule[2], /--mint|#a8f2cf/i);
  assert.match(styles, /\.range-menu-items button\.active\s*\{[^}]*color:\s*var\(--action\)/);
});

test("mint colors are reserved for provider data, not control or focus states", () => {
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const providerSelectors = new Set([".legend-key.mint", ".chart-segment.mint", ".tooltip-harness-dot.mint", ".chart-bar"]);
  for (const rule of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/var\(--mint(?:-dark)?\)/.test(rule[2])) {
      assert.ok(providerSelectors.has(rule[1].trim()), `Unexpected mint control color: ${rule[1].trim()}`);
    }
  }
  assert.doesNotMatch(styles, /#(?:101413|171d1b|1c2421|2a3430|25302b|27312d|111714|050806|202925)\b/i);
  assert.match(styles, /\.switch:checked\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--action\)/);
  assert.match(styles, /\.switch\s*\{[^}]*background:\s*var\(--bg\)/);
  assert.match(styles, /\.switch:checked::after\s*\{[^}]*background:\s*var\(--text\)/);
  assert.match(styles, /\.switch:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--action\)/);
});

test("menu option focus stays inside the option and rows fit their menu", () => {
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.range-menu-items button:focus-visible\s*\{[^}]*outline-offset:\s*-2px/);
  assert.match(styles, /\.range-menu-items button\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%/);
  assert.match(styles, /\.range-menu-items\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
});
