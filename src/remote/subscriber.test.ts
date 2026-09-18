import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  DEFAULT_MQTT_MAX_PAYLOAD_BYTES,
  RemoteMqttStore,
  makeMqttSubscriptionTopics,
  parseMqttSubscriptionTopic,
  parseRemoteMqttMessage,
} from "./subscriber.js";

const metadata = {
  schemaVersion: 2,
  publisherId: "publisher-1",
  connectionId: "connection-1",
  sequence: 1,
  hostId: "workstation",
  generatedAt: "2026-09-13T00:00:00.000Z",
  timezone: "Asia/Singapore",
  date: "2026-09-13",
  category: "hot",
  runId: "run-1",
};

function usage(overrides: Record<string, unknown> = {}, data: unknown = { daily: [{ date: "2026-09-13", cost: 2 }] }): string {
  return JSON.stringify({ ...metadata, ...overrides, data });
}

function dateUsage(date: string, overrides: Record<string, unknown> = {}): string {
  return usage({ date, ...overrides }, { daily: [{ date, cost: 2 }] });
}

test("parses date-level usage, host-level status, and command topics", () => {
  const topics = makeMqttSubscriptionTopics("example/v1");
  assert.deepEqual(parseMqttSubscriptionTopic("example/v1/hosts/workstation/usage/2026-09-13", "example/v1"), { hostId: "workstation", kind: "usage", date: "2026-09-13" });
  assert.deepEqual(parseMqttSubscriptionTopic(topics.status.replace("+", "workstation"), "example/v1"), { hostId: "workstation", kind: "status" });
  assert.deepEqual(parseMqttSubscriptionTopic(topics.command.replace("+", "workstation"), "example/v1"), { hostId: "workstation", kind: "command" });
  assert.equal(parseMqttSubscriptionTopic("example/v1/hosts/workstation/usage", "example/v1"), null);
  assert.equal(parseMqttSubscriptionTopic("example/v1/hosts/workstation/usage/2026-02-31", "example/v1"), null);
});

test("rejects old schema payloads and malformed date-level envelopes", () => {
  const topic = "quota-dashboard/v1/hosts/workstation/usage/2026-09-13";
  assert.equal(parseRemoteMqttMessage(topic, JSON.stringify({ ...JSON.parse(usage()), schemaVersion: 1 })), null);
  assert.equal(parseRemoteMqttMessage(topic, usage({ date: "2026-09-12" })), null);
  assert.equal(parseRemoteMqttMessage(topic, usage({}, { daily: [{ date: "2026-09-12" }] })), null);
  assert.equal(parseRemoteMqttMessage(topic, usage({ runId: "" })), null);
  assert.equal(parseRemoteMqttMessage(topic, Buffer.alloc(DEFAULT_MQTT_MAX_PAYLOAD_BYTES + 1)), null);
  assert.equal(parseRemoteMqttMessage(topic, usage({}, { daily: [{ agents: Array(65).fill({}) }] })), null);
});

test("accepts a null status error", () => {
  const topic = "quota-dashboard/v1/hosts/workstation/status";
  const message = { ...JSON.parse(usage()), status: "ok", error: null };
  assert.ok(parseRemoteMqttMessage(topic, JSON.stringify(message)));
});

test("keeps timezone and exact data untouched", () => {
  const data = { daily: [{ date: "2026-09-13", nullValue: null, nested: { keep: true } }], extra: [1, false] };
  const parsed = parseRemoteMqttMessage("quota-dashboard/v1/hosts/workstation/usage/2026-09-13", usage({}, data));
  assert.ok(parsed && parsed.message && "data" in parsed.message);
  assert.equal(parsed.message.timezone, "Asia/Singapore");
  assert.deepEqual(parsed.message.data, data);
});

test("orders usage independently for each date", () => {
  const store = new RemoteMqttStore({ mqttUrl: "mqtt://broker" });
  const topic13 = "quota-dashboard/v1/hosts/workstation/usage/2026-09-13";
  const topic12 = "quota-dashboard/v1/hosts/workstation/usage/2026-09-12";
  assert.equal(store.processMessage(topic13, usage({ sequence: 2, generatedAt: "2026-09-13T02:00:00.000Z" })), true);
  assert.equal(store.processMessage(topic13, usage({ sequence: 1, generatedAt: "2026-09-13T01:00:00.000Z" })), false);
  assert.equal(store.processMessage(topic12, dateUsage("2026-09-12", { sequence: 1, generatedAt: "2026-09-12T01:00:00.000Z" })), true);
  const host = store.getSnapshot().hosts.workstation;
  assert.equal(host.usageByDate["2026-09-13"].sequence, 2);
  assert.equal(host.usageByDate["2026-09-12"].sequence, 1);
});

test("rejects a mismatched usage timezone and exposes the ingestion error", () => {
  const store = new RemoteMqttStore({ mqttUrl: "mqtt://broker", usageTimezone: "UTC" });
  assert.equal(store.processMessage("quota-dashboard/v1/hosts/workstation/usage/2026-09-13", usage()), false);
  const host = store.getSnapshot().hosts.workstation;
  assert.equal(host.usage, null);
  assert.equal(host.ingestError, "Timezone Asia/Singapore does not match UTC");
});

test("does not block MQTT message acceptance on asynchronous persistence", async () => {
  let resolvePersistence!: () => void;
  let persisted = false;
  const store = new RemoteMqttStore({
    mqttUrl: "mqtt://broker",
    onUsage: async () => {
      await new Promise<void>((resolve) => { resolvePersistence = resolve; });
      persisted = true;
    },
  });
  assert.equal(store.processMessage("quota-dashboard/v1/hosts/workstation/usage/2026-09-13", usage()), true);
  assert.equal(persisted, false);
  resolvePersistence();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(persisted, true);
});

test("stores status and error independently of date-level usage", () => {
  const store = new RemoteMqttStore({ mqttUrl: "mqtt://broker" });
  const usageTopic = "quota-dashboard/v1/hosts/workstation/usage/2026-09-13";
  const statusTopic = "quota-dashboard/v1/hosts/workstation/status";
  const errorTopic = "quota-dashboard/v1/hosts/workstation/error";
  assert.equal(store.processMessage(usageTopic, usage()), true);
  assert.equal(store.processMessage(errorTopic, JSON.stringify({ ...metadata, error: "ccusage failed" })), true);
  assert.equal(store.processMessage(statusTopic, JSON.stringify({ ...metadata, status: "error", error: "ccusage failed" })), true);
  assert.equal(store.getSnapshot().hosts.workstation.status?.status, "error");
  assert.equal(store.getSnapshot().hosts.workstation.error?.error, "ccusage failed");
});

test("publishes validated commands without retaining them", async () => {
  class FakeClient extends EventEmitter {
    publications: Array<{ topic: string; payload: string; options: { qos: number; retain: boolean } }> = [];
    subscribe(_topics: string[], _options: unknown, callback: (error?: Error | null) => void): void { callback(null); }
    publish(topic: string, payload: string, options: { qos: number; retain: boolean }, callback: (error?: Error | null) => void): void {
      this.publications.push({ topic, payload, options });
      callback(null);
    }
    end(_force: boolean, _options: unknown, callback: () => void): void { callback(); }
  }
  const client = new FakeClient();
  const store = new RemoteMqttStore({ mqttUrl: "mqtt://broker" }, { connect: (() => client) as never });
  const started = store.start();
  client.emit("connect");
  await started;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await store.publishCommand("workstation", { requestId: "bad", category: "cold", from: "2026-02-31", to: "2026-02-31", mode: "offline" }), false);
  assert.equal(await store.publishCommand("workstation", { requestId: "request-1", category: "cold", from: "2026-09-01", to: "2026-09-02", mode: "offline" }), true);
  const command = client.publications.at(-1);
  assert.equal(command?.topic, "quota-dashboard/v1/hosts/workstation/command");
  assert.deepEqual(command?.options, { qos: 1, retain: false });
  assert.equal(JSON.parse(command?.payload || "{}").schemaVersion, 2);
  await store.stop();
});

test("connects to usage and lifecycle topics, but not commands", async () => {
  class FakeClient extends EventEmitter {
    subscriptions: string[] = [];
    subscribe(topics: string[], _options: unknown, callback: (error?: Error | null) => void): void { this.subscriptions = topics; callback(null); }
    end(_force: boolean, _options: unknown, callback: () => void): void { callback(); }
  }
  const client = new FakeClient();
  const store = new RemoteMqttStore({ mqttUrl: "mqtt://broker" }, { connect: (() => client) as never });
  const started = store.start();
  client.emit("connect");
  await started;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.subscriptions, [
    makeMqttSubscriptionTopics().usage,
    makeMqttSubscriptionTopics().status,
    makeMqttSubscriptionTopics().error,
  ]);
  await store.stop();
});
