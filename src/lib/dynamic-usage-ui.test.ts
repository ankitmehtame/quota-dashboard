import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const presentation = app.slice(app.indexOf("const usageSourceNames ="), app.indexOf("const HOT_USAGE_POLL_INTERVAL_MS"));
const escape = app.slice(app.indexOf("const escapeHtml ="), app.indexOf("const usageSourceNames ="));

test("usage date stays inline without an arbitrary width cap and cannot wrap internally", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(html, /class="usage-caption"><span id="usage-total-caption">Estimated spend · Today<\/span> · <span id="usage-total-date" class="usage-date">—<\/span><\/span>/);
  assert.match(styles, /\.usage-caption span\s*\{[^}]*display:\s*inline;/);
  assert.match(styles, /\.usage-caption \.usage-date\s*\{[^}]*display:\s*inline-block;[^}]*white-space:\s*nowrap;/);
  assert.doesNotMatch(styles, /\.usage-metric span\s*\{[^}]*max-width:/);
  const updates = app.split("\n").filter((line) => /\$\("#usage-total-(caption|date)"\)\.textContent =/.test(line)).join("\n");
  const elements = new Map<string, { textContent: string }>();
  runInNewContext(updates, {
    $: (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, { textContent: "" });
      return elements.get(selector);
    },
    state: { range: "calendar-month" }, usagePresetLabel: () => "This month", dateRange: "Oct 1–19",
  });
  assert.equal(elements.get("#usage-total-caption")?.textContent, "Estimated spend · This month");
  assert.equal(elements.get("#usage-total-date")?.textContent, "—");
  assert.match(updates, /\$\("#usage-total-date"\)\.textContent = dateRange;/);
});

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
  const render = (providers: string[]) => runInNewContext(`${escape}\n${presentation}\n${legend}`, {
    $: () => element,
    enabledSources: new Set(providers),
    sourceColors: () => "mint",
    sourceNames: (provider: string) => provider,
  });
  render(["Codex", "A long agent name", "<agent>"]);
  assert.match(element.innerHTML, />Codex<\/span>/);
  assert.match(element.innerHTML, />A long agent name<\/span>/);
  assert.match(element.innerHTML, />&lt;agent&gt;<\/span>/);
  assert.equal((element.innerHTML.match(/class="legend-key /g) || []).length, 3);
  render(["codex"]);
  assert.match(element.innerHTML, /data-icon="openai"[^>]*width="14" height="14"/);
  render([]);
  assert.equal(element.innerHTML, "No local usage sources enabled");
});

test("placeholder legend groups badges and labels, with non-wrapping flex items", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const legend = html.match(/<div class="chart-legend">(.*?)<\/div>/)![1];
  const expected = runInNewContext(`${escape}\n${presentation}\n["codex", "opencode", "hermes", "antigravity"].map(id => '<span class="chart-legend-item">' + sourceIcon(id) + usageSourceName(id) + '</span>').join('');`);
  assert.equal(legend, expected);
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

test("settings show icons in both provider sections without changing controls or the display setting", async () => {
  const settings = app.slice(app.indexOf("async function loadSettings("), app.indexOf("function showToast("));
  const elements = new Map<string, { innerHTML: string }>();
  const providerOrder = ["codex", "openrouter", "opencode-go", "ollama", "claude"];
  const usageSources = Object.fromEntries(["codex", "opencode", "hermes", "antigravity", "custom-agent"].map((id) => [id, { enabled: true }]));
  await runInNewContext(`${escape}\n${presentation}\n${settings}\nloadSettings();`, {
    fetch: async () => ({ json: async () => ({ providerOrder, providers: Object.fromEntries(providerOrder.map((id) => [id, { name: id, description: "Example", enabled: true }])), usageSources }) }),
    state: { hour12: false }, renderColdUsageSettings() {}, document: { querySelectorAll: () => [] },
    $: (selector: string) => { if (!elements.has(selector)) elements.set(selector, { innerHTML: "" }); return elements.get(selector); },
  });
  const html = elements.get("#provider-settings")!.innerHTML;
  const quota = html.split("Quota providers</p>")[1].split("<p class=\"settings-group\">Usage sources")[0];
  const usage = html.split("Usage sources</p>")[1];
  assert.equal((quota.match(/<img /g) || []).length, 5);
  assert.equal((usage.match(/<img /g) || []).length, 4);
  for (const icon of ["openai", "openrouter", "opencode", "ollama", "claude"]) assert.match(quota, new RegExp(`data-icon="${icon}"[^>]*width="14" height="14"`));
  assert.match(usage, /class="legend-key \w+"><\/span>Custom Agent usage/);
  assert.match(quota, /data-provider="codex" checked/);
  assert.match(usage, /data-kind="usage" data-provider="custom-agent" checked/);
  assert.match(html, /class="provider-name">12-hour times<\/div>/);
});
