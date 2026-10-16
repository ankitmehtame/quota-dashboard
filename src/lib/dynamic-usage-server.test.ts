import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "./core.js";
import { FilesystemUsageStore } from "./usage-store.js";
import { filterUsageRecords, type UsageRecord } from "./usage.js";

test("shared records follow any enabled tool, including dynamic tools", () => {
  const records = ["new-tool", "shared", "codex"].map((provider) => ({ provider }) as UsageRecord);
  assert.deepEqual(filterUsageRecords(["new-tool"], records).map((record) => record.provider), ["new-tool", "shared"]);
  assert.deepEqual(filterUsageRecords(["codex"], records).map((record) => record.provider), ["shared", "codex"]);
  assert.deepEqual(filterUsageRecords([], records), []);
});

test("server discovers tools across dates and hosts and persists dynamic toggles through restart", { timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-dynamic-server-"));
  const home = join(root, "home");
  await mkdir(home);
  const configPath = join(root, "config.json");
  const config = structuredClone(DEFAULT_CONFIG);
  for (const provider of Object.values(config.providers)) provider.enabled = false;
  for (const source of Object.values(config.usageSources)) source.enabled = false;
  await writeFile(configPath, JSON.stringify(config));
  const store = new FilesystemUsageStore({ dataRoot: join(root, "usage") });
  const today = new Date().toISOString().slice(0, 10);
  const ingest = async (hostId: string, date: string, agent: string, shared = false) => store.ingest({
    schemaVersion: 1, hostId, date, timezone: "UTC", category: "hot", runId: "fixture", generatedAt: new Date().toISOString(),
    data: { daily: [{ date, agent, ...(shared ? { metadata: { agents: ["new-tool", "other-agent"] } } : {}), modelBreakdowns: [{ modelName: "example", inputTokens: 1, cost: 2 }] }] },
  });
  await ingest("local-test", today, "New Tool");
  await ingest("remote-test", "2020-01-02", "historic-agent");
  await ingest("mixed-test", today, "all", true);
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const start = async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
      env: { ...process.env, HOME: home, HOST: "127.0.0.1", PORT: String(port), CONFIG_PATH: configPath,
        USAGE_DATA_DIR: store.dataRoot, QUOTA_LOG_DIR: join(root, "logs"), MQTT_ENABLED: "false", MQTT_URL: "", MQTT_BROKER_URL: "",
        USAGE_TIMEZONE: "UTC", LOCAL_HOST_ID: "local-test", CCUSAGE_BIN: join(root, "missing-ccusage") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const stop = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
      await exited;
      clearTimeout(timer);
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Startup timeout: ${output}`)), 8000);
        const check = () => { if (output.includes("Quota dashboard listening")) { clearTimeout(timer); resolve(); } };
        child.stdout.on("data", check);
        child.once("exit", () => { clearTimeout(timer); reject(new Error(`Server exited: ${output}`)); });
        check();
      });
    } catch (error) { await stop(); throw error; }
    return stop;
  };
  const request = (path: string, enabled?: unknown) => fetch(`http://127.0.0.1:${port}/api/v1/${path}`, enabled === undefined ? {} : {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }),
  });
  const get = async (path: string) => {
    const response = await request(path);
    assert.equal(response.status, 200);
    return response.json() as Promise<{ usageSources: Record<string, { enabled: boolean }>; usage: { status: string; records: UsageRecord[] } }>;
  };
  let stop: (() => Promise<void>) | undefined;
  try {
    stop = await start();
    const sources = (await get("providers")).usageSources;
    assert.deepEqual(sources["new-tool"], { enabled: true });
    assert.deepEqual(sources["historic-agent"], { enabled: true });
    assert.equal(Object.hasOwn(sources, "shared"), false);
    const usage = (await get("usage?days=1")).usage;
    assert.deepEqual(usage.records.map((record: UsageRecord) => record.provider).sort(), ["new-tool", "shared"]);
    await ingest("new-host", "2020-01-03", "late-agent");
    // External filesystem writes are picked up on cache expiry, not on every request.
    assert.equal((await get("providers")).usageSources["late-agent"], undefined);
    for (const id of ["new-tool", "historic-agent", "late-agent"]) {
      assert.equal((await request(`usage-sources/${id}/enabled`, false)).status, 200);
    }
    assert.equal((await request("usage-sources/future_agent.v2/enabled", false)).status, 200);
    assert.equal((await get("usage?days=1")).usage.status, "disabled");
    for (const id of ["raw", "raw.archive", "__proto__", "constructor", "shared", "Bad%20Tool", "a%2Fb", "%ZZ"]) {
      assert.equal((await request(`usage-sources/${id}/enabled`, true)).status, 400, id);
    }
    assert.equal((await request("usage-sources/new-tool/enabled", "yes")).status, 400);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).usageSources["new-tool"], { enabled: false });
    await stop();
    stop = await start();
    assert.deepEqual((await get("providers")).usageSources["new-tool"], { enabled: false });
    assert.deepEqual((await get("providers")).usageSources["future_agent.v2"], { enabled: false });
    assert.equal((await request("usage-sources/new-tool/enabled", true)).status, 200);
    assert.deepEqual((await get("usage?days=1")).usage.records.map((record) => record.provider).sort(), ["new-tool", "shared"]);
  } finally {
    await stop?.();
    await rm(root, { recursive: true, force: true });
  }
});
