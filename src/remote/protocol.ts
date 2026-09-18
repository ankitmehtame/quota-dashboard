/** The wire format shared by the remote publisher and MQTT consumers. */
export const MQTT_SCHEMA_VERSION = 2 as const;

export type MqttDateRange = {
  from: string;
  to: string;
};

export type MqttCategory = "hot" | "cold";
export type MqttCommandMode = "online" | "offline";

export type MqttMetadata = {
  schemaVersion: typeof MQTT_SCHEMA_VERSION;
  publisherId: string;
  connectionId: string;
  sequence: number;
  hostId: string;
  generatedAt: string;
  ccusageVersion?: string;
  timezone: string;
  date: string;
  category: MqttCategory;
  runId: string;
  /** Kept optional for source compatibility until the server seam is updated. */
  range?: MqttDateRange;
};

export type UsageSnapshot = MqttMetadata & {
  /** The parsed ccusage document for exactly one date. Do not normalize or copy this value. */
  data: unknown;
};

export type PublisherStatus = "offline" | "online" | "ok" | "error";

export type StatusMessage = MqttMetadata & {
  status: PublisherStatus;
  error?: string | null;
};

export type ErrorMessage = MqttMetadata & {
  error: string | null;
};

export type MqttCommand = {
  schemaVersion: typeof MQTT_SCHEMA_VERSION;
  requestId: string;
  category: MqttCategory;
  from: string;
  to: string;
  mode: MqttCommandMode;
};

export type MqttTopics = {
  usage: string;
  status: string;
  error: string;
  command: string;
};

export type ParsedMqttCommand = MqttCommand & { hostId: string };

const DEFAULT_PREFIX = "quota-dashboard/v1";
const MAX_HOST_ID_LENGTH = 128;

/** Turn an environment supplied host name into one safe MQTT topic segment. */
export function sanitizeHostId(value: string): string {
  const sanitized = value
    .trim()
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._~-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, MAX_HOST_ID_LENGTH);

  return sanitized || "host";
}

/** Keep a topic prefix hierarchical while removing unsafe MQTT characters. */
export function sanitizeTopicPrefix(value: string | undefined): string {
  const segments = (value?.trim() || DEFAULT_PREFIX)
    .normalize("NFKC")
    .split("/")
    .map((segment) => segment.replace(/[^A-Za-z0-9._~-]+/g, "-").replace(/\.{2,}/g, "-"))
    .map((segment) => segment.replace(/^[.-]+|[.-]+$/g, ""))
    .filter(Boolean);

  return segments.length > 0 ? segments.join("/") : DEFAULT_PREFIX;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function assertCalendarDate(value: string): void {
  if (!isCalendarDate(value)) throw new Error(`Invalid date: ${value}`);
}

export function makeMqttTopics(prefix: string | undefined, hostId: string): MqttTopics {
  const root = sanitizeTopicPrefix(prefix);
  const host = sanitizeHostId(hostId);
  const base = `${root}/hosts/${host}`;
  return {
    usage: `${base}/usage`,
    status: `${base}/status`,
    error: `${base}/error`,
    command: `${base}/command`,
  };
}

export function makeUsageTopic(prefix: string | undefined, hostId: string, date: string): string {
  assertCalendarDate(date);
  return `${makeMqttTopics(prefix, hostId).usage}/${date}`;
}

export function makeCommandTopic(prefix: string | undefined, hostId: string): string {
  return makeMqttTopics(prefix, hostId).command;
}

export function makeUsageSnapshot(metadata: Omit<MqttMetadata, "schemaVersion">, data: unknown): UsageSnapshot {
  return {
    schemaVersion: MQTT_SCHEMA_VERSION,
    ...metadata,
    data,
  };
}

export function makeStatusMessage(
  metadata: Omit<MqttMetadata, "schemaVersion">,
  status: PublisherStatus,
  error?: string | null,
): StatusMessage {
  return {
    schemaVersion: MQTT_SCHEMA_VERSION,
    ...metadata,
    status,
    ...(error ? { error } : {}),
  };
}

export function makeErrorMessage(metadata: Omit<MqttMetadata, "schemaVersion">, error: string | null): ErrorMessage {
  return {
    schemaVersion: MQTT_SCHEMA_VERSION,
    ...metadata,
    error,
  };
}

export function makeCommandMessage(command: Omit<MqttCommand, "schemaVersion">): MqttCommand {
  return { schemaVersion: MQTT_SCHEMA_VERSION, ...command };
}

export function parseMqttCommand(
  topic: string,
  payload: Uint8Array | string,
  prefix = DEFAULT_PREFIX,
  maxPayloadBytes = 64 * 1024,
): ParsedMqttCommand | null {
  const root = sanitizeTopicPrefix(prefix).split("/");
  const parts = topic.split("/");
  if (parts.length !== root.length + 3 || root.some((part, index) => parts[index] !== part) || parts[root.length] !== "hosts") return null;
  const hostId = parts[root.length + 1];
  if (!hostId || sanitizeHostId(hostId) !== hostId || parts[root.length + 2] !== "command") return null;
  const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
  if (new TextEncoder().encode(text).byteLength > maxPayloadBytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const command = value as Record<string, unknown>;
  if (command.schemaVersion !== MQTT_SCHEMA_VERSION
    || typeof command.requestId !== "string" || command.requestId.length === 0 || command.requestId.length > 128
    || !["hot", "cold"].includes(command.category as string)
    || !isCalendarDate(command.from) || !isCalendarDate(command.to) || command.from > command.to
    || !["online", "offline"].includes(command.mode as string)) return null;
  return { hostId, requestId: command.requestId, category: command.category as MqttCategory, from: command.from, to: command.to, mode: command.mode as MqttCommandMode, schemaVersion: MQTT_SCHEMA_VERSION };
}
