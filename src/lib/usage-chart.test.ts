import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Exercise the compiled renderer without running the dashboard's startup requests.
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const renderer = app.slice(app.indexOf("function renderUsage("), app.indexOf("function openUsageDetails("));

function renderChart(days: Array<{ date: string; costs: number[]; tokens?: number[] }>, representation = "day"): string {
  const buckets = days.map(({ date, costs, tokens }) => ({
    date, from: date, to: date, days: [],
    costUsd: costs.reduce((total, cost) => total + cost, 0),
    totalTokens: (tokens || []).reduce((total, count) => total + count, 0),
    byProvider: Object.fromEntries(costs.map((costUsd, index) => [["codex", "opencode", "hermes", "antigravity"][index], { costUsd, totalTokens: tokens?.[index] || 0 }])),
  }));
  const chart = { innerHTML: "", querySelectorAll: () => [] };
  const elements = new Map<string, { innerHTML?: string; textContent?: string }>();
  const usage = { from: days[0].date, to: days.at(-1)!.date, daily: buckets, providers: ["codex", "opencode", "hermes", "antigravity"] };
  runInNewContext(`${renderer}\nrenderUsage(usage);`, {
    usage, state: { chartScrollLeft: 0, hostSelections: new Map() },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    $: (selector: string) => {
      if (selector === "#usage-chart") return chart;
      if (!elements.has(selector)) elements.set(selector, {});
      return elements.get(selector);
    },
    closeHostStatusPopover() {}, renderSpendMetrics() {}, renderTopModels() {}, updateRepresentationControls() {}, bindChartTooltips() {},
    reconcileHostSelections: () => ({ hosts: [], usableHosts: [], selectedHostIds: new Set() }),
    filterUsageByHosts: () => usage,
    activeRepresentation: () => representation,
    usageBuckets: () => buckets,
    usageBucketLabel: (bucket: { date: string }) => bucket.date,
    usageSourceNames: {}, escapeHtml: String, money: (value: number) => `$${value.toFixed(2)}`, formatTokens: String,
    activeChartTooltip: null,
  });
  return chart.innerHTML;
}

function stackGeometry(html: string): Array<{ height: number; segments: Array<{ height: number }> }> {
  return [...html.matchAll(/<div class="chart-stack" style="([^"]*)">(.*?)<\/button>/g)].map((match) => ({
    height: Number(match[1].match(/height:([\d.]+)%/)?.[1] ?? 100),
    segments: [...match[2].matchAll(/style="flex:([\d.]+) 1 0%"/g)].map((segment) => ({ height: Number(segment[1]) })),
  }));
}

for (const representation of ["day", "week", "month"]) {
  test(`${representation} bars scale by spend even with tiny and token-only sources`, () => {
    const html = renderChart([
      { date: "2026-10-04", costs: [36.15, 0.01, 0], tokens: [100, 1, 10] },
      { date: "2026-10-05", costs: [36.72, 0, 0] },
    ], representation);
    assert.match(html, /\$36\.16/);
    assert.match(html, /\$36\.72/);
    const stacks = stackGeometry(html);
    assert.equal(stacks.length, 2);
    assert.ok(Math.abs(stacks[0].height - 36.16 / 36.72 * 100) < 1e-10);
    assert.equal(stacks[1].height, 100);
    assert.ok(stacks[0].height < stacks[1].height);
    for (const stack of stacks) {
      let offset = 0;
      for (const segment of stack.segments) {
        assert.ok(segment.height > 0);
        offset += segment.height;
      }
      assert.ok(Math.abs(offset - 100) < 1e-10);
    }
  });
}

test("equal spend has equal stack height despite different provider mixes", () => {
  const stacks = stackGeometry(renderChart([
    { date: "2026-10-04", costs: [10, 0, 0], tokens: [1, 1, 1] },
    { date: "2026-10-05", costs: [5, 5, 0] },
  ]));
  const visibleHeight = (stack: typeof stacks[number]) => stack.height * stack.segments.reduce((total, segment) => total + segment.height, 0) / 100;
  assert.ok(Math.abs(visibleHeight(stacks[0]) - visibleHeight(stacks[1])) < 1e-10);
});

test("Hermes and Antigravity share a continuous flex stack with OpenCode", () => {
  const html = renderChart([
    { date: "2026-09-24", costs: [0, 0.01, 7.13, 11.27] },
    { date: "2026-09-25", costs: [25, 0, 0, 0] },
  ]);
  const stack = stackGeometry(html)[0];
  assert.equal(stack.segments.length, 3);
  assert.ok(Math.abs(stack.segments.reduce((total, segment) => total + segment.height, 0) - 100) < 1e-10);
  assert.match(html, /chart-segment orange/);
  assert.match(html, /chart-segment blue/);
  assert.doesNotMatch(html, /bottom:/);

  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.chart-stack \{ position: relative; display: flex; flex-direction: column-reverse; justify-content: flex-start; gap: 0; \}/);
  assert.doesNotMatch(styles, /\.chart-segment \{[^}]*position: absolute/);
  assert.match(styles, /\.chart-segment:first-child \{ border-radius: 0; \}/);
  assert.match(styles, /\.chart-segment:last-child \{ border-radius: 2px 2px 0 0; \}/);
});

test("empty and token-only buckets stay finite and within their stacks", () => {
  const html = renderChart([
    { date: "2026-10-03", costs: [0, 0, 0] },
    { date: "2026-10-04", costs: [0, 0, 0], tokens: [1, 1, 1] },
    { date: "2026-10-05", costs: [0, 0, 0], tokens: [1, 0, 0] },
  ]);
  assert.doesNotMatch(html, /NaN|Infinity/);
  const stacks = stackGeometry(html);
  assert.deepEqual(stacks.map((stack) => stack.height), [0, 2, 2]);
  for (const stack of stacks.slice(1)) {
    assert.ok(Math.abs(stack.segments.reduce((total, segment) => total + segment.height, 0) - 100) < 1e-10);
  }
});

test("today-only view retains separate provider bars", () => {
  const html = renderChart([{ date: "2026-10-05", costs: [20, 10, 0] }]);
  assert.equal([...html.matchAll(/class="chart-column today-harness"/g)].length, 2);
  assert.match(html, /height:66\.666/);
  assert.match(html, /height:33\.333/);
});

test("today-only bars align to the bottom of reversed flex stacks", () => {
  const html = renderChart([{ date: "2026-10-05", costs: [0, 5.4, 0.06, 24.6] }]);
  assert.equal([...html.matchAll(/class="chart-column today-harness"/g)].length, 3);
  assert.match(html, /height:2%;bottom:0/);
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  // Logical `start` means top, whereas `flex-start` follows column-reverse to the baseline.
  const stackRules = [...styles.matchAll(/\.chart-stack \{([^}]+)\}/g)].map((match) => match[1]).join(";");
  const alignment = [...stackRules.matchAll(/justify-content:\s*([^;]+)/g)].at(-1)?.[1];
  assert.equal(alignment, "flex-start");
});
