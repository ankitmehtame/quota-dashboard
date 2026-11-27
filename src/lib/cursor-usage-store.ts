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
  upsert(events: CursorUsageEvent[], hostId: string, importedAt = new Date().toISOString()): Promise<CursorImportCounts> {
    const run = this.queue.catch(() => undefined).then(async () => {
      const counts: CursorImportCounts = { added: 0, updated: 0, moved: 0 };
      const byMonth = new Map<string, CursorUsageEvent[]>();
      for (const event of events) byMonth.set(monthOf(event.time), [...(byMonth.get(monthOf(event.time)) ?? []), event]);
      for (const [month, incoming] of byMonth) {
        const existing = new Map((await this.readShard(month)).map((event) => [event.id, event]));
        for (const event of incoming) {
          const previous = existing.get(event.id);
          if (!previous) counts.added++;
          else if (previous.hostId !== hostId) counts.moved++;
          else counts.updated++;
          existing.set(event.id, { ...event, hostId, importedAt });
        }
        await this.writeShard(month, [...existing.values()]);
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

  async hasEvents(): Promise<boolean> {
    try { return (await readdir(this.root)).some((name) => /^\d{4}-\d{2}\.json$/.test(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
}
