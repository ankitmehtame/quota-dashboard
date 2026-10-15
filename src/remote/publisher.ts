import os from "node:os";
import { createHash, randomUUID } from "node:crypto";

import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import { createDailyLogger, formatLocalTimestamp } from "../lib/daily-logger.js";

import {
  makeCommandTopic,
  makeErrorMessage,
  makeMqttTopics,
  makeStatusMessage,
  makeUsageSnapshot,
  makeUsageTopic,
  parseMqttCommand,
  sanitizeHostId,
  type MqttCategory,
  type MqttCommandMode,
  type MqttMetadata,
  type MqttDateRange,
  type ParsedMqttCommand,
} from "./protocol.js";
import {
  ccusageErrorMessage,
  DEFAULT_COLD_CCUSAGE_TIMEOUT_MS,
  DEFAULT_CCUSAGE_MAX_BUFFER,
  DEFAULT_HOT_CCUSAGE_TIMEOUT_MS,
  rollingDateRange,
  runCcusage,
  sliceCcusageDocument,
  type ExecFileRunner,
} from "./ccusage.js";

export const DEFAULT_MQTT_URL = "mqtt://127.0.0.1:1883";
export const DEFAULT_MQTT_PREFIX = "quota-dashboard/v1";
export const DEFAULT_PUBLISH_INTERVAL_MS = 10 * 60 * 1000;
export const DEFAULT_COLD_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MQTT_RECONNECT_TIMEOUT_MS = 90_000;
const MAX_ACTIVE_COMMANDS = 256;

export type RemotePublisherConfig = {
  mqttUrl: string;
  mqttPrefix: string;
  hostId: string;
  timezone: string;
  ccusageBinary: string;
  rollingDays: number;
  publishIntervalMs: number;
  reconnectTimeoutMs?: number;
  /** Kept as an optional compatibility input. New callers should use hotTimeoutMs. */
  ccusageTimeoutMs?: number;
  hotTimeoutMs?: number;
  coldTimeoutMs?: number;
  coldIntervalMs?: number;
  ccusageMaxBuffer: number;
  coldMode?: MqttCommandMode;
  username?: string;
  password?: string;
  ccusageVersion?: string;
};

type NormalizedPublisherConfig = Omit<RemotePublisherConfig, "hotTimeoutMs" | "coldTimeoutMs" | "coldIntervalMs" | "coldMode"> & {
  hotTimeoutMs: number;
  coldTimeoutMs: number;
  coldIntervalMs: number;
  coldMode: MqttCommandMode;
};

export type PublisherDependencies = {
  connect?: typeof mqtt.connect;
  runCcusage?: typeof runCcusage;
  now?: () => Date;
  execFileRunner?: ExecFileRunner;
  log?: (message: string) => void;
  infoLog?: (message: string) => void;
  /** Owns and drains the daily file logger. */
  closeLog?: (timeoutMs?: number) => Promise<void>;
  /** Fatal watchdog exit. Do not wait for jobs or MQTT acknowledgements. */
  exit?: (code: number) => void;
  /** Injectable observation seam for command handling without touching MQTT callbacks. */
  onCommand?: (command: ParsedMqttCommand) => void;
};

type UsageJob = {
  range: MqttDateRange;
  category: MqttCategory;
  mode: MqttCommandMode;
  runId: string;
  commandRequestId?: string;
  scheduledDate?: string;
  scheduled?: boolean;
};

/** Redact credentials, query parameters, and path from an MQTT URL for safe logging. */
export function sanitizeMqttUrl(rawUrl: string): string {
  if (typeof rawUrl !== "string") return "";
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (!parsed.host) return "[redacted-url]";
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
    if (schemeMatch) return `${schemeMatch[1].toLowerCase()}://[redacted]`;
    return "[redacted-url]";
  }
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readRemotePublisherConfig(env: NodeJS.ProcessEnv = process.env): RemotePublisherConfig {
  const hostId = sanitizeHostId(env.MQTT_HOST_ID?.trim() || env.HOST_ID?.trim() || os.hostname());
  const timezone = env.CCUSAGE_TIMEZONE?.trim() || env.MQTT_TIMEZONE?.trim() || env.TIMEZONE?.trim() || env.TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format();
  const legacyTimeout = positiveNumber(env.CCUSAGE_TIMEOUT_MS, DEFAULT_HOT_CCUSAGE_TIMEOUT_MS);

  return {
    mqttUrl: env.MQTT_URL?.trim() || env.MQTT_BROKER_URL?.trim() || env.MQTT_BROKER?.trim() || DEFAULT_MQTT_URL,
    mqttPrefix: env.MQTT_PREFIX?.trim() || DEFAULT_MQTT_PREFIX,
    hostId,
    timezone,
    ccusageBinary: env.CCUSAGE_BIN?.trim() || "ccusage",
    rollingDays: Math.max(1, Math.trunc(positiveNumber(env.CCUSAGE_DAYS, 370))),
    publishIntervalMs: positiveNumber(env.MQTT_INTERVAL_MS || env.MQTT_PUBLISH_INTERVAL_MS, DEFAULT_PUBLISH_INTERVAL_MS),
    reconnectTimeoutMs: positiveNumber(env.MQTT_RECONNECT_TIMEOUT_MS, DEFAULT_MQTT_RECONNECT_TIMEOUT_MS),
    hotTimeoutMs: positiveNumber(env.CCUSAGE_HOT_TIMEOUT_MS, legacyTimeout),
    coldTimeoutMs: positiveNumber(env.CCUSAGE_COLD_TIMEOUT_MS, DEFAULT_COLD_CCUSAGE_TIMEOUT_MS),
    coldIntervalMs: positiveNumber(env.CCUSAGE_COLD_INTERVAL_MS, DEFAULT_COLD_INTERVAL_MS),
    ccusageMaxBuffer: positiveNumber(env.CCUSAGE_MAX_BUFFER, DEFAULT_CCUSAGE_MAX_BUFFER),
    coldMode: env.CCUSAGE_COLD_MODE?.trim().toLowerCase() === "online" ? "online" : "offline",
    ...(env.MQTT_USERNAME !== undefined && env.MQTT_USERNAME !== "" ? { username: env.MQTT_USERNAME } : {}),
    ...(env.MQTT_PASSWORD !== undefined && env.MQTT_PASSWORD !== "" ? { password: env.MQTT_PASSWORD } : {}),
    ...(env.CCUSAGE_VERSION?.trim() ? { ccusageVersion: env.CCUSAGE_VERSION.trim() } : {}),
  };
}

function mqttOptions(config: NormalizedPublisherConfig, will: string): IClientOptions {
  const hostHash = createHash("sha256").update(config.hostId).digest("hex").slice(0, 12);
  const options: IClientOptions = {
    clientId: `quota-dashboard-remote-${config.hostId.slice(0, 80)}-${hostHash}`,
    reconnectPeriod: 5_000,
    connectTimeout: 30_000,
    clean: true,
    will: {
      topic: makeMqttTopics(config.mqttPrefix, config.hostId).status,
      payload: will,
      qos: 1,
      retain: true,
    },
  };
  if (config.username !== undefined && config.username !== "") options.username = config.username;
  if (config.password !== undefined && config.password !== "") options.password = config.password;
  return options;
}

function publish(client: MqttClient, topic: string, payload: string, retain = true): Promise<void> {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: 1, retain }, (error) => error ? reject(error) : resolve());
  });
}

function subscribe(client: MqttClient, topic: string): Promise<void> {
  const candidate = client as MqttClient & { subscribe?: MqttClient["subscribe"] };
  if (typeof candidate.subscribe !== "function") return Promise.resolve();
  return new Promise((resolve, reject) => candidate.subscribe(topic, { qos: 1 }, (error) => error ? reject(error) : resolve()));
}

function metadata(
  config: NormalizedPublisherConfig,
  date: string,
  category: MqttCategory,
  runId: string,
  now: Date,
  publisherId: string,
  connectionId: string,
  sequence: number,
): Omit<MqttMetadata, "schemaVersion"> {
  return {
    publisherId,
    connectionId,
    sequence,
    hostId: config.hostId,
    generatedAt: now.toISOString(),
    ...(config.ccusageVersion ? { ccusageVersion: config.ccusageVersion } : {}),
    timezone: config.timezone,
    date,
    category,
    runId,
  };
}

function dateList(range: MqttDateRange): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${range.from}T12:00:00.000Z`);
  const end = new Date(`${range.to}T12:00:00.000Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function previousDate(value: string): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function validDateRange(range: MqttDateRange): boolean {
  const valid = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  return valid(range.from) && valid(range.to) && range.from <= range.to;
}

function safeError(error: unknown): string {
  if (error instanceof SyntaxError) return "invalid ccusage output (SyntaxError)";
  if (error && typeof error === "object") {
    const detail = error as NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown; cmd?: unknown; command?: unknown; args?: unknown };
    if (detail.stdout !== undefined || detail.stderr !== undefined || detail.cmd !== undefined || detail.command !== undefined || detail.args !== undefined) {
      return `${error instanceof Error ? error.name : "Error"}${detail.code ? ` (${detail.code})` : ""}`;
    }
  }
  const raw = error instanceof Error ? error.message : String(error);
  if (/[{}\[\]]/.test(raw) || /\b(?:daily|totalCost|inputTokens|outputTokens)\b/i.test(raw)) return "error details omitted";
  return raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, "[redacted-url]")
    .replace(/([?&][^=\s]+=)[^&\s]*/g, "$1[redacted]")
    .replace(/\b(password|passwd|token|secret|authorization|api[-_]?key|access[-_]?token)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .slice(0, 500);
}

export class RemoteMqttPublisher {
  private readonly config: NormalizedPublisherConfig;
  private readonly dependencies: Required<Pick<PublisherDependencies, "connect" | "runCcusage" | "now" | "log" | "infoLog" | "exit">> & PublisherDependencies;
  private readonly topics;
  private readonly publisherId = randomUUID();
  private connectionId = randomUUID();
  private sequence = 0;
  private client: MqttClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private coldTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private hotInFlight: Promise<void> | null = null;
  private coldInFlight: Promise<void> | null = null;
  private readonly hotQueue: UsageJob[] = [];
  private readonly coldQueue: UsageJob[] = [];
  private readonly commandRequestIds = new Set<string>();
  private readonly scheduledColdDates = new Set<string>();
  private stopped = false;
  private stopPromise: Promise<void> | null = null;
  private connected = false;
  private hotFailed = false;
  private coldFailed = false;

  constructor(config = readRemotePublisherConfig(), dependencies: PublisherDependencies = {}) {
    this.config = {
      ...config,
      hostId: sanitizeHostId(config.hostId),
      hotTimeoutMs: config.hotTimeoutMs ?? config.ccusageTimeoutMs ?? DEFAULT_HOT_CCUSAGE_TIMEOUT_MS,
      coldTimeoutMs: config.coldTimeoutMs ?? DEFAULT_COLD_CCUSAGE_TIMEOUT_MS,
      coldIntervalMs: config.coldIntervalMs ?? DEFAULT_COLD_INTERVAL_MS,
      coldMode: config.coldMode ?? "offline",
    };
    const dailyLogger = dependencies.infoLog ? undefined : createDailyLogger({ name: "remote" });
    this.dependencies = {
      connect: mqtt.connect,
      runCcusage,
      now: () => new Date(),
      log: (message: string) => console.error(message),
      infoLog: (message: string) => dailyLogger!.log(message),
      exit: (code: number) => { process.exit(code); },
      ...(dailyLogger ? { closeLog: (timeoutMs?: number) => dailyLogger.close(timeoutMs) } : {}),
      ...dependencies,
    };
    this.topics = makeMqttTopics(this.config.mqttPrefix, this.config.hostId);
  }

  private log(message: string, quiet = false): void {
    const safe = message.replace(/[\x00-\x1f\x7f]/g, " ");
    try { this.dependencies.infoLog(safe); } catch { /* Logging cannot interrupt jobs. */ }
    if (!quiet) {
      try { this.dependencies.log(`[${formatLocalTimestamp(this.dependencies.now())}] ${safe}`); } catch { /* Logging cannot interrupt jobs. */ }
    }
  }

  private logCold(requestId: string, message: string, quiet = false): void {
    this.log(`[cold] [${requestId}] ${message}`, quiet);
  }

  private async send(client: MqttClient, topic: string, message: { category?: MqttCategory; date?: string; runId?: string; status?: string }): Promise<void> {
    const kind = topic === this.topics.status ? "status" : topic === this.topics.error ? "error" : "usage";
    const context = `kind=${kind} category=${message.category} date=${message.date} run=${message.runId}${message.status ? ` status=${message.status}` : ""}`;
    const startedAt = Date.now();
    this.log(`mqtt response start ${context}`, true);
    try {
      await publish(client, topic, JSON.stringify(message));
      this.log(`mqtt response sent ${context} duration=${Date.now() - startedAt}ms`, true);
    } catch (error) {
      this.log(`mqtt response failed ${context} duration=${Date.now() - startedAt}ms error=${safeError(error)}`, true);
      throw error;
    }
  }

  private reportJobResult(category: MqttCategory, job: UsageJob, failed: boolean): void {
    const previous = category === "hot" ? this.hotFailed : this.coldFailed;
    if (category === "hot") this.hotFailed = failed;
    else this.coldFailed = failed;
    if (!failed && previous && !this.stopped) {
      this.log(`${category} job recovered run=${job.runId} range=${job.range.from}..${job.range.to}`);
    }
  }

  get mqttTopics(): ReturnType<typeof makeMqttTopics> {
    return this.topics;
  }

  async start(): Promise<void> {
    if (this.client) return;
    this.stopped = false;
    const today = rollingDateRange(this.config.timezone, this.dependencies.now(), 1).to;
    const offline = makeStatusMessage(this.nextMetadata(today, "hot", "lifecycle"), "offline");
    const client = this.dependencies.connect(this.config.mqttUrl, mqttOptions(this.config, JSON.stringify(offline)));
    this.client = client;
    client.on("connect", this.onConnect);
    client.on("message", this.onMessage);
    client.on("reconnect", this.onReconnect);
    client.on("offline", this.onOffline);
    client.on("close", this.onClose);
    client.on("error", this.onError);
    this.armReconnectWatchdog();
  }

  /** Run today's and yesterday's hot jobs, with at most one hot job in flight. */
  async publishHot(onDemand = false): Promise<boolean> {
    if (this.hotInFlight || this.stopped || !this.client) {
      this.log(`hot job skipped reason=${this.hotInFlight ? "already-running" : "publisher-unavailable"} source=${onDemand ? "on-demand" : "scheduled"}`, !onDemand);
      return false;
    }
    const range = rollingDateRange(this.config.timezone, this.dependencies.now(), 2);
    const job: UsageJob = { range, category: "hot", mode: "online", runId: randomUUID(), scheduled: !onDemand };
    this.log(`[hot] [${job.runId}] receipt range=${range.from}..${range.to} source=${onDemand ? "on-demand" : "scheduled"}`, !onDemand);
    const task = this.startJob(job, this.config.hotTimeoutMs);
    this.hotInFlight = task;
    try {
      await task;
      this.reportJobResult("hot", job, false);
      return true;
    } catch (error) {
      this.reportJobResult("hot", job, true);
      return false;
    } finally {
      if (this.hotInFlight === task) this.hotInFlight = null;
      void this.drainHotQueue();
    }
  }

  /** Compatibility name for callers that used the host-wide snapshot method. */
  async publishSnapshot(): Promise<boolean> {
    return this.publishHot();
  }

  /** Queue a cold date range. The default is offline mode and one cold job runs at a time. */
  requestCold(from: string, to = from, mode: MqttCommandMode = this.config.coldMode, requestId: string = randomUUID()): boolean {
    if (!validDateRange({ from, to })) return false;
    this.logCold(requestId, `receipt range=${from}..${to} mode=${mode}`);
    return this.enqueueJob({ range: { from, to }, category: "cold", mode, runId: requestId }, false);
  }

  /** Run one cold job immediately when the cold slot is free. */
  async publishCold(from: string, to = from, mode: MqttCommandMode = this.config.coldMode): Promise<boolean> {
    if (!validDateRange({ from, to }) || this.coldInFlight || this.stopped || !this.client) return false;
    const runId = randomUUID();
    this.logCold(runId, `receipt range=${from}..${to} mode=${mode}`);
    const job: UsageJob = { range: { from, to }, category: "cold", mode, runId };
    const task = this.startJob(job, this.config.coldTimeoutMs);
    this.coldInFlight = task;
    try {
      await task;
      this.reportJobResult("cold", job, false);
      return true;
    } catch {
      this.reportJobResult("cold", job, true);
      return false;
    } finally {
      if (this.coldInFlight === task) this.coldInFlight = null;
      void this.drainColdQueue();
    }
  }

  /** Queue the older part of the configured rolling history for a scheduled cold pass. */
  scheduleColdHistory(): boolean {
    this.log("cold scheduler check", true);
    if (this.config.rollingDays <= 2) { this.log("cold scheduler skipped reason=no-history", true); return false; }
    const yesterday = rollingDateRange(this.config.timezone, this.dependencies.now(), 2).from;
    const staleDate = previousDate(yesterday);
    if (this.scheduledColdDates.has(staleDate)) { this.log(`cold scheduler skipped date=${staleDate} reason=already-queued`, true); return false; }
    this.logCold(`scheduled-${staleDate}`, `receipt range=${staleDate}..${staleDate} mode=${this.config.coldMode} source=scheduled`, true);
    return this.enqueueJob({ range: { from: staleDate, to: staleDate }, category: "cold", mode: this.config.coldMode, runId: `scheduled-${staleDate}`, scheduledDate: staleDate }, false);
  }

  /** Feed a command from MQTT without doing async work in the MQTT callback. */
  processCommand(topic: string, payload: Buffer | Uint8Array | string): boolean {
    const command = parseMqttCommand(topic, payload, this.config.mqttPrefix);
    if (!command || command.hostId !== this.config.hostId) { this.log("mqtt command rejected reason=validation-or-target", true); return false; }
    if (this.stopped || !this.client || this.commandRequestIds.has(command.requestId) || this.commandRequestIds.size >= MAX_ACTIVE_COMMANDS) {
      const reason = this.stopped || !this.client ? "publisher unavailable" : this.commandRequestIds.has(command.requestId) ? "duplicate request" : "active command limit reached";
      this.log(`command ignored request=${command.requestId} category=${command.category} reason=${reason}`);
      return false;
    }
    this.commandRequestIds.add(command.requestId);
    try {
      this.dependencies.onCommand?.(command);
    } catch (error) {
      this.log(`Command handler failed: ${safeError(error)}`);
    }
    this.log(`[${command.category}] [${command.requestId}] receipt range=${command.from}..${command.to} mode=${command.mode}`);
    const accepted = this.enqueueJob({ range: { from: command.from, to: command.to }, category: command.category, mode: command.mode, runId: command.requestId, commandRequestId: command.requestId }, command.category === "hot");
    if (!accepted) {
      this.commandRequestIds.delete(command.requestId);
      this.log(`command ignored request=${command.requestId} category=${command.category} reason=job queue rejected`);
    }
    return accepted;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopNow().finally(() => this.closeLog());
    return this.stopPromise;
  }

  private enqueueJob(job: UsageJob, hot: boolean): boolean {
    if (this.stopped || !this.client) { this.log(`job skipped run=${job.runId} reason=publisher-unavailable`, true); return false; }
    const queue = hot ? this.hotQueue : this.coldQueue;
    if (queue.some((entry) => entry.runId === job.runId)) return false;
    if (job.scheduledDate && this.scheduledColdDates.has(job.scheduledDate)) return false;
    if (job.scheduledDate) this.scheduledColdDates.add(job.scheduledDate);
    queue.push(job);
    this.log(`job queued category=${job.category} run=${job.runId} range=${job.range.from}..${job.range.to}`, true);
    if (hot) void this.drainHotQueue();
    else void this.drainColdQueue();
    return true;
  }

  private async drainHotQueue(): Promise<void> {
    if (this.hotInFlight || this.stopped || !this.client) return;
    const job = this.hotQueue.shift();
    if (!job) return;
    const task = this.startJob(job, this.config.hotTimeoutMs);
    this.hotInFlight = task;
    let failed = false;
    await task.catch(() => { failed = true; });
    this.reportJobResult("hot", job, failed);
    if (this.hotInFlight === task) this.hotInFlight = null;
    if (job.commandRequestId) this.commandRequestIds.delete(job.commandRequestId);
    void this.drainHotQueue();
  }

  private async drainColdQueue(): Promise<void> {
    if (this.coldInFlight || this.stopped || !this.client) return;
    const job = this.coldQueue.shift();
    if (!job) return;
    const task = this.startJob(job, this.config.coldTimeoutMs);
    this.coldInFlight = task;
    let failed = false;
    await task.catch(() => { failed = true; });
    this.reportJobResult("cold", job, failed);
    if (this.coldInFlight === task) this.coldInFlight = null;
    if (job.scheduledDate) this.scheduledColdDates.delete(job.scheduledDate);
    if (job.commandRequestId) this.commandRequestIds.delete(job.commandRequestId);
    void this.drainColdQueue();
  }

  private async startJob(job: UsageJob, timeoutMs: number): Promise<void> {
    if (!this.client) return;
    const quiet = Boolean(job.scheduledDate || job.scheduled);
    const startedAt = Date.now();
    this.log(`[${job.category}] [${job.runId}] start range=${job.range.from}..${job.range.to} mode=${job.mode} source=${quiet ? "scheduled" : "on-demand"}`, quiet);
    if (job.category === "cold") {
      try {
        await this.startColdJob(job, timeoutMs);
        this.log(`[cold] [${job.runId}] completion duration=${((Date.now() - startedAt) / 1000).toFixed(3)}s`, quiet);
      } catch (error) {
        this.log(`cold job failure run=${job.runId} duration=${Date.now() - startedAt}ms error=${safeError(error)}`);
        throw error;
      }
      return;
    }
    let currentDate = job.range.to;
    try {
      const dates = dateList(job.range);
      const range = { from: job.range.from, to: job.range.to, timezone: this.config.timezone };
      const result = await this.dependencies.runCcusage({
        binary: this.config.ccusageBinary,
        range,
        timeoutMs,
        maxBuffer: this.config.ccusageMaxBuffer,
        offline: job.mode === "offline",
        runner: this.dependencies.execFileRunner,
      });
      const documents = new Map(dates.map((date) => [date, sliceCcusageDocument(result.document, date)]));
      for (const date of dates) {
        currentDate = date;
        if (this.stopped || !this.client) return;
        const message = makeUsageSnapshot(this.nextMetadata(date, job.category, job.runId), documents.get(date) ?? { daily: [] });
        await this.send(this.client, makeUsageTopic(this.config.mqttPrefix, this.config.hostId, date), message);
      }
      if (!this.stopped && this.client && job.category === "hot") {
        const statusMetadata = this.nextMetadata(job.range.to, job.category, job.runId);
        await this.send(this.client, this.topics.status, makeStatusMessage(statusMetadata, "ok"));
        await this.send(this.client, this.topics.error, makeErrorMessage(statusMetadata, null));
      }
    } catch (error) {
      if (this.stopped || !this.client) return;
      const message = ccusageErrorMessage(error, this.config.ccusageBinary).slice(0, 16_384);
      this.log(`hot job failure run=${job.runId} duration=${Date.now() - startedAt}ms error=${safeError(error)}`);
      const errorMetadata = this.nextMetadata(currentDate, job.category, job.runId);
      try {
        await this.send(this.client, this.topics.status, makeStatusMessage(errorMetadata, "error", message));
        await this.send(this.client, this.topics.error, makeErrorMessage(errorMetadata, message));
      } catch (publishError) {
        this.log(`[hot] [${job.runId}] error status publication failed: ${safeError(publishError)}`);
      }
      this.log(`[hot] [${job.runId}] completion duration=${((Date.now() - startedAt) / 1000).toFixed(3)}s failed`, true);
      throw error;
    }
    this.log(`[hot] [${job.runId}] completion duration=${((Date.now() - startedAt) / 1000).toFixed(3)}s`, quiet);
  }

  private async startColdJob(job: UsageJob, timeoutMs: number): Promise<void> {
    const dates = dateList(job.range).reverse();
    const verbose = !job.scheduledDate;
    let succeeded = 0;
    let failed = 0;
    this.logCold(job.runId, `start days=${dates.length} reverse=true`, !verbose);
    const startedAt = Date.now();

    let documents: Map<string, Record<string, unknown>>;
    try {
      const range = { from: job.range.from, to: job.range.to, timezone: this.config.timezone };
      const result = await this.dependencies.runCcusage({
        binary: this.config.ccusageBinary,
        range,
        timeoutMs,
        maxBuffer: this.config.ccusageMaxBuffer,
        offline: job.mode === "offline",
        runner: this.dependencies.execFileRunner,
      });
      documents = new Map(dates.map((date) => [date, sliceCcusageDocument(result.document, date)]));
    } catch (error) {
      failed = dates.length;
      const detail = safeError(error);
      this.logCold(job.runId, `range failure elapsed=${((Date.now() - startedAt) / 1000).toFixed(3)}s error=${detail}`);
      if (!this.stopped && this.client) this.logCold(job.runId, `summary succeeded=${succeeded} failed=${failed}`, !verbose);
      throw error;
    }

    for (const date of dates) {
      if (this.stopped || !this.client) return;
      const dayStartedAt = Date.now();
      this.logCold(job.runId, `day ${date} start`, !verbose);
      try {
        const message = makeUsageSnapshot(this.nextMetadata(date, job.category, job.runId), documents.get(date) ?? { daily: [] });
        await this.send(this.client, makeUsageTopic(this.config.mqttPrefix, this.config.hostId, date), message);
        succeeded += 1;
        this.logCold(job.runId, `day ${date} end elapsed=${((Date.now() - dayStartedAt) / 1000).toFixed(3)}s`, !verbose);
      } catch (error) {
        failed += 1;
        this.logCold(job.runId, `day ${date} failure elapsed=${((Date.now() - dayStartedAt) / 1000).toFixed(3)}s error=${safeError(error)}`);
      }
    }

    if (!this.stopped && this.client) this.logCold(job.runId, `summary succeeded=${succeeded} failed=${failed}`, !verbose && failed === 0);
    if (failed > 0) throw new Error(`Cold publication failed for ${failed} date(s)`);
  }

  private nextMetadata(date: string, category: MqttCategory, runId: string, now = this.dependencies.now()): Omit<MqttMetadata, "schemaVersion"> {
    this.sequence += 1;
    return metadata(this.config, date, category, runId, now, this.publisherId, this.connectionId, this.sequence);
  }

  private async stopNow(): Promise<void> {
    this.stopped = true;
    this.clearReconnectWatchdog();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.coldTimer) clearInterval(this.coldTimer);
    this.coldTimer = null;
    await Promise.all([this.hotInFlight?.catch(() => undefined), this.coldInFlight?.catch(() => undefined)]);
    const client = this.client;
    this.client = null;
    const wasConnected = this.connected;
    this.connected = false;
    if (!client) return;
    client.off("connect", this.onConnect);
    client.off("message", this.onMessage);
    client.off("reconnect", this.onReconnect);
    client.off("offline", this.onOffline);
    client.off("close", this.onClose);
    client.off("error", this.onError);
    if (wasConnected) {
      try {
        const date = rollingDateRange(this.config.timezone, this.dependencies.now(), 1).to;
        await this.send(client, this.topics.status, makeStatusMessage(this.nextMetadata(date, "hot", "lifecycle"), "offline"));
      } catch (error) {
        this.log(`MQTT offline status failed: ${safeError(error)}`);
      }
    }
    await new Promise<void>((resolve, reject) => client.end(false, {}, (error) => error ? reject(error) : resolve()));
  }

  async closeLog(timeoutMs = 2_000): Promise<void> {
    await this.dependencies.closeLog?.(timeoutMs);
  }

  private readonly onConnect = (): void => {
    if (this.stopped || !this.client || this.connected) return;
    this.clearReconnectWatchdog();
    this.connected = true;
    this.log(`MQTT connected to ${sanitizeMqttUrl(this.config.mqttUrl)}`);
    const client = this.client;
    if (!this.timer) this.timer = setInterval(() => void this.publishHot(false), this.config.publishIntervalMs);
    if (!this.coldTimer) this.coldTimer = setInterval(() => this.scheduleColdHistory(), this.config.coldIntervalMs);
    void subscribe(client, makeCommandTopic(this.config.mqttPrefix, this.config.hostId))
      .then(() => this.send(client, this.topics.status, makeStatusMessage(this.nextMetadata(rollingDateRange(this.config.timezone, this.dependencies.now(), 1).to, "hot", "lifecycle"), "online")))
      .then(async () => {
        await this.publishHot();
        if (!this.stopped && this.connected) this.scheduleColdHistory();
      })
      .catch((error: unknown) => this.log(`MQTT reconnect publish failed: ${safeError(error)}`));
  };

  private readonly onMessage = (topic: string, payload: Buffer): void => {
    this.processCommand(topic, payload);
  };

  private readonly onError = (error: Error): void => {
    this.log(`MQTT connection error: ${safeError(error)}`);
  };

  private readonly onOffline = (): void => {
    this.connected = false;
    this.armReconnectWatchdog();
    this.log("MQTT connection lost (offline)");
  };

  private readonly onClose = (): void => {
    this.connected = false;
    this.armReconnectWatchdog();
  };

  private clearReconnectWatchdog(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private armReconnectWatchdog(): void {
    if (this.stopped || this.connected || this.reconnectTimer) return;
    const timeoutMs = this.config.reconnectTimeoutMs ?? DEFAULT_MQTT_RECONNECT_TIMEOUT_MS;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || this.connected) return;
      this.stopped = true;
      this.log(`FATAL: MQTT connection unavailable for ${timeoutMs}ms; exiting with code 1 for supervisor restart`);
      // Graceful shutdown can hang on queued QoS 1 publications while offline.
      this.dependencies.exit(1);
    }, timeoutMs);
  }

  private readonly onReconnect = (): void => {
    if (this.stopped || !this.client) return;
    this.connected = false;
    this.armReconnectWatchdog();
    this.log("MQTT reconnecting...");
    this.connectionId = randomUUID();
    const date = rollingDateRange(this.config.timezone, this.dependencies.now(), 1).to;
    this.client.options.will = {
      topic: this.topics.status,
      payload: JSON.stringify(makeStatusMessage(this.nextMetadata(date, "hot", "lifecycle"), "offline")),
      qos: 1,
      retain: true,
    };
  };
}

export async function runRemotePublisher(): Promise<RemoteMqttPublisher> {
  const publisher = new RemoteMqttPublisher();
  await publisher.start();
  return publisher;
}
