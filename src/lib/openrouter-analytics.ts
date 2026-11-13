import { createHash } from "node:crypto";
import type { UsageRecord } from "./usage.js";

/** Stable local storage identity derived from the secret; never expose it through the API. */
export function openRouterKeyHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function localDay(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(timestamp);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Find local midnight on the UTC timeline without assuming an hour-aligned offset. */
function midnight(date: string, timezone: string): number {
  const target = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 10) !== date) throw new Error("Invalid date");
  let lo = target - 48 * 3_600_000;
  let hi = target + 48 * 3_600_000;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000;
    if (localDay(mid, timezone) < date) lo = mid;
    else hi = mid;
  }
  if (localDay(hi, timezone) !== date) throw new Error("Date does not exist in timezone");
  return hi;
}

export function openRouterDayRange(date: string, timezone: string): { start: string; end: string } {
  const start = midnight(date, timezone);
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { start: new Date(start).toISOString(), end: new Date(midnight(next, timezone)).toISOString() };
}

function metric(row: Record<string, unknown>, name: string): number {
  const raw = row[name];
  const value = typeof raw === "number" || typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid analytics metric");
  return value;
}

/** The analytics filter accepts the SHA-256 of the API key. */
export async function fetchOpenRouterKeyId(secret: string): Promise<string> {
  return openRouterKeyHash(secret);
}

/** Fetch one complete local day. Reject partial results instead of replacing saved data. */
export class AnalyticsRateLimiter {
  private next = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly now = Date.now, private readonly sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {}
  async wait(): Promise<void> {
    const task = this.tail.then(async () => {
      const delay = Math.max(0, this.next - this.now());
      if (delay) await this.sleep(delay);
      this.next = this.now() + 1000;
    });
    this.tail = task.catch(() => {});
    await task;
  }
}
const analyticsLimiter = new AnalyticsRateLimiter();

export async function fetchOpenRouterDay(managementKey: string, keyId: string, date: string, timezone: string): Promise<UsageRecord[]> {
  let response!: Response;
  for (let attempt = 0; attempt < 4; attempt++) {
    await analyticsLimiter.wait();
    response = await fetch("https://openrouter.ai/api/v1/analytics/query", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${managementKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ metrics: ["total_usage", "tokens_prompt", "tokens_completion", "cached_tokens", "reasoning_tokens"],
      dimensions: ["model"], filters: [{ field: "api_key_id", operator: "eq", value: keyId }],
      time_range: openRouterDayRange(date, timezone), limit: 10000 }),
    });
    if (response.status !== 429 || attempt === 3) break;
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
  if (!response.ok) throw new Error(`OpenRouter analytics HTTP ${response.status}`);
  const payload = await response.json() as { data?: { data?: unknown; metadata?: { truncated?: unknown }; warnings?: unknown[] } };
  const data = payload?.data;
  if (!data || !Array.isArray(data.data) || data.metadata?.truncated !== false || data.warnings?.length) throw new Error("Incomplete OpenRouter analytics response");
  return data.data.map((value): UsageRecord => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid analytics row");
    const row = value as Record<string, unknown>;
    if (typeof row.model !== "string" || !row.model.trim()) throw new Error("Invalid analytics model");
    const prompt = metric(row, "tokens_prompt");
    const cached = row.cached_tokens === null ? 0 : metric(row, "cached_tokens");
    const completion = metric(row, "tokens_completion");
    const reasoning = row.reasoning_tokens === null ? 0 : metric(row, "reasoning_tokens");
    // OpenRouter reports cache and reasoning as breakdowns of prompt and completion.
    // Refuse inconsistent data rather than silently double-counting tokens.
    if (cached > prompt || reasoning > completion) throw new Error("Inconsistent analytics token breakdown");
    return { date, provider: "openrouter", model: row.model, inputTokens: prompt - cached, cachedInputTokens: cached,
      cacheCreationTokens: 0, outputTokens: completion - reasoning, reasoningTokens: reasoning,
      costUsd: metric(row, "total_usage"), missingPricing: false };
  });
}
