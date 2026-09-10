import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { type ProviderId, clampPercent, formatMoney, numberOrNull, usageWindow, type ProviderResult, type QuotaWindow, type RateLimitResetCredit } from "./core.js";

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" ? value as JsonObject : {};
}

function errorMessage(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : fallback;
}

const authPath = process.env.OPENCODE_AUTH_PATH || join(homedir(), ".local", "share", "opencode", "auth.json");
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDITS_ENDPOINT = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

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
const OLLAMA_SESSION_SECONDS = 5 * 60 * 60;
const OLLAMA_SESSION_ANCHOR = Date.parse("1970-01-01T00:00:00Z");
const OLLAMA_WEEK_ANCHOR = Date.parse("1970-01-05T00:00:00Z");

function nextOllamaReset(now: number, windowSeconds: number, anchor: number): string {
  const elapsed = Math.floor((now - anchor) / (windowSeconds * 1000));
  return new Date(anchor + (elapsed + 1) * windowSeconds * 1000).toISOString();
}

function ollamaResetAt(value: JsonObject, now: number, windowSeconds: number, anchor: number): string {
  const reported = value.reset_at ?? value.resetAt ?? value.reset;
  if (typeof reported === "string" && Number.isFinite(Date.parse(reported))) return new Date(reported).toISOString();
  const timestamp = numberOrNull(reported);
  if (timestamp !== null) return new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp).toISOString();
  return nextOllamaReset(now, windowSeconds, anchor);
}

export function parseOllamaUsage(payload: unknown, now = Date.now()): QuotaWindow[] {
  const limits = objectValue(objectValue(payload).limits);
  const windows: QuotaWindow[] = [];
  for (const [name, seconds, anchor] of [["session", OLLAMA_SESSION_SECONDS, OLLAMA_SESSION_ANCHOR], ["weekly", OLLAMA_WEEK_SECONDS, OLLAMA_WEEK_ANCHOR]] as const) {
    const limit = objectValue(limits[name]);
    const rawPercent = numberOrNull(limit.used_percent);
    const rawUsage = numberOrNull(limit.usage ?? limit.used);
    if (rawPercent === null && rawUsage === null) continue;
    const usage = rawPercent !== null ? rawPercent / 100 : rawUsage! > 1 ? rawUsage! / 100 : rawUsage!;
    windows.push(usageWindow({
      name,
      usedPercent: Math.round(usage * 10000) / 100,
      resetAt: ollamaResetAt(limit, now, seconds, anchor),
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

type CodexCredentials = { accessToken: string; accountId: string };

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function codexHeaders({ accessToken, accountId }: CodexCredentials): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "ChatGPT-Account-Id": accountId,
    Originator: "codex_cli_rs",
    Accept: "application/json",
    "User-Agent": "codex_cli_rs",
  };
}

async function refreshCodexCredentials(path: string, auth: unknown, tokens: JsonObject, accountId: string): Promise<CodexCredentials> {
  const refreshToken = nonEmptyString(tokens.refresh_token);
  if (!refreshToken) throw new Error("Codex access token expired and no refresh token is available; run codex login again");
  const response = await fetch(CODEX_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": "codex_cli_rs" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CODEX_OAUTH_CLIENT_ID }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const suffix = response.status === 400 || response.status === 401 ? "; run codex login again" : "";
    throw new Error(`Codex OAuth refresh returned HTTP ${response.status}${suffix}`);
  }
  const refreshed = objectValue(await response.json());
  const accessToken = nonEmptyString(refreshed.access_token);
  if (!accessToken) throw new Error("Codex OAuth refresh response did not include an access token; run codex login again");
  const updatedTokens: JsonObject = { ...tokens, access_token: accessToken };
  const rotatedRefreshToken = nonEmptyString(refreshed.refresh_token);
  if (rotatedRefreshToken) updatedTokens.refresh_token = rotatedRefreshToken;
  const idToken = nonEmptyString(refreshed.id_token);
  if (idToken) updatedTokens.id_token = idToken;
  const updatedAuth = { ...objectValue(auth), tokens: updatedTokens, last_refresh: new Date().toISOString() };
  await writeFile(path, `${JSON.stringify(updatedAuth, null, 2)}\n`, { mode: 0o600 });
  return { accessToken, accountId };
}

export async function fetchCodex(): Promise<ProviderResult> {
  const path = process.env.CODEX_AUTH_PATH || join(homedir(), ".codex", "auth.json");
  const auth = await readJson(path);
  const tokens = objectValue(objectValue(auth).tokens);
  const accessToken = nonEmptyString(tokens.access_token);
  const accountId = nonEmptyString(tokens.account_id);
  if (!accessToken || !accountId) return result(false, [], "Codex ChatGPT OAuth credentials are not configured");
  try {
    let credentials = { accessToken, accountId };
    let response = await fetch(CODEX_USAGE_ENDPOINT, { headers: codexHeaders(credentials), signal: AbortSignal.timeout(15_000) });
    if (response.status === 401) {
      credentials = await refreshCodexCredentials(path, auth, tokens, accountId);
      response = await fetch(CODEX_USAGE_ENDPOINT, { headers: codexHeaders(credentials), signal: AbortSignal.timeout(15_000) });
    }
    if (!response.ok) return result(true, [], `Codex quota returned HTTP ${response.status}`);
    const payload = objectValue(await response.json());
    const windows = parseCodexQuota(payload);
    if (!windows.length) return result(true, [], "Codex quota response did not include a rate-limit window");
    let resetCredits: RateLimitResetCredit[] = [];
    try {
      const creditsResponse = await fetch(CODEX_RESET_CREDITS_ENDPOINT, { headers: codexHeaders(credentials), signal: AbortSignal.timeout(15_000) });
      if (creditsResponse.ok) resetCredits = parseCodexResetCredits(await creditsResponse.json());
    } catch {
      // Reset credits are supplementary; quota windows remain useful if this request fails.
    }
    return {
      ...result(true, windows),
      planType: typeof payload.plan_type === "string" ? payload.plan_type : null,
      subscriptionActiveUntil: typeof payload.subscription_active_until === "string" ? payload.subscription_active_until : null,
      resetCredits,
    };
  } catch (error) {
    return result(true, [], errorMessage(error, "Codex quota request failed"));
  }
}

export function parseCodexResetCredits(payload: unknown): RateLimitResetCredit[] {
  const credits = objectValue(payload).credits;
  if (!Array.isArray(credits)) return [];
  return credits.flatMap((rawCredit) => {
    const credit = objectValue(rawCredit);
    if (credit.status !== "available" || typeof credit.id !== "string" || typeof credit.title !== "string") return [];
    return [{
      id: credit.id,
      title: credit.title,
      description: typeof credit.description === "string" ? credit.description : null,
      expiresAt: typeof credit.expires_at === "string" ? credit.expires_at : null,
    }];
  });
}

export function parseCodexQuota(payload: unknown): QuotaWindow[] {
  const data = objectValue(payload);
  const rateLimit = objectValue(data.rate_limit ?? data.rateLimit);
  if (!rateLimit || typeof rateLimit !== "object") return [];
  const windows = [];
  for (const [name, rawValue] of [["primary", rateLimit.primary_window], ["secondary", rateLimit.secondary_window]] as const) {
    const value = objectValue(rawValue);
    if (!Object.keys(value).length) continue;
    const windowSeconds = numberOrNull(value.limit_window_seconds);
    const resetAt = numberOrNull(value.reset_at);
    windows.push(usageWindow({
      name: windowSeconds === 18_000 ? "5-hour" : windowSeconds === 604_800 ? "weekly" : name,
      usedPercent: numberOrNull(value.used_percent),
      resetAt: resetAt === null ? null : new Date(resetAt * 1000).toISOString(),
      windowSeconds,
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
