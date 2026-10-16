import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderResult } from "./core.js";

test("built server shares Claude fetches across routes, enforces cooldowns, isolates accounts, and refreshes response time", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-claude-server-"));
  const home = join(root, "home");
  const controlPath = join(root, "control.json");
  const callsPath = join(root, "calls");
  const credentialsPath = join(root, "credentials.json");
  const preloadPath = join(root, "preload.mjs");
  const configPath = join(root, "config.json");
  const logs = join(root, "logs");
  let time = Date.now();
  const control = async (status = 200, retryAfter?: string) => {
    // Date.now in the child reads this during response completion as well as fetches.
    // Replace a complete file so it never sees a truncated or partially written JSON document.
    const temporary = `${controlPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ now: time, status, retryAfter }));
    await rename(temporary, controlPath);
  };
  await mkdir(home);
  await control();
  await writeFile(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: "FAKE_ACCOUNT_A_TOKEN", scopes: ["user:profile"] } }));
  await writeFile(configPath, JSON.stringify({
    providers: Object.fromEntries(["claude", "codex", "openrouter", "opencode-go", "ollama"].map((id) => [id, { enabled: id === "claude" }])),
    usageSources: Object.fromEntries(["codex", "opencode", "hermes", "antigravity"].map((id) => [id, { enabled: false }])),
  }));
  // This process cannot contact any upstream. All Claude responses use fake data.
  await writeFile(preloadPath, `
import { appendFileSync, readFileSync } from "node:fs";
const control = () => JSON.parse(readFileSync(process.env.TEST_CONTROL_PATH, "utf8"));
Date.now = () => control().now;
globalThis.fetch = async (url, init) => {
  if (String(url) !== "https://api.anthropic.com/api/oauth/usage") throw new Error("Unexpected upstream request");
  appendFileSync(process.env.TEST_CALLS_PATH, "request\\n");
  const { status, retryAfter } = control();
  const token = new Headers(init.headers).get("authorization");
  await new Promise(resolve => setTimeout(resolve, 60));
  return new Response(JSON.stringify(status === 200 ? { five_hour: { utilization: token.includes("ACCOUNT_B") ? 75 : 12.5, resets_at: "2026-10-17T18:00:00Z" } } : { secret: "RAW_RESPONSE_SECRET" }),
    { status, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } });
};
`);
  const socket = createServer();
  await new Promise<void>((resolve, reject) => socket.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", preloadPath, fileURLToPath(new URL("../server.js", import.meta.url))], {
    env: { ...process.env, HOME: home, HOST: "127.0.0.1", PORT: String(port), CONFIG_PATH: configPath,
      CLAUDE_OAUTH_TOKEN: "", CLAUDE_AUTH_PATH: credentialsPath, CLAUDE_USER_AGENT: "claude-code/test",
      CODEX_AUTH_PATH: join(root, "missing-codex.json"), OPENCODE_AUTH_PATH: join(root, "missing-opencode.json"),
      USAGE_DATA_DIR: join(root, "usage"), QUOTA_LOG_DIR: logs, MQTT_ENABLED: "false", USAGE_TIMEZONE: "UTC",
      TEST_CONTROL_PATH: controlPath, TEST_CALLS_PATH: callsPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const calls = async () => { try { return (await readFile(callsPath, "utf8")).trim().split("\n").length; } catch { return 0; } };
  type ApiResponse = { serverNow: string; cache: { fetchedAt: string; expiresAt: string }; quotas: Record<string, ProviderResult>; quota: ProviderResult; verified: boolean };
  const request = async (path: string, method = "GET", body?: unknown): Promise<ApiResponse> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    return response.json() as Promise<ApiResponse>;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server failed to start: ${output}`)), 8000);
      const check = () => { if (output.includes("Quota dashboard listening")) { clearTimeout(timer); resolve(); } };
      child.stdout.on("data", check);
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
      check();
    });
    const [first, direct, tested] = await Promise.all([
      request("/api/v1/dashboard?refresh=1"), request("/api/v1/quotas?refresh=1"), request("/api/v1/providers/claude/test", "POST"),
    ]);
    assert.equal(await calls(), 1);
    assert.equal(first.quotas.claude.windows[0].usedPercent, 12.5);
    assert.equal(direct.quotas.claude.windows[0].usedPercent, 12.5);
    assert.equal(tested.verified, true);
    assert.equal(Date.parse(first.cache.expiresAt), time + 300_000);
    const cached = await request("/api/v1/dashboard");
    assert.notEqual(cached.serverNow, first.serverNow);
    assert.equal(cached.cache.fetchedAt, first.cache.fetchedAt);
    assert.equal(cached.quotas.claude.fetchedAt, first.quotas.claude.fetchedAt);
    assert.equal(await calls(), 1);

    // A forced attempt fails and must invalidate already-built dashboard snapshots.
    await control(429, "600");
    const failed = await request("/api/v1/providers/claude/test", "POST");
    assert.equal(failed.verified, false);
    assert.equal(failed.quota.stale, true);
    assert.equal(failed.quota.fetchedAt, first.quotas.claude.fetchedAt);
    assert.equal(failed.quota.cooldownUntil, time + 600_000);
    const routes = await Promise.all([request("/api/v1/dashboard?refresh=1"), request("/api/v1/quotas?refresh=1"),
      request("/api/v1/widget-summary"), request("/api/v1/providers/claude/test", "POST")]);
    assert.equal(await calls(), 2);
    assert.equal(routes[0].quotas.claude.stale, true);
    assert.equal(routes[3].verified, false);

    // Expiry permits a live request immediately, not another full error TTL later.
    time += 600_000;
    await control(401, "60");
    const rejected = await request("/api/v1/quotas");
    assert.deepEqual(rejected.quotas.claude.windows, []);
    assert.equal(rejected.quotas.claude.errorKind, "authentication");
    assert.equal(await calls(), 3);
    assert.deepEqual((await request("/api/v1/dashboard")).quotas.claude.windows, []);
    time += 60_000;
    await control(503);
    assert.deepEqual((await request("/api/v1/quotas")).quotas.claude.windows, []);
    assert.equal(await calls(), 4);

    await writeFile(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: "FAKE_ACCOUNT_B_TOKEN" } }));
    await control();
    const changed = await request("/api/v1/providers/claude/test", "POST");
    assert.equal(changed.quota.windows[0].usedPercent, 75);
    assert.equal(changed.verified, true);
    assert.equal((await request("/api/v1/dashboard")).quotas.claude.windows[0].usedPercent, 75);
    await control(503);
    const staleB = await request("/api/v1/providers/claude/test", "POST");
    assert.equal(staleB.quota.windows[0].usedPercent, 75);
    await writeFile(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: "FAKE_ACCOUNT_C_TOKEN" } }));
    // A settings-only credential check must also invalidate an old account snapshot.
    await request("/api/v1/providers");
    assert.deepEqual((await request("/api/v1/dashboard")).quotas.claude.windows, []);
    const failedC = await request("/api/v1/providers/claude/test", "POST");
    assert.deepEqual(failedC.quota.windows, []);
    assert.deepEqual((await request("/api/v1/dashboard")).quotas.claude.windows, []);
    // Keep HTTP completion hooks reading the controls while the parent updates them.
    // These requests do not fetch quotas or depend on which complete snapshot they see.
    for (let iteration = 0; iteration < 50; iteration++) {
      time += 1;
      await Promise.all([request("/api/v1/providers"), control(503)]);
    }
    await request("/api/v1/providers");
    assert.equal(child.exitCode, null, output);
    const daily = (await Promise.all((await readdir(logs)).map((name) => readFile(join(logs, name), "utf8")))).join("\n");
    assert.doesNotMatch(JSON.stringify([first, changed, failedC, daily, output]), /FAKE_ACCOUNT|RAW_RESPONSE_SECRET|credentials\.json|identity|authorization|[a-f0-9]{64}/i);
    assert.equal((await readFile(credentialsPath, "utf8")), JSON.stringify({ claudeAiOauth: { accessToken: "FAKE_ACCOUNT_C_TOKEN" } }));
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
