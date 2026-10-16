import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sanitizeHostId } from "../remote/protocol.js";
import { parseCcusage, type UsageRecord } from "./usage.js";
import { isUsageSourceId, normalizeUsageToolId } from "./usage-source-id.js";
export { normalizeUsageToolId } from "./usage-source-id.js";

const MAX_ID_LENGTH = 128;
const MAX_RAW_ARCHIVES = 3;

export type RawUsageContainer = {
  schemaVersion: number;
  hostId: string;
  date: string;
  timezone: string;
  category: string;
  runId: string;
  generatedAt: string;
  range?: { from: string; to: string };
  ccusageVersion?: string;
  data: unknown;
};

export type NormalizedToolUsage = {
  schemaVersion: number;
  hostId: string;
  date: string;
  timezone: string;
  category: string;
  runId: string;
  generatedAt: string;
  range?: { from: string; to: string };
  ccusageVersion?: string;
  toolId: string;
  /** The raw file that produced this normalized record. */
  rawFile: string;
  records: UsageRecord[];
};

export type UsageStoreOptions = {
  dataRoot: string;
  /** Used for archive names. Injecting it keeps archive tests deterministic. */
  now?: () => Date;
  log?: (message: string) => void;
};

export type IngestResult = {
  written: boolean;
  hostId?: string;
  date?: string;
  toolIds?: string[];
  archivedRawFile?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function assertText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ID_LENGTH) {
    throw new Error(`${name} must be a non-empty string no longer than ${MAX_ID_LENGTH} characters`);
  }
}

function validateTimezone(value: unknown): asserts value is string {
  assertText(value, "timezone");
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format();
  } catch {
    throw new Error(`Invalid timezone: ${value}`);
  }
}

function validateGeneratedAt(value: unknown): asserts value is string {
  assertText(value, "generatedAt");
  if (!Number.isFinite(Date.parse(value))) throw new Error("generatedAt must be a valid date");
}

function validateContainer(input: RawUsageContainer): RawUsageContainer {
  if (!isObject(input)) throw new Error("usage container must be an object");
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) throw new Error("schemaVersion must be a positive integer");
  assertText(input.hostId, "hostId");
  assertText(input.date, "date");
  if (!isCalendarDate(input.date)) throw new Error(`Invalid date: ${input.date}`);
  validateTimezone(input.timezone);
  assertText(input.category, "category");
  assertText(input.runId, "runId");
  validateGeneratedAt(input.generatedAt);
  if (input.range !== undefined && (!isObject(input.range) || !isCalendarDate(input.range.from) || !isCalendarDate(input.range.to) || input.range.from > input.range.to)) {
    throw new Error("range must contain an ordered calendar date range");
  }
  if (input.ccusageVersion !== undefined) assertText(input.ccusageVersion, "ccusageVersion");
  if (!isObject(input.data)) throw new Error("data must be a ccusage document object");

  // JSON is the persistence format. Stringifying before any filesystem work
  // rejects cycles and values that could silently disappear on disk.
  JSON.stringify(input.data);
  return {
    schemaVersion: input.schemaVersion,
    hostId: sanitizeHostId(input.hostId),
    date: input.date,
    timezone: input.timezone,
    category: input.category,
    runId: input.runId,
    generatedAt: input.generatedAt,
    ...(input.range !== undefined ? { range: { from: input.range.from, to: input.range.to } } : {}),
    ...(input.ccusageVersion !== undefined ? { ccusageVersion: input.ccusageVersion } : {}),
    data: input.data,
  };
}

function toolRecords(records: UsageRecord[]): Map<string, UsageRecord[]> {
  const grouped = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const toolId = normalizeUsageToolId(record.provider);
    const values = grouped.get(toolId) || [];
    values.push({ ...record, provider: toolId });
    grouped.set(toolId, values);
  }
  return grouped;
}

function ccusageRowToolId(row: Record<string, unknown>): string {
  const metadata = isObject(row.metadata) ? row.metadata : {};
  const agents = Array.isArray(metadata.agents)
    ? metadata.agents.filter((agent): agent is string => typeof agent === "string" && agent.trim().length > 0)
    : [];
  if (agents.length === 1) return agents[0].trim().toLowerCase();
  if (agents.length > 1) return "shared";
  return typeof row.agent === "string" && row.agent !== "all"
    ? row.agent.trim().toLowerCase()
    : "unknown";
}

/** Find tool presence even when ccusage reports an explicit empty breakdown. */
function documentToolIds(document: unknown): Set<string> {
  if (!isObject(document) || !Array.isArray(document.daily)) return new Set();
  const ids = new Set<string>();
  for (const parent of document.daily) {
    if (!isObject(parent)) continue;
    const rows = Array.isArray(parent.agents) && parent.agents.some(isObject)
      ? parent.agents.filter(isObject)
      : [parent];
    for (const row of rows) {
      const models = Array.isArray(row.modelBreakdowns) && row.modelBreakdowns.length > 0
        ? row.modelBreakdowns.filter(isObject)
        : [null];
      for (const model of models) {
        const candidate = model && (typeof model.provider === "string" || typeof model.source === "string")
          ? String(model.provider ?? model.source)
          : typeof row.provider === "string" || typeof row.source === "string"
            ? String(row.provider ?? row.source)
            : ccusageRowToolId(row);
        ids.add(normalizeUsageToolId(candidate));
      }
    }
  }
  return ids;
}

function containerForFile(container: RawUsageContainer, toolId: string, records: UsageRecord[]): NormalizedToolUsage {
  return {
    schemaVersion: container.schemaVersion,
    hostId: container.hostId,
    date: container.date,
    timezone: container.timezone,
    category: container.category,
    runId: container.runId,
    generatedAt: container.generatedAt,
    ...(container.range !== undefined ? { range: { ...container.range } } : {}),
    ...(container.ccusageVersion !== undefined ? { ccusageVersion: container.ccusageVersion } : {}),
    toolId,
    rawFile: "raw.json",
    records,
  };
}

function datePath(root: string, hostId: string, date: string): string {
  const [year, month, day] = date.split("-");
  return join(root, hostId, year, month, day);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function writeTempFile(directory: string, contents: string): Promise<string> {
  const path = join(directory, `.tmp-${randomUUID()}`);
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  return path;
}

async function renameTempFile(tempPath: string, targetPath: string): Promise<void> {
  await rename(tempPath, targetPath);
  await chmod(targetPath, 0o600);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function rawToolIds(raw: unknown): Set<string> {
  if (!isObject(raw) || !isObject(raw.data)) throw new Error("Existing raw.json is not a usage container");
  return documentToolIds(raw.data);
}

function archiveTimestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("now must return a valid date");
  // Colons are valid on Unix but not on Windows. This is still an unambiguous
  // UTC timestamp and keeps the store portable.
  return now.toISOString().replace(/[.:]/g, "-");
}

async function archiveRaw(rawPath: string, directory: string, now: Date, log: (message: string) => void): Promise<string> {
  const stamp = archiveTimestamp(now);
  let suffix = 0;
  while (true) {
    const name = `raw.${stamp}${suffix ? `-${suffix}` : ""}.json`;
    const target = join(directory, name);
    if (await fileExists(target)) {
      suffix += 1;
      continue;
    }
    const temp = await writeTempFile(directory, await readFile(rawPath, "utf8"));
    try {
      await renameTempFile(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    try {
      const archives = (await readdir(directory)).filter((name) => /^raw\..+\.json$/.test(name)).sort((a, b) => b.localeCompare(a));
      await Promise.all(archives.slice(MAX_RAW_ARCHIVES).map((archive) => rm(join(directory, archive), { force: true })));
    } catch (error) {
      log(`Raw archive pruning failed in ${directory}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return name;
  }
}

export class FilesystemUsageStore {
  readonly dataRoot: string;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private toolDiscoveryRevision = 0;
  private toolIdsCache: { ids: string[]; expiresAt: number } | null = null;
  private toolDiscovery: { revision: number; promise: Promise<string[]> } | null = null;

  constructor(options: UsageStoreOptions) {
    if (!options || typeof options.dataRoot !== "string" || options.dataRoot.trim() === "") throw new Error("dataRoot is required");
    this.dataRoot = options.dataRoot;
    this.now = options.now || (() => new Date());
    this.log = options.log || ((message) => console.error(message));
  }

  /** Store one complete host/date result. Missing messages and dates do nothing. */
  async ingest(input: RawUsageContainer | null | undefined): Promise<IngestResult> {
    if (!input || typeof input !== "object" || typeof input.date !== "string" || input.date.trim() === "") return { written: false };
    const container = validateContainer(input);
    const records = parseCcusage(container.data);
    if (records.some((record) => record.date !== container.date)) {
      throw new Error(`Parsed usage records must all use container date ${container.date}`);
    }
    const grouped = toolRecords(records);
    for (const toolId of documentToolIds(container.data)) {
      if (!grouped.has(toolId)) grouped.set(toolId, []);
    }
    const toolIds = [...grouped.keys()].sort();
    const hostId = container.hostId;
    const directory = datePath(this.dataRoot, hostId, container.date);
    await ensurePrivateDirectory(this.dataRoot);
    await ensurePrivateDirectory(join(this.dataRoot, hostId));
    await ensurePrivateDirectory(join(this.dataRoot, hostId, container.date.slice(0, 4)));
    await ensurePrivateDirectory(join(this.dataRoot, hostId, container.date.slice(0, 4), container.date.slice(5, 7)));
    await ensurePrivateDirectory(directory);

    const rawPath = join(directory, "raw.json");
    const previousRaw = await fileExists(rawPath) ? await readJson(rawPath) : null;
    const previousToolIds = previousRaw === null ? new Set<string>() : rawToolIds(previousRaw);
    const missingToolIds = [...previousToolIds].filter((toolId) => !grouped.has(toolId));
    const shouldArchive = missingToolIds.length > 0;
    const rawContents = JSON.stringify(container);
    const tempFiles: Array<{ temp: string; target: string }> = [];
    try {
      tempFiles.push({ temp: await writeTempFile(directory, rawContents), target: rawPath });
      for (const toolId of toolIds) {
        const normalized = containerForFile(container, toolId, grouped.get(toolId) || []);
        tempFiles.push({ temp: await writeTempFile(directory, `${JSON.stringify(normalized)}\n`), target: join(directory, `${toolId}.json`) });
      }

      let archivedRawFile: string | undefined;
      if (shouldArchive) {
        archivedRawFile = await archiveRaw(rawPath, directory, this.now(), this.log);
        for (const toolId of missingToolIds) {
          const target = join(directory, `${toolId}.json`);
          if (!(await fileExists(target))) continue;
          const retained = await readJson(target);
          if (!isObject(retained) || !Array.isArray(retained.records)) throw new Error(`Invalid normalized usage file: ${toolId}.json`);
          tempFiles.push({
            temp: await writeTempFile(directory, `${JSON.stringify({ ...retained, rawFile: archivedRawFile })}\n`),
            target,
          });
        }
      }
      for (const file of tempFiles) await renameTempFile(file.temp, file.target);
      this.toolDiscoveryRevision++;
      this.toolIdsCache = null;
      return { written: true, hostId, date: container.date, toolIds, ...(archivedRawFile ? { archivedRawFile } : {}) };
    } finally {
      for (const file of tempFiles) await rm(file.temp, { force: true }).catch(() => undefined);
    }
  }

  /** Read normalized per-tool files without opening raw.json or its archives. */
  async readNormalized(hostId: string, from: string, to: string): Promise<NormalizedToolUsage[]> {
    const safeHostId = sanitizeHostId(hostId);
    if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) throw new Error("Invalid usage date range");
    const result: NormalizedToolUsage[] = [];
    for (let cursor = from; cursor <= to;) {
      const directory = datePath(this.dataRoot, safeHostId, cursor);
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          cursor = nextDate(cursor);
          continue;
        }
        throw error;
      }
      for (const name of names.filter((entry) => entry.endsWith(".json") && entry !== "raw.json" && !entry.startsWith("raw."))) {
        try {
          const value = await readJson(join(directory, name));
          if (!isObject(value) || !Array.isArray(value.records)) throw new Error(`Invalid normalized usage file: ${name}`);
          const toolId = normalizeUsageToolId(value.toolId);
          const file = value as unknown as NormalizedToolUsage;
          result.push({ ...file, toolId, records: file.records.map((record) => ({ ...record, provider: toolId })) });
        } catch (error) {
          this.log(`Skipping unreadable normalized usage file ${join(directory, name)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      cursor = nextDate(cursor);
    }
    return result.sort((a, b) => a.date.localeCompare(b.date) || a.toolId.localeCompare(b.toolId));
  }

  /** Return dates with a persisted raw result, including days with no tool records. */
  async readStoredDates(hostId: string, from: string, to: string): Promise<Set<string>> {
    const safeHostId = sanitizeHostId(hostId);
    if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) throw new Error("Invalid usage date range");
    const result = new Set<string>();
    for (let cursor = from; cursor <= to;) {
      const directory = datePath(this.dataRoot, safeHostId, cursor);
      if (await fileExists(join(directory, "raw.json"))) result.add(cursor);
      cursor = nextDate(cursor);
    }
    return result;
  }

  /** Read the newest normalized record for a host, independent of a query range. */
  async readLatest(hostId: string): Promise<NormalizedToolUsage | null> {
    const safeHostId = sanitizeHostId(hostId);
    const hostRoot = join(this.dataRoot, safeHostId);
    let years;
    try {
      years = await readdir(hostRoot, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }

    const yearNames = years
      .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
    for (const year of yearNames) {
      let months;
      try {
        months = await readdir(join(hostRoot, year), { withFileTypes: true });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      const monthNames = months
        .filter((entry) => entry.isDirectory() && /^\d{2}$/.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a));
      for (const month of monthNames) {
        let days;
        try {
          days = await readdir(join(hostRoot, year, month), { withFileTypes: true });
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
          throw error;
        }
        const dayNames = days
          .filter((entry) => entry.isDirectory() && /^\d{2}$/.test(entry.name))
          .map((entry) => entry.name)
          .sort((a, b) => b.localeCompare(a));
        for (const day of dayNames) {
          const date = `${year}-${month}-${day}`;
          if (!isCalendarDate(date)) continue;
          const values = await this.readNormalized(safeHostId, date, date);
          if (values.length === 0) continue;
          let latest = values[0];
          for (const value of values.slice(1)) if (Date.parse(value.generatedAt) > Date.parse(latest.generatedAt)) latest = value;
          return latest;
        }
      }
    }
    return null;
  }

  async listHostIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.dataRoot, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && sanitizeHostId(entry.name) === entry.name).map((entry) => entry.name).sort();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  async readNormalizedAll(from: string, to: string): Promise<NormalizedToolUsage[]> {
    const hosts = await this.listHostIds();
    const files = await Promise.all(hosts.map((hostId) => this.readNormalized(hostId, from, to)));
    return files.flat();
  }

  /** Discover tools across all stored hosts and dates, independent of the UI range. */
  async listToolIds(): Promise<string[]> {
    if (this.toolIdsCache && this.now().getTime() < this.toolIdsCache.expiresAt) return [...this.toolIdsCache.ids];
    const revision = this.toolDiscoveryRevision;
    if (!this.toolDiscovery || this.toolDiscovery.revision !== revision) {
      const promise = this.discoverToolIds().then((ids) => {
        if (this.toolDiscoveryRevision === revision) this.toolIdsCache = { ids, expiresAt: this.now().getTime() + 30_000 };
        return ids;
      });
      this.toolDiscovery = { revision, promise };
    }
    const discovery = this.toolDiscovery;
    try { return [...await discovery.promise]; }
    finally { if (this.toolDiscovery === discovery) this.toolDiscovery = null; }
  }

  private async discoverToolIds(): Promise<string[]> {
    const ids = new Set<string>();
    const directories = async (path: string, pattern: RegExp): Promise<string[]> => {
      try {
        return (await readdir(path, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && pattern.test(entry.name)).map((entry) => entry.name);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
    };
    for (const hostId of await this.listHostIds()) {
      const hostRoot = join(this.dataRoot, hostId);
      for (const year of await directories(hostRoot, /^\d{4}$/)) {
        for (const month of await directories(join(hostRoot, year), /^\d{2}$/)) {
          for (const day of await directories(join(hostRoot, year, month), /^\d{2}$/)) {
            const date = `${year}-${month}-${day}`;
            if (!isCalendarDate(date)) continue;
            const directory = join(hostRoot, year, month, day);
            let files;
            try {
              files = await readdir(directory, { withFileTypes: true });
            } catch (error) {
              if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
              throw error;
            }
            for (const file of files) {
              if (!file.isFile() || !file.name.endsWith(".json")) continue;
              const id = file.name.slice(0, -5);
              if (isUsageSourceId(id)) ids.add(id);
            }
          }
        }
      }
    }
    return [...ids].sort();
  }

  async readRecords(hostId: string, from: string, to: string): Promise<UsageRecord[]> {
    const files = await this.readNormalized(hostId, from, to);
    return files.flatMap((file) => file.records.map((record) => ({ ...record, hostId: file.hostId })));
  }

  async readAllRecords(from: string, to: string): Promise<UsageRecord[]> {
    const files = await this.readNormalizedAll(from, to);
    return files.flatMap((file) => file.records.map((record) => ({ ...record, hostId: file.hostId })));
  }

  async read(hostId: string, from: string, to: string): Promise<UsageRecord[]> {
    return this.readRecords(hostId, from, to);
  }
}

function nextDate(value: string): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function createFilesystemUsageStore(options: UsageStoreOptions): FilesystemUsageStore {
  return new FilesystemUsageStore(options);
}

/** Short aliases for callers that do not need to name the backing medium. */
export { FilesystemUsageStore as UsageStore };
export const createUsageStore = createFilesystemUsageStore;
