import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type AppConfig, type ProviderId, type UsageSourceId, DEFAULT_CONFIG, PROVIDER_IDS, USAGE_SOURCE_IDS, localDateRange, normalizeConfig, providerStatus } from "./lib/core.js";
import type { ProviderResult } from "./lib/core.js";
import { isProviderConfigured, PROVIDER_FETCHERS } from "./lib/providers.js";
import { readUsageSources } from "./lib/usage.js";

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
const quotaCache = new Map<ProviderId, { cachedAt: number; value: ProviderResult }>();
const dashboardCache = new Map<string, { cachedAt: number; fetchedAt: string; value: DashboardValue }>();
const buildInfo = await loadBuildInfo();

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
  providers: Record<string, unknown>;
  quotas: Record<string, ProviderResult>;
  usage: Record<string, unknown>;
};

type RequestBody = { enabled?: unknown };

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

async function dashboard(url: URL, config: AppConfig) {
  const range = localDateRange(Number(url.searchParams.get("days") || 30), url.searchParams.get("timezone") || undefined, url.searchParams.get("range") || "relative");
  const cacheKey = `${range.from}:${range.to}:${range.timeZone}`;
  const forceRefresh = url.searchParams.get("refresh") === "1";
  const cached = dashboardCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.cachedAt < 300_000) return { ...cached.value, cache: { fetchedAt: cached.fetchedAt, expiresAt: new Date(cached.cachedAt + 300_000).toISOString() } };
  const enabled = PROVIDER_IDS.filter((id) => config.providers[id].enabled);
  const quotaEntries = await Promise.all(enabled.map(async (id) => [id, await getQuota(id, true)]));
  const quotas = Object.fromEntries(quotaEntries);
  const usageSources = USAGE_SOURCE_IDS.filter((id) => config.usageSources[id].enabled);
  const usage = usageSources.length ? await readUsageSources(usageSources, range) : { status: "disabled", daily: [], byModel: [], byProvider: [], totalCostUsd: 0, totalTokens: 0, error: null, source: null, sources: [] };
  const statuses = Object.fromEntries(await Promise.all(PROVIDER_IDS.map(async (id) => [id, providerStatus({ id, config: config.providers[id], result: quotas[id] ?? { configured: await isProviderConfigured(id) } })])));
  const value = { version: buildInfo.version, apiVersion: 1, serverNow: new Date().toISOString(), timezone: range.timeZone, providers: statuses, quotas, usage: { ...usage, from: range.from, to: range.to, providers: usageSources } };
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

async function handleApi(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, url: URL): Promise<void> {
  const config = await loadConfig();
  if (request.method === "GET" && url.pathname === "/api/v1/providers") {
    const statuses = Object.fromEntries(await Promise.all(PROVIDER_IDS.map(async (id) => [id, providerStatus({ id, config: config.providers[id], result: { configured: await isProviderConfigured(id) } })])));
    return json(response, 200, { version: buildInfo.version, apiVersion: 1, providers: statuses, usageSources: config.usageSources });
  }
  if (request.method === "GET" && url.pathname === "/api/v1/dashboard") return json(response, 200, await dashboard(url, config));
  if (request.method === "GET" && url.pathname === "/api/v1/quotas") {
    const enabled = PROVIDER_IDS.filter((id) => config.providers[id].enabled);
    const entries = await Promise.all(enabled.map(async (id) => [id, await getQuota(id, url.searchParams.get("refresh") === "1")]));
    return json(response, 200, { version: buildInfo.version, apiVersion: 1, serverNow: new Date().toISOString(), quotas: Object.fromEntries(entries) });
  }
  if (request.method === "GET" && url.pathname === "/api/v1/widget-summary") {
    const enabled = PROVIDER_IDS.filter((id) => config.providers[id].enabled);
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
