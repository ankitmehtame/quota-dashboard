import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("server serves SVGs with revalidation, refreshes only allowlisted upstreams, and rejects cross-site triggers", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-icons-server-"));
  const home = join(root, "home");
  await mkdir(home);
  const preload = join(root, "preload.mjs");
  const config = join(root, "config.json");
  const callsPath = join(root, "calls");
  await writeFile(config, JSON.stringify({ providers: Object.fromEntries(["claude", "codex", "openrouter", "opencode-go", "ollama"].map((id) => [id, { enabled: false }])), usageSources: {} }));
  await writeFile(preload, `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/') && !String(url).startsWith('https://thesvg.org/icons/')) throw new Error('Unexpected upstream');
  if (init.redirect !== 'error') throw new Error('Unsafe redirect policy');
  appendFileSync(${JSON.stringify(callsPath)}, String(url) + '\\n');
  return new Response('<svg xmlns="http://www.w3.org/2000/svg"><path fill="#123456" d="M0 0h10v10H0z"/></svg>', { headers: { 'content-type': 'image/svg+xml' } });
};
`);
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", preload, fileURLToPath(new URL("../server.js", import.meta.url))], {
    env: { ...process.env, HOME: home, HOST: "127.0.0.1", PORT: String(port), CONFIG_PATH: config, USAGE_DATA_DIR: join(root, "usage"), QUOTA_LOG_DIR: join(root, "logs"), MQTT_ENABLED: "false", CCUSAGE_BIN: join(root, "missing-ccusage") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const request = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(output)), 8000);
      const check = () => { if (output.includes("Quota dashboard listening")) { clearTimeout(timer); resolve(); } };
      child.stdout.on("data", check);
      child.once("exit", () => { clearTimeout(timer); reject(new Error(output)); });
      check();
    });
    const first = await request("/icons/openai.svg");
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "image/svg+xml");
    assert.equal(first.headers.get("cache-control"), "no-cache");
    assert.equal(first.headers.get("x-content-type-options"), "nosniff");
    assert.match(first.headers.get("content-security-policy")!, /sandbox/);
    const original = await first.text();
    const etag = first.headers.get("etag")!;
    assert.equal((await request("/icons/openai.svg", { headers: { "if-none-match": etag } })).status, 304);
    assert.equal((await request("/icons/not-known.svg")).status, 404);
    assert.equal((await request("/icons/openai.svg", { method: "POST" })).status, 405);
    const crossSite = await request("/api/v1/icons/refresh", { method: "POST", headers: { origin: "https://evil.test" } });
    assert.equal(crossSite.status, 403);
    assert.equal((await request("/api/v1/icons/refresh", { method: "POST", headers: { origin: "null" } })).status, 403);
    const snapshot = await (await request("/api/v1/icons/refresh", { method: "POST" })).json() as { icons: Record<string, string> };
    assert.equal(snapshot.icons.openai, etag.replaceAll('"', ""));
    // Await completion through observed HTTP responses, with a bounded integration-test retry.
    let updated = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      updated = await (await request("/icons/openai.svg")).text();
      if (updated !== original) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(updated, /#123456/);
    const refreshed = await request("/icons/openai.svg", { headers: { "if-none-match": etag } });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.headers.get("etag"), etag);
    await Promise.all(Array.from({ length: 5 }, () => request("/api/v1/icons/refresh", { method: "POST" })));
    const calls = (await readFile(callsPath, "utf8")).trim().split("\n");
    assert.equal(calls.length, 7);
    assert.equal(new Set(calls).size, 7);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
      await exited;
      clearTimeout(timer);
    }
    await rm(root, { recursive: true, force: true });
  }
});
