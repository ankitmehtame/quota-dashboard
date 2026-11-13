import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const statusRenderer = app.slice(app.indexOf("function renderStatus("), app.indexOf("function renderClock("));

test("dashboard summary counts offline warnings separately from errors", () => {
  const elements = new Map<string, { textContent: string; setAttribute(): void }>();
  const render = (hosts: unknown[]) => {
    runInNewContext(`${statusRenderer}\nrenderStatus(data);`, {
      data: { providers: { codex: { id: "codex", enabled: true, status: "ok" } }, quotas: {}, usage: { hosts }, serverNow: "2026-01-02", version: "test" },
      hostHealthy: (host: { status: string }) => host.status === "ok",
      relativeTime: String, formatRefreshTime: String,
      renderHeaderRefresh() {},
      $: (selector: string) => {
        if (!elements.has(selector)) elements.set(selector, { textContent: "", setAttribute() {} });
        return elements.get(selector);
      },
    });
    return elements.get("#status-copy")!.textContent;
  };
  const warning = { status: "offline", severity: "warning" };
  assert.match(render([warning]), /1 usage warning/);
  assert.doesNotMatch(render([warning]), /need attention/);
  assert.match(render([warning, { status: "error", severity: "error" }]), /1 source need attention.*1 usage warning/);
});

test("dashboard summary counts partial OpenRouter failures and valid usage from any key", () => {
  const elements = new Map<string, { textContent: string; setAttribute(): void }>();
  runInNewContext(`${statusRenderer}\nrenderStatus(data);`, {
    data: { providers: { openrouter: { id: "openrouter", enabled: true, status: "partial" } },
      quotas: { openrouter: { windows: [], openrouterKeys: [{ windows: [] }, { windows: [{ usedValue: 0 }] }] } },
      usage: { hosts: [] }, version: "test" },
    hostHealthy: () => true, renderHeaderRefresh() {},
    $: (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, { textContent: "", setAttribute() {} });
      return elements.get(selector);
    },
  });
  assert.match(elements.get("#status-copy")!.textContent, /1 source need attention/);
  assert.match(elements.get("#account-summary")!.textContent, /1 of 1 accounts reporting quota/);
});

test("analytics error is visible even when quotas and hosts are healthy", () => {
  const elements = new Map<string, { textContent: string; setAttribute(): void }>();
  runInNewContext(`${statusRenderer}\nrenderStatus(data);`, {
    data: { providers: { codex: { id: "codex", enabled: true, status: "ok" } }, quotas: {},
      usage: { status: "partial", error: "OpenRouter refresh failed", hosts: [{ status: "ok" }] }, version: "test" },
    hostHealthy: () => true, renderHeaderRefresh() {},
    $: (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, { textContent: "", setAttribute() {} });
      return elements.get(selector);
    },
  });
  assert.match(elements.get("#status-copy")!.textContent, /1 source need attention/);
});
