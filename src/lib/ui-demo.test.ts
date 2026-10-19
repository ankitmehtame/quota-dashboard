import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("isolated UI demo serves the application, sample ranges, and in-memory settings", { timeout: 15_000 }, async (t) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../../scripts/demo.mjs", import.meta.url))], {
    env: { ...process.env, DEMO_PORT: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
  });
  const [message] = await once(child.stdout!, "data");
  const origin = String(message).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(origin, `Missing demo URL: ${message}`);
  const html = await (await fetch(origin)).text();
  assert.match(html, /Sample data\./);
  assert.match(html, /id="usage-range"/);
  const app = await (await fetch(`${origin}/app.js`)).text();
  assert.match(app, /days: 30, range: "relative-30"/);
  const data = await (await fetch(`${origin}/api/v1/dashboard?days=30&range=relative`)).json() as { version: string; quotas: { codex: { resetCredits: Array<{ title: string; expiresAt: string }> } }; usage: { records: unknown[]; hosts: Array<{ severity?: string }> } };
  assert.equal(data.version, "demo");
  assert.equal(data.usage.records.length, 180);
  assert.equal(data.usage.hosts[1].severity, "warning");
  assert.equal(data.quotas.codex.resetCredits[0].title, "Full reset");
  assert.ok(Date.parse(data.quotas.codex.resetCredits[0].expiresAt) > Date.now());
  const today = await (await fetch(`${origin}/api/v1/usage?days=1&range=relative`)).json() as { usage: { from: string; to: string } };
  assert.equal(today.usage.from, today.usage.to);
  const changed = await fetch(`${origin}/api/v1/providers/claude/enabled`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
  assert.equal(changed.status, 200);
  const settings = await (await fetch(`${origin}/api/v1/providers`)).json() as { providers: Record<string, { enabled: boolean }> };
  assert.equal(settings.providers.claude.enabled, false);
  assert.equal((await fetch(`${origin}/api/v1/usage/cold`, { method: "POST" })).status, 409);
  assert.equal((await fetch(`${origin}/api/v1/not-an-endpoint`)).status, 404);
});
