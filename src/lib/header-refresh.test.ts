import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const formatter = app.slice(app.indexOf("function formatHeaderRefresh("), app.indexOf("function renderHeaderRefresh("));
const renderer = app.slice(app.indexOf("function formatRefreshTime("), app.indexOf("function bindHeaderRefreshTooltip("));
const now = Date.parse("2026-10-09T12:00:00.000Z");
const FixedDate = class extends Date { static now() { return now; } };

function format(iso?: string): string {
  return runInNewContext(`${formatter}\nformatHeaderRefresh(iso);`, { Date: FixedDate, iso });
}

test("header refresh label formats completed time units and invalid timestamps", () => {
  assert.equal(format("2026-10-09T12:00:00.000Z"), "Refreshed just now");
  assert.equal(format("2026-10-09T11:36:00.000Z"), "Refreshed 24m ago");
  assert.equal(format("2026-10-09T10:55:00.000Z"), "Refreshed 1h 5m ago");
  assert.equal(format("2026-10-07T08:00:00.000Z"), "Refreshed 2d 4h ago");
  assert.equal(format("2026-10-09T11:59:00.001Z"), "Refreshed just now");
  assert.equal(format("2026-10-09T11:59:00.000Z"), "Refreshed 1m ago");
  assert.equal(format("2026-10-09T11:00:00.001Z"), "Refreshed 59m ago");
  assert.equal(format("2026-10-09T11:00:00.000Z"), "Refreshed 1h 0m ago");
  assert.equal(format("2026-10-08T12:00:00.001Z"), "Refreshed 23h 59m ago");
  assert.equal(format("2026-10-08T12:00:00.000Z"), "Refreshed 1d 0h ago");
  assert.equal(format("2026-10-09T12:01:00.000Z"), "Refreshed just now");
  assert.equal(format("not-a-date"), "Refreshed —");
  assert.equal(format(undefined), "Refreshed —");
});

test("header renderer prefers cache fetchedAt, falls back to serverNow, and clears invalid tooltip times", () => {
  const label = { textContent: "" };
  const tooltip = { textContent: "" };
  const state: { hour12: boolean; dashboard: { serverNow: string; cache?: { fetchedAt: string } } } = {
    hour12: false,
    dashboard: { serverNow: "2026-10-09T11:36:00.000Z" },
  };
  const render = () => runInNewContext(`${renderer}\nrenderHeaderRefresh();`, {
    Date: FixedDate,
    state,
    $: (selector: string) => selector === "#header-refresh-label" ? label : selector === "#header-refresh-tooltip" ? tooltip : {},
  });

  render();
  assert.equal(label.textContent, "Refreshed 24m ago");
  assert.ok(tooltip.textContent);

  state.dashboard = { serverNow: "2026-10-09T11:36:00.000Z", cache: { fetchedAt: "2026-10-09T10:55:00.000Z" } };
  render();
  assert.equal(label.textContent, "Refreshed 1h 5m ago");

  state.dashboard = { serverNow: "invalid" };
  render();
  assert.equal(label.textContent, "Refreshed —");
  assert.equal(tooltip.textContent, "Refresh time unavailable");
});

test("shared quota and refresh tooltip triggers support hover, focus, touch clicks, and dismissal", () => {
  const binding = app.slice(app.indexOf("function closeActiveQuotaTooltip("), app.indexOf("function bindQuotaTooltips("));
  type TooltipEvent = { pointerType?: string; target?: object; key?: string };
  const triggerEvents = new Map<string, (event: TooltipEvent) => void>();
  const documentEvents = new Map<string, (event: TooltipEvent) => void>();
  const tooltip: { hidden: boolean; parentElement?: unknown } = { hidden: true };
  const body = { appendChild(node: typeof tooltip) { node.parentElement = body; } };
  const trigger = {
    addEventListener(name: string, handler: (event: TooltipEvent) => void) { triggerEvents.set(name, handler); },
    contains(target: object) { return target === this; },
    appendChild(node: typeof tooltip) { node.parentElement = trigger; },
  };
  tooltip.parentElement = trigger;
  runInNewContext(`${binding}\nbindQuotaTooltipTrigger(trigger, tooltip); bindQuotaTooltipDismissal();`, {
    trigger,
    tooltip,
    document: { body, addEventListener(name: string, handler: (event: TooltipEvent) => void) { documentEvents.set(name, handler); } },
    activeQuotaTooltip: null,
    positionQuotaTooltip(anchor: unknown, target: unknown) { assert.equal(anchor, trigger); assert.equal(target, tooltip); },
    clearQuotaTooltip(target: unknown) { assert.equal(target, tooltip); },
  });
  triggerEvents.get("pointerenter")!({ pointerType: "mouse" });
  assert.equal(tooltip.hidden, false);
  triggerEvents.get("pointerleave")!({ pointerType: "mouse" });
  assert.equal(tooltip.hidden, true);
  triggerEvents.get("pointerenter")!({ pointerType: "touch" });
  assert.equal(tooltip.hidden, true);
  triggerEvents.get("click")!({});
  triggerEvents.get("pointerleave")!({ pointerType: "touch" });
  assert.equal(tooltip.hidden, false);
  documentEvents.get("pointerdown")!({ target: trigger });
  assert.equal(tooltip.hidden, false);
  documentEvents.get("pointerdown")!({ target: {} });
  assert.equal(tooltip.hidden, true);
  triggerEvents.get("focus")!({});
  assert.equal(tooltip.hidden, false);
  documentEvents.get("keydown")!({ key: "Escape" });
  assert.equal(tooltip.hidden, true);
  triggerEvents.get("focus")!({});
  triggerEvents.get("blur")!({});
  assert.equal(tooltip.hidden, true);
});
