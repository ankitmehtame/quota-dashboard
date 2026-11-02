import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, normalizeConfig } from "./core.js";

test("normalizeConfig keeps only valid tool color overrides in lowercase", () => {
  assert.deepEqual(normalizeConfig({}).toolColors, {});
  assert.deepEqual(normalizeConfig({ toolColors: "red" }).toolColors, {});
  assert.deepEqual(normalizeConfig({ toolColors: ["#ffffff"] }).toolColors, {});
  const raw = JSON.parse('{"toolColors":{"claude":"#AABBCC","opencode":"#12345","codex":"red","_bad":"#000000","a b":"#000000","new.tool_1":"#000000","ok-tool":"#0A0B0C","num":5,"__proto__":"#000000"}}');
  assert.deepEqual(normalizeConfig(raw).toolColors, { claude: "#aabbcc", "ok-tool": "#0a0b0c", "new.tool_1": "#000000" });
  assert.deepEqual(normalizeConfig({ toolColors: { ["x".repeat(65)]: "#000000", ["x".repeat(64)]: "#000000" } }).toolColors, { ["x".repeat(64)]: "#000000" });
});

test("server persists tool colors with merge, reset, and whole-request validation", { timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-tool-colors-"));
  const home = join(root, "home");
  await mkdir(home);
  const configPath = join(root, "config.json");
  const config = structuredClone(DEFAULT_CONFIG);
  for (const provider of Object.values(config.providers)) provider.enabled = false;
  for (const source of Object.values(config.usageSources)) source.enabled = false;
  await writeFile(configPath, JSON.stringify(config));
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const start = async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
      env: { ...process.env, HOME: home, HOST: "127.0.0.1", PORT: String(port), CONFIG_PATH: configPath,
        USAGE_DATA_DIR: join(root, "usage"), QUOTA_LOG_DIR: join(root, "logs"), MQTT_ENABLED: "false", MQTT_URL: "", MQTT_BROKER_URL: "",
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
  const url = `http://127.0.0.1:${port}/api/v1/appearance/colors`;
  const get = async () => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    return (await response.json() as { colors: Record<string, string> }).colors;
  };
  const put = (colors: unknown) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ colors }) });
  let stop: (() => Promise<void>) | undefined;
  try {
    stop = await start();
    assert.deepEqual(await get(), {});
    const set = await put({ claude: "#AABBCC", opencode: "#112233" });
    assert.equal(set.status, 200);
    assert.deepEqual((await set.json() as { colors: unknown }).colors, { claude: "#aabbcc", opencode: "#112233" });
    const merged = await put({ codex: "#010203", claude: null });
    assert.equal(merged.status, 200);
    assert.deepEqual((await merged.json() as { colors: unknown }).colors, { opencode: "#112233", codex: "#010203" });
    for (const bad of [{ codex: "red" }, { codex: "#fff" }, { codex: 5 }, { "_bad": "#000000" }, { "a/b": "#000000" }, { hermes: "#000000", codex: "nope" }]) {
      const response = await put(bad);
      assert.equal(response.status, 400, JSON.stringify(bad));
      assert.equal(typeof (await response.json() as { error: unknown }).error, "string");
    }
    assert.equal((await put(null)).status, 400);
    assert.equal((await put([])).status, 400);
    assert.deepEqual(await get(), { opencode: "#112233", codex: "#010203" });
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).toolColors, { opencode: "#112233", codex: "#010203" });
    await stop();
    stop = await start();
    assert.deepEqual(await get(), { opencode: "#112233", codex: "#010203" });
  } finally {
    await stop?.();
    await rm(root, { recursive: true, force: true });
  }
});
