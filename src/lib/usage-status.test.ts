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
      data: { providers: { codex: { enabled: true, status: "ok" } }, usage: { hosts }, serverNow: "2026-01-02", version: "test" },
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
