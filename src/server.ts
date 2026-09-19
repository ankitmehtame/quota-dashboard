import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type AppConfig, type ProviderId, type UsageSourceId, DEFAULT_CONFIG, PROVIDER_IDS, USAGE_SOURCE_IDS, localDateRange, normalizeConfig, normalizeProviderOrder, providerStatus } from "./lib/core.js";
import type { ProviderResult } from "./lib/core.js";
import { isProviderConfigured, PROVIDER_FETCHERS } from "./lib/providers.js";
import { filterUsageRecords, summarizeUsage } from "./lib/usage.js";
import { FilesystemUsageStore } from "./lib/usage-store.js";
import { ccusageErrorMessage, DEFAULT_CCUSAGE_MAX_BUFFER, DEFAULT_COLD_CCUSAGE_TIMEOUT_MS, DEFAULT_HOT_CCUSAGE_TIMEOUT_MS, DEFAULT_ROLLING_DAYS, rollingDateRange, runCcusage } from "./remote/ccusage.js";
import { DEFAULT_COLD_INTERVAL_MS, DEFAULT_PUBLISH_INTERVAL_MS } from "./remote/publisher.js";
import { sanitizeHostId } from "./remote/protocol.js";
import { RemoteMqttStore, readRemoteMqttSubscriberConfig } from "./remote/subscriber.js";

function loadEnvironmentFile(path: string): void {
  try {
    const contents = readFileSync(path, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      const value = match[2].replace(/\s+#.*$/, "").replace(/^(['"])(.*)\1$/, "$2");
      process.env[match[1]] = value;
    }
  } catch {
    // Environment files are optional; deployment environments may inject variables directly.
  }
}

loadEnvironmentFile(join(homedir(), ".config", "quota-dashboard", ".env"));

const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = join(root, "public");
const port = Number(process.env.PORT || 4173);
const configPath = process.env.CONFIG_PATH || join(homedir(), ".config", "quota-dashboard", "config.json");
function validatedTimezone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format();
    return value;
  } catch {
    throw new Error(`Invalid USAGE_TIMEZONE: ${value}`);
  }
}

const usageTimezone = validatedTimezone(process.env.USAGE_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
const usageDataRoot = resolve(process.env.USAGE_DATA_DIR?.trim() || join(homedir(), ".local", "share", "quota-dashboard", "usage"));
const usageStore = new FilesystemUsageStore({ dataRoot: usageDataRoot });
function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const localCcusageBinary = process.env.CCUSAGE_BIN?.trim() || "ccusage";
const localCcusageMaxBuffer = positiveNumber(process.env.CCUSAGE_MAX_BUFFER, DEFAULT_CCUSAGE_MAX_BUFFER);
const localHotTimeoutMs = positiveNumber(process.env.CCUSAGE_HOT_TIMEOUT_MS, positiveNumber(process.env.CCUSAGE_TIMEOUT_MS, DEFAULT_HOT_CCUSAGE_TIMEOUT_MS));
const localColdTimeoutMs = positiveNumber(process.env.CCUSAGE_COLD_TIMEOUT_MS, DEFAULT_COLD_CCUSAGE_TIMEOUT_MS);
const localColdMode = process.env.CCUSAGE_COLD_MODE?.trim().toLowerCase() === "online" ? "online" : "offline";
const localRollingDays = Math.max(3, Math.trunc(positiveNumber(process.env.CCUSAGE_DAYS, DEFAULT_ROLLING_DAYS)));
const localHotIntervalMs = positiveNumber(process.env.CCUSAGE_HOT_INTERVAL_MS, DEFAULT_PUBLISH_INTERVAL_MS);
const localColdIntervalMs = positiveNumber(process.env.CCUSAGE_COLD_INTERVAL_MS, DEFAULT_COLD_INTERVAL_MS);
const quotaCache = new Map<ProviderId, { cachedAt: number; value: ProviderResult }>();
const dashboardCache = new Map<string, { cachedAt: number; fetchedAt: string; value: DashboardValue }>();
const localHostId = sanitizeHostId(process.env.LOCAL_HOST_ID?.trim() || hostname());
const remotePersistenceErrors = new Map<string, string>();
const remotePersistenceChains = new Map<string, Promise<void>>();
let localHotPromise: Promise<void> | null = null;
let localColdPromise: Promise<void> | null = null;
let localHotSchedulePromise: Promise<void> | null = null;
let localColdSchedulePromise: Promise<void> | null = null;
let localHotTimer: NodeJS.Timeout | null = null;
let localColdTimer: NodeJS.Timeout | null = null;
let localHotUsageError: string | null = null;
const localColdQueue: Array<{ from: string; to: string; offline: boolean }> = [];
const localColdQueued = new Set<string>();
const localDateChains = new Map<string, Promise<void>>();
const MAX_LOCAL_COLD_QUEUE = 10;
const remoteUsageStore = new RemoteMqttStore({
  ...readRemoteMqttSubscriberConfig(),
  usageTimezone,
  onUsage: (message) => {
    const key = `${message.hostId}/${message.date}`;
    const previous = remotePersistenceChains.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(() => usageStore.ingest({ ...message, hostId: message.hostId })).then(() => {
      remotePersistenceErrors.delete(message.hostId);
      dashboardCache.clear();
    });
    remotePersistenceChains.set(key, next);
    void next.then(
      () => { if (remotePersistenceChains.get(key) === next) remotePersistenceChains.delete(key); },
      () => { if (remotePersistenceChains.get(key) === next) remotePersistenceChains.delete(key); },
    );
    return next;
  },
  onUsageError: (message, error) => {
    remotePersistenceErrors.set(message.hostId, error instanceof Error ? error.message : String(error));
    dashboardCache.clear();
  },
});
remoteUsageStore.addChangeListener(() => dashboardCache.clear());
void remoteUsageStore.start().catch((error) => console.error(`Remote MQTT subscriber failed: ${error instanceof Error ? error.message : String(error)}`));
const buildInfo = await loadBuildInfo();
startLocalHotScheduler();
startLocalColdScheduler();

type BuildInfo = { version: string; commit: string | null };

async function loadBuildInfo(): Promise<BuildInfo> {
  try {
    const value = JSON.parse(await readFile(join(root, "version.json"), "utf8")) as Partial<BuildInfo>;
    if (typeof value.version === "string") return { version: value.version, commit: typeof value.commit === "string" ? value.commit : null };
  } catch {
    // Development servers without a completed build still have a usable fallback.
  }
  return { version: "0.0.0-dev.0", commit: null };
}

type DashboardValue = {
  version: string;
  apiVersion: number;
  serverNow: string;
  timezone: string;
  providerOrder: ProviderId[];
  providers: Record<string, unknown>;
  quotas: Record<string, ProviderResult>;
  usage: Record<string, unknown>;
};

type RequestBody = { enabled?: unknown; order?: unknown; hostId?: unknown; from?: unknown; to?: unknown; mode?: unknown };

async function loadConfig(): Promise<AppConfig> {
  try {
    return normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

async function saveConfig(config: AppConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

async function getQuota(id: ProviderId, force = false): Promise<ProviderResult> {
  const ttl = Number(process.env.QUOTA_CACHE_TTL_SECONDS || 120) * 1000;
  const cached = quotaCache.get(id);
  if (!force && cached && Date.now() - cached.cachedAt < ttl) return cached.value;
  const value = await PROVIDER_FETCHERS[id]();
  quotaCache.set(id, { cachedAt: Date.now(), value });
  return value;
}

function dateList(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let cursor = from; cursor <= to;) {
    dates.push(cursor);
    const date = new Date(`${cursor}T12:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    cursor = date.toISOString().slice(0, 10);
  }
  return dates;
}

function ccusageVersion(): string | undefined {
  const value = process.env.CCUSAGE_VERSION?.trim();
  return value || undefined;
}

function documentMatchesDate(document: unknown, date: string): boolean {
  if (!document || typeof document !== "object" || !Array.isArray((document as { daily?: unknown }).daily)) return true;
  return (document as { daily: unknown[] }).daily.every((row) => {
    if (!row || typeof row !== "object") return false;
    const value = row as { date?: unknown; period?: unknown };
    return (value.date === undefined || value.date === date) && (value.period === undefined || value.period === date);
  });
}

async function runLocalUsageJob(range: { from: string; to: string }, category: "hot" | "cold", offline: boolean, timeoutMs: number): Promise<void> {
  const failures: string[] = [];
  for (const date of dateList(range.from, range.to)) {
    const previous = localDateChains.get(date) || Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const result = await runCcusage({
        binary: localCcusageBinary,
        range: { from: date, to: date, timezone: usageTimezone },
        offline,
        timeoutMs,
        maxBuffer: localCcusageMaxBuffer,
      });
      if (!documentMatchesDate(result.document, date)) throw new Error(`ccusage returned data outside ${date}`);
      await usageStore.ingest({
        schemaVersion: 2,
        hostId: localHostId,
        date,
        timezone: usageTimezone,
        category,
        runId: randomUUID(),
        generatedAt: new Date().toISOString(),
        ...(ccusageVersion() ? { ccusageVersion: ccusageVersion() } : {}),
        range,
        data: result.document,
      });
    });
    localDateChains.set(date, current);
    try {
      await current;
    } catch (error) {
      failures.push(`${date}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (localDateChains.get(date) === current) localDateChains.delete(date);
    }
  }
  dashboardCache.clear();
  if (failures.length > 0) throw new Error(failures.join("; "));
}

function queueLocalHot(): void {
  if (localHotPromise) return;
  const range = localDateRange(2, usageTimezone);
  localHotPromise = runLocalUsageJob(range, "hot", false, localHotTimeoutMs)
    .then(() => { localHotUsageError = null; })
    .catch((error) => {
      localHotUsageError = ccusageErrorMessage(error, localCcusageBinary);
      dashboardCache.clear();
      console.error(`Local hot usage refresh failed: ${localHotUsageError}`);
    })
    .finally(() => { localHotPromise = null; });
}

function startLocalHotScheduler(): void {
  if (localHotTimer) return;
  const trigger = () => {
    if (localHotSchedulePromise) return;
    localHotSchedulePromise = loadConfig()
      .then((config) => {
        if (USAGE_SOURCE_IDS.some((id) => config.usageSources[id].enabled)) queueLocalHot();
      })
      .catch((error) => console.error(`Local hot scheduler failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { localHotSchedulePromise = null; });
  };
  localHotTimer = setInterval(trigger, localHotIntervalMs);
  trigger();
}

type LocalColdQueueResult = "accepted" | "duplicate" | "full" | "shutdown";

function queueLocalCold(from: string, to: string, offline: boolean): LocalColdQueueResult {
  if (shuttingDown) return "shutdown";
  const key = `${from}:${to}:${offline ? "offline" : "online"}`;
  if (localColdQueued.has(key)) return "duplicate";
  if (localColdQueue.length >= MAX_LOCAL_COLD_QUEUE) return "full";
  localColdQueued.add(key);
  localColdQueue.push({ from, to, offline });
  void drainLocalColdQueue();
  return "accepted";
}

async function drainLocalColdQueue(): Promise<void> {
  if (localColdPromise || shuttingDown) return;
  const job = localColdQueue.shift();
  if (!job) return;
  const key = `${job.from}:${job.to}:${job.offline ? "offline" : "online"}`;
  localColdPromise = runLocalUsageJob({ from: job.from, to: job.to }, "cold", job.offline, localColdTimeoutMs)
    .catch((error) => {
      dashboardCache.clear();
      console.error(`Local cold usage refresh failed: ${ccusageErrorMessage(error, localCcusageBinary)}`);
    })
    .finally(() => { localColdPromise = null; localColdQueued.delete(key); });
  await localColdPromise;
  if (!shuttingDown) void drainLocalColdQueue();
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function localHotIsStale(files: Array<{ hostId: string; category: string; generatedAt: string }>): boolean {
  const latest = files
    .filter((file) => file.hostId === localHostId && file.category === "hot")
    .map((file) => Date.parse(file.generatedAt))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  return latest === undefined || Date.now() - latest > 10 * 60 * 1000;
}

function previousDate(value: string): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function scheduleLocalColdDate(): Promise<void> {
  const config = await loadConfig();
  if (!USAGE_SOURCE_IDS.some((id) => config.usageSources[id].enabled)) return;
  const rolling = rollingDateRange(usageTimezone, new Date(), localRollingDays);
  const newestColdDate = previousDate(localDateRange(2, usageTimezone).from);
  const files = await usageStore.readNormalized(localHostId, rolling.from, newestColdDate);
  const coveredDates = new Set(files.filter((file) => file.timezone === usageTimezone).map((file) => file.date));
  for (let date = newestColdDate; date >= rolling.from; date = previousDate(date)) {
    if (!coveredDates.has(date)) {
      queueLocalCold(date, date, localColdMode === "offline");
      return;
    }
  }
}

function startLocalColdScheduler(): void {
  if (localColdTimer) return;
  const trigger = () => {
    if (localColdSchedulePromise) return;
    localColdSchedulePromise = scheduleLocalColdDate()
      .catch((error) => console.error(`Local cold scheduler failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { localColdSchedulePromise = null; });
  };
  localColdTimer = setInterval(trigger, localColdIntervalMs);
  trigger();
}

async function buildUsage(url: URL, config: AppConfig) {
  const range = localDateRange(Number(url.searchParams.get("days") || 30), usageTimezone, url.searchParams.get("range") || "relative");
  const usageSources = USAGE_SOURCE_IDS.filter((id) => config.usageSources[id].enabled);
  const normalizedFiles = usageSources.length ? await usageStore.readNormalizedAll(range.from, range.to) : [];
  const today = localDateRange(1, usageTimezone).to;
  const localHotFiles = usageSources.length ? await usageStore.readNormalized(localHostId, today, today) : [];
  if (usageSources.length && localHotIsStale(localHotFiles)) queueLocalHot();
  const persistedHostIds = usageSources.length ? await usageStore.listHostIds() : [];
  const latestByHost = new Map<string, Awaited<ReturnType<typeof usageStore.readLatest>>>();
  await Promise.all(persistedHostIds.map(async (hostId) => { latestByHost.set(hostId, await usageStore.readLatest(hostId)); }));
  const remoteState = remoteUsageStore.getSnapshot();
  const configuredStaleSeconds = Number(process.env.MQTT_STALE_AFTER_SECONDS || 900);
  const staleAfterMs = (Number.isFinite(configuredStaleSeconds) && configuredStaleSeconds > 0 ? configuredStaleSeconds : 900) * 1000;
  const storedFiles = normalizedFiles.filter((file) => file.timezone === usageTimezone);
  const storedRecords = storedFiles.flatMap((file) => file.records.map((record) => ({ ...record, hostId: file.hostId })));
  const records = filterUsageRecords(usageSources, storedRecords);
  const summary = summarizeUsage(records);
  const hostIds = new Set<string>([localHostId, ...persistedHostIds, ...storedFiles.map((file) => file.hostId), ...Object.keys(remoteState.hosts)]);
  const activeHostIds = new Set<string>([localHostId, ...Object.keys(remoteState.hosts)]);
  const storageErrorsByHost = new Map<string, string | null>();
  const hosts = [...hostIds].map((hostId) => {
    const state = remoteState.hosts[hostId];
    const files = storedFiles.filter((file) => file.hostId === hostId);
    const latest = latestByHost.get(hostId) || null;
    const generatedAt = latest?.generatedAt ?? state?.usage?.generatedAt ?? null;
    const generatedTime = generatedAt ? Date.parse(generatedAt) : NaN;
    const hostRecords = records.filter((record) => record.hostId === hostId);
    const isLocal = hostId === localHostId;
    const ingestError = remotePersistenceErrors.get(hostId) || state?.ingestError || null;
    const storageError = ingestError || (isLocal ? localHotUsageError : null) || null;
    storageErrorsByHost.set(hostId, storageError);
    const error = storageError || state?.error?.error || state?.status?.error || null;
    const coveredDates = new Set(files.map((file) => file.date));
    const complete = dateList(range.from, range.to).every((date) => coveredDates.has(date));
    const stale = !Number.isFinite(generatedTime) || generatedTime > Date.now() + 60_000 || Date.now() - generatedTime > (isLocal ? 10 * 60 * 1000 : staleAfterMs);
    const status = error ? "error" : state?.status?.status || (hostRecords.length ? "ok" : "unknown");
    return {
      hostId,
      generatedAt,
      timezone: latest?.timezone ?? state?.usage?.timezone ?? state?.status?.timezone ?? usageTimezone,
      category: latest?.category ?? state?.usage?.category ?? state?.status?.category ?? null,
      range: latest?.range ?? state?.usage?.range ?? { from: range.from, to: range.to },
      status,
      error,
      active: activeHostIds.has(hostId),
      stale,
      local: isLocal,
      included: !error && (latest?.timezone ?? state?.usage?.timezone ?? usageTimezone) === usageTimezone,
      complete,
      usable: hostRecords.length > 0,
      disabledReason: error || (hostRecords.length ? null : `No usable usage data reported by ${hostId}`),
    };
  });
  const hostProblem = hosts.some((host) => {
    const hasSelectedRecords = records.some((record) => record.hostId === host.hostId);
    if (!activeHostIds.has(host.hostId)) return hasSelectedRecords && Boolean(storageErrorsByHost.get(host.hostId));
    return Boolean(host.error) || host.stale || !host.included || (!host.local && !host.complete)
      || (!host.local && !["ok", "online"].includes(host.status));
  });
  const usageStatus = usageSources.length === 0 ? "disabled" : hostProblem ? (records.length ? "partial" : "error") : "ok";
  const usageResult = usageSources.length ? {
    status: usageStatus,
    error: hosts.find((host) => Boolean(host.error))?.error ?? null,
    source: "filesystem",
    sources: usageSources.map((provider) => ({ provider, status: usageStatus, error: hosts.find((host) => Boolean(host.error))?.error ?? null })),
    hosts,
    records,
    ...summary,
  } : { status: "disabled", daily: [], byModel: [], byProvider: [], totalCostUsd: 0, totalTokens: 0, error: null, source: null, sources: [], hosts: [], records: [] };
  const usage = {
    ...usageResult,
    mqtt: { configured: remoteState.configured, connection: remoteState.connection },
    hosts: usageSources.length ? hosts : [],
  };
  return { range, usage: { ...usage, from: range.from, to: range.to, providers: usageSources } };
}

async function dashboard(url: URL, config: AppConfig) {
  const range = localDateRange(Number(url.searchParams.get("days") || 30), usageTimezone, url.searchParams.get("range") || "relative");
  const cacheKey = `${range.from}:${range.to}:${range.timeZone}`;
  const forceRefresh = url.searchParams.get("refresh") === "1";
  const cached = dashboardCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.cachedAt < 300_000) return { ...cached.value, cache: { fetchedAt: cached.fetchedAt, expiresAt: new Date(cached.cachedAt + 300_000).toISOString() } };
  const { usage } = await buildUsage(url, config);
  const enabled = config.providerOrder.filter((id) => config.providers[id].enabled);
  const quotaEntries = await Promise.all(enabled.map(async (id) => [id, await getQuota(id, forceRefresh)]));
  const quotas = Object.fromEntries(quotaEntries);
  const statuses = Object.fromEntries(await Promise.all(config.providerOrder.map(async (id) => [id, providerStatus({ id, config: config.providers[id], result: quotas[id] ?? { configured: await isProviderConfigured(id) } })])));
  const value = { version: buildInfo.version, apiVersion: 1, serverNow: new Date().toISOString(), timezone: range.timeZone, providerOrder: config.providerOrder, providers: statuses, quotas, usage };
  dashboardCache.set(cacheKey, { cachedAt: Date.now(), fetchedAt: value.serverNow, value });
  return { ...value, cache: { fetchedAt: value.serverNow, expiresAt: new Date(Date.now() + 300_000).toISOString() } };
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}

async function body(request: import("node:http").IncomingMessage): Promise<RequestBody> {
  let value = "";
  for await (const chunk of request) value += chunk;
  if (value.length > 100_000) throw new Error("Request body is too large");
  return value ? JSON.parse(value) : {};
}

function publishRemoteRefresh(category: "hot" | "cold", from: string, to: string, mode: "online" | "offline"): void {
  for (const hostId of Object.keys(remoteUsageStore.getSnapshot().hosts)) {
    if (hostId === localHostId) continue;
    void remoteUsageStore.publishCommand(hostId, { requestId: randomUUID(), category, from, to, mode });
  }
}

async function handleApi(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, url: URL): Promise<void> {
  const config = await loadConfig();
  if (request.method === "GET" && url.pathname === "/api/v1/providers") {
    const statuses = Object.fromEntries(await Promise.all(config.providerOrder.map(async (id) => [id, providerStatus({ id, config: config.providers[id], result: { configured: await isProviderConfigured(id) } })])));
    return json(response, 200, { version: buildInfo.version, apiVersion: 1, providerOrder: config.providerOrder, providers: statuses, usageSources: config.usageSources });
  }
  if (request.method === "GET" && url.pathname === "/api/v1/usage") {
    const { range, usage } = await buildUsage(url, config);
    return json(response, 200, { version: buildInfo.version, apiVersion: 1, serverNow: new Date().toISOString(), timezone: usageTimezone, from: range.from, to: range.to, usage });
  }
  if (request.method === "GET" && url.pathname === "/api/v1/dashboard") return json(response, 200, await dashboard(url, config));
  if (request.method === "POST" && url.pathname === "/api/v1/usage/refresh") {
    const range = localDateRange(2, usageTimezone);
    queueLocalHot();
    publishRemoteRefresh("hot", range.from, range.to, "online");
    return json(response, 202, { accepted: true, category: "hot", from: range.from, to: range.to });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/usage/cold") {
    const maxColdRangeDays = 370;
    const input = await body(request);
    const defaultRange = rollingDateRange(usageTimezone);
    const from = input.from === undefined ? defaultRange.from : input.from;
    const to = input.to === undefined ? defaultRange.to : input.to;
    if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) return json(response, 400, { error: "from and to must be an ordered YYYY-MM-DD range" });
    const rangeDays = Math.floor((Date.parse(`${to}T12:00:00.000Z`) - Date.parse(`${from}T12:00:00.000Z`)) / 86_400_000) + 1;
    if (rangeDays > maxColdRangeDays) return json(response, 400, { error: `cold range must not exceed ${maxColdRangeDays} days` });
    const mode = input.mode === undefined ? "offline" : input.mode;
    if (mode !== "online" && mode !== "offline") return json(response, 400, { error: "mode must be online or offline" });
    if (input.hostId !== undefined && (typeof input.hostId !== "string" || sanitizeHostId(input.hostId) !== input.hostId)) return json(response, 400, { error: "hostId is invalid" });
    const hostId = input.hostId as string | undefined;
    if (!hostId || hostId === localHostId) {
      const queueResult = queueLocalCold(from, to, mode === "offline");
      if (queueResult === "shutdown") return json(response, 503, { error: "Server is shutting down" });
      if (queueResult === "full") console.warn(`[server] Local cold queue full (${MAX_LOCAL_COLD_QUEUE}); dropped request for ${from}..${to} (${hostId ? `host ${hostId}` : "all hosts"})`);
    }
    if (hostId && hostId !== localHostId) void remoteUsageStore.publishCommand(hostId, { requestId: randomUUID(), category: "cold", from, to, mode });
    if (!hostId) publishRemoteRefresh("cold", from, to, mode);
    return json(response, 202, { accepted: true, category: "cold", from, to, mode, hostId: hostId || "all" });
  }
  if (request.method === "GET" && url.pathname === "/api/v1/quotas") {
    const enabled = config.providerOrder.filter((id) => config.providers[id].enabled);
    const entries = await Promise.all(enabled.map(async (id) => [id, await getQuota(id, url.searchParams.get("refresh") === "1")]));
    return json(response, 200, { version: buildInfo.version, apiVersion: 1, serverNow: new Date().toISOString(), quotas: Object.fromEntries(entries) });
  }
  if (request.method === "GET" && url.pathname === "/api/v1/widget-summary") {
    const enabled = config.providerOrder.filter((id) => config.providers[id].enabled);
    const entries = await Promise.all(enabled.map(async (id) => [id, await getQuota(id)]));
    return json(response, 200, { version: buildInfo.version, apiVersion: 1, serverNow: new Date().toISOString(), providers: Object.fromEntries(entries) });
  }
  const providerMatch = url.pathname.match(/^\/api\/v1\/providers\/([^/]+)\/(enabled|test)$/);
  if (providerMatch && PROVIDER_IDS.includes(providerMatch[1] as ProviderId)) {
    const id = providerMatch[1] as ProviderId;
    if (request.method === "PUT" && providerMatch[2] === "enabled") {
      const input = await body(request);
      if (typeof input.enabled !== "boolean") return json(response, 400, { error: "enabled must be boolean" });
      config.providers[id].enabled = input.enabled;
      await saveConfig(config);
      if (!input.enabled) quotaCache.delete(id);
      dashboardCache.clear();
      return json(response, 200, { provider: providerStatus({ id, config: config.providers[id] }) });
    }
    if (request.method === "POST" && providerMatch[2] === "test") {
      if (!config.providers[id].enabled) return json(response, 409, { error: "Provider is disabled" });
      return json(response, 200, { provider: providerStatus({ id, config: config.providers[id], result: await getQuota(id, true) }), quota: await getQuota(id) });
    }
  }
  if (request.method === "PUT" && url.pathname === "/api/v1/providers/order") {
    const input = await body(request);
    if (!Array.isArray(input.order) || input.order.length !== PROVIDER_IDS.length || new Set(input.order).size !== PROVIDER_IDS.length || input.order.some((id) => typeof id !== "string" || !PROVIDER_IDS.includes(id as ProviderId))) {
      return json(response, 400, { error: "order must contain each provider exactly once" });
    }
    config.providerOrder = normalizeProviderOrder(input.order);
    await saveConfig(config);
    dashboardCache.clear();
    return json(response, 200, { providerOrder: config.providerOrder });
  }
  const usageMatch = url.pathname.match(/^\/api\/v1\/usage-sources\/([^/]+)\/enabled$/);
  if (usageMatch && USAGE_SOURCE_IDS.includes(usageMatch[1] as UsageSourceId) && request.method === "PUT") {
    const input = await body(request);
    if (typeof input.enabled !== "boolean") return json(response, 400, { error: "enabled must be boolean" });
    const id = usageMatch[1] as UsageSourceId;
    config.usageSources[id].enabled = input.enabled;
    await saveConfig(config);
    dashboardCache.clear();
    return json(response, 200, { source: id, enabled: input.enabled });
  }
  return json(response, 404, { error: "Not found" });
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

async function serveStatic(response: import("node:http").ServerResponse, pathname: string): Promise<void> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const file = resolve(publicRoot, `.${normalize(requested)}`);
  if (!file.startsWith(`${publicRoot}/`)) return json(response, 403, { error: "Forbidden" });
  try {
    const content = await readFile(file);
    response.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Cache-Control": extname(file) === ".html" ? "no-cache" : "public, max-age=3600" });
    response.end(content);
  } catch {
    if (pathname !== "/") return serveStatic(response, "/index.html");
    json(response, 404, { error: "Not found" });
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
    else await serveStatic(response, url.pathname);
  } catch (error) {
    const message = error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "Internal server error";
    json(response, 500, { error: message });
  }
});

server.listen(port, process.env.HOST || "127.0.0.1", () => {
  console.log(`Quota dashboard listening on http://${process.env.HOST || "127.0.0.1"}:${port}`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (localHotTimer) clearInterval(localHotTimer);
  if (localColdTimer) clearInterval(localColdTimer);
  localHotTimer = null;
  localColdTimer = null;
  await localHotSchedulePromise?.catch(() => undefined);
  await localColdSchedulePromise?.catch(() => undefined);
  await Promise.all([localHotPromise, localColdPromise].map((job) => job?.catch(() => undefined)));
  await remoteUsageStore.stop().catch((error) => console.error(`Remote MQTT shutdown failed: ${error instanceof Error ? error.message : String(error)}`));
  server.close(() => process.exit(0));
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
