import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { type ProviderId, clampPercent, formatMoney, numberOrNull, usageWindow, type ProviderResult, type QuotaWindow } from "./core.js";

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" ? value as JsonObject : {};
}

function errorMessage(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : fallback;
}

const authPath = process.env.OPENCODE_AUTH_PATH || join(homedir(), ".local", "share", "opencode", "auth.json");

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function authValue(auth: unknown, aliases: string[]): string | null {
  for (const alias of aliases) {
    const entry = objectValue(auth)[alias];
    if (typeof entry === "string" && entry) return entry;
    if (entry && typeof entry === "object") {
      const object = objectValue(entry);
      const value = object.key || object.token || object.apiKey;
      if (typeof value === "string" && value) return value;
    }
  }
  return null;
}

function result(configured: boolean, windows: QuotaWindow[] = [], error: string | null = null): ProviderResult {
  return {
    configured,
    status: error ? "error" : "ok",
    error,
    fetchedAt: new Date().toISOString(),
    windows,
  };
}

const OLLAMA_WEEK_SECONDS = 7 * 24 * 60 * 60;
const OLLAMA_SESSION_START_HOURS = [0, 4, 9, 14, 19];
const OLLAMA_WEEK_ANCHOR = Date.parse("1970-01-05T00:00:00Z");

function nextOllamaReset(now: number, windowSeconds: number): string {
  const elapsed = Math.floor((now - OLLAMA_WEEK_ANCHOR) / (windowSeconds * 1000));
  return new Date(OLLAMA_WEEK_ANCHOR + (elapsed + 1) * windowSeconds * 1000).toISOString();
}

function nextOllamaSessionWindow(now: number): { resetAt: string; windowSeconds: number } {
  const current = new Date(now);
  const dayStart = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
  const resetTimes = OLLAMA_SESSION_START_HOURS.map((hour) => dayStart + hour * 60 * 60 * 1000);
  const nextIndex = resetTimes.findIndex((resetAt) => resetAt > now);
  const resetAt = nextIndex === -1 ? dayStart + 24 * 60 * 60 * 1000 : resetTimes[nextIndex];
  const startAt = nextIndex === -1 ? resetTimes[resetTimes.length - 1] : nextIndex === 0 ? dayStart : resetTimes[nextIndex - 1];
  return { resetAt: new Date(resetAt).toISOString(), windowSeconds: (resetAt - startAt) / 1000 };
}

export function parseOllamaUsage(payload: unknown, now = Date.now()): QuotaWindow[] {
  const limits = objectValue(objectValue(payload).limits);
  const windows: QuotaWindow[] = [];
  const sessionUsage = numberOrNull(objectValue(limits.session).usage);
  if (sessionUsage !== null) {
    const sessionWindow = nextOllamaSessionWindow(now);
    windows.push(usageWindow({
      name: "session",
      usedPercent: Math.round(sessionUsage * 10000) / 100,
      resetAt: sessionWindow.resetAt,
      windowSeconds: sessionWindow.windowSeconds,
    }));
  }
  for (const [name, seconds] of [["weekly", OLLAMA_WEEK_SECONDS]] as const) {
    const usage = numberOrNull(objectValue(limits[name]).usage);
    if (usage === null) continue;
    windows.push(usageWindow({
      name,
      usedPercent: Math.round(usage * 10000) / 100,
      resetAt: nextOllamaReset(now, seconds),
      windowSeconds: seconds,
    }));
  }
  return windows;
}

async function fetchOllama(): Promise<ProviderResult> {
  const key = process.env.OLLAMA_API_KEY?.trim();
  if (!key) return result(false, [], "Ollama Cloud API key is not configured");
  try {
    const response = await fetch("https://ollama.com/api/usage", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return result(true, [], `Ollama returned HTTP ${response.status}`);
    const windows = parseOllamaUsage(await response.json());
    return windows.length ? result(true, windows) : result(true, [], "Ollama usage response did not include a limit window");
  } catch (error) {
    return result(true, [], errorMessage(error, "Ollama request failed"));
  }
}

async function fetchOpenRouter(): Promise<ProviderResult> {
  const auth = await readJson(authPath);
  const key = process.env.OPENROUTER_API_KEY?.trim() || authValue(auth, ["openrouter"]);
  if (!key) return result(false, [], "OpenRouter API key is not configured");
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return result(true, [], `OpenRouter returned HTTP ${response.status}`);
    const data = objectValue(objectValue(await response.json()).data);
    const usage = numberOrNull(data.usage);
    const rawLimit = numberOrNull(data.limit);
    // OpenRouter uses zero/null for an unlimited key. It is not a usable cap.
    const limit = rawLimit !== null && rawLimit > 0 ? rawLimit : null;
    const reportedRemaining = numberOrNull(data.limit_remaining);
    const remaining = limit === null ? null : reportedRemaining ?? (usage !== null ? Math.max(0, limit - usage) : null);
    const percent = limit !== null && usage !== null ? (usage / limit) * 100 : null;
    let balance = null;
    try {
      const creditsResponse = await fetch("https://openrouter.ai/api/v1/credits", { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (creditsResponse.ok) {
        const credits = objectValue(objectValue(await creditsResponse.json()).data);
        const totalCredits = numberOrNull(credits.total_credits);
        const totalUsage = numberOrNull(credits.total_usage);
        if (totalCredits !== null && totalUsage !== null) balance = Math.max(0, totalCredits - totalUsage);
      }
    } catch {
      // The key endpoint remains useful when the credits endpoint is unavailable.
    }
    const valueLabel = balance !== null
      ? `${formatMoney(balance)} balance · ${formatMoney(usage ?? 0)} spent`
      : remaining !== null
      ? `${formatMoney(remaining)} remaining${limit !== null ? ` of ${formatMoney(limit)}` : ""}`
      : usage !== null
        ? `${formatMoney(usage)} spent · no spending limit`
        : "No spending limit configured";
    return result(true, [usageWindow({
      name: "credits",
      usedPercent: percent,
      usedValue: usage,
      limitValue: limit,
      valueLabel,
      balanceLabel: balance !== null ? `${formatMoney(balance)} balance` : null,
      spentLabel: usage !== null ? `${formatMoney(usage)} spent (all time)` : null,
    })]);
  } catch (error) {
    return result(true, [], errorMessage(error, "OpenRouter request failed"));
  }
}

function parseNumber(body: string, field: string): number | null {
  const match = body.match(new RegExp(`["']?${field}["']?\\s*:\\s*["']?(-?\\d+(?:\\.\\d+)?)`));
  const value = match ? Number(match[1]) : null;
  return Number.isFinite(value) ? value : null;
}

function parseOpenCodeGo(body: string, now = Date.now()): QuotaWindow[] {
  const normalized = body.replaceAll("&quot;", '"').replaceAll("\\u0022", '"').replaceAll('\\"', '"');
  const patterns = { "5h": ["rollingUsage", 18_000], weekly: ["weeklyUsage", 604_800], monthly: ["monthlyUsage", 2_592_000] };
  const windows = [];
  for (const [name, [field, seconds]] of Object.entries(patterns)) {
    const escaped = String(field).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = normalized.match(new RegExp(`["']?${escaped}["']?\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{([^{}]*)\\}`, "s"));
    if (!match) continue;
    const percent = parseNumber(match[1], "usagePercent");
    const resetInSec = parseNumber(match[1], "resetInSec");
    if (percent === null || resetInSec === null) continue;
    windows.push(usageWindow({ name, usedPercent: clampPercent(percent ?? NaN), resetAt: new Date(now + Math.max(0, resetInSec) * 1000).toISOString(), windowSeconds: Number(seconds) }));
  }
  return windows;
}

async function fetchOpenCodeGo(): Promise<ProviderResult> {
  const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
  const authCookie = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
  if (!workspaceId || !authCookie) return result(false, [], "OpenCode Go workspace ID and auth cookie are required");
  try {
    const response = await fetch(`https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`, { headers: { Accept: "text/html,application/xhtml+xml", Cookie: `auth=${authCookie}`, "User-Agent": "QuotaDashboard/1.0" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) return result(true, [], "OpenCode Go authentication failed");
    if (!response.ok) return result(true, [], `OpenCode Go returned HTTP ${response.status}`);
    const windows = parseOpenCodeGo(await response.text());
    return windows.length ? result(true, windows) : result(true, [], "OpenCode Go usage data could not be parsed");
  } catch (error) {
    return result(true, [], errorMessage(error, "OpenCode Go request failed"));
  }
}

async function fetchCodex(): Promise<ProviderResult> {
  const path = process.env.CODEX_AUTH_PATH || join(homedir(), ".codex", "auth.json");
  const auth = await readJson(path);
  const tokens = objectValue(objectValue(auth).tokens);
  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : null;
  const accountId = typeof tokens.account_id === "string" ? tokens.account_id : null;
  if (!accessToken || !accountId) return result(false, [], "Codex ChatGPT OAuth credentials are not configured");
  try {
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "ChatGPT-Account-Id": accountId,
        Originator: "Codex",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return result(true, [], `Codex quota returned HTTP ${response.status}`);
    const payload = objectValue(await response.json());
    const windows = parseCodexQuota(payload);
    if (!windows.length) return result(true, [], "Codex quota response did not include a rate-limit window");
    return {
      ...result(true, windows),
      planType: typeof payload.plan_type === "string" ? payload.plan_type : null,
      subscriptionActiveUntil: typeof payload.subscription_active_until === "string" ? payload.subscription_active_until : null,
    };
  } catch (error) {
    return result(true, [], errorMessage(error, "Codex quota request failed"));
  }
}

export function parseCodexQuota(payload: unknown): QuotaWindow[] {
  const data = objectValue(payload);
  const rateLimit = objectValue(data.rate_limit ?? data.rateLimit);
  if (!rateLimit || typeof rateLimit !== "object") return [];
  const windows = [];
  for (const [name, rawValue] of [["primary", rateLimit.primary_window], ["secondary", rateLimit.secondary_window]] as const) {
    const value = objectValue(rawValue);
    if (!Object.keys(value).length) continue;
    const resetAt = numberOrNull(value.reset_at);
    windows.push(usageWindow({
      name,
      usedPercent: numberOrNull(value.used_percent),
      resetAt: resetAt === null ? null : new Date(resetAt * 1000).toISOString(),
      windowSeconds: numberOrNull(value.limit_window_seconds),
      valueLabel: null,
    }));
  }
  return windows;
}

export const PROVIDER_FETCHERS: Record<ProviderId, () => Promise<ProviderResult>> = { codex: fetchCodex, openrouter: fetchOpenRouter, "opencode-go": fetchOpenCodeGo, ollama: fetchOllama };

export async function isProviderConfigured(id: ProviderId): Promise<boolean> {
  if (id === "openrouter") {
    const auth = await readJson(authPath);
    return Boolean(process.env.OPENROUTER_API_KEY?.trim() || authValue(auth, ["openrouter"]));
  }
  if (id === "opencode-go") return Boolean(process.env.OPENCODE_GO_WORKSPACE_ID?.trim() && process.env.OPENCODE_GO_AUTH_COOKIE?.trim());
  if (id === "ollama") return Boolean(process.env.OLLAMA_API_KEY?.trim());
  if (id === "codex") {
    const auth = await readJson(process.env.CODEX_AUTH_PATH || join(homedir(), ".codex", "auth.json"));
    const tokens = objectValue(objectValue(auth).tokens);
    return Boolean(tokens.access_token && tokens.account_id);
  }
  return false;
}

export { parseOpenCodeGo };
