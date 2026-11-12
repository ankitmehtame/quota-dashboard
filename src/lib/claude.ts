import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type ProviderResult, type QuotaWindow, type RateLimitResetCredit, usageWindow } from "./core.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const loginGuidance = "Sign in with a Claude subscription using Claude Code; inference-only setup tokens may not grant user:profile.";
export type ClaudeCredentials = { configured: boolean; identity: string; account?: string; accessToken?: string; error?: string; errorKind?: ProviderResult["errorKind"] };

function isoTimestamp(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const y = Number(year);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days[Number(month) - 1] ||
    Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59) return NaN;
  return Date.parse(value);
}

function expiryTime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e11 ? value * 1000 : value;
  if (typeof value === "string") return isoTimestamp(value);
  return NaN;
}

// Only equality metadata leaves the resolver. It never goes into a ProviderResult.
export async function resolveClaudeCredentials(env: NodeJS.ProcessEnv = process.env, now = Date.now(), home = homedir()): Promise<ClaudeCredentials> {
  const direct = env.CLAUDE_OAUTH_TOKEN?.trim();
  const path = resolve(env.CLAUDE_AUTH_PATH !== undefined ? env.CLAUDE_AUTH_PATH
    : join(env.CLAUDE_CONFIG_DIR !== undefined ? env.CLAUDE_CONFIG_DIR : join(home, ".claude"), ".credentials.json"));
  const source = direct ? "environment" : `${env.CLAUDE_AUTH_PATH !== undefined ? "auth-path" : env.CLAUDE_CONFIG_DIR !== undefined ? "config-dir" : "default"}:${path}`;
  let identity = source;
  const fail = (message: string, kind: ProviderResult["errorKind"] = "configuration", configured = false): ClaudeCredentials =>
    ({ configured, identity, error: message, errorKind: kind });
  let token: unknown = direct;
  let oauth: ObjectValue = {};
  if (!direct) {
    if (env.CLAUDE_AUTH_PATH === "" || env.CLAUDE_CONFIG_DIR === "") return fail("Claude credential path override is empty");
    try {
      const document: unknown = JSON.parse(await readFile(path, "utf8"));
      oauth = object(object(document).claudeAiOauth);
      token = oauth.accessToken !== undefined ? oauth.accessToken : oauth.access_token;
    } catch {
      return fail("Claude credential file is missing, unreadable, or invalid. " + loginGuidance);
    }
  }
  if (typeof token !== "string" || !token.trim() || /[\x00-\x20\x7f]/.test(token)) return fail("Claude OAuth access token is missing or invalid. " + loginGuidance);
  identity = `${source}:${createHash("sha256").update(token).digest("hex")}`;
  if (oauth.scopes !== undefined) {
    const scopes = typeof oauth.scopes === "string" ? oauth.scopes.trim().split(/\s+/).filter(Boolean) : oauth.scopes;
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string" && scope.trim())) return fail("Claude OAuth scopes metadata is invalid");
    if (!scopes.includes("user:profile")) return fail("Claude OAuth token lacks user:profile. " + loginGuidance, "authentication", true);
  }
  const expiry = oauth.expiresAt !== undefined ? oauth.expiresAt : oauth.expires_at;
  if (expiry !== undefined) {
    const time = expiryTime(expiry);
    if (!Number.isFinite(time) || time <= 0 || !Number.isFinite(new Date(time).getTime())) return fail("Claude OAuth expiry metadata is invalid");
    if (time <= now) return fail("Claude OAuth token has expired. " + loginGuidance, "authentication", true);
  }
  // File-based sources keep one account slot across OAuth token refreshes; an environment token is its own account.
  return { configured: true, identity, account: direct ? identity : source, accessToken: token };
}

export function parseClaudeQuota(payload: unknown): QuotaWindow[] {
  const data = object(payload);
  const fields = [["five_hour", "5-hour", 18_000], ["seven_day", "Weekly", 604_800],
    ["seven_day_sonnet", "Sonnet (Weekly)", 604_800], ["seven_day_opus", "Opus (Weekly)", 604_800]] as const;
  return fields.flatMap(([field, name, seconds]) => {
    const value = object(data[field]);
    if (!Object.keys(value).length) return [];
    const percent = typeof value.utilization === "number" && Number.isFinite(value.utilization) ? value.utilization : null;
    const end = isoTimestamp(value.resets_at);
    const start = end - seconds * 1000;
    const valid = Number.isFinite(end) && Number.isFinite(new Date(start).getTime());
    return [usageWindow({ name, usedPercent: percent, windowSeconds: seconds,
      resetAt: valid ? new Date(end).toISOString() : null,
      windowEnd: valid ? new Date(end).toISOString() : null,
      windowStart: valid ? new Date(start).toISOString() : null })];
  });
}

export function parseClaudeResetCredits(payload: unknown, now = Date.now()): RateLimitResetCredit[] | undefined {
  const block = object(object(payload).cedar_ember);
  if (block.eligible === false) return [];
  if (block.eligible !== true || !Array.isArray(block.grants)) return undefined;
  return block.grants.flatMap((entry) => {
    const grant = object(entry);
    const expiry = isoTimestamp(grant.ends_at);
    if (typeof grant.id !== "string" || !grant.id.trim() || typeof grant.label !== "string" || !grant.label.trim() ||
      typeof grant.resets_left !== "number" || !Number.isSafeInteger(grant.resets_left) || grant.resets_left <= 0 || grant.paused === true ||
      !Number.isFinite(expiry) || expiry <= now) return [];
    return [{ id: grant.id, title: grant.resets_left > 1 ? `${grant.label} (${grant.resets_left} resets remaining)` : grant.label,
      description: null, expiresAt: new Date(expiry).toISOString() }];
  }).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

// retryUntil is the server's Retry-After from the grants request; the penalty covers the whole account.
// Grants are only served to the token identity that fetched them, so a rotated or switched token never shows another account's grants.
type ResetCreditState = { nextCheck: number; retryUntil?: number; credits?: RateLimitResetCredit[]; creditsIdentity?: string; checkedIdentity?: string; earlyRechecked?: boolean;
  lastOk?: { identity: string; result: ProviderResult }; pending?: Promise<void> };
const resetCreditStates = new Map<string, ResetCreditState>();
const resetCheckInterval = 3_600_000;
// How long the card's required result may wait for the optional grants check.
const resetCheckBudget = 3_000;
// Pause applied when a grants 429 has no usable Retry-After, matching the first step of the quota cache's own 429 backoff.
const resetFallbackCooldown = 300_000;

function resetCreditState(auth: ClaudeCredentials): ResetCreditState {
  // Keyed by account, not token hash, so a refreshed OAuth token cannot bypass the throttle or cooldown.
  const key = auth.account ?? auth.identity;
  let state = resetCreditStates.get(key);
  if (!state) { state = { nextCheck: 0 }; resetCreditStates.set(key, state); }
  return state;
}

async function claudeResetCredits(auth: ClaudeCredentials, skip: boolean): Promise<{ credits?: RateLimitResetCredit[]; cooldownUntil?: number }> {
  const state = resetCreditState(auth);
  // A refreshed token for the same account gets one early recheck so its grants reappear, but never during a 429 pause.
  // The early recheck is capped at one per throttle window whatever the outcome, so alternating tokens cannot add requests.
  const paused = state.retryUntil !== undefined && state.retryUntil > Date.now();
  const scheduled = Date.now() >= state.nextCheck;
  if (!skip && !state.pending && (scheduled || (state.checkedIdentity !== auth.identity && !paused && !state.earlyRechecked))) {
    const current = state;
    current.earlyRechecked = scheduled ? false : true;
    current.nextCheck = Date.now() + resetCheckInterval;
    current.checkedIdentity = auth.identity;
    current.pending = (async () => {
      const userAgent = process.env.CLAUDE_RESET_USER_AGENT ?? "claude-cli/2.1.280 (external, cli)";
      if (!userAgent.trim() || !/^[\x20-\x7e]+$/.test(userAgent)) return;
      try {
        const response = await fetch("https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1", {
          headers: { Authorization: `Bearer ${auth.accessToken}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json", "User-Agent": userAgent },
          redirect: "error", signal: AbortSignal.timeout(15_000),
        });
        if (response.status === 429) {
          const deadline = parseRetryAfter(response.headers.get("retry-after"));
          // The penalty covers the whole account, so a missing, malformed, or past Retry-After still pauses plain usage.
          const until = deadline !== undefined && deadline > Date.now() ? deadline : Date.now() + resetFallbackCooldown;
          current.retryUntil = until;
          current.nextCheck = Math.max(current.nextCheck, until);
        }
        if (response.status !== 200) return;
        const credits = parseClaudeResetCredits(await response.json());
        if (credits !== undefined) { current.credits = credits; current.creditsIdentity = auth.identity; }
      } catch { /* Reset grants are optional; keep the last answer without changing quota status. */ }
    })().finally(() => { current.pending = undefined; });
  }
  if (!skip && state.pending) {
    // Do not let a slow optional request delay the required windows; a late result fills the cache for the next refresh.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([state.pending, new Promise<void>((done) => { timer = setTimeout(done, resetCheckBudget); })]);
    clearTimeout(timer);
  }
  return { credits: (state.creditsIdentity === auth.identity ? state.credits : undefined)?.filter((credit) => Date.parse(credit.expiresAt!) > Date.now()),
    ...(state.retryUntil !== undefined && state.retryUntil > Date.now() ? { cooldownUntil: state.retryUntil } : {}) };
}

// Accept HTTP delay-seconds or IMF-fixdate, never JavaScript's loose numeric/date grammar.
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  let deadline: number;
  if (/^[0-9]+$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isSafeInteger(seconds)) return undefined;
    deadline = now + seconds * 1000;
  } else {
    if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return undefined;
    deadline = Date.parse(text);
    if (!Number.isFinite(deadline) || new Date(deadline).toUTCString() !== text) return undefined;
  }
  return Number.isSafeInteger(deadline) && Math.abs(deadline) <= 8.64e15 ? deadline : undefined;
}

export async function fetchClaude(credentials?: ClaudeCredentials): Promise<ProviderResult> {
  const auth = credentials ?? await resolveClaudeCredentials();
  const fail = (errorKind: ProviderResult["errorKind"], error: string, cooldownUntil?: number): ProviderResult => {
    // A newer usage failure supersedes the stored good card, so a late grants 429 can never replay it.
    const stored = resetCreditStates.get(auth.account ?? auth.identity);
    if (stored) stored.lastOk = undefined;
    return failure(errorKind, error, cooldownUntil);
  };
  const failure = (errorKind: ProviderResult["errorKind"], error: string, cooldownUntil?: number): ProviderResult => ({
    configured: auth.configured, status: "error", errorKind, error, fetchedAt: new Date().toISOString(), windows: [],
    ...(cooldownUntil !== undefined && cooldownUntil > Date.now() ? { cooldownUntil } : {}),
  });
  if (auth.error || !auth.accessToken) return fail(auth.errorKind ?? "configuration", auth.error ?? "Claude OAuth credentials are not configured");
  const userAgent = process.env.CLAUDE_USER_AGENT ?? "claude-code/2.1.69";
  if (!userAgent.trim() || !/^[\x20-\x7e]+$/.test(userAgent)) return fail("configuration", "CLAUDE_USER_AGENT must contain non-empty printable ASCII text");
  const resetState = resetCreditState(auth);
  const resetRetry = resetState.retryUntil;
  // A grants 429 arriving after the last card result still pauses plain usage requests for the whole account.
  if (resetRetry !== undefined && resetRetry > Date.now()) {
    // The optional grants failure must not turn a good card into an error: keep the last successful windows for this token and only carry the cooldown.
    const last = resetState.lastOk;
    if (last && last.identity === auth.identity) return { ...last.result, resetCredits: (await claudeResetCredits(auth, true)).credits, cooldownUntil: resetRetry };
    return fail("rate_limit", "Claude quota is paused until the server's Retry-After deadline", resetRetry);
  }
  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${auth.accessToken}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json", "User-Agent": userAgent },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return fail("network", "Claude quota request failed or timed out");
  }
  const cooldown = parseRetryAfter(response.headers.get("retry-after"));
  if (!response.ok) {
    if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") return fail("authentication", "Claude quota access was blocked by a Cloudflare network challenge; no automatic bypass is available", cooldown);
    if (response.status === 401 || response.status === 403) return fail("authentication", `Claude rejected quota access (HTTP ${response.status}). ${loginGuidance}`, cooldown);
    return fail(response.status === 429 ? "rate_limit" : response.status >= 500 ? "server" : "response", `Claude quota returned HTTP ${response.status}`, cooldown);
  }
  let payload: unknown;
  try { payload = await response.json(); } catch (error) {
    return error instanceof SyntaxError ? fail("response", "Claude quota response was not valid JSON", cooldown)
      : fail("network", "Claude quota response could not be received", cooldown);
  }
  const windows = parseClaudeQuota(payload);
  if (!windows.some((window) => window.usedPercent !== null)) return fail("response", "Claude quota response did not include supported utilization measurements", cooldown);
  const reset = await claudeResetCredits(auth, cooldown !== undefined && cooldown > Date.now());
  const deadline = Math.max(cooldown ?? 0, reset.cooldownUntil ?? 0);
  const result: ProviderResult = { configured: true, status: "ok", error: null, windows, resetCredits: reset.credits, fetchedAt: new Date().toISOString(),
    ...(deadline > Date.now() ? { cooldownUntil: deadline } : {}) };
  resetState.lastOk = { identity: auth.identity, result: { ...result, cooldownUntil: undefined } };
  return result;
}
