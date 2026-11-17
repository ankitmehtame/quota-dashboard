import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, normalizeConfig } from "./core.js";

const sourceId = (label: string) => `openrouter-${createHash("sha256").update(label).digest("hex").slice(0, 24)}`;

test("label icon config accepts only opaque label IDs and safe slugs", () => {
  const id = sourceId("Home");
  assert.deepEqual(normalizeConfig({ labelIcons: { [id]: "home-assistant", codex: "openai", [sourceId("bad")]: "../bad" } }).labelIcons, { [id]: "home-assistant" });
  for (const input of [null, [], "icon"]) assert.deepEqual(normalizeConfig({ labelIcons: input }).labelIcons, {});
});

test("server shares icons by exact configured label, persists edits without fetching, and prunes only confirmed removals", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-label-icons-"));
  const home = join(root, "home");
  await mkdir(home);
  const configPath = join(root, "config.json");
  await mkdir(join(root, "icons"));
  await writeFile(join(root, "icons", "selfhst-cached.json"), JSON.stringify({ source: "https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/cached.svg", svg: '<svg xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M0 0h1v1z"/></svg>' }));
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
  const url = `http://127.0.0.1:${port}`;
  const start = async (extra: NodeJS.ProcessEnv = {}) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
      env: { ...process.env, HOME: home, HOST: "127.0.0.1", PORT: String(port), CONFIG_PATH: configPath,
        USAGE_DATA_DIR: join(root, "usage"), QUOTA_LOG_DIR: join(root, "logs"), MQTT_ENABLED: "false", MQTT_URL: "", MQTT_BROKER_URL: "",
        USAGE_TIMEZONE: "UTC", LOCAL_HOST_ID: "local-test", CCUSAGE_BIN: join(root, "missing-ccusage"), OPENCODE_AUTH_PATH: join(root, "missing-auth"),
        OPENROUTER_API_KEY: "", OPENROUTER_MANAGEMENT_API_KEY: "", OPENROUTER_USAGE_KEYS: "", OPENROUTER_INACTIVE_KEYS: "",
        OPENROUTER_KEY_1: "ONE_SECRET", OPENROUTER_KEY_1_LABEL: " Home ", OPENROUTER_KEY_2: "TWO_SECRET", OPENROUTER_KEY_2_LABEL: "Home", ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
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
        child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.includes("Quota dashboard listening")) { clearTimeout(timer); resolve(); } });
        child.once("exit", () => { clearTimeout(timer); reject(new Error(`Server exited: ${output}`)); });
      });
    } catch (error) { await stop(); throw error; }
    return stop;
  };
  const get = async () => { const response = await fetch(`${url}/api/v1/appearance/icons`); assert.equal(response.status, 200); return response.json() as Promise<{ icons: Record<string, string>; labels: Record<string, string> }>; };
  const put = (icons: unknown) => fetch(`${url}/api/v1/appearance/icons`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ icons }) });
  const id = sourceId("Home");
  let stop: (() => Promise<void>) | undefined;
  try {
    stop = await start();
    const cached = await fetch(`${url}/icons/selfhst-cached.svg`);
    assert.equal(cached.status, 200);
    assert.equal(cached.headers.get("Content-Type"), "image/svg+xml");
    assert.equal(cached.headers.get("X-Content-Type-Options"), "nosniff");
    assert.match(await cached.text(), /fill="#f0f5f1"/);
    assert.equal((await fetch(`${url}/icons/selfhst-cached.svg`, { headers: { "If-None-Match": cached.headers.get("ETag")! } })).status, 304);
    assert.equal(await (await fetch(`${url}/icons/selfhst-cached.svg`, { method: "HEAD" })).text(), "");
    assert.deepEqual((await get()).labels, { [id]: "Home" }, "keys with equal trimmed labels share one assignment");
    assert.equal((await put({ [id]: "not-in-catalog" })).status, 200, "saving a slug never requires a fetch");
    assert.deepEqual((await get()).icons, { [id]: "not-in-catalog" });
    assert.equal((await fetch(`${url}/icons/selfhst-not-in-catalog.svg`)).status, 404);
    for (const icons of [null, [], { codex: "openai" }, { [id]: "../bad" }, { [id]: "https://evil.test" }, { [sourceId("unknown")]: "home-assistant" }]) assert.equal((await put(icons)).status, 400);
    assert.equal((await fetch(`${url}/api/v1/appearance/icons/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: "../bad" }) })).status, 400);
    assert.equal((await fetch(`${url}/api/v1/appearance/icons/preview`, { method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "application/json" }, body: JSON.stringify({ slug: "home-assistant" }) })).status, 403);
    assert.equal((await put({ [id]: null })).status, 200);
    assert.deepEqual((await get()).icons, {});
    await put({ [id]: "home-assistant" });
    const concurrent = await Promise.all([
      put({ [id]: "home-assistant" }),
      fetch(`${url}/api/v1/appearance/colors`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ colors: { codex: "#123456" } }) }),
    ]);
    assert.ok(concurrent.every((response) => response.ok));
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved.labelIcons, { [id]: "home-assistant" });
    assert.equal(saved.toolColors.codex, "#123456", "simultaneous icon and color commits preserve both patches");
    await stop();
    stop = await start({ OPENROUTER_KEY_1: "REPLACEMENT_SECRET" });
    assert.deepEqual((await get()).icons, { [id]: "home-assistant" }, "key changes do not change label assignments");
    await stop();
    stop = await start({ OPENROUTER_KEY_1_LABEL: "Renamed", OPENROUTER_KEY_2_LABEL: "Renamed", OPENROUTER_USAGE_KEYS: "99" });
    assert.deepEqual((await get()).icons, { [id]: "home-assistant" }, "invalid configuration preserves old assignments");
    await stop();
    stop = await start({ OPENROUTER_KEY_1_LABEL: "Renamed", OPENROUTER_KEY_2_LABEL: "Renamed" });
    assert.deepEqual((await get()).icons, {}, "rename is a new label, with no inherited icon");
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).labelIcons, {}, "confirmed removals are persisted");
  } finally { await stop?.(); await rm(root, { recursive: true, force: true }); }
});
