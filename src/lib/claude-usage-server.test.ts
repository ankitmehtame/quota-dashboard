import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_IDS, USAGE_SOURCE_IDS } from "./core.js";
import { FilesystemUsageStore } from "./usage-store.js";
import { claudeUsageDocument } from "./fixtures/claude-usage.js";
import type { UsageRecord, UsageSummary } from "./usage.js";

test("built API exposes stored Claude usage across hosts with independent quota and source settings", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-claude-usage-api-"));
  const home = join(root, "home");
  const configPath = join(root, "config.json");
  const dataRoot = join(root, "usage");
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const store = new FilesystemUsageStore({ dataRoot });
  await mkdir(home);
  await writeFile(configPath, JSON.stringify({ providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, { enabled: false }])),
    usageSources: Object.fromEntries(USAGE_SOURCE_IDS.map((id) => [id, { enabled: id === "claude" }])) }));
  for (const hostId of ["fixture-local", "fixture-remote"]) {
    await store.ingest({ schemaVersion: 2, hostId, date: today, timezone: "UTC", category: "hot", runId: "fixture-run",
      generatedAt: now.toISOString(), ccusageVersion: "ccusage 20.0.33", data: claudeUsageDocument(today) });
  }
  // Cover the cold scheduler's only eligible day without invoking a real collector.
  const coldDate = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
  await store.ingest({ schemaVersion: 2, hostId: "fixture-local", date: coldDate, timezone: "UTC", category: "cold", runId: "fixture-cold",
    generatedAt: now.toISOString(), data: { daily: [] } });
  const binary = join(root, "ccusage-fixture.mjs");
  await writeFile(binary, `#!/usr/bin/env node
import { claudeUsageDocument } from ${JSON.stringify(new URL("./fixtures/claude-usage.js", import.meta.url).href)};
const date = process.argv[process.argv.indexOf("--since") + 1];
console.log(JSON.stringify(claudeUsageDocument(date)));
`, { mode: 0o700 });
  const tcp = createServer();
  await new Promise<void>((resolve, reject) => tcp.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = tcp.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => tcp.close(() => resolve()));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
    env: { ...process.env, HOME: home, HOST: "127.0.0.1", PORT: String(port), LOCAL_HOST_ID: "fixture-local",
      CONFIG_PATH: configPath, USAGE_DATA_DIR: dataRoot, USAGE_TIMEZONE: "UTC", QUOTA_LOG_DIR: join(root, "logs"),
      CCUSAGE_BIN: binary, CCUSAGE_DAYS: "3", MQTT_ENABLED: "false", CODEX_AUTH_PATH: join(root, "missing-codex"),
      OPENCODE_AUTH_PATH: join(root, "missing-opencode"), CLAUDE_AUTH_PATH: join(root, "missing-claude"), CLAUDE_OAUTH_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  type ApiResponse = { usage: UsageSummary & { records: UsageRecord[]; providers: string[] }; quotas: Record<string, unknown>;
    providers: Record<string, { enabled: boolean }>; usageSources: Record<string, { enabled: boolean }> };
  const request = async (path: string, method = "GET", body?: unknown): Promise<ApiResponse> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    return response.json() as Promise<ApiResponse>;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 6000);
      const check = () => { if (output.includes("Quota dashboard listening")) { clearTimeout(timer); resolve(); } };
      child.stdout.on("data", check);
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
      check();
    });
    const first = await request("/api/v1/usage?days=1") as { usage: UsageSummary & { records: UsageRecord[]; providers: string[] } };
    assert.deepEqual(first.usage.providers, ["claude"]);
    assert.equal(first.usage.totalCostUsd, 3.5);
    assert.equal(first.usage.totalTokens, 300);
    assert.equal(first.usage.missingPricing, true);
    assert.equal(first.usage.records.length, 8);
    assert.deepEqual([...new Set(first.usage.records.map((record) => record.hostId))].sort(), ["fixture-local", "fixture-remote"]);
    assert.equal(first.usage.byModel.find((model) => model.model === "unpriced-example")?.missingPricing, true);
    assert.deepEqual((await request("/api/v1/quotas")).quotas, {});
    const dashboard = await request("/api/v1/dashboard?days=1");
    assert.equal(dashboard.providers.claude.enabled, false);
    assert.equal(dashboard.usage.totalTokens, 300);
    await request("/api/v1/usage-sources/claude/enabled", "PUT", { enabled: false });
    assert.equal((await request("/api/v1/usage?days=1")).usage.records.length, 0);
    await request("/api/v1/usage-sources/opencode/enabled", "PUT", { enabled: true });
    const other = await request("/api/v1/usage?days=1");
    assert.equal(other.usage.totalCostUsd, 18);
    assert.ok(other.usage.records.every((record: UsageRecord) => record.provider === "opencode"));
    await request("/api/v1/usage-sources/claude/enabled", "PUT", { enabled: true });
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.usageSources.claude.enabled, true);
    assert.equal(saved.providers.claude.enabled, false);
    assert.equal((await request("/api/v1/providers")).usageSources.claude.enabled, true);
    assert.doesNotMatch(output, /modelBreakdowns|unpriced-example|accessToken/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
      await exited;
      clearTimeout(timer);
    }
    await rm(root, { recursive: true, force: true });
  }
});
