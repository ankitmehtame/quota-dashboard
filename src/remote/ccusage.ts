import { execFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";

export const DEFAULT_CCUSAGE_TIMEOUT_MS = 30_000;
export const DEFAULT_HOT_CCUSAGE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_COLD_CCUSAGE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_CCUSAGE_MAX_BUFFER = 32 * 1024 * 1024;
export const DEFAULT_ROLLING_DAYS = 370;

export type CcusageRange = {
  from: string;
  to: string;
  timezone: string;
};

export type CcusageCommandResult = {
  document: unknown;
  stdout: string;
  stderr: string;
};

type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout: string | Buffer, stderr: string | Buffer) => void;
export type ExecFileRunner = (
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: ExecFileCallback,
) => unknown;

export function ccusageArgs(range: CcusageRange, options: { offline?: boolean } | boolean = {}): string[] {
  const offline = typeof options === "boolean" ? options : options.offline;
  return [
    "daily",
    "--json",
    "--by-agent",
    "--since",
    range.from,
    "--until",
    range.to,
    "--timezone",
    range.timezone,
    ...(offline ? ["--offline"] : []),
  ];
}

export function rollingDateRange(
  timezone: string,
  now = new Date(),
  days = DEFAULT_ROLLING_DAYS,
): CcusageRange {
  const safeDays = Number.isInteger(days) && days > 0 ? days : DEFAULT_ROLLING_DAYS;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const today = `${values.year}-${values.month}-${values.day}`;
  const start = new Date(`${today}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - safeDays + 1);

  return {
    from: start.toISOString().slice(0, 10),
    to: today,
    timezone,
  };
}

function executeFile(
  runner: ExecFileRunner,
  binary: string,
  args: string[],
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    runner(binary, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function runCcusage({
  binary = process.env.CCUSAGE_BIN?.trim() || "ccusage",
  range,
  timeoutMs = DEFAULT_CCUSAGE_TIMEOUT_MS,
  maxBuffer = DEFAULT_CCUSAGE_MAX_BUFFER,
  offline = false,
  runner = execFile as unknown as ExecFileRunner,
}: {
  binary?: string;
  range: CcusageRange;
  timeoutMs?: number;
  maxBuffer?: number;
  offline?: boolean;
  runner?: ExecFileRunner;
}): Promise<CcusageCommandResult> {
  const { stdout, stderr } = await executeFile(runner, binary, ccusageArgs(range, { offline }), {
    timeout: timeoutMs,
    maxBuffer,
    windowsHide: true,
    killSignal: "SIGTERM",
    encoding: "utf8",
  });

  return {
    document: JSON.parse(stdout),
    stdout,
    stderr,
  };
}

export function ccusageErrorMessage(error: unknown, binary: string): string {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    return `${binary} was not found`;
  }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "ccusage failed";
}
