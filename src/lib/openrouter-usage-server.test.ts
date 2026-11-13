import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openRouterKeyHash } from "./openrouter-analytics.js";
import { OpenRouterUsageStore } from "./openrouter-usage-store.js";
import type { UsageRecord } from "./usage.js";

const keyIdOf = (secret: string) => createHash("sha256").update(secret).digest("hex");
type Call = { path: string; authorization: string; body: any };
type UsageBody = { usageSources?: Record<string, { enabled: boolean }>; usageSourceLabels?: Record<string, string>;
  timezone: string; usage: { status: string; error: string | null; records: Array<UsageRecord & { hostId?: string }>; sourceLabels: Record<string, string>; byProvider: Array<{ provider: string; costUsd: number }> } };

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => socket.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

/** Spawn the real server against a fake OpenRouter analytics endpoint. */
async function harness(env: Record<string, string>, enabledSources: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "quota-openrouter-usage-"));
  const home = join(root, "home");
  await mkdir(home);
  const configPath = join(root, "config.json");
  const callsPath = join(root, "calls");
  const rowsPath = join(root, "rows.json");
  const preload = join(root, "preload.mjs");
  await writeFile(callsPath, "");
  await writeFile(rowsPath, "{}");
  await writeFile(configPath, JSON.stringify({
    providers: Object.fromEntries(["claude", "codex", "openrouter", "opencode-go", "ollama"].map((id) => [id, { enabled: false }])),
    usageSources: Object.fromEntries(["codex", "opencode", "hermes", "antigravity"].map((id) => [id, { enabled: enabledSources.includes(id) }])),
  }));
  await writeFile(preload, `
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
globalThis.fetch = async (url, init) => {
  const path = new URL(String(url)).pathname;
  const headers = new Headers(init?.headers);
  const authorization = headers.get("authorization") ?? "";
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  appendFileSync(process.env.TEST_CALLS_PATH, JSON.stringify({ path, authorization, body }) + "\\n");
  if (new URL(String(url)).origin !== "https://openrouter.ai") throw new Error("Unexpected upstream");
  if (path === "/api/v1/key") return Response.json({ data: { label: "sk-or-v1-UPSTREAM_LABEL", usage: 1, hash: createHash("sha256").update("upstream:" + authorization.slice(7)).digest("hex") } });
  if (path === "/api/v1/analytics/query") {
    if (authorization !== "Bearer MANAGEMENT_SECRET") return new Response("RAW_MANAGEMENT_SECRET", { status: 403 });
    const plan = JSON.parse(readFileSync(process.env.TEST_ROWS_PATH, "utf8"))[body.filters[0].value] ?? { data: [] };
    if (plan.status) return new Response("RAW_UPSTREAM_SECRET", { status: plan.status });
    return Response.json({ data: { data: plan.data, metadata: { truncated: Boolean(plan.truncated) } } });
  }
  throw new Error("Unexpected upstream URL");
};
`);
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", preload, fileURLToPath(new URL("../server.js", import.meta.url))], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OPENROUTER_"))), HOME: home, HOST: "127.0.0.1", PORT: String(port),
      CONFIG_PATH: configPath, OPENCODE_AUTH_PATH: join(root, "missing-auth.json"), USAGE_DATA_DIR: join(root, "usage"), QUOTA_LOG_DIR: join(root, "logs"),
      MQTT_ENABLED: "false", MQTT_URL: "", MQTT_BROKER_URL: "", CCUSAGE_BIN: join(root, "missing-ccusage"), TEST_CALLS_PATH: callsPath, TEST_ROWS_PATH: rowsPath,
      OPENROUTER_MANAGEMENT_API_KEY: "MANAGEMENT_SECRET", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const responses: string[] = [];
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/${path}`, { method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const text = await response.text();
    responses.push(text);
    assert.ok(response.status < 300, `${path}: ${response.status} ${text}`);
    return JSON.parse(text);
  };
  const calls = async (): Promise<Call[]> => (await readFile(callsPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const queries = async () => (await calls()).filter((call) => call.path === "/api/v1/analytics/query");
  const waitFor = async (predicate: () => Promise<boolean>, what: string) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${what}: ${output}`);
  };
  const start = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server failed to start: ${output}`)), 8000);
    const check = () => { if (output.includes("Quota dashboard listening")) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", check);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
    check();
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
      await exited;
      clearTimeout(timer);
    }
  };
  const setRows = (rows: Record<string, unknown>) => writeFile(rowsPath, JSON.stringify(rows));
  const everything = async () => JSON.stringify([responses, output, await readFile(configPath, "utf8"),
    (await Promise.all((await readdir(join(root, "logs")).catch(() => [])).map((name) => readFile(join(root, "logs", name), "utf8")))).join("\n")]);
  return { root, api, calls, queries, waitFor, start, stop, setRows, everything, cleanup: async () => { await stop(); await rm(root, { recursive: true, force: true }); } };
}

const raw = (model: string, cost: number, prompt: number, cached: number, completion: number, reasoning: number) =>
  ({ model, total_usage: cost, tokens_prompt: String(prompt), cached_tokens: String(cached), tokens_completion: String(completion), reasoning_tokens: String(reasoning) });
const localDate = (daysAgo: number, timezone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now() - daysAgo * 86_400_000);

test("server collects hot and cold OpenRouter usage per key, groups by label and never exposes secrets or hashes", { timeout: 70_000 }, async () => {
  const timezone = "Asia/Singapore";
  const secrets = { alpha: "ALPHA_SECRET", beta: "BETA_SECRET", gamma: "GAMMA_SECRET", delta: "DELTA_SECRET" };
  const h = await harness({
    USAGE_TIMEZONE: timezone,
    OPENROUTER_KEY_1: secrets.alpha, OPENROUTER_KEY_1_LABEL: "Home",
    OPENROUTER_KEY_2: secrets.beta, OPENROUTER_KEY_2_LABEL: "Home",
    OPENROUTER_KEY_3: secrets.gamma, OPENROUTER_KEY_3_LABEL: "Work",
    OPENROUTER_KEY_4: secrets.delta, OPENROUTER_KEY_4_LABEL: "Idle",
    OPENROUTER_KEY_5: secrets.delta, OPENROUTER_KEY_5_LABEL: "Idle",
    OPENROUTER_INACTIVE_KEYS: "4",
  });
  const seedDate = localDate(5, timezone);
  await h.setRows({
    [keyIdOf(secrets.alpha)]: { data: [raw("model/a", 1, 100, 20, 50, 10)] },
    [keyIdOf(secrets.beta)]: { data: [raw("model/a", 2, 10, 0, 5, 0)] },
    [keyIdOf(secrets.gamma)]: { data: [raw("model/b", 4, 1000, 400, 600, 100)] },
    [keyIdOf(secrets.delta)]: { data: [raw("model/never", 99, 1, 0, 1, 0)] },
  });
  // History of a key that is now inactive, written by an earlier run.
  await new OpenRouterUsageStore(join(h.root, "openrouter-usage")).write(openRouterKeyHash(secrets.delta), seedDate, timezone, [
    { date: seedDate, provider: "openrouter", model: "model/old", inputTokens: 7, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 3, reasoningTokens: 0, costUsd: 0.5, missingPricing: false }]);
  try {
    await h.start;
    // Startup runs the hot collection (today and yesterday) and the cold scheduler's newest missing day, for the three active keys only.
    await h.waitFor(async () => (await h.queries()).length >= 9, "hot and scheduled cold queries");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const startup = await h.queries();
    assert.equal(startup.length, 9);
    const newestFirst = [...new Set(startup.map((call) => call.body.time_range.start))].sort().reverse();
    assert.equal(newestFirst.length, 3);
    const hot = startup.filter((call) => call.body.time_range.start !== newestFirst[2]);
    assert.equal(hot.length, 6);
    assert.equal(startup.filter((call) => call.body.time_range.start === newestFirst[2]).length, 3);
    const wanted = new Set([keyIdOf(secrets.alpha), keyIdOf(secrets.beta), keyIdOf(secrets.gamma)]);
    assert.deepEqual(new Set(hot.map((call) => call.body.filters[0].value)), wanted);
    assert.ok(hot.every((call) => call.authorization === "Bearer MANAGEMENT_SECRET" && call.body.filters[0].field === "api_key_id" && call.body.dimensions[0] === "model"));
    // Singapore local days are 24h windows starting at 16:00Z, not UTC calendar days.
    for (const call of hot) {
      assert.match(call.body.time_range.start, /T16:00:00\.000Z$/);
      assert.equal(Date.parse(call.body.time_range.end) - Date.parse(call.body.time_range.start), 86_400_000);
    }
    const hotStarts = new Set(hot.map((call) => call.body.time_range.start));
    assert.equal(hotStarts.size, 2);
    assert.equal(Math.abs([...hotStarts].map(Date.parse).reduce((a, b) => a - b)), 86_400_000);
    // Analytics key identifiers are derived locally; no key lookup is needed.
    assert.equal((await h.calls()).filter((call) => call.path === "/api/v1/key").length, 0);

    const first = await h.api("usage?days=30") as UsageBody;
    assert.equal(first.timezone, timezone);
    const labels = first.usage.sourceLabels;
    assert.deepEqual(Object.values(labels).sort(), ["Home", "Idle", "Work"]);
    const idOf = (label: string) => Object.entries(labels).find(([, value]) => value === label)![0];
    assert.match(idOf("Home"), /^openrouter-[a-f0-9]{24}$/);
    const byProvider = (label: string) => first.usage.records.filter((record) => record.provider === idOf(label));
    // The two newest dates are the hot window; the third is the day filled by the scheduled cold backfill.
    const newestTwo = (records: UsageRecord[]) => [...records].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 2);
    // Same label combines both keys per date and model; each hot day contributes once.
    const home = byProvider("Home");
    assert.equal(home.length, 3);
    assert.equal(new Set(home.map((record) => record.date)).size, 3);
    assert.ok(home.every((record) => record.model === "model/a" && record.costUsd === 3 && record.inputTokens === 90 && record.cachedInputTokens === 20 && record.outputTokens === 45 && record.reasoningTokens === 10));
    assert.deepEqual(byProvider("Work").map((record) => [record.inputTokens, record.cachedInputTokens, record.outputTokens, record.reasoningTokens]), Array(3).fill([600, 400, 500, 100]));
    // The inactive key's retained history is displayed and it is never queried.
    assert.deepEqual(byProvider("Idle").map((record) => [record.date, record.model, record.costUsd]), [[seedDate, "model/old", 0.5]]);
    assert.ok(!(await h.queries()).some((call) => call.body.filters[0].value === keyIdOf(secrets.delta)));
    // This harness has no ccusage, so the local host reports its own failure; OpenRouter adds none.
    assert.doesNotMatch(first.usage.error ?? "", /OpenRouter/);
    assert.ok(first.usage.records.every((record) => !("hash" in record)));

    // Repeated dashboard views use stored snapshots; they do not requery OpenRouter.
    const before = (await h.queries()).length;
    await h.api("usage?days=30");
    await h.api("usage?days=7");
    await h.api("dashboard");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await h.queries()).length, before);

    // New sources are enabled by default and persist across config loads, keyed by current labels.
    const providers = await h.api("providers") as UsageBody;
    assert.deepEqual(Object.keys(providers.usageSources!).filter((id) => id.startsWith("openrouter-")).sort(), Object.keys(labels).sort());
    assert.deepEqual(providers.usageSourceLabels, labels);

    // An explicit refresh requeries the hot days. One key failing keeps its previous snapshot and reports a partial status.
    await h.setRows({
      [keyIdOf(secrets.alpha)]: { data: [raw("model/a", 10, 100, 20, 50, 10)] },
      [keyIdOf(secrets.beta)]: { data: [raw("model/a", 20, 10, 0, 5, 0)] },
      [keyIdOf(secrets.gamma)]: { status: 500 },
    });
    await h.api("usage/refresh", "POST");
    await h.waitFor(async () => (await h.queries()).length >= before + 6, "forced refresh");
    await h.waitFor(async () => /could not be refreshed/.test((await h.api("usage?days=30") as UsageBody).usage.error ?? ""), "partial error");
    const partial = await h.api("usage?days=30") as UsageBody;
    assert.equal(partial.usage.status, "partial");
    assert.match(partial.usage.error!, /One or more OpenRouter usage keys could not be refreshed$/);
    const partialProvider = (label: string) => partial.usage.records.filter((record) => record.provider === idOf(label));
    assert.ok(newestTwo(partialProvider("Home")).every((record) => record.costUsd === 30));
    assert.ok(partialProvider("Work").length === 3 && partialProvider("Work").every((record) => record.costUsd === 4));

    // A later success of the same job clears the error; an empty successful day is stored as zero.
    await h.setRows({
      [keyIdOf(secrets.alpha)]: { data: [] }, [keyIdOf(secrets.beta)]: { data: [] }, [keyIdOf(secrets.gamma)]: { data: [raw("model/b", 5, 1, 0, 1, 0)] },
    });
    const beforeRecovery = (await h.queries()).length;
    await h.api("usage/refresh", "POST");
    await h.waitFor(async () => (await h.queries()).length >= beforeRecovery + 6, "recovery refresh");
    await h.waitFor(async () => !/OpenRouter/.test((await h.api("usage?days=30") as UsageBody).usage.error ?? ""), "recovered error");
    const recovered = await h.api("usage?days=30") as UsageBody;
    assert.ok(recovered.usage.sourceLabels[idOf("Home")]);
    const recoveredHome = recovered.usage.records.filter((record) => record.provider === idOf("Home"));
    assert.equal(recoveredHome.length, 1, "hot days replaced by empty results; only the cold day remains");
    assert.deepEqual(newestTwo(recovered.usage.records.filter((record) => record.provider === idOf("Work"))).map((record) => record.costUsd), [5, 5]);

    // Cold backfill is newest first, covers the requested local days for active keys only, and is queued rather than dropped.
    await h.setRows({ [keyIdOf(secrets.alpha)]: { data: [raw("model/a", 1, 1, 0, 1, 0)] }, [keyIdOf(secrets.beta)]: { data: [] }, [keyIdOf(secrets.gamma)]: { status: 500 } });
    const beforeCold = (await h.queries()).length;
    const older = localDate(20, timezone);
    const oldest = localDate(21, timezone);
    await h.api("usage/cold", "POST", { from: oldest, to: older });
    await h.waitFor(async () => (await h.queries()).length >= beforeCold + 6, "cold queries");
    const cold = (await h.queries()).slice(beforeCold);
    assert.equal(cold.length, 6);
    const starts = [...new Set(cold.map((call) => call.body.time_range.start))];
    assert.equal(starts.length, 2);
    assert.ok(Date.parse(cold[0].body.time_range.start) > Date.parse(cold.at(-1)!.body.time_range.start), "newest day first");
    assert.ok(!cold.some((call) => call.body.filters[0].value === keyIdOf(secrets.delta)));
    await h.waitFor(async () => (await h.api(`usage?days=40`) as UsageBody).usage.records.some((record) => record.date === older && record.provider === idOf("Home")), "cold records");

    // Nothing sensitive crosses any API, log or the saved config: credentials, upstream ids, storage hashes or raw bodies.
    const dump = await h.everything();
    for (const secret of [...Object.values(secrets), "MANAGEMENT_SECRET", "UPSTREAM_LABEL", "RAW_UPSTREAM_SECRET", "RAW_MANAGEMENT_SECRET",
      ...Object.values(secrets).flatMap((value) => [keyIdOf(value), openRouterKeyHash(value)])]) assert.ok(!dump.includes(secret), `leaked ${secret}`);
    assert.doesNotMatch(dump, /sk-or-|Bearer/i);
    const stored = await readdir(join(h.root, "openrouter-usage"));
    assert.deepEqual(stored.sort(), [secrets.alpha, secrets.beta, secrets.gamma, secrets.delta].map(openRouterKeyHash).sort());
  } finally { await h.cleanup(); }
});

test("server does not poll OpenRouter without a management key, keeps retained history and exposes no empty sources", { timeout: 25_000 }, async () => {
  const h = await harness({ USAGE_TIMEZONE: "UTC", OPENROUTER_MANAGEMENT_API_KEY: "", OPENROUTER_KEY_1: "ONLY_SECRET", OPENROUTER_KEY_1_LABEL: "Home" }, ["codex"]);
  try {
    await h.start;
    const usage = await h.api("usage?days=7") as UsageBody;
    await h.api("usage/refresh", "POST");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(await h.calls(), []);
    assert.deepEqual(usage.usage.sourceLabels, {});
    assert.ok(!JSON.stringify(await h.api("providers")).includes("openrouter-"));
  } finally { await h.cleanup(); }
});

test("cold scheduler advances past a persistently failing key and retries fairly", { timeout: 30_000 }, async () => {
  const h = await harness({ USAGE_TIMEZONE: "UTC", CCUSAGE_DAYS: "5", CCUSAGE_COLD_INTERVAL_MS: "200",
    OPENROUTER_KEY_1: "HEALTHY", OPENROUTER_KEY_1_LABEL: "Healthy", OPENROUTER_KEY_2: "BROKEN", OPENROUTER_KEY_2_LABEL: "Broken" }, ["codex"]);
  await h.setRows({ [keyIdOf("HEALTHY")]: { data: [raw("model", 1, 1, 0, 1, 0)] }, [keyIdOf("BROKEN")]: { status: 500 } });
  try {
    await h.start;
    const coldDates = async () => new Set((await h.queries()).filter((call) => call.body.time_range.start.slice(0, 10) <= localDate(2, "UTC")).map((call) => call.body.time_range.start.slice(0, 10)));
    await h.waitFor(async () => (await coldDates()).size >= 2, "scheduler progress past failing key");
    assert.ok((await coldDates()).size >= 2);
  } finally { await h.cleanup(); }
});

test("server reports conflicting duplicate labels and invalid selectors as configuration errors without querying", { timeout: 25_000 }, async () => {
  for (const env of <Array<Record<string, string>>>[
    { OPENROUTER_KEY_1: "SAME_SECRET", OPENROUTER_KEY_1_LABEL: "Home", OPENROUTER_KEY_2: "SAME_SECRET", OPENROUTER_KEY_2_LABEL: "Work" },
    { OPENROUTER_KEY_1: "ONE_SECRET", OPENROUTER_KEY_1_LABEL: "Home", OPENROUTER_USAGE_KEYS: "9" },
    { OPENROUTER_KEY_1: "ONE_SECRET", OPENROUTER_KEY_1_LABEL: "Home", OPENROUTER_INACTIVE_KEYS: "nope" },
  ]) {
    const h = await harness({ USAGE_TIMEZONE: "UTC", ...env }, ["codex"]);
    try {
      await h.start;
      const usage = await h.api("usage?days=7") as UsageBody;
      await h.api("usage/refresh", "POST");
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.deepEqual(await h.calls(), []);
      assert.deepEqual(usage.usage.sourceLabels, {});
      assert.ok(!JSON.stringify(usage).includes("SECRET"));
      assert.doesNotMatch(await h.everything(), /ONE_SECRET|SAME_SECRET/);
    } finally { await h.cleanup(); }
  }
});
