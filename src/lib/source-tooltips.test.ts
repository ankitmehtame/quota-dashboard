import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const helpers = app.slice(app.indexOf("function recordTokens("), app.indexOf("function emptyUsageDay("));
const tooltip = app.slice(app.indexOf("function sourceUsageTooltip("), app.indexOf("function bindSourceTooltips("));
const presentation = app.slice(app.indexOf("const usageSourceNames ="), app.indexOf("const HOT_USAGE_POLL_INTERVAL_MS"));
const record = (date: string, provider: string, hostId: string, costUsd: number, inputTokens: number, missingPricing = false) => ({ date, provider, hostId, costUsd, inputTokens, cachedInputTokens: 10, cacheCreationTokens: 20, outputTokens: 30, reasoningTokens: 40, missingPricing });

function render(overrides = {}, selected = ["one"], provider = "codex", range = "relative-7") {
  return runInNewContext(`${helpers}\n${presentation}\n${tooltip}\nsourceUsageTooltip(usage, provider, selected);`, {
    state: { range, sourceSelections: new Map([["codex", false]]) },
    usage: { providers: ["codex", "opencode"], to: "2026-10-19", hosts: [{ hostId: "one", status: "ok" }], records: [record("2026-10-18", "codex", "one", 4, 100000), record("2026-10-19", "codex", "one", 1.37, 77010), record("2026-10-19", "codex", "two", 100, 100), record("2026-10-19", "opencode", "one", 100, 100)], ...overrides },
    provider, selected: new Set(selected), escapeHtml: (value: string) => value.replace(/</g, "&lt;"), usagePresetLabel: () => "Last 7 days",
    spend: (value: number, missing: boolean) => `$${value.toFixed(2)}${missing ? "+" : ""}`,
  });
}

test("agent tooltip totals respect machines but ignore the agent toggle, with exact tokens", () => {
  const html = render();
  assert.match(html, /data-icon="openai"/);
  assert.match(html, /<strong>Codex<\/strong>/);
  assert.match(html, /Last 7 days/);
  assert.match(html, /\$5\.37 · 177,210 tokens/);
  assert.match(html, /Today so far/);
  assert.match(html, /\$1\.37 · 77,110 tokens/);
  assert.doesNotMatch(html, /\$100/);
});

test("Today selection shows only the Today so far row", () => {
  const html = render({}, ["one"], "codex", "today");
  assert.equal((html.match(/class="agent-tooltip-row"/g) || []).length, 1);
  assert.match(html, /Today so far/);
  assert.doesNotMatch(html, /Last 7 days|177,210 tokens/);
});

test("zero-usage underlines follow the range and machines, not the toggle state", () => {
  const check = (records: unknown[] | undefined, hosts = [{ hostId: "one", status: "ok" }], selected = ["one"]) => runInNewContext(`${helpers}\n${tooltip}\nsourceUsageIsZero(usage, 'codex', selected);`, {
    usage: { providers: ["codex"], hosts, records }, selected: new Set(selected),
  });
  assert.equal(check([]), true);
  assert.equal(check([record("2026-10-19", "codex", "two", 2, 100)]), true);
  assert.equal(check([record("2026-10-18", "codex", "one", 2, 100)]), false);
  assert.equal(check([record("2026-10-19", "codex", "one", 0, 100)]), false);
  assert.equal(check([record("2026-10-19", "codex", "one", 0, 0, true)]), false);
  assert.equal(check(undefined), false);
  assert.equal(check([], [{ hostId: "one", status: "offline" }]), false);
  assert.equal(check([], [], []), true);
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\[aria-pressed="true"\]\[data-zero-usage="true"\]::after\s*\{\s*opacity: \.3;/);
});

test("tooltips distinguish healthy zero, deselection, unavailable records, and incomplete pricing", () => {
  assert.match(render({ records: [] }), /\$0\.00 · 0 tokens/);
  assert.match(render({}, []), /\$0\.00 · 0 tokens/);
  assert.match(render({ records: undefined }), /Usage unavailable/);
  const html = render({ hosts: [{ hostId: "one", status: "offline" }], records: [record("2026-10-19", "codex", "one", 2, 100, true)] });
  assert.match(html, /\$2\.00\+ · 200 tokens/);
  assert.match(html, /incomplete usage/);
  assert.match(html, /Pricing unavailable/);
  assert.match(render({}, ["one"], "<custom>"), /&lt;custom>/);
});
