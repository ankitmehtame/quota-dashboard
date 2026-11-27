import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HEADER = "Billing Item ID,Event Time,Product,Charge Category,Usage Type,Principal Type,Principal ID,Usage,Pricing Currency,Pricing Contracted,Model,User Email";
const usage = (prompt: number, cached: number, completion: number) =>
  `"{""cache-write-text-tokens"":""0"",""cached-prompt-text-tokens"":""${cached}"",""completion-text-tokens"":""${completion}"",""prompt-text-tokens"":""${prompt}""}"`;
const row = (id: string, time: string, product: string, model: string, tokens: string) => `${id},${time},${product},usage,included,user,principal-secret,${tokens},USD,0.0000000000,${model},person@example.com`;

/** Stand-in for `ccusage claude daily --instances --breakdown`: prices grok-4.7-medium only, from the generated Claude logs. */
const FAKE_CCUSAGE = `#!/usr/bin/env node
const { readdirSync, readFileSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_CCUSAGE_CALLS, JSON.stringify(args) + "\\n");
const timeZone = args[args.indexOf("--timezone") + 1];
const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
const root = join(process.env.CLAUDE_CONFIG_DIR, "projects");
const projects = {};
const unpriced = new Set();
for (const project of readdirSync(root)) {
  const rows = new Map();
  for (const line of readFileSync(join(root, project, "cursor.jsonl"), "utf8").split("\\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    const date = day.format(new Date(entry.timestamp));
    const u = entry.message.usage;
    const priced = entry.message.model === "grok-4.7-medium";
    if (!priced) unpriced.add(entry.message.model);
    const models = rows.get(date) ?? new Map();
    const model = models.get(entry.message.model) ?? { modelName: entry.message.model, cost: 0, ...(priced ? {} : { missingPricing: true }) };
    if (priced) model.cost += u.input_tokens * 1e-6 + u.output_tokens * 1e-5 + u.cache_read_input_tokens * 1e-7;
    models.set(entry.message.model, model);
    rows.set(date, models);
  }
  projects[project] = [...rows].map(([date, models]) => ({ date, modelBreakdowns: [...models.values()] }));
}
process.stdout.write(JSON.stringify({ projects, totals: { unpricedModels: [...unpriced] } }));
`;

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => socket.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
  await exited;
  clearTimeout(timer);
}

test("imports Cursor rows from an xAI usage CSV, prices them with ccusage and merges them into usage", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-cursor-import-"));
  const timezone = "Asia/Singapore";
  const configPath = join(root, "config.json");
  const ccusage = join(root, "fake-ccusage");
  const calls = join(root, "ccusage-calls");
  await mkdir(join(root, "home"));
  await writeFile(ccusage, FAKE_CCUSAGE);
  await chmod(ccusage, 0o755);
  await writeFile(calls, "");
  await writeFile(configPath, JSON.stringify({
    providers: Object.fromEntries(["claude", "codex", "openrouter", "opencode-go", "ollama", "grok"].map((id) => [id, { enabled: false }])),
    usageSources: Object.fromEntries(["codex", "opencode", "hermes", "antigravity"].map((id) => [id, { enabled: false }])),
  }));
  const children: ChildProcess[] = [];
  const launch = async (localHostId: string, ccusageBin = ccusage) => {
    const port = await freePort();
    const child = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OPENROUTER_") && name !== "CLAUDE_CONFIG_DIR")), HOME: join(root, "home"), HOST: "127.0.0.1", PORT: String(port),
        CONFIG_PATH: configPath, USAGE_DATA_DIR: join(root, "data", "usage"), QUOTA_LOG_DIR: join(root, "logs"), USAGE_TIMEZONE: timezone, LOCAL_HOST_ID: localHostId,
        MQTT_ENABLED: "false", MQTT_URL: "", MQTT_BROKER_URL: "", CCUSAGE_BIN: ccusageBin, TEST_CCUSAGE_CALLS: calls, OPENCODE_AUTH_PATH: join(root, "missing-auth.json") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server failed to start: ${output}`)), 8000);
      const check = () => { if (output.includes("Quota dashboard listening")) { clearTimeout(timer); resolve(); } };
      child.stdout!.on("data", check);
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
      check();
    });
    const base = `http://127.0.0.1:${port}/api/v1`;
    return {
      child,
      base,
      upload: (csv: string | Buffer, query = "", headers: Record<string, string> = {}) => fetch(`${base}/usage/import${query}`, { method: "POST", headers: { "content-type": "text/csv", ...headers }, body: csv }),
      usage: async (): Promise<any> => (await (await fetch(`${base}/usage?days=1`)).json() as any).usage,
    };
  };
  try {
    const server = await launch("controller");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const time = new Date(`${today}T04:00:00.000Z`).toISOString();
    const later = new Date(`${today}T05:00:00.000Z`).toISOString();
    const csv = [HEADER,
      row("bill-1", time, "cursor", "grok-4.7-medium", usage(1000, 100_000, 100)),
      row("bill-2", later, "cursor", "gemini-4-neon-medium", usage(10, 0, 5)),
      row("bill-3", later, "grok-build", "", `"{""Prompt text tokens"":""1587""}"`),
    ].join("\n");

    const first = await server.upload(csv);
    const result: any = await first.json();
    assert.equal(first.status, 200, JSON.stringify(result));
    assert.deepEqual(result, { hostId: "controller", rows: 3, cursorRows: 2, added: 2, updated: 0, moved: 0, skipped: 1, skippedByProduct: { "grok-build": 1 }, invalid: 0, from: today, to: today, unpricedModels: [{ model: "gemini-4-neon-medium", rows: 1 }], pricingError: null });

    // Re-importing the same export is idempotent.
    assert.deepEqual(await (await server.upload(csv)).json(), { ...result, added: 0, updated: 2 });

    const providers: any = await (await fetch(`${server.base}/providers`)).json();
    assert.deepEqual(providers.usageSources.cursor, { enabled: true });
    const body = await server.usage();
    const cursor = body.records.filter((record: { provider: string }) => record.provider === "cursor");
    assert.deepEqual(cursor.map((record: Record<string, unknown>) => [record.hostId, record.model, record.inputTokens, record.cachedInputTokens, record.outputTokens, record.missingPricing]),
      [["controller", "gemini-4-neon-medium", 10, 0, 5, true], ["controller", "grok-4.7-medium", 1000, 100_000, 100, false]]);
    const priced = cursor.find((record: { model: string }) => record.model === "grok-4.7-medium");
    assert.ok(Math.abs(priced.costUsd - (1000e-6 + 100e-5 + 100_000e-7)) < 1e-12);
    assert.equal(body.byProvider.find((entry: { provider: string }) => entry.provider === "cursor").totalTokens, 101_115);
    assert.equal(body.error, null);
    // ccusage ran with the private generated data directory, never the user's own Claude logs.
    // The fake binary also receives the server's regular `daily --by-agent` runs; only `claude` runs price imports.
    const pricingCalls = async () => (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]).filter((args) => args[0] === "claude");
    const ccusageCalls = await pricingCalls();
    assert.ok(ccusageCalls.length >= 1);
    assert.ok(ccusageCalls.every((args) => args.slice(0, 5).join(" ") === "claude daily --json --instances --breakdown"));
    // A repeated read within the cache window does not run ccusage again.
    const callCount = ccusageCalls.length;
    await server.usage();
    assert.equal((await pricingCalls()).length, callCount);

    const rejected = await Promise.all([
      server.upload(csv, "?hostId=unknown-machine"),
      server.upload("Date,Model\n2026-11-27,x\n"),
      server.upload(csv, "", { origin: "http://evil.example" }),
      server.upload(csv, "", { "sec-fetch-site": "cross-site" }),
      server.upload(Buffer.alloc(10 * 1024 * 1024 + 1, 0x61)),
    ]);
    assert.deepEqual(rejected.map((response) => response.status), [400, 400, 403, 403, 413]);
    assert.match(((await rejected[1].json()) as any).error, /Not an xAI unified usage export/);

    // Stored files hold no personal columns.
    const stored = await Promise.all((await readdir(join(root, "data", "cursor-usage"))).map((name) => readFile(join(root, "data", "cursor-usage", name), "utf8")));
    assert.doesNotMatch(stored.join("\n"), /person@example\.com|principal-secret|grok-build/);

    // Disabling the source hides imported rows.
    await fetch(`${server.base}/usage-sources/cursor/enabled`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    assert.equal((await server.usage()).status, "disabled");
    await fetch(`${server.base}/usage-sources/cursor/enabled`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    await stop(server.child);

    // A machine whose only usage is imported Cursor rows stays selectable, and a missing ccusage is reported.
    const other = await launch("other-controller", join(root, "missing-ccusage"));
    const after = await other.usage();
    const controller = after.hosts.find((host: { hostId: string }) => host.hostId === "controller");
    assert.ok(controller, JSON.stringify(after.hosts));
    assert.equal(controller.usable, true);
    // It has no collector, so it is not reported as stale, incomplete or failing.
    assert.deepEqual([controller.severity, controller.stale, controller.complete, controller.status, controller.error], [null, false, true, "ok", null]);
    assert.ok(after.records.some((record: { provider: string; hostId: string; missingPricing: boolean }) => record.provider === "cursor" && record.hostId === "controller" && record.missingPricing));
    assert.match(after.error, /Cursor costs unavailable/);
    const imported: any = await (await other.upload(csv, "?hostId=controller")).json();
    assert.equal(imported.updated, 2);
    assert.match(imported.pricingError, /missing-ccusage was not found|not found/);

    // Today's rows move to this machine and the Cursor-only machine keeps only an old row:
    // it stays listed for the Today view, so the import menu still offers it.
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    assert.equal((await other.upload([HEADER, row("bill-old", old, "cursor", "grok-4.7-medium", usage(5, 0, 1))].join("\n"), "?hostId=controller")).status, 200);
    assert.equal((await other.upload(csv, "?hostId=other-controller")).status, 200);
    const today2 = await other.usage();
    assert.ok(!today2.records.some((record: { hostId: string }) => record.hostId === "controller"));
    assert.ok(today2.hosts.some((host: { hostId: string; severity: unknown }) => host.hostId === "controller" && host.severity === null), JSON.stringify(today2.hosts));
  } finally {
    await Promise.all(children.map(stop));
    await rm(root, { recursive: true, force: true });
  }
});
