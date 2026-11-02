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
  assert.deepEqual(Array.from(result).slice(0, 6), ["OpenCode", "mint", "violet", "yellow", "antigravity", "New Tool V2"]);
  assert.equal(result[6], result[7]);
  assert.deepEqual(Array.from(runInNewContext(`${presentation}; [usageSourceColor("claude"), usageSourceColor("gemini"), usageSourceColor("gemini-cli")]`)), ["claude", "gemini", "gemini"]);
});

test("expanded fallback palette has matching bar, legend, and tooltip styles", () => {
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const colors: string[] = Array.from(runInNewContext(`${presentation}; Array.from({ length: 128 }, (_, index) => usageSourceColor('future-tool-' + index))`));
  assert.equal(new Set(colors).size, 6);
  for (const reserved of ["claude", "antigravity", "gemini", "orange", "blue"]) assert.ok(!colors.includes(reserved));
  for (const color of ["rose", "yellow", "teal", "claude", "antigravity", "gemini"]) {
    if (!["claude", "antigravity", "gemini"].includes(color)) assert.ok(colors.includes(color));
    assert.ok(styles.includes(`--${color}:`));
  }
  assert.match(styles, /\.legend-key, \.tooltip-harness-dot, \.chart-segment \{ background: var\(--tool-color/);
});

test("usage breakdown header badges have spacing before the agent name", () => {
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.detail-group h3 \.legend-key\s*\{[^}]*margin:\s*0 6px 0 0\s*;/);
});

test("chart legend groups each dynamic badge with its escaped label", () => {
  const start = app.indexOf('$(".chart-legend").innerHTML =');
  const legend = app.slice(start, app.indexOf('document.querySelectorAll("[data-usage-source]")', start));
  const element = { innerHTML: "" };
  const render = (providers: string[]) => runInNewContext(`${escape}\n${presentation}\n${legend}`, {
    $: () => element,
    enabledSources: new Set(providers),
    state: { sourceSelections: new Map() },
    sourceColors: () => "mint",
    sourceNames: (provider: string) => provider,
  });
  render(["Codex", "A long agent name", "<agent>"]);
  assert.match(element.innerHTML, />Codex<\/button>/);
  assert.match(element.innerHTML, />A long agent name<\/button>/);
  assert.match(element.innerHTML, />&lt;agent&gt;<\/button>/);
  assert.equal((element.innerHTML.match(/aria-pressed="true"/g) || []).length, 3);
  assert.doesNotMatch(element.innerHTML, /class="legend-key"/);
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
    state: { hour12: false }, renderColdUsageSettings() {}, renderAppearanceSettings() {},
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

test("settings show icons in both provider sections without changing controls", async () => {
  const settings = app.slice(app.indexOf("async function loadSettings("), app.indexOf("function showToast("));
  const elements = new Map<string, { innerHTML: string }>();
  const providerOrder = ["codex", "openrouter", "opencode-go", "ollama", "claude"];
  const usageSources = Object.fromEntries(["codex", "opencode", "hermes", "antigravity", "custom-agent"].map((id) => [id, { enabled: true }]));
  await runInNewContext(`${escape}\n${presentation}\n${settings}\nloadSettings();`, {
    fetch: async () => ({ json: async () => ({ providerOrder, providers: Object.fromEntries(providerOrder.map((id) => [id, { name: id, description: "Example", enabled: true }])), usageSources }) }),
    state: { hour12: false }, renderColdUsageSettings() {}, renderAppearanceSettings() {}, document: { querySelectorAll: () => [] },
    $: (selector: string) => { if (!elements.has(selector)) elements.set(selector, { innerHTML: "" }); return elements.get(selector); },
  });
  const html = elements.get("#provider-settings")!.innerHTML;
  const quota = html.split("Quota providers</p>")[1].split("<p class=\"settings-group\">Usage sources")[0];
  const usage = html.split("Usage sources</p>")[1];
  assert.equal((quota.match(/<img /g) || []).length, 5);
  assert.equal((usage.match(/<img /g) || []).length, 4);
  for (const icon of ["openai", "openrouter", "opencode", "ollama", "claude"]) assert.match(quota, new RegExp(`data-icon="${icon}"[^>]*width="14" height="14"`));
  assert.match(usage, /class="legend-key" data-tool="custom-agent" style="--tool-color:var\(--\w+\)"><\/span>Custom Agent usage/);
  assert.match(quota, /data-provider="codex" checked/);
  assert.match(usage, /data-kind="usage" data-provider="custom-agent" checked/);
  assert.doesNotMatch(html, /12-hour times/);
});

const appearance = app.slice(app.indexOf("function renderAppearanceSettings("), app.indexOf("function settingsHashSection("));
const colorState = app.slice(app.indexOf("const settingsSections ="), app.indexOf("function renderAppearanceSettings("));

test("appearance lists each tool once by canonical id with color controls and the per-device clock toggle", () => {
  const elements = new Map<string, { innerHTML: string }>();
  const providerOrder = ["codex", "openrouter", "opencode-go", "ollama", "claude"];
  const usageIds = ["codex", "opencode", "gemini-cli", "custom-agent", "claude"];
  runInNewContext(`${escape}\n${presentation}\n${colorState}\n${appearance}\nrenderAppearanceSettings(data, usageIds);`, {
    data: { providerOrder, providers: Object.fromEntries(providerOrder.map((id) => [id, { name: `Provider ${id}` }])) }, usageIds,
    state: { hour12: true }, document: { querySelectorAll: () => [] },
    $: (selector: string) => { if (!elements.has(selector)) elements.set(selector, { innerHTML: "" }); return elements.get(selector); },
  });
  const html = elements.get("#appearance-settings")!.innerHTML;
  const rows = [...html.matchAll(/data-tool-row="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rows, ["codex", "openrouter", "opencode", "ollama", "claude", "gemini", "custom-agent"]);
  assert.match(html, /<input class="switch" type="checkbox" data-kind="time-format" checked/);
  assert.ok(html.indexOf("12-hour times") < html.indexOf('class="settings-group">Colors'));
  assert.match(html, /data-tool-color="openrouter" value="#66c9bf"/);
  assert.match(html, /data-tool-color="opencode" value="#c7b8ff"/);
  assert.equal((html.match(/<button[^>]*data-color-reset[^>]* hidden/g) || []).length, 7);
  assert.equal((html.match(/<button[^>]*data-color-undo[^>]* hidden/g) || []).length, 7);
});

test("default tool colors match the stylesheet and overrides win only for the canonical tool", () => {
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const tokens = runInNewContext(`${presentation}; colorTokenHex`) as Record<string, string>;
  for (const [token, hex] of Object.entries(tokens)) assert.ok(styles.includes(`--${token}: ${hex};`), token);
  const result = runInNewContext(`${presentation}; toolColors = { opencode: "#112233" }; [toolColorValue("opencode-go"), toolColorValue("opencode"), toolColorValue("codex"), toolColorValue("openrouter"), defaultToolHex("ollama")]`);
  assert.deepEqual(Array.from(result), ["#112233", "#112233", "var(--mint)", "var(--teal)", "#aeb8b2"]);
});

function colorHarness(fetchImpl: (url: string, init?: { method?: string; body?: string; keepalive?: boolean }) => Promise<{ ok: boolean; json?: () => Promise<unknown> }>) {
  const rows = new Map<string, { input: { value: string }; reset: { hidden: boolean }; undo: { hidden: boolean } }>();
  const toasts: string[] = [];
  const row = (id: string) => { if (!rows.has(id)) rows.set(id, { input: { value: "" }, reset: { hidden: true }, undo: { hidden: true } }); return rows.get(id)!; };
  const context: Record<string, unknown> = {
    fetch: fetchImpl, showToast: (message: string) => toasts.push(message),
    document: {
      querySelectorAll: (selector: string) => selector === "[data-tool-row]" ? [...rows].map(([id, value]) => ({ dataset: { toolRow: id }, querySelector: (target: string) => target.includes("tool-color") ? value.input : target.includes("reset") ? value.reset : value.undo })) : [],
    },
  };
  const api = runInNewContext(`${escape}\n${presentation}\n${colorState}\n({ preview: previewToolColor, set: setToolColor, save: saveToolColors, adopt: adoptServerColors, clean: cleanToolColors, get colors() { return toolColors; }, get saved() { return savedToolColors; }, undo: colorUndo, editStart: colorEditStart })`, context) as {
    preview(id: string, color: string): void; set(id: string, color: string | null): void; save(keepalive?: boolean): Promise<void>; adopt(colors: Record<string, string>): void; clean(raw: unknown): Record<string, string>;
    colors: Record<string, string>; saved: Record<string, string>; undo: Map<string, string | null>; editStart: Map<string, string | null>;
  };
  return { api, row, toasts };
}

test("live color edits keep one undo step per tool and treat the default hex as no override", () => {
  const { api, row } = colorHarness(async () => ({ ok: true }));
  row("codex");
  api.preview("codex", "#111111");
  api.preview("codex", "#222222");
  assert.equal(api.undo.get("codex"), null);
  assert.equal(row("codex").undo.hidden, false);
  assert.equal(row("codex").reset.hidden, false);
  api.editStart.delete("codex");
  api.preview("codex", "#333333");
  assert.equal(api.undo.get("codex"), "#222222");
  api.editStart.delete("codex");
  api.preview("codex", "#a8f2cf");
  assert.equal(api.colors.codex, undefined);
  assert.equal(row("codex").reset.hidden, true);
});

test("color changes save as one batched PUT with nulls for removed overrides and revert with a toast on failure", async () => {
  const requests: Array<{ url: string; method?: string; body: unknown; keepalive?: boolean }> = [];
  let ok = true;
  const { api, row, toasts } = colorHarness(async (url, init) => { requests.push({ url, method: init?.method, body: init?.body && JSON.parse(init.body), keepalive: init?.keepalive }); return { ok }; });
  row("codex"); row("claude");
  api.adopt({ claude: "#abcdef" });
  api.preview("codex", "#111111");
  api.editStart.delete("codex");
  api.set("claude", null);
  await api.save();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/v1/appearance/colors");
  assert.equal(requests[0].method, "PUT");
  assert.deepEqual(requests[0].body, { colors: { codex: "#111111", claude: null } });
  assert.deepEqual({ ...api.saved }, { codex: "#111111" });
  await api.save();
  assert.equal(requests.length, 1, "nothing left to save");

  ok = false;
  api.preview("codex", "#222222");
  api.editStart.delete("codex");
  await api.save();
  assert.equal(api.colors.codex, "#111111");
  assert.equal(row("codex").input.value, "#111111");
  assert.equal(api.undo.get("codex"), "#111111", "undo history is left unchanged by a failed save");
  assert.deepEqual(toasts, ["Colors could not be saved"]);

  ok = true;
  api.preview("codex", "#333333");
  await api.save(true);
  assert.equal(requests.at(-1)!.keepalive, true);
});

test("refetched colors follow the server except for unsaved local edits", () => {
  const { api } = colorHarness(async () => ({ ok: true }));
  api.adopt({ codex: "#111111", claude: "#222222" });
  assert.deepEqual({ ...api.colors }, { codex: "#111111", claude: "#222222" });
  api.set("codex", "#999999");
  api.adopt({ codex: "#444444", claude: "#555555", hermes: "#666666" });
  assert.deepEqual({ ...api.colors }, { codex: "#999999", claude: "#555555", hermes: "#666666" });
  assert.deepEqual({ ...api.clean({ a: "#ABCDEF", b: "red", c: 4 }) }, { a: "#abcdef" });
});

test("settings sections use hash URLs, replaceState for switching, and keep the last section per device", () => {
  const navigation = app.slice(app.indexOf("function settingsHashSection("), app.indexOf("function bindSettingsDialog("));
  const bind = app.slice(app.indexOf("function bindSettingsDialog("), app.indexOf('$("#refresh-button")'));
  const history: string[] = [];
  const storage = new Map<string, string>();
  const location = { hash: "#settings/usage", pathname: "/", search: "" };
  const context = {
    location, localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    history: { replaceState: (_: unknown, __: string, url: string) => { history.push(url); location.hash = url; } },
    document: { querySelectorAll: () => [] }, saveToolColors: () => { history.push("save"); return Promise.resolve(); }, settingsSections: ["appearance", "sources", "usage"], settingsSectionStorageKey: "k",
  };
  const api = runInNewContext(`let activeSettingsSection = null;\n${navigation}\n({ hash: settingsHashSection, stored: storedSettingsSection, show: showSettingsSection })`, context) as { hash(): string | null; stored(): string; show(section: string, update?: boolean): void };
  assert.equal(api.hash(), "usage");
  location.hash = "#settings/bogus";
  assert.equal(api.hash(), null);
  assert.equal(api.stored(), "sources");
  api.show("appearance");
  assert.deepEqual(history, ["#settings/appearance"]);
  assert.equal(api.stored(), "appearance");
  api.show("sources");
  assert.deepEqual(history, ["#settings/appearance", "save", "#settings/sources"]);
  assert.match(bind, /dialog\.addEventListener\("close"/);
  assert.match(bind, /window\.addEventListener\("pagehide", \(\) => void saveToolColors\(true\)\)/);
  assert.match(bind, /history\.back\(\)/);
});
