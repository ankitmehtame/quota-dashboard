import mqtt, { type IClientOptions, type MqttClient } from "mqtt";

import {
  MQTT_SCHEMA_VERSION,
  makeCommandMessage,
  makeCommandTopic,
  makeMqttTopics,
  makeUsageTopic,
  parseMqttCommand,
  sanitizeHostId,
  sanitizeTopicPrefix,
  type ErrorMessage,
  type MqttCommand,
  type MqttMetadata,
  type MqttTopics,
  type PublisherStatus,
  type StatusMessage,
  type UsageSnapshot,
} from "./protocol.js";

export const DEFAULT_MQTT_PREFIX = "quota-dashboard/v1";
export const DEFAULT_MQTT_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MQTT_RECONNECT_PERIOD_MS = 5_000;

const MAX_HOST_ID_LENGTH = 128;
const MAX_METADATA_STRING_LENGTH = 4_096;
const MAX_ERROR_LENGTH = 16_384;
const MAX_REMOTE_HOSTS = 64;
const STATUS_VALUES: readonly PublisherStatus[] = ["offline", "online", "ok", "error"];

export type MqttSubscriptionTopics = Omit<MqttTopics, "usage"> & { usage: string; all: readonly [string, string, string] };

export type RemoteMqttConnectionState = "disabled" | "disconnected" | "connecting" | "reconnecting" | "connected";

export type RemoteHostState = {
  /** Latest usage retained for the existing server seam. */
  usage: UsageSnapshot | null;
  /** Complete date-aware usage state for the next server slice. */
  usageByDate: Record<string, UsageSnapshot>;
  status: StatusMessage | null;
  error: ErrorMessage | null;
  /** Local ingestion error, such as a timezone mismatch or persistence failure. */
  ingestError: string | null;
};

export type RemoteMqttStoreSnapshot = {
  configured: boolean;
  connection: RemoteMqttConnectionState;
  hosts: Readonly<Record<string, Readonly<RemoteHostState>>>;
};

export type RemoteMqttSubscriberConfig = {
  mqttUrl?: string | null;
  mqttPrefix?: string;
  enabled?: boolean;
  maxPayloadBytes?: number;
  username?: string;
  password?: string;
  clientOptions?: IClientOptions;
  usageTimezone?: string;
  onUsage?: (message: UsageSnapshot) => void | Promise<void>;
  onUsageError?: (message: UsageSnapshot, error: unknown) => void;
  onChange?: (snapshot: RemoteMqttStoreSnapshot) => void;
};

export type RemoteMqttSubscriberDependencies = {
  connect?: typeof mqtt.connect;
};

export type NormalizedRemoteMqttSubscriberConfig = Omit<RemoteMqttSubscriberConfig, "mqttUrl" | "mqttPrefix" | "enabled" | "maxPayloadBytes"> & {
  mqttUrl: string | null;
  mqttPrefix: string;
  enabled: boolean;
  maxPayloadBytes: number;
};

export type ParsedRemoteMqttTopic = {
  hostId: string;
  kind: "usage" | "status" | "error" | "command";
  date?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength = MAX_METADATA_STRING_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isValidHostId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_HOST_ID_LENGTH && sanitizeHostId(value) === value;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isMetadata(value: unknown): value is MqttMetadata {
  if (!isRecord(value) || value.schemaVersion !== MQTT_SCHEMA_VERSION || !isValidHostId(value.hostId)) return false;
  if (!isBoundedString(value.publisherId, 128) || !isBoundedString(value.connectionId, 128) || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 || !isBoundedString(value.generatedAt) || !Number.isFinite(Date.parse(value.generatedAt)) || !isBoundedString(value.timezone) || !isCalendarDate(value.date) || (value.category !== "hot" && value.category !== "cold") || !isBoundedString(value.runId, 128)) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value.timezone }).format();
  } catch {
    return false;
  }
  if (value.ccusageVersion !== undefined && !isBoundedString(value.ccusageVersion)) return false;
  if (value.range !== undefined && (!isRecord(value.range) || !isCalendarDate(value.range.from) || !isCalendarDate(value.range.to) || value.range.from > value.range.to)) return false;
  return true;
}

function copyAndFreeze<T>(value: T): T {
  const copy = structuredClone(value);
  const objects: object[] = [copy as object];
  const seen = new Set<object>();
  while (objects.length > 0) {
    const current = objects.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current)) if (child !== null && typeof child === "object") objects.push(child);
    Object.freeze(current);
  }
  return copy as T;
}

function normalizedMaxPayloadBytes(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return DEFAULT_MQTT_MAX_PAYLOAD_BYTES;
  return Math.min(Math.floor(value as number), DEFAULT_MQTT_MAX_PAYLOAD_BYTES);
}

export function readRemoteMqttSubscriberConfig(env: NodeJS.ProcessEnv = process.env): NormalizedRemoteMqttSubscriberConfig {
  const mqttUrl = env.MQTT_URL?.trim() || env.MQTT_BROKER_URL?.trim() || env.MQTT_BROKER?.trim() || null;
  const explicitlyDisabled = env.MQTT_ENABLED?.trim().toLowerCase() === "false";
  const explicitlyEnabled = env.MQTT_ENABLED?.trim().toLowerCase() === "true";
  const enabled = !explicitlyDisabled && Boolean(mqttUrl) && (explicitlyEnabled || env.MQTT_ENABLED === undefined);
  return {
    mqttUrl,
    mqttPrefix: sanitizeTopicPrefix(env.MQTT_PREFIX || DEFAULT_MQTT_PREFIX),
    enabled,
    maxPayloadBytes: normalizedMaxPayloadBytes(Number(env.MQTT_MAX_PAYLOAD_BYTES)),
    ...(env.MQTT_USERNAME !== undefined && env.MQTT_USERNAME !== "" ? { username: env.MQTT_USERNAME } : {}),
    ...(env.MQTT_PASSWORD !== undefined && env.MQTT_PASSWORD !== "" ? { password: env.MQTT_PASSWORD } : {}),
  };
}

export function makeMqttSubscriptionTopics(prefix = DEFAULT_MQTT_PREFIX): MqttSubscriptionTopics {
  const root = sanitizeTopicPrefix(prefix);
  const base = `${root}/hosts/+`;
  const topics = {
    usage: `${base}/usage/+`,
    status: `${base}/status`,
    error: `${base}/error`,
    command: `${base}/command`,
  };
  return { ...topics, all: [topics.usage, topics.status, topics.error] };
}

export function parseMqttSubscriptionTopic(topic: string, prefix = DEFAULT_MQTT_PREFIX): ParsedRemoteMqttTopic | null {
  if (typeof topic !== "string") return null;
  const root = sanitizeTopicPrefix(prefix).split("/");
  const parts = topic.split("/");
  if (parts.length < root.length + 3 || root.some((part, index) => parts[index] !== part) || parts[root.length] !== "hosts") return null;
  const hostId = parts[root.length + 1];
  const kind = parts[root.length + 2];
  if (!isValidHostId(hostId)) return null;
  if (kind === "usage" && parts.length === root.length + 4 && isCalendarDate(parts[root.length + 3])) return { hostId, kind, date: parts[root.length + 3] };
  if ((kind === "status" || kind === "error" || kind === "command") && parts.length === root.length + 3) return { hostId, kind };
  return null;
}

function hasBoundedBreakdowns(row: unknown): boolean {
  if (!isRecord(row)) return false;
  if (row.modelBreakdowns !== undefined && (!Array.isArray(row.modelBreakdowns) || row.modelBreakdowns.length > 1_000)) return false;
  if (row.agents === undefined) return true;
  return Array.isArray(row.agents) && row.agents.length <= 64 && row.agents.every((agent) => isRecord(agent) && (agent.modelBreakdowns === undefined || (Array.isArray(agent.modelBreakdowns) && agent.modelBreakdowns.length <= 1_000)));
}

function hasOnlyDate(data: Record<string, unknown>, date: string): boolean {
  if (data.daily === undefined) return true;
  if (!Array.isArray(data.daily)) return false;
  return data.daily.every((row) => {
    if (!isRecord(row) || !hasBoundedBreakdowns(row)) return false;
    const rowDate = row.date ?? row.period;
    return rowDate === undefined || rowDate === date;
  });
}

export function parseRemoteMqttMessage(
  topic: string,
  payload: Buffer | Uint8Array | string,
  prefix = DEFAULT_MQTT_PREFIX,
  maxPayloadBytes = DEFAULT_MQTT_MAX_PAYLOAD_BYTES,
): { topic: ParsedRemoteMqttTopic; message: UsageSnapshot | StatusMessage | ErrorMessage | MqttCommand } | null {
  const parsedTopic = parseMqttSubscriptionTopic(topic, prefix);
  if (!parsedTopic || (typeof payload !== "string" && !(payload instanceof Uint8Array))) return null;
  const payloadLimit = normalizedMaxPayloadBytes(maxPayloadBytes);
  const bytes = typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.byteLength;
  if (!Number.isFinite(bytes) || bytes > payloadLimit) return null;
  if (parsedTopic.kind === "command") {
    const command = parseMqttCommand(topic, payload, prefix, Math.min(payloadLimit, 64 * 1024));
    return command ? { topic: parsedTopic, message: command } : null;
  }
  let value: unknown;
  try {
    value = JSON.parse(typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (!isMetadata(value) || value.hostId !== parsedTopic.hostId) return null;
  if (parsedTopic.kind === "usage") {
    if (value.date !== parsedTopic.date || !isRecord((value as Record<string, unknown>).data)) return null;
    const data = (value as Record<string, unknown>).data as Record<string, unknown>;
    const daily = data.daily;
    if (daily !== undefined && (!Array.isArray(daily) || daily.length > 2_000)) return null;
    if (!hasOnlyDate(data, parsedTopic.date as string)) return null;
    return { topic: parsedTopic, message: value as UsageSnapshot };
  }
  if (parsedTopic.kind === "status") {
    if (!STATUS_VALUES.includes((value as Record<string, unknown>).status as PublisherStatus)) return null;
    const error = (value as Record<string, unknown>).error;
    if (error !== undefined && error !== null && (typeof error !== "string" || error.length > MAX_ERROR_LENGTH)) return null;
    return { topic: parsedTopic, message: value as StatusMessage };
  }
  const error = (value as Record<string, unknown>).error;
  return error === null || (typeof error === "string" && error.length > 0 && error.length <= MAX_ERROR_LENGTH)
    ? { topic: parsedTopic, message: value as ErrorMessage }
    : null;
}

function shouldReplace(current: MqttMetadata | null, incoming: MqttMetadata, offline = false): boolean {
  if (!current) return true;
  if (offline && current.publisherId === incoming.publisherId && current.connectionId === incoming.connectionId) return true;
  if (current.publisherId === incoming.publisherId) return incoming.sequence > current.sequence;
  return Date.parse(incoming.generatedAt) > Date.parse(current.generatedAt);
}

function latestUsage(values: Readonly<Record<string, UsageSnapshot>>): UsageSnapshot | null {
  return Object.values(values).reduce<UsageSnapshot | null>((latest, value) => !latest || Date.parse(value.generatedAt) > Date.parse(latest.generatedAt) ? value : latest, null);
}

function publish(client: MqttClient, topic: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => client.publish(topic, payload, { qos: 1, retain: false }, (error) => error ? reject(error) : resolve()));
}

function subscribe(client: MqttClient, topics: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => client.subscribe([...topics], { qos: 1 }, (error) => error ? reject(error) : resolve()));
}

function endClient(client: MqttClient): Promise<void> {
  const candidate = client as MqttClient & { endAsync?: (force?: boolean) => Promise<void> };
  if (typeof candidate.endAsync === "function") return candidate.endAsync(false);
  return new Promise((resolve) => {
    const done = () => resolve();
    const end = client.end as unknown as (...args: unknown[]) => unknown;
    if (end.length >= 3) end.call(client, false, {}, done);
    else if (end.length === 2) end.call(client, false, done);
    else end.call(client, done);
  });
}

export class RemoteMqttStore {
  readonly config: NormalizedRemoteMqttSubscriberConfig;
  readonly mqttTopics: MqttSubscriptionTopics;
  private readonly connect: typeof mqtt.connect;
  private readonly listeners = new Set<(snapshot: RemoteMqttStoreSnapshot) => void>();
  private readonly hosts = new Map<string, RemoteHostState>();
  private client: MqttClient | null = null;
  private connection: RemoteMqttConnectionState;
  private stopped = true;
  private startPromise: Promise<void> | null = null;

  constructor(config: RemoteMqttSubscriberConfig = readRemoteMqttSubscriberConfig(), dependencies: RemoteMqttSubscriberDependencies = {}) {
    const mqttUrl = typeof config.mqttUrl === "string" && config.mqttUrl.trim() ? config.mqttUrl.trim() : null;
    const enabled = config.enabled !== false && Boolean(mqttUrl);
    const { username, password, ...configWithoutCredentials } = config;
    this.config = {
      ...configWithoutCredentials,
      mqttUrl,
      mqttPrefix: sanitizeTopicPrefix(config.mqttPrefix || DEFAULT_MQTT_PREFIX),
      enabled,
      maxPayloadBytes: normalizedMaxPayloadBytes(config.maxPayloadBytes),
      ...(username !== undefined && username !== "" ? { username } : {}),
      ...(password !== undefined && password !== "" ? { password } : {}),
    };
    this.mqttTopics = makeMqttSubscriptionTopics(this.config.mqttPrefix);
    this.connect = dependencies.connect || mqtt.connect;
    this.connection = enabled ? "disconnected" : "disabled";
    if (config.onChange) this.listeners.add(config.onChange);
  }

  get configured(): boolean {
    return this.config.enabled && this.config.mqttUrl !== null;
  }

  addChangeListener(listener: (snapshot: RemoteMqttStoreSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): RemoteMqttStoreSnapshot {
    const hosts = Object.create(null) as Record<string, Readonly<RemoteHostState>>;
    for (const [hostId, state] of this.hosts) {
      hosts[hostId] = Object.freeze({ ...state, usageByDate: Object.freeze({ ...state.usageByDate }) });
    }
    return Object.freeze({ configured: this.configured, connection: this.connection, hosts: Object.freeze(hosts) });
  }

  snapshot(): RemoteMqttStoreSnapshot {
    return this.getSnapshot();
  }

  getHost(hostId: string): Readonly<RemoteHostState> | null {
    const state = this.hosts.get(hostId);
    return state ? Object.freeze({ ...state, usageByDate: Object.freeze({ ...state.usageByDate }) }) : null;
  }

  /** Publish a non-retained date/range command for a remote host. */
  async publishCommand(hostId: string, command: Omit<MqttCommand, "schemaVersion">): Promise<boolean> {
    if (!this.client || !this.configured || sanitizeHostId(hostId) !== hostId) return false;
    const topic = makeCommandTopic(this.config.mqttPrefix, hostId);
    const payload = JSON.stringify(makeCommandMessage(command));
    if (!parseMqttCommand(topic, payload, this.config.mqttPrefix)) return false;
    try {
      await publish(this.client, topic, payload);
      return true;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (!this.configured) {
      this.connection = "disabled";
      return;
    }
    if (this.startPromise) return this.startPromise;
    if (this.client) return;
    this.stopped = false;
    this.setConnection("connecting");
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const client = this.client;
    this.client = null;
    if (!client) {
      if (this.configured) this.setConnection("disconnected");
      return;
    }
    this.detach(client);
    try {
      await endClient(client);
    } finally {
      this.setConnection("disconnected");
    }
  }

  processMessage(topic: string, payload: Buffer | Uint8Array | string): boolean {
    const parsed = parseRemoteMqttMessage(topic, payload, this.config.mqttPrefix, this.config.maxPayloadBytes);
    if (!parsed || parsed.topic.kind === "command") return false;
    if (!this.hosts.has(parsed.topic.hostId) && this.hosts.size >= MAX_REMOTE_HOSTS) return false;
    const state = this.hosts.get(parsed.topic.hostId) || { usage: null, usageByDate: Object.create(null) as Record<string, UsageSnapshot>, status: null, error: null, ingestError: null };
    if (parsed.topic.kind === "usage") {
      const message = parsed.message as UsageSnapshot;
      if (this.config.usageTimezone && message.timezone !== this.config.usageTimezone) {
        state.ingestError = `Timezone ${message.timezone} does not match ${this.config.usageTimezone}`;
        this.hosts.set(parsed.topic.hostId, state);
        this.emitChange();
        return false;
      }
      const current = state.usageByDate[message.date] || null;
      if (!shouldReplace(current, message)) return false;
      const accepted = copyAndFreeze(message);
      state.usageByDate[message.date] = accepted;
      state.usage = latestUsage(state.usageByDate);
      state.ingestError = null;
      if (this.config.onUsage) {
        try {
          void Promise.resolve(this.config.onUsage(accepted)).catch((error) => {
            this.config.onUsageError?.(accepted, error);
          });
        } catch (error) {
          this.config.onUsageError?.(accepted, error);
        }
      }
    } else if (parsed.topic.kind === "status") {
      const message = parsed.message as StatusMessage;
      if (!shouldReplace(state.status, message, message.status === "offline")) return false;
      state.status = copyAndFreeze(message);
    } else {
      const message = parsed.message as ErrorMessage;
      if (!shouldReplace(state.error, message)) return false;
      state.error = copyAndFreeze(message);
    }
    this.hosts.set(parsed.topic.hostId, state);
    this.emitChange();
    return true;
  }

  handleMessage(topic: string, payload: Buffer | Uint8Array | string): boolean {
    return this.processMessage(topic, payload);
  }

  private async startInternal(): Promise<void> {
    const options: IClientOptions = { clean: true, reconnectPeriod: DEFAULT_MQTT_RECONNECT_PERIOD_MS, connectTimeout: 30_000, ...this.config.clientOptions };
    if (options.username === "") delete options.username;
    if (options.password === "") delete options.password;
    if (this.config.username !== undefined) options.username = this.config.username;
    if (this.config.password !== undefined) options.password = this.config.password;
    let client: MqttClient;
    try {
      client = this.connect(this.config.mqttUrl as string, options);
    } catch (error) {
      this.setConnection("disconnected");
      throw error;
    }
    this.client = client;
    this.attach(client);
  }

  private attach(client: MqttClient): void {
    client.on("connect", this.onConnect);
    client.on("message", this.onMessage);
    client.on("reconnect", this.onReconnect);
    client.on("offline", this.onOffline);
    client.on("close", this.onClose);
    client.on("error", this.onError);
  }

  private detach(client: MqttClient): void {
    client.off("connect", this.onConnect);
    client.off("message", this.onMessage);
    client.off("reconnect", this.onReconnect);
    client.off("offline", this.onOffline);
    client.off("close", this.onClose);
    client.off("error", this.onError);
  }

  private readonly onConnect = (): void => {
    const client = this.client;
    if (!client || this.stopped) return;
    void subscribe(client, this.mqttTopics.all).then(() => {
      if (this.stopped || this.client !== client) return;
      this.setConnection("connected");
    }).catch(() => this.setConnection("disconnected"));
  };

  private readonly onMessage = (topic: string, payload: Buffer): void => {
    this.processMessage(topic, payload);
  };

  private readonly onReconnect = (): void => {
    if (!this.stopped) this.setConnection("reconnecting");
  };

  private readonly onOffline = (): void => {
    if (!this.stopped) this.setConnection("disconnected");
  };

  private readonly onClose = (): void => {
    if (!this.stopped) this.setConnection("disconnected");
  };

  private readonly onError = (): void => {
    if (!this.stopped) this.setConnection("disconnected");
  };

  private setConnection(connection: RemoteMqttConnectionState): void {
    if (this.connection === connection) return;
    this.connection = connection;
    this.emitChange();
  }

  private emitChange(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error(`Remote MQTT change listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

export class RemoteMqttSubscriber extends RemoteMqttStore {}

export function createRemoteMqttStore(config?: RemoteMqttSubscriberConfig, dependencies?: RemoteMqttSubscriberDependencies): RemoteMqttStore {
  return new RemoteMqttStore(config, dependencies);
}
