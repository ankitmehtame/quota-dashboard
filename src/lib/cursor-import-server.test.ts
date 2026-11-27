import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HEADER = "Billing Item ID,Event Time,Product,Charge Category,Usage Type,Principal Type,Principal ID,Usage,Pricing Currency,Pricing Contracted,Model,User Email";
const usage = (prompt: number, cached: number, completion: number) =>
  `"{""cache-write-text-tokens"":""0"",""cached-prompt-text-tokens"":""${cached}"",""completion-text-tokens"":""${completion}"",""prompt-text-tokens"":""${prompt}""}"`;
const row = (id: string, time: string, product: string, model: string, tokens: string) => `${id},${time},${product},usage,included,user,principal-secret,${tokens},USD,0.0000000000,${model},person@example.com`;

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => socket.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

test("imports Cursor rows from an xAI usage CSV, prices them from ccusage overrides and merges them into usage", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-cursor-import-"));
  const home = join(root, "home");
  await mkdir(join(home, ".config", "ccusage"), { recursive: true });
  await writeFile(join(home, ".config", "ccusage", "config.json"), JSON.stringify({ defaults: { pricingOverrides: { "grok-4.7-medium": { inputCostPerToken: 1e-6, outputCostPerToken: 1e-5, cacheReadInputTokenCost: 1e-7 } } } }));
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({
    providers: Object.fromEntries(["claude", "codex", "openrouter", "opencode-go", "ollama", "grok"].map((id) => [id, { enabled: false }])),
    usageSources: Object.fromEntries(["codex", "opencode", "hermes", "antigravity"].map((id) => [id, { enabled: false }])),
  }));
  const port = await freePort();
  const timezone = "Asia/Singapore";
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OPENROUTER_") && name !== "CCUSAGE_CONFIG_PATH")), HOME: home, HOST: "127.0.0.1", PORT: String(port),
      CONFIG_PATH: configPath, USAGE_DATA_DIR: join(root, "data", "usage"), QUOTA_LOG_DIR: join(root, "logs"), USAGE_TIMEZONE: timezone, LOCAL_HOST_ID: "controller",
      MQTT_ENABLED: "false", MQTT_URL: "", MQTT_BROKER_URL: "", CCUSAGE_BIN: join(root, "missing-ccusage"), OPENCODE_AUTH_PATH: join(root, "missing-auth.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const base = `http://127.0.0.1:${port}/api/v1`;
  const upload = (csv: string | Buffer, query = "", headers: Record<string, string> = {}) => fetch(`${base}/usage/import${query}`, { method: "POST", headers: { "content-type": "text/csv", ...headers }, body: csv });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server failed to start: ${output}`)), 8000);
      const check = () => { if (output.includes("Quota dashboard listening")) { clearTimeout(timer); resolve(); } };
      child.stdout.on("data", check);
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
      check();
    });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const time = new Date(`${today}T04:00:00.000Z`).toISOString();
    const later = new Date(`${today}T05:00:00.000Z`).toISOString();
    const csv = [HEADER,
      row("bill-1", time, "cursor", "grok-4.7-medium", usage(1000, 100_000, 100)),
      row("bill-2", later, "cursor", "gemini-4-neon-medium", usage(10, 0, 5)),
      row("bill-3", later, "grok-build", "", `"{""Prompt text tokens"":""1587""}"`),
    ].join("\n");

    const first = await upload(csv);
    const result: any = await first.json();
    assert.equal(first.status, 200, JSON.stringify(result));
    assert.deepEqual(result, { hostId: "controller", rows: 3, cursorRows: 2, added: 2, updated: 0, moved: 0, skipped: 1, skippedByProduct: { "grok-build": 1 }, invalid: 0, from: today, to: today, unpricedModels: [{ model: "gemini-4-neon-medium", rows: 1 }] });

    // Re-importing the same export is idempotent.
    assert.deepEqual(await (await upload(csv)).json(), { ...result, added: 0, updated: 2 });

    const providers: any = await (await fetch(`${base}/providers`)).json();
    assert.deepEqual(providers.usageSources.cursor, { enabled: true });
    const body: any = await (await fetch(`${base}/usage?days=1`)).json();
    const cursor = body.usage.records.filter((record: { provider: string }) => record.provider === "cursor");
    assert.deepEqual(cursor.map((record: Record<string, unknown>) => [record.hostId, record.model, record.inputTokens, record.cachedInputTokens, record.outputTokens, record.missingPricing]),
      [["controller", "gemini-4-neon-medium", 10, 0, 5, true], ["controller", "grok-4.7-medium", 1000, 100_000, 100, false]]);
    const priced = cursor.find((record: { model: string }) => record.model === "grok-4.7-medium");
    assert.ok(Math.abs(priced.costUsd - (1000e-6 + 100e-5 + 100_000e-7)) < 1e-12);
    assert.equal(body.usage.byProvider.find((entry: { provider: string }) => entry.provider === "cursor").totalTokens, 101_115);
    assert.ok(body.usage.hosts.some((host: { hostId: string }) => host.hostId === "controller"));

    // Disabling the source hides imported rows.
    await fetch(`${base}/usage-sources/cursor/enabled`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    assert.equal(((await (await fetch(`${base}/usage?days=1`)).json()) as any).usage.status, "disabled");

    const rejected = await Promise.all([
      upload(csv, "?hostId=unknown-machine"),
      upload("Date,Model\n2026-11-27,x\n"),
      upload(csv, "", { origin: "http://evil.example" }),
      upload(csv, "", { "sec-fetch-site": "cross-site" }),
      upload(Buffer.alloc(10 * 1024 * 1024 + 1, 0x61)),
    ]);
    assert.deepEqual(rejected.map((response) => response.status), [400, 400, 403, 403, 413]);
    assert.match(((await rejected[1].json()) as any).error, /Not an xAI unified usage export/);

    // Stored files hold no personal columns.
    const stored = await Promise.all((await readdir(join(root, "data", "cursor-usage"))).map((name) => readFile(join(root, "data", "cursor-usage", name), "utf8")));
    assert.doesNotMatch(stored.join("\n"), /person@example\.com|principal-secret|grok-build/);
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
