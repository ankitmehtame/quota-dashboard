import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const presentation = app.slice(app.indexOf("const usageSourceNames ="), app.indexOf("const HOT_USAGE_POLL_INTERVAL_MS"));
const escape = app.slice(app.indexOf("const escapeHtml ="), app.indexOf("const usageSourceNames ="));

test("known source names and colors remain curated and fallback colors are stable", () => {
  const result = runInNewContext(`${presentation}; [usageSourceName("opencode"), usageSourceColor("codex"), usageSourceColor("opencode"), usageSourceColor("hermes"), usageSourceColor("antigravity"), usageSourceName("new_tool.v2"), usageSourceColor("new-tool"), usageSourceColor("new-tool")]`);
  assert.deepEqual(Array.from(result).slice(0, 6), ["OpenCode", "mint", "violet", "orange", "blue", "New Tool V2"]);
  assert.equal(result[6], result[7]);
});

test("expanded fallback palette has matching bar, legend, and tooltip styles", () => {
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const colors: string[] = Array.from(runInNewContext(`${presentation}; Array.from({ length: 128 }, (_, index) => usageSourceColor('future-tool-' + index))`));
  assert.equal(new Set(colors).size, 8);
  for (const color of ["rose", "yellow", "teal"]) {
    assert.ok(colors.includes(color));
    assert.ok(styles.includes(`--${color}:`));
    for (const selector of ["legend-key", "chart-segment", "tooltip-harness-dot"]) {
      assert.ok(styles.includes(`.${selector}.${color}`));
    }
  }
});

test("usage breakdown header badges have spacing before the agent name", () => {
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.detail-group h3 \.legend-key\s*\{[^}]*margin:\s*0 6px 0 0\s*;/);
});

test("chart legend groups each dynamic badge with its escaped label", () => {
  const legend = app.slice(app.indexOf('$(".chart-legend").innerHTML ='), app.indexOf('$("#usage-hosts").innerHTML ='));
  const element = { innerHTML: "" };
  const render = (providers: string[]) => runInNewContext(`${escape}\n${legend}`, {
    $: () => element,
    enabledSources: new Set(providers),
    sourceColors: () => "mint",
    sourceNames: (provider: string) => provider,
  });
  render(["Codex", "A long agent name", "<agent>"]);
  assert.equal(element.innerHTML, ["Codex", "A long agent name", "&lt;agent&gt;"].map((label) => `<span class="chart-legend-item"><span class="legend-key mint"></span>${label}</span>`).join(""));
  render([]);
  assert.equal(element.innerHTML, "No local usage sources enabled");
});

test("placeholder legend groups badges and labels, with non-wrapping flex items", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const legend = html.match(/<div class="chart-legend">(.*?)<\/div>/)![1];
  const entries = [...legend.matchAll(/<span class="chart-legend-item"><span class="legend-key \w+"><\/span>[^<]+<\/span>/g)];
  assert.equal(entries.length, 4);
  assert.equal(entries.map(([entry]) => entry).join(""), legend);
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const itemStyles = styles.match(/\.chart-legend \.chart-legend-item\s*\{([^}]*)\}/)![1];
  for (const rule of [/display:\s*inline-flex;/, /align-items:\s*center;/, /white-space:\s*nowrap;/, /gap:\s*6px;/]) {
    assert.match(itemStyles, rule);
  }
  assert.match(styles, /\.chart-legend \.legend-key\s*\{[^}]*flex-shrink:\s*0;/);
});

test("settings list dynamic sources, honor saved toggles, and escape labels and IDs", async () => {
  const settings = app.slice(app.indexOf("async function loadSettings("), app.indexOf("function showToast("));
  const elements = new Map<string, { innerHTML: string }>();
  await runInNewContext(`${escape}\n${presentation}\n${settings}\nloadSettings();`, {
    fetch: async () => ({ json: async () => ({ providerOrder: [], providers: {}, usageSources: { "new-tool": { enabled: true }, "another-agent": { enabled: false }, 'odd-"<tool>': { enabled: true } } }) }),
    state: { hour12: false }, renderColdUsageSettings() {},
    document: { querySelectorAll: () => [] },
    $: (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, { innerHTML: "" });
      return elements.get(selector);
    },
  });
  const html = elements.get("#provider-settings")!.innerHTML;
  assert.match(html, /New Tool usage/);
  assert.match(html, /data-provider="new-tool" checked/);
  assert.match(html, /data-provider="another-agent"\s+aria-label/);
  assert.doesNotMatch(html, /<tool>|data-provider="odd-"/);
  assert.match(html, /&quot;&lt;tool&gt;/i);
});
