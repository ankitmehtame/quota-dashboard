import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderResult } from "./core.js";

test("server loads private OpenRouter .env pairs, shares refreshes across routes, keeps failures independent and omits secrets from APIs and logs", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-openrouter-server-"));
  const home = join(root, "home");
  const configDirectory = join(home, ".config", "quota-dashboard");
  const envPath = join(configDirectory, ".env");
  const preload = join(root, "preload.mjs");
  const callsPath = join(root, "calls");
  const logs = join(root, "logs");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await writeFile(envPath, [
    "OPENROUTER_API_KEY=DOTENV_DEFAULT_SECRET",
    "OPENROUTER_KEY_2_LABEL='Home Assistant #2' # comment", "OPENROUTER_KEY_2=VALID_KEY_SECRET",
    "OPENROUTER_KEY_7_LABEL=Broken automation", "OPENROUTER_KEY_7=INVALID_KEY_SECRET",
    "OPENROUTER_KEY_10_LABEL=Missing key", "OPENROUTER_KEY_11=UNLABELED_KEY_SECRET",
  ].join("\n"), { mode: 0o600 });
  const originalEnv = await readFile(envPath, "utf8");
  const configPath = join(configDirectory, "config.json");
  await writeFile(configPath, JSON.stringify({
    providers: Object.fromEntries(["claude", "codex", "openrouter", "opencode-go", "ollama"].map((id) => [id, { enabled: id === "openrouter" }])),
    usageSources: Object.fromEntries(["codex", "opencode", "hermes", "antigravity"].map((id) => [id, { enabled: false }])),
  }));
  await writeFile(preload, `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, init) => {
  if (String(url) !== "https://openrouter.ai/api/v1/key") throw new Error("Unexpected upstream URL");
  const key = new Headers(init.headers).get("authorization");
  const index = key === "Bearer ENV_DEFAULT_SECRET" ? 0 : key === "Bearer VALID_KEY_SECRET" ? 2 : key === "Bearer INVALID_KEY_SECRET" ? 7 : -1;
  appendFileSync(process.env.TEST_CALLS_PATH, index + "\\n");
  if (index === -1) throw new Error("UNEXPECTED_KEY_SECRET");
  await new Promise(resolve => setTimeout(resolve, 50));
  if (index === 7) return new Response("RAW_ERROR_SECRET INVALID_KEY_SECRET", { status: 401 });
  return Response.json({ data: { label: "sk-or-v1-UPSTREAM_SECRET", usage: 10 + index, usage_daily: 0,
    usage_weekly: 3, usage_monthly: 6, limit: 20, limit_remaining: 14, limit_reset: "monthly", byok_usage: 1 } });
};
`);
  const socket = createServer();
  await new Promise<void>((resolve, reject) => socket.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("OPENROUTER_")) delete env[name];
  const child = spawn(process.execPath, ["--import", preload, fileURLToPath(new URL("../server.js", import.meta.url))], {
    env: { ...env, HOME: home, HOST: "127.0.0.1", PORT: String(port), CONFIG_PATH: configPath,
      OPENROUTER_API_KEY: "ENV_DEFAULT_SECRET", OPENCODE_AUTH_PATH: join(root, "missing-auth.json"),
      USAGE_DATA_DIR: join(root, "usage"), QUOTA_LOG_DIR: logs, MQTT_ENABLED: "false", USAGE_TIMEZONE: "UTC",
      QUOTA_CACHE_TTL_SECONDS: "120", TEST_CALLS_PATH: callsPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  type ApiResponse = { quotas: Record<string, ProviderResult>; providers: Record<string, ProviderResult>; quota: ProviderResult; verified: boolean };
  const responses: ApiResponse[] = [];
  const request = async (path: string, method = "GET", body?: unknown): Promise<ApiResponse> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    const value = await response.json() as ApiResponse;
    responses.push(value);
    return value;
  };
  const calls = async () => (await readFile(callsPath, "utf8")).trim().split("\n").map(Number);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server failed to start: ${output}`)), 8000);
      const check = () => { if (output.includes("Quota dashboard listening")) { clearTimeout(timer); resolve(); } };
      child.stdout.on("data", check);
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
      check();
    });
    assert.equal((await request("/api/v1/providers")).providers.openrouter.configured, true);
    const [dashboard, quotas, tested] = await Promise.all([request("/api/v1/dashboard?refresh=1"),
      request("/api/v1/quotas?refresh=1"), request("/api/v1/providers/openrouter/test", "POST")]);
    assert.deepEqual((await calls()).sort(), [0, 2, 7]);
    assert.equal(tested.verified, false);
    for (const quota of [dashboard.quotas.openrouter, quotas.quotas.openrouter, tested.quota,
      (await request("/api/v1/widget-summary")).providers.openrouter]) {
      assert.equal(quota.status, "partial");
      assert.deepEqual(quota.openrouterKeys?.map((entry) => entry.label), ["Default", "Home Assistant #2", "Broken automation", "Missing key", "Key 11"]);
      assert.deepEqual(quota.openrouterKeys?.map((entry) => entry.status), ["ok", "ok", "error", "error", "error"]);
      assert.equal(quota.openrouterKeys![1].windows[0].usedValue, 12);
      assert.equal(quota.openrouterKeys![1].windows[1].usedValue, 0);
      assert.match(quota.openrouterKeys![2].error!, /HTTP 401/);
      assert.match(quota.openrouterKeys![3].error!, /OPENROUTER_KEY_10 is missing/);
      assert.match(quota.openrouterKeys![4].error!, /OPENROUTER_KEY_11_LABEL is missing/);
    }
    await request("/api/v1/dashboard");
    assert.equal((await calls()).length, 3);
    await request("/api/v1/providers/openrouter/enabled", "PUT", { enabled: false });
    assert.equal((await request("/api/v1/quotas?refresh=1")).quotas.openrouter, undefined);
    assert.equal((await calls()).length, 3);
    await request("/api/v1/providers/openrouter/enabled", "PUT", { enabled: true });
    await request("/api/v1/providers/openrouter/test", "POST");
    assert.equal((await calls()).length, 6);
    const daily = (await Promise.all((await readdir(logs)).map((name) => readFile(join(logs, name), "utf8")))).join("\n");
    assert.doesNotMatch(JSON.stringify([responses, daily, output]), /SECRET|sk-or-v1|authorization|Bearer/i);
    assert.equal(await readFile(envPath, "utf8"), originalEnv);
    assert.equal((await stat(envPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(configPath, "utf8"), /SECRET|OPENROUTER_KEY/);
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
