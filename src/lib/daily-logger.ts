import { appendFile, chmod, mkdir, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type DailyLoggerName = "remote" | "server";

export type DailyLoggerFileSystem = {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  appendFile(path: string, data: string, options: { encoding: "utf8"; mode: number }): Promise<void>;
};

export type DailyLoggerOptions = {
  name: DailyLoggerName;
  directory?: string;
  now?: () => Date;
  /** Maximum number of accepted log calls waiting to be written. Defaults to 1000. */
  maxPending?: number;
  /** Internal seams are public to allow deterministic filesystem/timer tests. */
  fileSystem?: DailyLoggerFileSystem;
  stderr?: (message: string) => void;
  rolloverIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
};

export type DailyLogger = {
  /** Control characters become spaces. Messages are capped at 8192 characters. */
  log(message: string): void;
  close(timeoutMs?: number): Promise<void>;
};

const DEFAULT_MAX_PENDING = 1000;
const DEFAULT_SHUTDOWN_TIMEOUT = 2_000;
const DEFAULT_ROLLOVER_CHECK_MS = 60_000;
const STDERR_INTERVAL_MS = 30_000;
const MAX_MESSAGE_LENGTH = 8_192;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Resolve the platform-appropriate default log directory (or use an override). */
export function resolveDailyLogDirectory(options: {
  directory?: string;
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  if (options.directory !== undefined) return options.directory;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const override = env.QUOTA_LOG_DIR;
  if (override) return override;
  if (platform === "darwin") return join(home, "Library", "Logs", "quota-dashboard");
  return join(home, ".local", "state", "quota-dashboard", "logs");
}

/** A local wall-clock timestamp with an explicit numeric offset. */
export function formatLocalTimestamp(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absOffset = Math.abs(offset);
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;
}

function localDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function validDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function addLocalDays(dateString: string, days: number): string {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(0);
  // Calendar arithmetic should not land in a midnight daylight-saving transition.
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month - 1, day + days);
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function createDailyLogger(options: DailyLoggerOptions): DailyLogger {
  if (options.name !== "remote" && options.name !== "server") throw new Error("name must be 'remote' or 'server'");
  const directory = resolveDailyLogDirectory({ directory: options.directory });
  const now = options.now ?? (() => new Date());
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  if (!Number.isInteger(maxPending) || maxPending < 1) throw new Error("maxPending must be a positive integer");

  const io: DailyLoggerFileSystem = options.fileSystem ?? {
    mkdir,
    chmod,
    readdir,
    unlink,
    appendFile,
  };
  const report = (message: string): void => {
    try {
      if (options.stderr) options.stderr(message);
      else process.stderr.write(`${message}\n`);
    } catch { /* Even a broken stderr must not interrupt application work. */ }
  };
  const setTimer = options.setIntervalFn ?? setInterval;
  const clearTimer = options.clearIntervalFn ?? clearInterval;
  const intervalMs = options.rolloverIntervalMs ?? DEFAULT_ROLLOVER_CHECK_MS;
  const prefix = options.name === "remote" ? "remote-info" : "server-info";
  const filename = (date: string) => `${prefix}-${date}.log`;
  const securedFiles = new Set<string>();
  const pending: Array<{ message: string; timestamp: string; date: string; synthetic?: boolean }> = [];
  let active = false;
  let closed = false;
  let lastPrunedDate: string | undefined;
  let preparation: Promise<void> = Promise.resolve();
  let preparationJobs = 0;
  let lastErrorNotice = 0;
  let lastDropNotice = 0;
  let filesystemLost = 0;
  let overflowLost = 0;
  let preparationFailed = false;
  let closePromise: Promise<void> | undefined;

  function rateLimitedError(message: string): void {
    const at = Date.now();
    if (at - lastErrorNotice >= STDERR_INTERVAL_MS || lastErrorNotice === 0) {
      lastErrorNotice = at;
      report(`[${prefix}] ${message}`);
    }
  }

  async function prepareAndPrune(date: string): Promise<void> {
    await io.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    const earliest = addLocalDays(date, -6);
    const entries = await io.readdir(directory);
    let complete = true;
    for (const entry of entries) {
      const match = entry.match(new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})\\.log$`));
      if (!match || !validDate(match[1])) continue;
      if (match[1] < earliest) {
        const path = join(directory, entry);
        try { await io.unlink(path); securedFiles.delete(path); }
        catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
            complete = false;
            rateLimitedError(`unable to prune expired log file (${error instanceof Error ? error.message : String(error)})`);
          } else securedFiles.delete(path);
        }
      }
    }
    lastPrunedDate = complete ? date : undefined;
  }

  function ensurePrepared(): Promise<void> {
    if (lastPrunedDate === localDate(now())) return preparation;
    preparationJobs++;
    const work = preparation.catch(() => {}).then(async () => {
      const date = localDate(now());
      if (lastPrunedDate !== date) await prepareAndPrune(date);
    }).catch(error => {
      preparationFailed = true;
      throw error;
    }).finally(() => {
      preparationJobs--;
    });
    preparation = work;
    return work;
  }

  async function writeEntry(entry: (typeof pending)[number]): Promise<boolean> {
    try {
      await ensurePrepared();
      const currentDate = localDate(now());
      const delayed = entry.date < addLocalDays(currentDate, -6);
      const path = join(directory, filename(delayed ? currentDate : entry.date));
      const lost = { filesystem: filesystemLost, overflow: overflowLost };
      const lostCount = lost.filesystem + lost.overflow;
      const gapLine = lostCount > 0
        ? `${entry.timestamp} GAP: lost ${lostCount} log entr${lostCount === 1 ? "y" : "ies"} (filesystem failures: ${lost.filesystem}, queue overflow: ${lost.overflow})\n`
        : "";
      await io.appendFile(path, `${gapLine}${entry.timestamp} ${delayed ? `delayed-date=${entry.date} ` : ""}${entry.message}\n`, { encoding: "utf8", mode: FILE_MODE });
      filesystemLost -= lost.filesystem;
      overflowLost -= lost.overflow;
      if (lost.filesystem > 0) report(`[${prefix}] logging recovered; ${lost.filesystem} entries were lost to filesystem failures`);
      if (preparationFailed) {
        report(`[${prefix}] logging recovered after a directory or retention preparation failure`);
        preparationFailed = false;
      }
      if (!securedFiles.has(path)) {
        try {
          await io.chmod(path, FILE_MODE);
          securedFiles.add(path);
        } catch (error) {
          rateLimitedError(`unable to secure log file permissions (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      // A stalled append can finish after a date rollover. Reconcile retention
      // after that write too, including the final entry of an otherwise idle queue.
      await ensurePrepared().catch(error => {
        rateLimitedError(`unable to reconcile retention after write (${error instanceof Error ? error.message : String(error)})`);
      });
      return true;
    } catch (error) {
      if (!entry.synthetic) filesystemLost++;
      rateLimitedError(`${entry.synthetic ? "unable to record logging gap" : "unable to write log entry; entry dropped"}; logging will retry on the next write or periodic check (${error instanceof Error ? error.message : String(error)})`);
      return false;
    }
  }

  async function drain(): Promise<void> {
    if (active) return;
    active = true;
    try {
      let wrote = false;
      while (pending.length) {
        const entry = pending.shift()!;
        wrote = await writeEntry(entry);
      }
      // Loss can accumulate while the final append is stalled. Record that gap even
      // if no application event arrives after the disk becomes writable again.
      if (wrote && (filesystemLost > 0 || overflowLost > 0)) await writeEntry(gapEntry());
    } finally {
      active = false;
      if (pending.length) void drain();
    }
  }

  function gapEntry(): (typeof pending)[number] {
    const time = now();
    return { message: "logging resumed", timestamp: formatLocalTimestamp(time), date: localDate(time), synthetic: true };
  }

  // Prepare at startup and retain only the current local date and six preceding dates.
  void ensurePrepared().catch(error => {
    rateLimitedError(`unable to prepare log directory; will retry (${error instanceof Error ? error.message : String(error)})`);
  });

  const timer = setTimer(() => {
    const date = localDate(now());
    if (lastPrunedDate !== date) {
      void ensurePrepared().catch(error => {
        rateLimitedError(`unable to rotate log retention; will retry (${error instanceof Error ? error.message : String(error)})`);
      });
    }
    if (!closed && !active && pending.length === 0 && (filesystemLost > 0 || overflowLost > 0)) {
      pending.push(gapEntry());
      void drain();
    }
  }, intervalMs);
  timer.unref?.();

  return {
    log(message: string): void {
      if (closed) return;
      if (pending.length + (active ? 1 : 0) >= maxPending) {
        overflowLost++;
        const at = Date.now();
        if (at - lastDropNotice >= STDERR_INTERVAL_MS || lastDropNotice === 0) {
          lastDropNotice = at;
          report(`[${prefix}] dropped ${overflowLost} log entr${overflowLost === 1 ? "y" : "ies"} because the queue was full`);
        }
        return;
      }
      const time = now();
      const safeMessage = message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, MAX_MESSAGE_LENGTH);
      pending.push({ message: safeMessage, timestamp: formatLocalTimestamp(time), date: localDate(time) });
      void drain();
    },
    close(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      clearTimer(timer);
      closePromise = (async () => {
        const deadline = Date.now() + Math.max(0, timeoutMs);
        while ((active || pending.length || preparationJobs > 0) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
        }
        if (active || pending.length || preparationJobs > 0) {
          const left = pending.length + (active ? 1 : 0);
          report(`[${prefix}] shutdown timed out; ${left} queued or active log entr${left === 1 ? "y" : "ies"} may be lost${preparationJobs > 0 ? `, ${preparationJobs} preparation task${preparationJobs === 1 ? "" : "s"} still running` : ""}`);
          pending.length = 0;
        }
        if (filesystemLost > 0 || overflowLost > 0) report(`[${prefix}] unrecorded logging gap: filesystem=${filesystemLost} overflow=${overflowLost}`);
      })();
      return closePromise;
    },
  };
}
