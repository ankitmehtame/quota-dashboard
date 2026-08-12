import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { clampPercent, formatMoney, numberOrNull, usageWindow } from "./core.js";

const authPath = process.env.OPENCODE_AUTH_PATH || join(homedir(), ".local", "share", "opencode", "auth.json");

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function authValue(auth, aliases) {
  for (const alias of aliases) {
    const entry = auth?.[alias];
    if (typeof entry === "string" && entry) return entry;
    if (entry && typeof entry === "object") {
      const value = entry.key || entry.token || entry.apiKey;
      if (typeof value === "string" && value) return value;
    }
  }
  return null;
}

function result(configured, windows = [], error = null) {
  return {
    configured,
    status: error ? "error" : "ok",
    error,
    fetchedAt: new Date().toISOString(),
    windows,
  };
}

async function fetchOpenRouter() {
  const auth = await readJson(authPath);
  const key = process.env.OPENROUTER_API_KEY?.trim() || authValue(auth, ["openrouter"]);
  if (!key) return result(false, [], "OpenRouter API key is not configured");
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return result(true, [], `OpenRouter returned HTTP ${response.status}`);
    const data = (await response.json())?.data ?? {};
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
        const credits = (await creditsResponse.json())?.data ?? {};
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
    return result(true, [], error?.message || "OpenRouter request failed");
  }
}

async function fetchTogether() {
  const auth = await readJson(authPath);
  const key = process.env.TOGETHER_API_KEY?.trim() || authValue(auth, ["togetherai", "together"]);
  if (!key) return result(false, [], "Together AI API key is not configured");
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "QuotaDashboard/1.0" };
  try {
    const whoami = await fetch("https://api.together.ai/v1/whoami", { headers, signal: AbortSignal.timeout(15_000) });
    if (!whoami.ok) return result(true, [], `Together AI whoami returned HTTP ${whoami.status}`);
    const identity = await whoami.json();
    const organization = process.env.TOGETHER_ORGANIZATION_ID?.trim() || identity?.organization_id || identity?.organization?.id;
    if (!organization) return result(true, [], "Together AI response did not include an organization");
    const balance = await fetch(`https://api.together.ai/api/billing/organizations/${encodeURIComponent(organization)}/ongoing-balance`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!balance.ok) return result(true, [], `Together AI balance returned HTTP ${balance.status}`);
    const payload = await balance.json();
    const remainingCents = numberOrNull(payload?.ongoingBalance?.value_cents ?? payload?.totalOngoingBalanceCents);
    const spentCents = numberOrNull(payload?.ongoingBillingCycleUsage?.value_cents);
    const remaining = remainingCents === null ? null : remainingCents / 100;
    const spent = spentCents === null ? null : spentCents / 100;
    const valueLabel = remaining !== null && spent !== null ? `${formatMoney(remaining)} left · ${formatMoney(spent)} spent` : remaining !== null ? `${formatMoney(remaining)} left` : null;
    return result(true, [usageWindow({
      name: "credits",
      valueLabel,
      balanceLabel: remaining !== null ? `${formatMoney(remaining)} balance` : null,
      spentLabel: spent !== null ? `${formatMoney(spent)} spent (this billing cycle)` : null,
      source: "provider",
    })]);
  } catch (error) {
    return result(true, [], error?.message || "Together AI request failed");
  }
}

function parseNumber(body, field) {
  const match = body.match(new RegExp(`["']?${field}["']?\\s*:\\s*["']?(-?\\d+(?:\\.\\d+)?)`));
  const value = match ? Number(match[1]) : null;
  return Number.isFinite(value) ? value : null;
}

function parseOpenCodeGo(body, now = Date.now()) {
  const normalized = body.replaceAll("&quot;", '"').replaceAll("\\u0022", '"').replaceAll('\\"', '"');
  const patterns = { "5h": ["rollingUsage", 18_000], weekly: ["weeklyUsage", 604_800], monthly: ["monthlyUsage", 2_592_000] };
  const windows = [];
  for (const [name, [field, seconds]] of Object.entries(patterns)) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = normalized.match(new RegExp(`["']?${escaped}["']?\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{([^{}]*)\\}`, "s"));
    if (!match) continue;
    const percent = parseNumber(match[1], "usagePercent");
    const resetInSec = parseNumber(match[1], "resetInSec");
    if (percent === null || resetInSec === null) continue;
    windows.push(usageWindow({ name, usedPercent: clampPercent(percent), resetAt: new Date(now + Math.max(0, resetInSec) * 1000).toISOString(), windowSeconds: seconds }));
  }
  return windows;
}

async function fetchOpenCodeGo() {
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
    return result(true, [], error?.message || "OpenCode Go request failed");
  }
}

async function fetchCodex() {
  const path = process.env.CODEX_AUTH_PATH || join(homedir(), ".codex", "auth.json");
  const auth = await readJson(path);
  const accessToken = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id;
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
    const payload = await response.json();
    const windows = parseCodexQuota(payload);
    if (!windows.length) return result(true, [], "Codex quota response did not include a rate-limit window");
    return { ...result(true, windows), planType: payload?.plan_type ?? null, subscriptionActiveUntil: payload?.subscription_active_until ?? null };
  } catch (error) {
    return result(true, [], error?.message || "Codex quota request failed");
  }
}

export function parseCodexQuota(payload) {
  const rateLimit = payload?.rate_limit ?? payload?.rateLimit;
  if (!rateLimit || typeof rateLimit !== "object") return [];
  const windows = [];
  for (const [name, value] of [["primary", rateLimit.primary_window], ["secondary", rateLimit.secondary_window]]) {
    if (!value || typeof value !== "object") continue;
    const resetAt = numberOrNull(value.reset_at);
    windows.push(usageWindow({
      name,
      usedPercent: numberOrNull(value.used_percent),
      resetAt: resetAt === null ? null : new Date(resetAt * 1000).toISOString(),
      windowSeconds: value.limit_window_seconds,
      valueLabel: null,
    }));
  }
  return windows;
}

export const PROVIDER_FETCHERS = { codex: fetchCodex, openrouter: fetchOpenRouter, togetherai: fetchTogether, "opencode-go": fetchOpenCodeGo };

export async function isProviderConfigured(id) {
  if (id === "openrouter" || id === "togetherai") {
    const auth = await readJson(authPath);
    return Boolean(id === "openrouter"
      ? process.env.OPENROUTER_API_KEY?.trim() || authValue(auth, ["openrouter"])
      : process.env.TOGETHER_API_KEY?.trim() || authValue(auth, ["togetherai", "together"]));
  }
  if (id === "opencode-go") return Boolean(process.env.OPENCODE_GO_WORKSPACE_ID?.trim() && process.env.OPENCODE_GO_AUTH_COOKIE?.trim());
  if (id === "codex") {
    const auth = await readJson(process.env.CODEX_AUTH_PATH || join(homedir(), ".codex", "auth.json"));
    return Boolean(auth?.tokens?.access_token && auth?.tokens?.account_id);
  }
  return false;
}

export { parseOpenCodeGo };
