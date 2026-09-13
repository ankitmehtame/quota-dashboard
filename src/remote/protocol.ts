/** The wire format shared by the remote publisher and MQTT consumers. */
export const MQTT_SCHEMA_VERSION = 1 as const;

export type MqttDateRange = {
  from: string;
  to: string;
};

export type MqttMetadata = {
  schemaVersion: typeof MQTT_SCHEMA_VERSION;
  publisherId: string;
  connectionId: string;
  sequence: number;
  hostId: string;
  generatedAt: string;
  ccusageVersion?: string;
  timezone: string;
  range: MqttDateRange;
};

export type UsageSnapshot = MqttMetadata & {
  /** The parsed ccusage document. Do not normalize or copy this value. */
  data: unknown;
};

export type PublisherStatus = "offline" | "online" | "ok" | "error";

export type StatusMessage = MqttMetadata & {
  status: PublisherStatus;
  error?: string;
};

export type ErrorMessage = MqttMetadata & {
  error: string | null;
};

export type MqttTopics = {
  usage: string;
  status: string;
  error: string;
};

const DEFAULT_PREFIX = "quota-dashboard/v1";
const MAX_HOST_ID_LENGTH = 128;

/**
 * Turn an environment supplied host name into one safe MQTT topic segment.
 * In particular, MQTT wildcards and slashes never make it into the result.
 */
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

export function makeMqttTopics(prefix: string | undefined, hostId: string): MqttTopics {
  const root = sanitizeTopicPrefix(prefix);
  const host = sanitizeHostId(hostId);
  const base = `${root}/hosts/${host}`;
  return {
    usage: `${base}/usage`,
    status: `${base}/status`,
    error: `${base}/error`,
  };
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
  error?: string,
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
