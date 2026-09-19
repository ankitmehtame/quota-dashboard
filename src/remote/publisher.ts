import os from "node:os";
import { createHash, randomUUID } from "node:crypto";

import mqtt, { type IClientOptions, type MqttClient } from "mqtt";

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
  type CcusageRange,
  type ExecFileRunner,
} from "./ccusage.js";

export const DEFAULT_MQTT_URL = "mqtt://127.0.0.1:1883";
export const DEFAULT_MQTT_PREFIX = "quota-dashboard/v1";
export const DEFAULT_PUBLISH_INTERVAL_MS = 10 * 60 * 1000;
export const DEFAULT_COLD_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_COMMANDS = 256;

export type RemotePublisherConfig = {
  mqttUrl: string;
  mqttPrefix: string;
  hostId: string;
  timezone: string;
  ccusageBinary: string;
  rollingDays: number;
  publishIntervalMs: number;
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

function documentMatchesDate(document: unknown, date: string): boolean {
  if (!document || typeof document !== "object" || Array.isArray(document)) return false;
  const daily = (document as Record<string, unknown>).daily;
  if (daily === undefined) return true;
  if (!Array.isArray(daily)) return false;
  return daily.every((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    const rowDate = (row as Record<string, unknown>).date ?? (row as Record<string, unknown>).period;
    return rowDate === undefined || rowDate === date;
  });
}

export class RemoteMqttPublisher {
  private readonly config: NormalizedPublisherConfig;
  private readonly dependencies: Required<Pick<PublisherDependencies, "connect" | "runCcusage" | "now" | "log">> & PublisherDependencies;
  private readonly topics;
  private readonly publisherId = randomUUID();
  private connectionId = randomUUID();
  private sequence = 0;
  private client: MqttClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private coldTimer: NodeJS.Timeout | null = null;
  private hotInFlight: Promise<void> | null = null;
  private coldInFlight: Promise<void> | null = null;
  private readonly hotQueue: UsageJob[] = [];
  private readonly coldQueue: UsageJob[] = [];
  private readonly commandRequestIds = new Set<string>();
  private readonly scheduledColdDates = new Set<string>();
  private stopped = false;
  private stopPromise: Promise<void> | null = null;
  private connected = false;

  constructor(config = readRemotePublisherConfig(), dependencies: PublisherDependencies = {}) {
    this.config = {
      ...config,
      hostId: sanitizeHostId(config.hostId),
      hotTimeoutMs: config.hotTimeoutMs ?? config.ccusageTimeoutMs ?? DEFAULT_HOT_CCUSAGE_TIMEOUT_MS,
      coldTimeoutMs: config.coldTimeoutMs ?? DEFAULT_COLD_CCUSAGE_TIMEOUT_MS,
      coldIntervalMs: config.coldIntervalMs ?? DEFAULT_COLD_INTERVAL_MS,
      coldMode: config.coldMode ?? "offline",
    };
    this.dependencies = {
      connect: mqtt.connect,
      runCcusage,
      now: () => new Date(),
      log: (message: string) => console.error(message),
      ...dependencies,
    };
    this.topics = makeMqttTopics(this.config.mqttPrefix, this.config.hostId);
  }

  private log(message: string): void {
    this.dependencies.log(`[${this.dependencies.now().toISOString()}] ${message}`);
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
    client.on("error", this.onError);
  }

  /** Run today's and yesterday's hot jobs, with at most one hot job in flight. */
  async publishHot(): Promise<boolean> {
    if (this.hotInFlight || this.stopped || !this.client) return false;
    const range = rollingDateRange(this.config.timezone, this.dependencies.now(), 2);
    const task = this.startJob({ range, category: "hot", mode: "online", runId: randomUUID() }, this.config.hotTimeoutMs);
    this.hotInFlight = task;
    try {
      await task;
      return true;
    } catch (error) {
      this.log(`Hot ccusage job failed: ${error instanceof Error ? error.message : String(error)}`);
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
    return this.enqueueJob({ range: { from, to }, category: "cold", mode, runId: requestId }, false);
  }

  /** Run one cold job immediately when the cold slot is free. */
  async publishCold(from: string, to = from, mode: MqttCommandMode = this.config.coldMode): Promise<boolean> {
    if (!validDateRange({ from, to }) || this.coldInFlight || this.stopped || !this.client) return false;
    const task = this.startJob({ range: { from, to }, category: "cold", mode, runId: randomUUID() }, this.config.coldTimeoutMs);
    this.coldInFlight = task;
    try {
      await task;
      return true;
    } finally {
      if (this.coldInFlight === task) this.coldInFlight = null;
      void this.drainColdQueue();
    }
  }

  /** Queue the older part of the configured rolling history for a scheduled cold pass. */
  scheduleColdHistory(): boolean {
    if (this.config.rollingDays <= 2) return false;
    const yesterday = rollingDateRange(this.config.timezone, this.dependencies.now(), 2).from;
    const staleDate = previousDate(yesterday);
    if (this.scheduledColdDates.has(staleDate)) return false;
    return this.enqueueJob({ range: { from: staleDate, to: staleDate }, category: "cold", mode: this.config.coldMode, runId: `scheduled-${staleDate}`, scheduledDate: staleDate }, false);
  }

  /** Feed a command from MQTT without doing async work in the MQTT callback. */
  processCommand(topic: string, payload: Buffer | Uint8Array | string): boolean {
    const command = parseMqttCommand(topic, payload, this.config.mqttPrefix);
    if (!command || command.hostId !== this.config.hostId || this.commandRequestIds.has(command.requestId) || this.commandRequestIds.size >= MAX_ACTIVE_COMMANDS) return false;
    this.commandRequestIds.add(command.requestId);
    try {
      this.dependencies.onCommand?.(command);
    } catch (error) {
      this.log(`Command handler failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const accepted = this.enqueueJob({ range: { from: command.from, to: command.to }, category: command.category, mode: command.mode, runId: command.requestId, commandRequestId: command.requestId }, command.category === "hot");
    if (!accepted) this.commandRequestIds.delete(command.requestId);
    return accepted;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopNow();
    return this.stopPromise;
  }

  private enqueueJob(job: UsageJob, hot: boolean): boolean {
    if (this.stopped || !this.client) return false;
    const queue = hot ? this.hotQueue : this.coldQueue;
    if (queue.some((entry) => entry.runId === job.runId)) return false;
    if (job.scheduledDate && this.scheduledColdDates.has(job.scheduledDate)) return false;
    if (job.scheduledDate) this.scheduledColdDates.add(job.scheduledDate);
    queue.push(job);
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
    await task.catch((error) => this.log(`Hot ccusage job failed: ${error instanceof Error ? error.message : String(error)}`));
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
    await task.catch((error) => this.log(`Cold ccusage job failed: ${error instanceof Error ? error.message : String(error)}`));
    if (this.coldInFlight === task) this.coldInFlight = null;
    if (job.scheduledDate) this.scheduledColdDates.delete(job.scheduledDate);
    if (job.commandRequestId) this.commandRequestIds.delete(job.commandRequestId);
    void this.drainColdQueue();
  }

  private async startJob(job: UsageJob, timeoutMs: number): Promise<void> {
    if (!this.client) return;
    let currentDate = job.range.from;
    try {
      for (const date of dateList(job.range)) {
        currentDate = date;
        const range: CcusageRange = { from: date, to: date, timezone: this.config.timezone };
        const result = await this.dependencies.runCcusage({
          binary: this.config.ccusageBinary,
          range,
          timeoutMs,
          maxBuffer: this.config.ccusageMaxBuffer,
          offline: job.mode === "offline",
          runner: this.dependencies.execFileRunner,
        });
        if (!documentMatchesDate(result.document, date)) throw new Error(`ccusage returned data outside ${date}`);
        if (this.stopped || !this.client) return;
        const message = makeUsageSnapshot(this.nextMetadata(date, job.category, job.runId), result.document);
        await publish(this.client, makeUsageTopic(this.config.mqttPrefix, this.config.hostId, date), JSON.stringify(message));
      }
      if (!this.stopped && this.client && job.category === "hot") {
        const statusMetadata = this.nextMetadata(job.range.to, job.category, job.runId);
        await publish(this.client, this.topics.status, JSON.stringify(makeStatusMessage(statusMetadata, "ok")));
        await publish(this.client, this.topics.error, JSON.stringify(makeErrorMessage(statusMetadata, null)));
      }
    } catch (error) {
      if (this.stopped || !this.client) return;
      const message = ccusageErrorMessage(error, this.config.ccusageBinary).slice(0, 16_384);
      if (job.category === "cold") {
        this.log(`Cold ccusage job failed: ${message}`);
        return;
      }
      const errorMetadata = this.nextMetadata(currentDate, job.category, job.runId);
      await publish(this.client, this.topics.status, JSON.stringify(makeStatusMessage(errorMetadata, "error", message)));
      await publish(this.client, this.topics.error, JSON.stringify(makeErrorMessage(errorMetadata, message)));
    }
  }

  private nextMetadata(date: string, category: MqttCategory, runId: string, now = this.dependencies.now()): Omit<MqttMetadata, "schemaVersion"> {
    this.sequence += 1;
    return metadata(this.config, date, category, runId, now, this.publisherId, this.connectionId, this.sequence);
  }

  private async stopNow(): Promise<void> {
    this.stopped = true;
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
    client.off("error", this.onError);
    if (wasConnected) {
      try {
        const date = rollingDateRange(this.config.timezone, this.dependencies.now(), 1).to;
        await publish(client, this.topics.status, JSON.stringify(makeStatusMessage(this.nextMetadata(date, "hot", "lifecycle"), "offline")));
      } catch (error) {
        this.log(`MQTT offline status failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await new Promise<void>((resolve, reject) => client.end(false, {}, (error) => error ? reject(error) : resolve()));
  }

  private readonly onConnect = (): void => {
    if (this.stopped || !this.client || this.connected) return;
    this.connected = true;
    this.log(`MQTT connected to ${sanitizeMqttUrl(this.config.mqttUrl)}`);
    const client = this.client;
    if (!this.timer) this.timer = setInterval(() => void this.publishHot(), this.config.publishIntervalMs);
    if (!this.coldTimer) this.coldTimer = setInterval(() => this.scheduleColdHistory(), this.config.coldIntervalMs);
    void subscribe(client, makeCommandTopic(this.config.mqttPrefix, this.config.hostId))
      .then(() => publish(client, this.topics.status, JSON.stringify(makeStatusMessage(this.nextMetadata(rollingDateRange(this.config.timezone, this.dependencies.now(), 1).to, "hot", "lifecycle"), "online"))))
      .then(() => {
        this.scheduleColdHistory();
        return this.publishHot();
      })
      .catch((error: unknown) => this.log(`MQTT reconnect publish failed: ${error instanceof Error ? error.message : String(error)}`));
  };

  private readonly onMessage = (topic: string, payload: Buffer): void => {
    this.processCommand(topic, payload);
  };

  private readonly onError = (error: Error): void => {
    this.log(`MQTT connection error: ${error.message}`);
  };

  private readonly onOffline = (): void => {
    this.connected = false;
    this.log("MQTT connection lost (offline)");
  };

  private readonly onReconnect = (): void => {
    if (this.stopped || !this.client) return;
    this.connected = false;
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
