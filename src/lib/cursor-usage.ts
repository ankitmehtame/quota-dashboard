import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { UsageRecord } from "./usage.js";

/** Usage source ID for Cursor rows imported from the xAI unified-usage CSV. */
export const CURSOR_SOURCE_ID = "cursor";
/** Only this product is imported. grok-build is already counted by ccusage's Grok Build collector. */
const IMPORTED_PRODUCT = "cursor";
const REQUIRED_COLUMNS = ["Billing Item ID", "Event Time", "Product", "Usage Type", "Usage", "Pricing Currency", "Pricing Contracted", "Model"] as const;
const MAX_SKIPPED_PRODUCT_KEYS = 20;
const BILLING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_YEAR = /^\d{4}-/;

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
    // Four-digit years only: expanded ISO years such as +010000 cannot name a month file.
    if (!BILLING_ID.test(id) || !Number.isFinite(time) || !ISO_YEAR.test(new Date(time).toISOString()) || !usage || counts.some((count) => count === null)) { invalid++; continue; }
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

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The event's calendar date in a time zone. One formatter per zone, since this runs per event. */
export function localDate(time: string, timeZone: string): string {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, formatter);
  }
  return formatter.format(new Date(time));
}

export type HostCursorEvent = CursorUsageEvent & { hostId: string };
type RecordKey = string;
export const recordKey = (date: string, hostId: string, model: string): RecordKey => JSON.stringify([date, hostId, model]);

/** Token totals per local date, host and model. Costs start unpriced until ccusage prices them. */
export function aggregateCursorEvents(events: HostCursorEvent[], range: { from: string; to: string }, timeZone: string): UsageRecord[] {
  const records = new Map<RecordKey, UsageRecord>();
  for (const event of events) {
    const date = localDate(event.time, timeZone);
    if (date < range.from || date > range.to) continue;
    const key = recordKey(date, event.hostId, event.model);
    const record = records.get(key) ?? { hostId: event.hostId, date, provider: CURSOR_SOURCE_ID, model: event.model, inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, missingPricing: true };
    record.inputTokens += event.inputTokens;
    record.cachedInputTokens += event.cacheReadTokens;
    record.cacheCreationTokens += event.cacheWriteTokens;
    record.outputTokens += event.outputTokens;
    records.set(key, record);
  }
  return [...records.values()].sort((a, b) => a.date.localeCompare(b.date) || a.hostId!.localeCompare(b.hostId!) || a.model.localeCompare(b.model));
}

export type CcusagePrice = { costUsd: number; missingPricing: boolean };
export type CcusagePrices = Map<RecordKey, CcusagePrice>;
export type CcusageRunner = (binary: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }) => Promise<string>;

const defaultRunner: CcusageRunner = (binary, args, options) => new Promise((resolve, reject) => {
  execFile(binary, args, { ...options, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
});

/**
 * Price events with ccusage itself, so its catalog, pricingOverrides, config discovery,
 * cache-rate defaults and long-context tiers all apply exactly as for other tools.
 * Events are written as one Claude Code request each, in a private temporary data
 * directory with one project per host, and read back with `claude daily --instances`.
 */
/**
 * The user-level ccusage config that ccusage 20.1.2 reads for Claude data, checked against it:
 * - `CLAUDE_CONFIG_DIR` set: each comma-separated entry's `ccusage.json`, with `~` expanded and an
 *   existing `…/projects` directory meaning its parent. The home locations are not used.
 * - otherwise `$XDG_CONFIG_HOME/claude` (taken literally; `~/.config/claude` when unset or empty),
 *   then `~/.claude`.
 * The first file holding a JSON object wins. Returns its text, or null.
 */
export async function readCcusageUserConfig(env: NodeJS.ProcessEnv, home: string): Promise<string | null> {
  const expand = (dir: string) => dir === "~" ? home : dir.startsWith("~/") ? join(home, dir.slice(2)) : dir;
  const isDirectory = async (path: string) => { try { return (await stat(path)).isDirectory(); } catch { return false; } };
  const claudeDirs: string[] = [];
  for (const entry of (env.CLAUDE_CONFIG_DIR ?? "").split(",").map((dir) => dir.trim()).filter(Boolean)) {
    const dir = expand(entry).replace(/\/+$/, "") || "/";
    claudeDirs.push(basename(dir) === "projects" && await isDirectory(dir) ? dirname(dir) : dir);
  }
  const xdg = env.XDG_CONFIG_HOME;
  const candidates = claudeDirs.length
    ? claudeDirs.map((dir) => join(dir, "ccusage.json"))
    : [join(xdg ? xdg : join(home, ".config"), "claude", "ccusage.json"), join(home, ".claude", "ccusage.json")];
  for (const path of candidates) {
    try {
      const text = await readFile(path, "utf8");
      const value: unknown = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) return text;
    } catch { /* missing or malformed: ccusage moves on to the next location */ }
  }
  return null;
}

export async function priceWithCcusage(events: HostCursorEvent[], options: { binary: string; timeZone: string; timeoutMs: number; maxBuffer: number; runner?: CcusageRunner; env?: NodeJS.ProcessEnv; home?: string }): Promise<CcusagePrices> {
  const prices: CcusagePrices = new Map();
  if (events.length === 0) return prices;
  const root = await mkdtemp(join(tmpdir(), "quota-cursor-pricing-"));
  try {
    const hosts = [...new Set(events.map((event) => event.hostId))].sort();
    const projectHost = new Map(hosts.map((hostId, index) => [`host-${index}`, hostId]));
    const projectOf = new Map(hosts.map((hostId, index) => [hostId, `host-${index}`]));
    let since = "9999-12-31";
    let until = "0000-01-01";
    const byProject = new Map<string, string[]>();
    for (const event of events) {
      const date = localDate(event.time, options.timeZone);
      if (date < since) since = date;
      if (date > until) until = date;
      const project = projectOf.get(event.hostId)!;
      const line = JSON.stringify({
        type: "assistant", timestamp: event.time, sessionId: "cursor-import", requestId: event.id, uuid: event.id, cwd: "/cursor-import",
        message: { id: event.id, model: event.model, role: "assistant", usage: { input_tokens: event.inputTokens, output_tokens: event.outputTokens, cache_read_input_tokens: event.cacheReadTokens, cache_creation_input_tokens: event.cacheWriteTokens } },
      });
      const lines = byProject.get(project) ?? [];
      lines.push(line);
      byProject.set(project, lines);
    }
    for (const [project, lines] of byProject) {
      await mkdir(join(root, "projects", project), { recursive: true, mode: 0o700 });
      await writeFile(join(root, "projects", project, "cursor.jsonl"), `${lines.join("\n")}\n`, { mode: 0o600 });
    }
    // CLAUDE_CONFIG_DIR also moves where ccusage looks for its config, so bring the file it
    // would otherwise use. A project `.ccusage/ccusage.json` still wins, as ccusage runs in the same directory.
    const config = await readCcusageUserConfig(options.env ?? process.env, options.home ?? homedir());
    if (config !== null) await writeFile(join(root, "ccusage.json"), config, { mode: 0o600 });
    const args = ["claude", "daily", "--json", "--instances", "--breakdown", "--offline", "--mode", "calculate", "--timezone", options.timeZone, "--since", since.replaceAll("-", ""), "--until", until.replaceAll("-", "")];
    const stdout = await (options.runner ?? defaultRunner)(options.binary, args, { env: { ...(options.env ?? process.env), CLAUDE_CONFIG_DIR: root }, timeout: options.timeoutMs, maxBuffer: options.maxBuffer });
    const document = JSON.parse(stdout) as { projects?: Record<string, Array<{ date?: unknown; modelBreakdowns?: Array<Record<string, unknown>> }>>; totals?: { unpricedModels?: unknown } };
    if (!document || typeof document !== "object" || !document.projects || typeof document.projects !== "object") throw new Error("ccusage did not return per-project usage");
    const unpriced = new Set(Array.isArray(document.totals?.unpricedModels) ? document.totals.unpricedModels.filter((model): model is string => typeof model === "string") : []);
    for (const [project, rows] of Object.entries(document.projects)) {
      const hostId = projectHost.get(project);
      if (!hostId || !Array.isArray(rows)) continue;
      for (const row of rows) {
        if (typeof row?.date !== "string" || !Array.isArray(row.modelBreakdowns)) continue;
        for (const model of row.modelBreakdowns) {
          if (typeof model?.modelName !== "string") continue;
          const cost = typeof model.cost === "number" && Number.isFinite(model.cost) && model.cost >= 0 ? model.cost : null;
          const key = recordKey(row.date, hostId, model.modelName);
          const previous = prices.get(key);
          prices.set(key, {
            costUsd: (previous?.costUsd ?? 0) + (cost ?? 0),
            missingPricing: Boolean(previous?.missingPricing) || cost === null || model.missingPricing === true || unpriced.has(model.modelName),
          });
        }
      }
    }
    return prices;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Apply ccusage prices. Records ccusage did not report stay unpriced. */
export function applyCcusagePrices(records: UsageRecord[], prices: CcusagePrices): UsageRecord[] {
  return records.map((record) => {
    const price = prices.get(recordKey(record.date, record.hostId!, record.model));
    return price ? { ...record, costUsd: price.costUsd, missingPricing: price.missingPricing } : { ...record, costUsd: 0, missingPricing: true };
  });
}
