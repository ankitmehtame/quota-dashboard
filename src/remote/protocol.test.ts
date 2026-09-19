import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import {
  MQTT_SCHEMA_VERSION,
  makeCommandMessage,
  makeMqttTopics,
  makeStatusMessage,
  makeUsageSnapshot,
  makeUsageTopic,
  parseMqttCommand,
  sanitizeHostId,
} from "./protocol.js";

const metadata = {
  publisherId: "publisher-1",
  connectionId: "connection-1",
  sequence: 1,
  hostId: "workstation",
  generatedAt: "2026-09-13T00:00:00.000Z",
  timezone: "Asia/Singapore",
  date: "2026-09-13",
  category: "hot" as const,
  runId: "run-1",
};

test("keeps the parsed ccusage document under data without changing it", () => {
  const data = { daily: [{ date: "2026-09-13", extra: [null, false, "x"] }], unknownField: { value: 7 } };
  const snapshot = makeUsageSnapshot(metadata, data);
  assert.strictEqual(snapshot.data, data);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)).data, data);
  assert.equal(snapshot.schemaVersion, MQTT_SCHEMA_VERSION);
});

test("builds date-level usage and command topics", () => {
  assert.deepEqual(makeMqttTopics(undefined, "bad/host+#"), {
    usage: "quota-dashboard/v1/hosts/bad-host/usage",
    status: "quota-dashboard/v1/hosts/bad-host/status",
    error: "quota-dashboard/v1/hosts/bad-host/error",
    command: "quota-dashboard/v1/hosts/bad-host/command",
  });
  assert.equal(makeUsageTopic(undefined, "workstation", "2026-09-13"), "quota-dashboard/v1/hosts/workstation/usage/2026-09-13");
  assert.throws(() => makeUsageTopic(undefined, "workstation", "2026-02-31"), /Invalid date/);
});

test("sanitizes empty and traversal-like host IDs", () => {
  assert.equal(sanitizeHostId("../+/"), "host");
  assert.equal(sanitizeHostId("my machine"), "my-machine");
});

test("status, usage, and commands use the new schema metadata", () => {
  assert.equal(makeStatusMessage(metadata, "ok").schemaVersion, MQTT_SCHEMA_VERSION);
  assert.equal(makeStatusMessage(metadata, "ok").status, "ok");
  assert.equal(makeCommandMessage({ requestId: "request-1", category: "cold", from: "2026-09-01", to: "2026-09-03", mode: "offline" }).schemaVersion, MQTT_SCHEMA_VERSION);
});

test("checks command payload byte length before decoding", () => {
  const topic = "quota-dashboard/v1/hosts/workstation/command";
  const command = JSON.stringify({ schemaVersion: 2, requestId: "request-1", category: "cold", from: "2026-09-01", to: "2026-09-03", mode: "offline" });
  assert.equal(parseMqttCommand(topic, command, undefined, Buffer.byteLength(command, "utf8") - 1), null);
  assert.equal(parseMqttCommand(topic, Buffer.from(command), undefined, Buffer.byteLength(command, "utf8") - 1), null);
  assert.deepEqual(parseMqttCommand(topic, Buffer.from(command), undefined, Buffer.byteLength(command, "utf8"))?.requestId, "request-1");
});

test("returns null when binary command decoding throws", () => {
  const topic = "quota-dashboard/v1/hosts/workstation/command";
  const invalidPayload = { byteLength: 0 } as unknown as Uint8Array;
  assert.equal(parseMqttCommand(topic, invalidPayload), null);
});
