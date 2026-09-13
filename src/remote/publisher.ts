import os from "node:os";
import { createHash, randomUUID } from "node:crypto";

import mqtt, { type IClientOptions, type MqttClient } from "mqtt";

import {
  makeErrorMessage,
  makeMqttTopics,
  makeStatusMessage,
  makeUsageSnapshot,
  sanitizeHostId,
  type MqttDateRange,
  type MqttMetadata,
} from "./protocol.js";
import {
  ccusageErrorMessage,
  DEFAULT_CCUSAGE_MAX_BUFFER,
  DEFAULT_CCUSAGE_TIMEOUT_MS,
  DEFAULT_ROLLING_DAYS,
  rollingDateRange,
  runCcusage,
  type ExecFileRunner,
} from "./ccusage.js";

export const DEFAULT_MQTT_URL = "mqtt://127.0.0.1:1883";
export const DEFAULT_MQTT_PREFIX = "quota-dashboard/v1";
export const DEFAULT_PUBLISH_INTERVAL_MS = 5 * 60 * 1000;

export type RemotePublisherConfig = {
  mqttUrl: string;
  mqttPrefix: string;
  hostId: string;
  timezone: string;
  ccusageBinary: string;
  rollingDays: number;
  publishIntervalMs: number;
  ccusageTimeoutMs: number;
  ccusageMaxBuffer: number;
  username?: string;
  password?: string;
  ccusageVersion?: string;
};

export type PublisherDependencies = {
  connect?: typeof mqtt.connect;
  runCcusage?: typeof runCcusage;
  now?: () => Date;
  execFileRunner?: ExecFileRunner;
};

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readRemotePublisherConfig(env: NodeJS.ProcessEnv = process.env): RemotePublisherConfig {
  const hostId = sanitizeHostId(env.MQTT_HOST_ID?.trim() || env.HOST_ID?.trim() || os.hostname());
  const timezone = env.CCUSAGE_TIMEZONE?.trim() || env.MQTT_TIMEZONE?.trim() || env.TIMEZONE?.trim() || env.TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format();

  return {
    mqttUrl: env.MQTT_URL?.trim() || env.MQTT_BROKER_URL?.trim() || env.MQTT_BROKER?.trim() || DEFAULT_MQTT_URL,
    mqttPrefix: env.MQTT_PREFIX?.trim() || DEFAULT_MQTT_PREFIX,
    hostId,
    timezone,
    ccusageBinary: env.CCUSAGE_BIN?.trim() || "ccusage",
    rollingDays: Math.max(1, Math.trunc(positiveNumber(env.CCUSAGE_DAYS, DEFAULT_ROLLING_DAYS))),
    publishIntervalMs: positiveNumber(env.MQTT_INTERVAL_MS || env.MQTT_PUBLISH_INTERVAL_MS, DEFAULT_PUBLISH_INTERVAL_MS),
    ccusageTimeoutMs: positiveNumber(env.CCUSAGE_TIMEOUT_MS, DEFAULT_CCUSAGE_TIMEOUT_MS),
    ccusageMaxBuffer: positiveNumber(env.CCUSAGE_MAX_BUFFER, DEFAULT_CCUSAGE_MAX_BUFFER),
    ...(env.MQTT_USERNAME !== undefined && env.MQTT_USERNAME !== "" ? { username: env.MQTT_USERNAME } : {}),
    ...(env.MQTT_PASSWORD !== undefined && env.MQTT_PASSWORD !== "" ? { password: env.MQTT_PASSWORD } : {}),
    ...(env.CCUSAGE_VERSION?.trim() ? { ccusageVersion: env.CCUSAGE_VERSION.trim() } : {}),
  };
}

function mqttOptions(config: RemotePublisherConfig, will: string, topics: ReturnType<typeof makeMqttTopics>): IClientOptions {
  const hostHash = createHash("sha256").update(config.hostId).digest("hex").slice(0, 12);
  const options: IClientOptions = {
    clientId: `quota-dashboard-remote-${config.hostId.slice(0, 80)}-${hostHash}`,
    reconnectPeriod: 5_000,
    connectTimeout: 30_000,
    clean: true,
    will: {
      topic: topics.status,
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

function metadata(config: RemotePublisherConfig, range: MqttDateRange, now: Date, publisherId: string, connectionId: string, sequence: number): MqttMetadata {
  return {
    schemaVersion: 1,
    publisherId,
    connectionId,
    sequence,
    hostId: config.hostId,
    generatedAt: now.toISOString(),
    ...(config.ccusageVersion ? { ccusageVersion: config.ccusageVersion } : {}),
    timezone: config.timezone,
    range,
  };
}

export class RemoteMqttPublisher {
  private readonly config: RemotePublisherConfig;
  private readonly dependencies: Required<Pick<PublisherDependencies, "connect" | "runCcusage" | "now">> & PublisherDependencies;
  private readonly topics;
  private readonly publisherId = randomUUID();
  private connectionId = randomUUID();
  private sequence = 0;
  private client: MqttClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;
  private connected = false;

  constructor(config = readRemotePublisherConfig(), dependencies: PublisherDependencies = {}) {
    this.config = { ...config, hostId: sanitizeHostId(config.hostId) };
    this.dependencies = {
      connect: mqtt.connect,
      runCcusage,
      now: () => new Date(),
      ...dependencies,
    };
    this.topics = makeMqttTopics(this.config.mqttPrefix, this.config.hostId);
  }

  get mqttTopics(): ReturnType<typeof makeMqttTopics> {
    return this.topics;
  }

  async start(): Promise<void> {
    if (this.client) return;
    this.stopped = false;
    const range = this.range();
    const now = this.dependencies.now();
    const offline = makeStatusMessage(this.nextMetadata(range, now), "offline");
    const client = this.dependencies.connect(this.config.mqttUrl, mqttOptions(this.config, JSON.stringify(offline), this.topics));
    this.client = client;
    client.on("connect", this.onConnect);
    client.on("reconnect", this.onReconnect);
    client.on("offline", this.onOffline);
    client.on("error", this.onError);
  }

  /** Publish one snapshot, returning false when another run already owns the slot. */
  async publishSnapshot(): Promise<boolean> {
    if (this.inFlight || this.stopped || !this.client) return false;
    const client = this.client;
    const task = this.publishSnapshotNow(client);
    this.inFlight = task;
    try {
      await task;
      return true;
    } catch (error) {
      console.error(`MQTT publish failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      if (this.inFlight === task) this.inFlight = null;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopNow();
    return this.stopPromise;
  }

  private async stopNow(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    const client = this.client;
    this.client = null;
    const wasConnected = this.connected;
    this.connected = false;
    if (!client) return;
    client.off("connect", this.onConnect);
    client.off("reconnect", this.onReconnect);
    client.off("offline", this.onOffline);
    client.off("error", this.onError);
    if (wasConnected) {
      try {
        await publish(client, this.topics.status, JSON.stringify(makeStatusMessage(this.nextMetadata(this.range()), "offline")));
      } catch (error) {
        console.error(`MQTT offline status failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await new Promise<void>((resolve, reject) => client.end(false, {}, (error) => error ? reject(error) : resolve()));
  }

  private range(): MqttDateRange {
    const range = rollingDateRange(this.config.timezone, this.dependencies.now(), this.config.rollingDays);
    return { from: range.from, to: range.to };
  }

  private nextMetadata(range: MqttDateRange, now = this.dependencies.now()): MqttMetadata {
    this.sequence += 1;
    return metadata(this.config, range, now, this.publisherId, this.connectionId, this.sequence);
  }

  private async publishSnapshotNow(client: MqttClient): Promise<void> {
    const commandRange = rollingDateRange(this.config.timezone, this.dependencies.now(), this.config.rollingDays);
    const range = { from: commandRange.from, to: commandRange.to };
    try {
      const result = await this.dependencies.runCcusage({
        binary: this.config.ccusageBinary,
        range: commandRange,
        timeoutMs: this.config.ccusageTimeoutMs,
        maxBuffer: this.config.ccusageMaxBuffer,
        runner: this.dependencies.execFileRunner,
      });
      if (this.stopped) return;
      const snapshotMetadata = this.nextMetadata(range);
      await publish(client, this.topics.usage, JSON.stringify(makeUsageSnapshot(snapshotMetadata, result.document)));
      await publish(client, this.topics.status, JSON.stringify(makeStatusMessage(snapshotMetadata, "ok")));
      await publish(client, this.topics.error, JSON.stringify(makeErrorMessage(snapshotMetadata, null)));
    } catch (error) {
      if (this.stopped) return;
      const message = ccusageErrorMessage(error, this.config.ccusageBinary).slice(0, 16_384);
      const errorMetadata = this.nextMetadata(range);
      await publish(client, this.topics.status, JSON.stringify(makeStatusMessage(errorMetadata, "error", message)));
      await publish(client, this.topics.error, JSON.stringify(makeErrorMessage(errorMetadata, message)));
    }
  }

  private readonly onConnect = (): void => {
    if (this.stopped || !this.client || this.connected) return;
    this.connected = true;
    const client = this.client;
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.publishSnapshot();
      }, this.config.publishIntervalMs);
    }
    const status = makeStatusMessage(this.nextMetadata(this.range()), "online");
    void publish(client, this.topics.status, JSON.stringify(status))
      .then(() => this.publishSnapshot())
      .catch((error: unknown) => console.error(`MQTT reconnect publish failed: ${error instanceof Error ? error.message : String(error)}`));
  };

  private readonly onError = (error: Error): void => {
    console.error(`MQTT connection error: ${error.message}`);
  };

  private readonly onOffline = (): void => {
    this.connected = false;
  };

  private readonly onReconnect = (): void => {
    if (this.stopped || !this.client) return;
    this.connected = false;
    this.connectionId = randomUUID();
    const offline = makeStatusMessage(this.nextMetadata(this.range()), "offline");
    this.client.options.will = {
      topic: this.topics.status,
      payload: JSON.stringify(offline),
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
