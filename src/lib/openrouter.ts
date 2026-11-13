import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatMoney, usageWindow, type OpenRouterKeyResult, type ProviderResult, type QuotaWindow } from "./core.js";

export type KeyConfig = { id: string; label: string; key: string | null; error: string | null };
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const amount = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

// This type stays server-side. Never spread a KeyConfig into a response or log it.
export async function resolveOpenRouterKeys(env: NodeJS.ProcessEnv = process.env): Promise<KeyConfig[]> {
  let defaultKey = env.OPENROUTER_API_KEY?.trim() || null;
  if (!defaultKey) {
    try {
      const auth = object(JSON.parse(await readFile(env.OPENCODE_AUTH_PATH || join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8")));
      const entry = auth.openrouter;
      const value = typeof entry === "string" ? entry : object(entry).key || object(entry).token || object(entry).apiKey;
      if (typeof value === "string") defaultKey = value.trim() || null;
    } catch {
      // Preserve the optional legacy OpenCode credential fallback.
    }
  }
  const indices = [...new Set(Object.keys(env).flatMap((name) => {
    const match = /^OPENROUTER_KEY_([0-9]+)(?:_LABEL)?$/.exec(name);
    return match ? [match[1]] : [];
  }))].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const entries: KeyConfig[] = defaultKey ? [{ id: "default", label: "Default", key: defaultKey, error: null }] : [];
  for (const index of indices) {
    const key = env[`OPENROUTER_KEY_${index}`]?.trim() || null;
    const label = env[`OPENROUTER_KEY_${index}_LABEL`]?.trim() || "";
    entries.push({ id: `key-${index}`, label: label || `Key ${index}`, key,
      error: !key ? `OPENROUTER_KEY_${index} is missing or empty` : !label ? `OPENROUTER_KEY_${index}_LABEL is missing or empty` : null });
  }
  // Labels are operator-supplied, but still guard against accidentally pasting a credential.
  const secrets = entries.flatMap((entry) => entry.key ? [entry.key] : []);
  for (const entry of entries) {
    for (const secret of secrets) entry.label = entry.label.replaceAll(secret, "[redacted]");
    entry.label = entry.label.replace(/sk-or-[a-z0-9._-]+/gi, "[redacted]").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
  }
  return entries;
}

/** Resolve user-facing selectors without ever treating key numbers as identities. */
export function selectOpenRouterKeys(entries: KeyConfig[], selector: string | undefined, defaultSelection: "all" | "numbered"): KeyConfig[] {
  const value = selector?.trim();
  if (!value) return entries.filter((entry) => defaultSelection === "all" || entry.id !== "default");
  if (value.toLowerCase() === "none") return [];
  const requested = value.split(",").map((part) => part.trim());
  if (requested.some((part) => !/^(?:default|[0-9]+)$/.test(part))) throw new Error("Invalid OpenRouter key selector");
  const ids = new Set(requested.map((part) => part === "default" ? part : `key-${part}`));
  if ([...ids].some((id) => !entries.some((entry) => entry.id === id))) throw new Error("OpenRouter key selector references an unknown entry");
  return entries.filter((entry) => ids.has(entry.id));
}

export function filterInactiveOpenRouterKeys(entries: KeyConfig[], selector: string | undefined): KeyConfig[] {
  if (!selector?.trim() || selector.trim().toLowerCase() === "none") return entries;
  const inactive = selectOpenRouterKeys(entries, selector, "numbered");
  const inactiveSecrets = new Set(inactive.flatMap((entry) => entry.key ? [entry.key] : []));
  const inactiveIds = new Set(inactive.map((entry) => entry.id));
  return entries.filter((entry) => !inactiveIds.has(entry.id) && (!entry.key || !inactiveSecrets.has(entry.key)));
}

/** Distinguish visibility from polling: inactive selected keys retain their history. */
export function resolveOpenRouterUsageSelection(entries: KeyConfig[], selector: string | undefined, inactiveSelector: string | undefined): { visible: KeyConfig[]; active: KeyConfig[]; incomplete: number } {
  const selected = selectOpenRouterKeys(entries, selector, "numbered");
  const activeEntries = filterInactiveOpenRouterKeys(entries, inactiveSelector);
  // Incomplete pairs cannot be queried or labelled; skip them so one bad entry does not hide the others.
  const complete = selected.filter((entry) => !entry.error && entry.key);
  const labelsBySecret = new Map<string, string>();
  for (const entry of complete) {
    const label = labelsBySecret.get(entry.key!);
    if (label !== undefined && label !== entry.label) throw new Error("Duplicate OpenRouter key has conflicting labels");
    labelsBySecret.set(entry.key!, entry.label);
  }
  const unique = new Set<string>();
  const visible = complete.filter((entry) => {
    if (unique.has(entry.key!)) return false;
    unique.add(entry.key!);
    return true;
  });
  const activeSecrets = new Set(activeEntries.flatMap((entry) => entry.key ? [entry.key] : []));
  return { visible, active: visible.filter((entry) => activeSecrets.has(entry.key!)), incomplete: selected.length - complete.length };
}

function usageWindows(data: JsonObject, prefix = ""): QuotaWindow[] {
  return [["total", "usage"], ["daily (UTC)", "usage_daily"], ["weekly (UTC)", "usage_weekly"], ["monthly (UTC)", "usage_monthly"]].map(([name, field]) => {
    const used = amount(data[`${prefix}${field}`]);
    return usageWindow({ name, usedValue: used, unit: "USD", valueLabel: used === null ? "Not reported" : `${used > 0 && used < 0.01 ? "<$0.01" : formatMoney(used)} spent` });
  });
}

export function parseOpenRouterUsage(payload: unknown): Pick<OpenRouterKeyResult, "windows" | "byokWindows" | "spendingLimit" | "effectiveBudget"> | null {
  const data = object(object(payload).data);
  const windows = usageWindows(data);
  if (!windows.some((window) => window.usedValue !== null)) return null;
  const limit = amount(data.limit);
  const reset = data.limit_reset === null ? null : ["daily", "weekly", "monthly"].includes(String(data.limit_reset)) ? data.limit_reset as "daily" | "weekly" | "monthly" : "unknown";
  // Use reported remaining credit, not lifetime usage, for resettable or BYOK-inclusive limits.
  const remaining = typeof data.limit_remaining === "number" && Number.isFinite(data.limit_remaining) ? data.limit_remaining : null;
  const byokWindows = usageWindows(data, "byok_");
  const budget = object(data.effective_budget);
  const budgetLimit = amount(budget.limit_usd);
  const scopes = ["workspace_default_member", "workspace_default_key", "member", "api_key", "workspace", "key_limit"];
  const scope = typeof budget.scope === "string" && scopes.includes(budget.scope) ? budget.scope : "unknown";
  const budgetRemaining = typeof budget.remaining_usd === "number" && Number.isFinite(budget.remaining_usd) ? budget.remaining_usd : null;
  return {
    windows,
    ...(byokWindows.some((window) => window.usedValue !== null) ? { byokWindows } : {}),
    ...(limit !== null ? { spendingLimit: { limitUsd: limit, remainingUsd: remaining, reset,
      includesByok: typeof data.include_byok_in_limit === "boolean" ? data.include_byok_in_limit : null } } : {}),
    ...(budgetLimit !== null ? { effectiveBudget: { scope, limitUsd: budgetLimit, remainingUsd: budgetRemaining } } : {}),
  };
}

async function fetchKey(entry: KeyConfig): Promise<OpenRouterKeyResult> {
  const base: OpenRouterKeyResult = { id: entry.id, label: entry.label, configured: !entry.error && Boolean(entry.key),
    status: "error", error: entry.error, fetchedAt: new Date().toISOString(), windows: [] };
  if (entry.error || !entry.key) return base;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${entry.key}`, Accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { ...base, error: response.status === 401 || response.status === 403
      ? `OpenRouter authentication failed (HTTP ${response.status})` : `OpenRouter returned HTTP ${response.status}` };
    let payload: unknown;
    try { payload = await response.json(); } catch { return { ...base, error: "OpenRouter returned invalid JSON" }; }
    const usage = parseOpenRouterUsage(payload);
    return usage ? { ...base, ...usage, status: "ok", error: null, fetchedAt: new Date().toISOString() }
      : { ...base, error: "OpenRouter response did not include valid usage" };
  } catch {
    // Exceptions and upstream bodies can contain credentials. Return fixed messages only.
    return { ...base, error: "OpenRouter request failed or timed out" };
  }
}

export async function fetchOpenRouter(): Promise<ProviderResult> {
  let entries: KeyConfig[];
  try {
    const all = await resolveOpenRouterKeys();
    const selected = selectOpenRouterKeys(all, process.env.OPENROUTER_QUOTA_KEYS, "all");
    const active = filterInactiveOpenRouterKeys(all, process.env.OPENROUTER_INACTIVE_KEYS);
    const activeIds = new Set(active.map((entry) => entry.id));
    entries = selected.filter((entry) => activeIds.has(entry.id));
  } catch {
    return { configured: false, status: "error", error: "Invalid OpenRouter quota or inactive key selector", fetchedAt: new Date().toISOString(), windows: [], openrouterKeys: [] };
  }
  const openrouterKeys = await Promise.all(entries.map(fetchKey));
  const successes = openrouterKeys.filter((entry) => entry.status === "ok").length;
  return {
    configured: openrouterKeys.some((entry) => entry.configured),
    status: successes === openrouterKeys.length && successes > 0 ? "ok" : successes > 0 ? "partial" : "error",
    error: !entries.length ? "OpenRouter API key is not configured" : successes < entries.length ? "One or more OpenRouter keys need attention" : null,
    fetchedAt: new Date().toISOString(),
    // Expose the first entry's windows without summing overlapping periods or keys.
    windows: openrouterKeys[0]?.windows ?? [],
    openrouterKeys,
  };
}
