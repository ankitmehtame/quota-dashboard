import { fetchOpenRouterDay, fetchOpenRouterKeyId, openRouterDayRange, openRouterKeyHash } from "./openrouter-analytics.js";
import { resolveOpenRouterKeys, resolveOpenRouterUsageSelection, type KeyConfig } from "./openrouter.js";
import { OpenRouterUsageStore } from "./openrouter-usage-store.js";
import type { UsageRecord } from "./usage.js";

export type OpenRouterUsageEntry = { label: string; records: UsageRecord[] };
export type OpenRouterRefreshResult = { attempted: number; succeeded: number; failed: number; error: string | null };
export type OpenRouterReadResult = { entries: OpenRouterUsageEntry[]; error: string | null };

/** Analytics rows for a finished day can arrive late, so a day is final only after a fetch this long past its end. */
const DAY_SETTLE_MS = 15 * 60_000;

type Selection = { visible: KeyConfig[]; active: KeyConfig[]; incomplete: number; managed: boolean };

/** Sum records that share a date and model, as happens when several keys carry one label. */
function combine(records: UsageRecord[]): UsageRecord[] {
  const merged = new Map<string, UsageRecord>();
  for (const record of records) {
    const key = JSON.stringify([record.date, record.model]);
    const existing = merged.get(key);
    if (!existing) { merged.set(key, { ...record }); continue; }
    existing.inputTokens += record.inputTokens;
    existing.cachedInputTokens += record.cachedInputTokens;
    existing.cacheCreationTokens += record.cacheCreationTokens;
    existing.outputTokens += record.outputTokens;
    existing.reasoningTokens += record.reasoningTokens;
    existing.costUsd += record.costUsd;
  }
  return [...merged.values()];
}

/** All credentials, hashes and upstream error details remain server-side. */
export class OpenRouterUsageCollector {
  private pending = new Map<string, Promise<OpenRouterRefreshResult>>();
  // Cache the locally derived analytics identifier by storage hash.
  private keyIds = new Map<string, string>();

  constructor(private readonly store: OpenRouterUsageStore, private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchDay = fetchOpenRouterDay, private readonly fetchKeyId = fetchOpenRouterKeyId,
    private readonly now: () => number = Date.now) {}

  private async selection(): Promise<Selection> {
    const entries = await resolveOpenRouterKeys(this.env);
    return { ...resolveOpenRouterUsageSelection(entries, this.env.OPENROUTER_USAGE_KEYS, this.env.OPENROUTER_INACTIVE_KEYS),
      managed: Boolean(this.env.OPENROUTER_MANAGEMENT_API_KEY?.trim()) };
  }

  /** Whether any selected key is polled, i.e. whether refreshing can do anything. */
  async enabled(): Promise<boolean> {
    try { const selection = await this.selection(); return selection.managed && selection.active.length > 0; } catch { return false; }
  }

  /** Replace a day only after that key's entire query and snapshot write succeed. */
  async refresh(date: string, timezone: string): Promise<OpenRouterRefreshResult> {
    const id = `${timezone}:${date}`;
    const existing = this.pending.get(id);
    if (existing) return existing;
    const task = this.refreshDay(date, timezone);
    this.pending.set(id, task);
    try { return await task; } finally { if (this.pending.get(id) === task) this.pending.delete(id); }
  }

  private async keyId(secret: string, hash: string): Promise<string> {
    const known = this.keyIds.get(hash);
    if (known) return known;
    const id = await this.fetchKeyId(secret);
    this.keyIds.set(hash, id);
    return id;
  }

  private async refreshDay(date: string, timezone: string): Promise<OpenRouterRefreshResult> {
    let selection: Selection;
    try { selection = await this.selection(); }
    catch { return { attempted: 0, succeeded: 0, failed: 1, error: "Invalid OpenRouter usage key configuration" }; }
    const skipped = selection.incomplete ? "One or more OpenRouter usage keys are incomplete" : null;
    if (!selection.active.length) return { attempted: 0, succeeded: 0, failed: 0, error: skipped };
    const managementKey = this.env.OPENROUTER_MANAGEMENT_API_KEY?.trim();
    if (!managementKey) return { attempted: 0, succeeded: 0, failed: selection.active.length, error: "OpenRouter management key is not configured" };
    const results = await Promise.allSettled(selection.active.map(async (entry) => {
      const hash = openRouterKeyHash(entry.key!);
      const records = await this.fetchDay(managementKey, await this.keyId(entry.key!, hash), date, timezone);
      await this.store.write(hash, date, timezone, records, new Date(this.now()).toISOString());
    }));
    const succeeded = results.filter((result) => result.status === "fulfilled").length;
    const failed = results.length - succeeded;
    return { attempted: results.length, succeeded, failed,
      error: failed ? "One or more OpenRouter usage keys could not be refreshed" : skipped };
  }

  /**
   * Relabel stored per-key records at read time and group them by exact current label,
   * including selected inactive keys. A corrupt snapshot is skipped and reported.
   */
  async read(dates: string[], timezone: string): Promise<OpenRouterReadResult> {
    let selection: Selection;
    try { selection = await this.selection(); }
    catch (error) {
      if (this.env.OPENROUTER_MANAGEMENT_API_KEY?.trim()) throw error;
      const keys = await resolveOpenRouterKeys(this.env);
      const history = await Promise.all(keys.filter((entry) => entry.key).map((entry) => this.store.has(openRouterKeyHash(entry.key!), timezone).catch(() => false)));
      if (history.some(Boolean)) throw error;
      return { entries: [], error: null };
    }
    let error: string | null = selection.managed && selection.incomplete ? "One or more OpenRouter usage keys are incomplete" : null;
    const groups = new Map<string, UsageRecord[]>();
    await Promise.all(selection.visible.map(async (entry) => {
      const hash = openRouterKeyHash(entry.key!);
      const records: UsageRecord[] = [];
      for (const date of dates) {
        try { records.push(...(await this.store.read(hash, date, timezone))?.records ?? []); }
        catch { error = "OpenRouter usage data could not be fully read"; }
      }
      const retained = records.length > 0 || (selection.managed && selection.active.includes(entry)) || await this.store.has(hash, timezone).catch(() => false);
      if (retained) groups.set(entry.label, [...(groups.get(entry.label) ?? []), ...records]);
    }));
    // Entry order is deterministic regardless of which reads finished first.
    const order = selection.visible.map((entry) => entry.label);
    const entries = [...groups].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([label, records]) => ({ label, records: combine(records) }));
    if (!error && selection.incomplete && entries.length) error = "One or more OpenRouter usage keys are incomplete";
    return { entries, error };
  }

  /** Only actively polled keys need cold backfill; unfinished or never-fetched days do. */
  async needsRefresh(date: string, timezone: string): Promise<boolean> {
    const selection = await this.selection();
    if (!selection.managed) return false;
    const settled = Date.parse(openRouterDayRange(date, timezone).end) + DAY_SETTLE_MS;
    // A day still in progress is the hot job's business.
    if (this.now() < settled) return false;
    const snapshots = await Promise.all(selection.active.map((entry) => this.store.read(openRouterKeyHash(entry.key!), date, timezone).catch(() => null)));
    return snapshots.some((snapshot) => snapshot === null || Date.parse(snapshot.fetchedAt) < settled);
  }
}
