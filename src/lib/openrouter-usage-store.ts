import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UsageRecord } from "./usage.js";

type Snapshot = { version: 1; date: string; timezone: string; fetchedAt: string; records: UsageRecord[] };

/** Dedicated per-key snapshots, kept separate from ccusage's host/date files. */
export class OpenRouterUsageStore {
  constructor(private readonly root: string) {}

  private path(hash: string, date: string, timezone: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid OpenRouter snapshot identifier");
    const timezoneId = createHash("sha256").update(timezone).digest("hex");
    return join(this.root, hash, timezoneId, `${date}.json`);
  }

  async read(hash: string, date: string, timezone: string): Promise<Snapshot | null> {
    try {
      const value = JSON.parse(await readFile(this.path(hash, date, timezone), "utf8")) as Snapshot;
      if (value.version !== 1 || value.date !== date || value.timezone !== timezone || !Array.isArray(value.records)
        || typeof value.fetchedAt !== "string" || !Number.isFinite(Date.parse(value.fetchedAt))) throw new Error("Invalid OpenRouter snapshot");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Whether any snapshot exists for this key and timezone. Used to retain history for keys no longer polled. */
  async has(hash: string, timezone: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid OpenRouter snapshot identifier");
    try { return (await readdir(join(this.root, hash, createHash("sha256").update(timezone).digest("hex")))).some((name) => name.endsWith(".json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }

  async write(hash: string, date: string, timezone: string, records: UsageRecord[], fetchedAt = new Date().toISOString()): Promise<void> {
    const target = this.path(hash, date, timezone);
    if (!Number.isFinite(Date.parse(fetchedAt)) || records.some((record) => record.date !== date)) throw new Error("Invalid OpenRouter snapshot");
    const directory = join(this.root, hash, createHash("sha256").update(timezone).digest("hex"));
    for (const dir of [this.root, join(this.root, hash), directory]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
    }
    const temp = join(directory, `.tmp-${randomUUID()}`);
    try {
      await writeFile(temp, JSON.stringify({ version: 1, date, timezone, fetchedAt, records } satisfies Snapshot), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temp, target);
      await chmod(target, 0o600);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
