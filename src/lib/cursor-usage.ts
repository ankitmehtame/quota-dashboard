import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageRecord } from "./usage.js";

/** Usage source ID for Cursor rows imported from the xAI unified-usage CSV. */
export const CURSOR_SOURCE_ID = "cursor";
/** Only this product is imported. grok-build is already counted by ccusage's Grok Build collector. */
const IMPORTED_PRODUCT = "cursor";
const REQUIRED_COLUMNS = ["Billing Item ID", "Event Time", "Product", "Usage Type", "Usage", "Pricing Currency", "Pricing Contracted", "Model"] as const;
const MAX_SKIPPED_PRODUCT_KEYS = 20;
const BILLING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** One Cursor billing event. Personal columns (email, principal) are never kept. */
export type CursorUsageEvent = {
  id: string;
  time: string;
  model: string;
  usageType: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ParsedUnifiedUsage = {
  rows: number;
  events: CursorUsageEvent[];
  skipped: Record<string, number>;
  invalid: number;
};

export class UnifiedUsageCsvError extends Error {}

/** RFC 4180 parser: quoted fields, doubled quotes, embedded newlines, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character !== '"') field += character;
      else if (text[index + 1] === '"') { field += '"'; index++; }
      else quoted = false;
    } else if (character === '"' && field === "") quoted = true;
    else if (character === ",") { row.push(field); field = ""; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += character;
  }
  if (quoted) throw new UnifiedUsageCsvError("CSV has an unterminated quoted field");
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.length > 1 || cells[0] !== "");
}

function tokenCount(value: unknown): number | null {
  if (value === undefined) return 0;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function skippedKey(product: string): string {
  const trimmed = product.trim();
  return (trimmed || "(blank)").slice(0, 64);
}

/** Parse an xAI "personal unified usage" export and keep only Cursor rows. */
export function parseUnifiedUsageCsv(text: string): ParsedUnifiedUsage {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new UnifiedUsageCsvError("CSV is empty");
  const columns = new Map(header.map((name, index) => [name.trim(), index]));
  const missing = REQUIRED_COLUMNS.filter((name) => !columns.has(name));
  if (missing.length) throw new UnifiedUsageCsvError(`Not an xAI unified usage export. Missing columns: ${missing.join(", ")}`);
  const cell = (row: string[], name: typeof REQUIRED_COLUMNS[number]) => (row[columns.get(name)!] ?? "").trim();
  const events = new Map<string, CursorUsageEvent>();
  const skipped: Record<string, number> = Object.create(null);
  let invalid = 0;
  for (const row of rows) {
    const product = cell(row, "Product");
    if (product !== IMPORTED_PRODUCT) {
      let key = skippedKey(product);
      if (!Object.hasOwn(skipped, key) && Object.keys(skipped).length >= MAX_SKIPPED_PRODUCT_KEYS) key = "(other)";
      skipped[key] = (skipped[key] ?? 0) + 1;
      continue;
    }
    const id = cell(row, "Billing Item ID");
    const time = Date.parse(cell(row, "Event Time"));
    let usage: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(cell(row, "Usage") || "{}");
      if (value && typeof value === "object" && !Array.isArray(value)) usage = value;
    } catch { /* counted as invalid below */ }
    const counts = usage ? ["prompt-text-tokens", "completion-text-tokens", "cached-prompt-text-tokens", "cache-write-text-tokens"].map((key) => tokenCount(usage![key])) : [];
    if (!BILLING_ID.test(id) || !Number.isFinite(time) || !usage || counts.some((count) => count === null)) { invalid++; continue; }
    const [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] = counts as number[];
    events.set(id, {
      id,
      time: new Date(time).toISOString(),
      model: cell(row, "Model").slice(0, 200) || "unknown",
      usageType: cell(row, "Usage Type").slice(0, 64),
      inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    });
  }
  return { rows: rows.length, events: [...events.values()], skipped: { ...skipped }, invalid };
}

/** The ccusage pricingOverrides fields this importer uses, in USD per token. */
export type ModelPricing = {
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  cacheReadInputTokenCost?: number;
  cacheCreationInputTokenCost?: number;
  inputCostPerTokenAbove200kTokens?: number;
  outputCostPerTokenAbove200kTokens?: number;
  cacheReadInputTokenCostAbove200kTokens?: number;
  cacheCreationInputTokenCostAbove200kTokens?: number;
};
export type PricingTable = Map<string, ModelPricing>;

const PRICE_FIELDS = ["inputCostPerToken", "outputCostPerToken", "cacheReadInputTokenCost", "cacheCreationInputTokenCost", "inputCostPerTokenAbove200kTokens", "outputCostPerTokenAbove200kTokens", "cacheReadInputTokenCostAbove200kTokens", "cacheCreationInputTokenCostAbove200kTokens"] as const;
const TIER_THRESHOLD = 200_000;

function pricingEntries(value: unknown): Array<[string, ModelPricing]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([model, raw]) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const pricing: ModelPricing = {};
    for (const field of PRICE_FIELDS) {
      const price = (raw as Record<string, unknown>)[field];
      if (typeof price === "number" && Number.isFinite(price) && price >= 0) pricing[field] = price;
    }
    return [[model, pricing]];
  });
}

/** ccusage auto-discovers these files. Earlier paths win, and `commands.daily` overrides `defaults`. */
export function ccusageConfigPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const explicit = env.CCUSAGE_CONFIG_PATH?.trim();
  return explicit ? [explicit] : [join(home, ".config", "ccusage", "config.json"), join(home, ".ccusage", "ccusage.json")];
}

/** Read ccusage pricingOverrides, keyed by exact model name. Missing or unreadable files give no prices. */
export async function loadCcusagePricing(paths = ccusageConfigPaths()): Promise<PricingTable> {
  const table: PricingTable = new Map();
  for (const path of [...paths].reverse()) {
    let config: Record<string, any>;
    try { config = JSON.parse(await readFile(path, "utf8")); } catch { continue; }
    for (const section of [config?.defaults, config?.commands?.daily]) {
      for (const [model, pricing] of pricingEntries(section?.pricingOverrides)) table.set(model, pricing);
    }
  }
  return table;
}

function tieredCost(tokens: number, base: number | undefined, above: number | undefined): number {
  if (tokens <= 0) return 0;
  if (above !== undefined && tokens > TIER_THRESHOLD) return TIER_THRESHOLD * (base ?? 0) + (tokens - TIER_THRESHOLD) * above;
  return tokens * (base ?? 0);
}

/** API-equivalent cost of one event, with ccusage's 200k-token tiers. Null when the model has no price. */
export function eventCost(event: CursorUsageEvent, pricing: PricingTable): number | null {
  const price = pricing.get(event.model);
  if (!price) return null;
  return tieredCost(event.inputTokens, price.inputCostPerToken, price.inputCostPerTokenAbove200kTokens)
    + tieredCost(event.outputTokens, price.outputCostPerToken, price.outputCostPerTokenAbove200kTokens)
    + tieredCost(event.cacheReadTokens, price.cacheReadInputTokenCost, price.cacheReadInputTokenCostAbove200kTokens)
    + tieredCost(event.cacheWriteTokens, price.cacheCreationInputTokenCost, price.cacheCreationInputTokenCostAbove200kTokens);
}

export function localDate(time: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(time));
}

/** Group events into one usage record per local date, host and model. */
export function aggregateCursorEvents(events: Array<CursorUsageEvent & { hostId: string }>, range: { from: string; to: string }, timeZone: string, pricing: PricingTable): UsageRecord[] {
  const records = new Map<string, UsageRecord>();
  for (const event of events) {
    const date = localDate(event.time, timeZone);
    if (date < range.from || date > range.to) continue;
    const key = JSON.stringify([date, event.hostId, event.model]);
    const record = records.get(key) ?? { hostId: event.hostId, date, provider: CURSOR_SOURCE_ID, model: event.model, inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, missingPricing: false };
    const cost = eventCost(event, pricing);
    record.inputTokens += event.inputTokens;
    record.cachedInputTokens += event.cacheReadTokens;
    record.cacheCreationTokens += event.cacheWriteTokens;
    record.outputTokens += event.outputTokens;
    record.costUsd += cost ?? 0;
    record.missingPricing ||= cost === null;
    records.set(key, record);
  }
  return [...records.values()].sort((a, b) => a.date.localeCompare(b.date) || a.hostId!.localeCompare(b.hostId!) || a.model.localeCompare(b.model));
}
