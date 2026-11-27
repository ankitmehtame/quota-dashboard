import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseRetryAfter } from "./claude.js";
import { type ProviderResult, type QuotaWindow, usageWindow } from "./core.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const loginGuidance = "Run grok on the dashboard host to renew the login, or grok login to sign in again.";
export const GROK_BILLING_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
export type GrokCredentials = { configured: boolean; identity: string; accessToken?: string; error?: string; errorKind?: ProviderResult["errorKind"] };

function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  // Date.parse handles at most millisecond precision; Grok writes nanoseconds.
  return Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
}

// The Grok CLI keeps one entry per OIDC login, keyed by "<issuer>::<user>". Only equality metadata leaves the resolver.
export async function resolveGrokCredentials(env: NodeJS.ProcessEnv = process.env, now = Date.now(), home = homedir()): Promise<GrokCredentials> {
  if (env.GROK_AUTH_PATH === "") return { configured: false, identity: "grok:empty-path", error: "GROK_AUTH_PATH is empty", errorKind: "configuration" };
  const path = resolve(env.GROK_AUTH_PATH ?? join(home, ".grok", "auth.json"));
  const source = `${env.GROK_AUTH_PATH !== undefined ? "auth-path" : "default"}:${path}`;
  const fail = (message: string, kind: ProviderResult["errorKind"] = "configuration", configured = false, identity = source): GrokCredentials =>
    ({ configured, identity, error: message, errorKind: kind });
  let document: ObjectValue;
  try {
    document = object(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return fail(`Grok credential file is missing, unreadable, or invalid. ${loginGuidance}`);
  }
  const logins = Object.entries(document).flatMap(([account, raw]) => {
    const entry = object(raw);
    return typeof entry.key === "string" ? [{ account, token: entry.key, expiresAt: entry.expires_at }] : [];
  });
  if (!logins.length) return fail(`Grok credential file has no login. ${loginGuidance}`);
  // Several logins only happen after switching accounts; the one that expires last is the one the CLI refreshed most recently.
  const login = logins.reduce((best, entry) => (timestamp(entry.expiresAt) || 0) > (timestamp(best.expiresAt) || 0) ? entry : best);
  const account = `${source}:${login.account}`;
  if (!login.token.trim() || /[\x00-\x20\x7f]/.test(login.token)) return fail(`Grok access token is missing or invalid. ${loginGuidance}`, "configuration", false, account);
  const identity = `${account}:${createHash("sha256").update(login.token).digest("hex")}`;
  if (login.expiresAt !== undefined) {
    const expiry = timestamp(login.expiresAt);
    if (!Number.isFinite(expiry)) return fail("Grok login expiry metadata is invalid", "configuration", true, identity);
    if (expiry <= now) return fail(`Grok login token has expired. ${loginGuidance}`, "authentication", true, identity);
  }
  return { configured: true, identity, accessToken: login.token };
}

const productNames: Record<string, string> = { GrokBuild: "Grok Build", Cursor: "Cursor" };
const periodNames: Record<string, [string, number]> = {
  USAGE_PERIOD_TYPE_DAILY: ["Daily", 86_400],
  USAGE_PERIOD_TYPE_WEEKLY: ["Weekly", 604_800],
  USAGE_PERIOD_TYPE_MONTHLY: ["Monthly", 2_592_000],
};

function percentLabel(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

export function parseGrokQuota(payload: unknown): QuotaWindow[] {
  const config = object(object(payload).config);
  const percent = config.creditUsagePercent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return [];
  const period = object(config.currentPeriod);
  const [name, nominalSeconds] = typeof period.type === "string" && Object.hasOwn(periodNames, period.type) ? periodNames[period.type] : ["Usage", null];
  const start = timestamp(period.start);
  const end = timestamp(period.end);
  const valid = Number.isFinite(start) && Number.isFinite(end) && end > start;
  const products = Array.isArray(config.productUsage) ? config.productUsage.flatMap((raw) => {
    const product = object(raw);
    if (typeof product.product !== "string" || !product.product.trim() || typeof product.usagePercent !== "number" || !Number.isFinite(product.usagePercent)) return [];
    return [`${productNames[product.product] ?? product.product} ${percentLabel(product.usagePercent)}`];
  }) : [];
  return [usageWindow({
    name,
    usedPercent: percent,
    windowStart: valid ? new Date(start).toISOString() : null,
    windowEnd: valid ? new Date(end).toISOString() : null,
    resetAt: valid ? new Date(end).toISOString() : null,
    // usageWindow reads null as 0, so an unknown duration is left out instead.
    ...(valid || nominalSeconds !== null ? { windowSeconds: valid ? (end - start) / 1000 : nominalSeconds! } : {}),
    valueLabel: products.length ? products.join(" · ") : null,
  })];
}

export async function fetchGrok(credentials?: GrokCredentials): Promise<ProviderResult> {
  const auth = credentials ?? await resolveGrokCredentials();
  const fail = (errorKind: ProviderResult["errorKind"], error: string, cooldownUntil?: number): ProviderResult => ({
    configured: auth.configured, status: "error", errorKind, error, fetchedAt: new Date().toISOString(), windows: [],
    ...(cooldownUntil !== undefined && cooldownUntil > Date.now() ? { cooldownUntil } : {}),
  });
  if (auth.error || !auth.accessToken) return fail(auth.errorKind ?? "configuration", auth.error ?? "Grok login is not configured");
  const version = process.env.GROK_CLIENT_VERSION ?? "1.0.92";
  if (!/^[0-9A-Za-z.+-]{1,64}$/.test(version)) return fail("configuration", "GROK_CLIENT_VERSION must be a version string such as 1.0.92");
  let response: Response;
  try {
    response = await fetch(GROK_BILLING_ENDPOINT, {
      headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json", "x-grok-client-version": version },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return fail("network", "Grok usage request failed or timed out");
  }
  const cooldown = parseRetryAfter(response.headers.get("retry-after"));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) return fail("authentication", `Grok rejected usage access (HTTP ${response.status}). ${loginGuidance}`, cooldown);
    return fail(response.status === 429 ? "rate_limit" : response.status >= 500 ? "server" : "response", `Grok usage returned HTTP ${response.status}`, cooldown);
  }
  let payload: unknown;
  try { payload = await response.json(); } catch (error) {
    return error instanceof SyntaxError ? fail("response", "Grok usage response was not valid JSON", cooldown)
      : fail("network", "Grok usage response could not be received", cooldown);
  }
  const windows = parseGrokQuota(payload);
  if (!windows.length) {
    const unified = object(object(payload).config).isUnifiedBillingUser;
    return fail("response", unified === false ? "This Grok login is not on The X Subscription, so it has no shared usage pool" : "Grok usage response did not include a usage percentage", cooldown);
  }
  return { configured: true, status: "ok", error: null, windows, fetchedAt: new Date().toISOString(),
    ...(cooldown !== undefined && cooldown > Date.now() ? { cooldownUntil: cooldown } : {}) };
}
