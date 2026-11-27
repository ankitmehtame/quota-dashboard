import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CursorUsageEvent } from "./cursor-usage.js";

export type StoredCursorEvent = CursorUsageEvent & { hostId: string; importedAt: string };
type Shard = { version: 1; month: string; events: StoredCursorEvent[] };
export type CursorImportCounts = { added: number; updated: number; moved: number };

const MONTH = /^\d{4}-\d{2}$/;

function monthOf(time: string): string {
  return time.slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const date = new Date(`${month}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}

function shiftDay(date: string, delta: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + delta);
  return value.toISOString().slice(0, 10);
}

/**
 * Imported Cursor billing events, one file per UTC month.
 * The billing ID is the key across all hosts: a later import of the same ID replaces it,
 * including its host. Writes run one at a time so overlapping uploads never lose rows.
 */
export class CursorUsageStore {
  private queue: Promise<unknown> = Promise.resolve();
  /** Increases after every completed import, so derived results can be cached. */
  revision = 0;

  constructor(private readonly root: string) {}

  private path(month: string): string {
    if (!MONTH.test(month)) throw new Error("Invalid Cursor usage month");
    return join(this.root, `${month}.json`);
  }

  private async readShard(month: string): Promise<StoredCursorEvent[]> {
    try {
      const value = JSON.parse(await readFile(this.path(month), "utf8")) as Shard;
      if (value.version !== 1 || value.month !== month || !Array.isArray(value.events)) throw new Error("Invalid Cursor usage file");
      return value.events;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeShard(month: string, events: StoredCursorEvent[]): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    const target = this.path(month);
    const temp = join(this.root, `.tmp-${randomUUID()}`);
    try {
      const sorted = [...events].sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
      await writeFile(temp, JSON.stringify({ version: 1, month, events: sorted } satisfies Shard), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temp, target);
      await chmod(target, 0o600);
    } finally {
      await rm(temp, { force: true });
    }
  }

  /** Add or replace events under one host. Returns how many were new, changed, or moved from another host. */
  upsert(batch: CursorUsageEvent[], hostId: string, importedAt = new Date().toISOString()): Promise<CursorImportCounts> {
    // One row per billing ID; a later duplicate in the same batch wins.
    const events = [...new Map(batch.map((event) => [event.id, event])).values()];
    const run = this.queue.catch(() => undefined).then(async () => {
      const counts: CursorImportCounts = { added: 0, updated: 0, moved: 0 };
      const byMonth = new Map<string, CursorUsageEvent[]>();
      for (const event of events) {
        const month = monthOf(event.time);
        // Check every month before writing any file, so a bad event cannot leave a partial import.
        if (!MONTH.test(month)) throw new Error("Invalid Cursor usage month");
        const bucket = byMonth.get(month);
        if (bucket) bucket.push(event);
        else byMonth.set(month, [event]);
      }
      const incomingIds = new Set(events.map((event) => event.id));
      // Read every month first: an incoming billing ID replaces its stored copy wherever
      // that copy is, including a month that also receives other incoming rows.
      const previous = new Map<string, StoredCursorEvent>();
      const shards = new Map<string, { kept: StoredCursorEvent[]; changed: boolean }>();
      for (const month of new Set([...await this.months(), ...byMonth.keys()])) {
        const stored = await this.readShard(month);
        const kept = stored.filter((event) => {
          if (!incomingIds.has(event.id)) return true;
          previous.set(event.id, event);
          return false;
        });
        shards.set(month, { kept, changed: kept.length !== stored.length });
      }
      for (const event of events) {
        const before = previous.get(event.id);
        if (!before) counts.added++;
        else if (before.hostId !== hostId) counts.moved++;
        else counts.updated++;
      }
      // Two passes, so a write failing part way can leave a moved row in two months but never in none:
      // first add incoming rows (keeping copies that move elsewhere), then drop the moved copies.
      const added = new Map<string, StoredCursorEvent[]>();
      for (const [month, incoming] of byMonth) {
        const here = new Set(incoming.map((event) => event.id));
        const stored = await this.readShard(month);
        added.set(month, [...stored.filter((event) => !here.has(event.id)), ...incoming.map((event) => ({ ...event, hostId, importedAt }))]);
      }
      try {
        for (const [month, events] of added) await this.writeShard(month, events);
        for (const [month, shard] of shards) {
          if (!shard.changed) continue;
          const final = [...shard.kept, ...(byMonth.get(month) ?? []).map((event) => ({ ...event, hostId, importedAt }))];
          if (final.length !== added.get(month)?.length) await this.writeShard(month, final);
        }
      } finally {
        // Bump even after a partial failure, so cached results never outlive changed files.
        this.revision++;
      }
      return counts;
    });
    this.queue = run;
    return run;
  }

  /** Events whose UTC month overlaps the local date range, padded a day either side for timezones. */
  async read(from: string, to: string): Promise<StoredCursorEvent[]> {
    const first = monthOf(shiftDay(from, -1));
    const last = monthOf(shiftDay(to, 1));
    const months: string[] = [];
    for (let month = first; month <= last && months.length < 400; month = shiftMonth(month, 1)) months.push(month);
    return (await Promise.all(months.map((month) => this.readShard(month)))).flat();
  }

  private async months(): Promise<string[]> {
    try { return (await readdir(this.root)).filter((name) => /^\d{4}-\d{2}\.json$/.test(name)).map((name) => name.slice(0, 7)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  private hostCache: { revision: number; hosts: Promise<Set<string>> } | null = null;

  /** Every host that owns at least one imported event. Cached until the next import. */
  hostIds(): Promise<Set<string>> {
    if (this.hostCache?.revision === this.revision) return this.hostCache.hosts.then((hosts) => new Set(hosts));
    const revision = this.revision;
    const hosts = (async () => {
      const found = new Set<string>();
      for (const month of await this.months()) for (const event of await this.readShard(month)) found.add(event.hostId);
      return found;
    })();
    this.hostCache = { revision, hosts };
    hosts.catch(() => { if (this.hostCache?.hosts === hosts) this.hostCache = null; });
    return hosts.then((found) => new Set(found));
  }

  async hasEvents(): Promise<boolean> {
    return (await this.months()).length > 0;
  }
}
