import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  DEFAULT_MQTT_MAX_PAYLOAD_BYTES,
  RemoteMqttStore,
  makeMqttSubscriptionTopics,
  parseMqttSubscriptionTopic,
  parseRemoteMqttMessage,
  readRemoteMqttSubscriberConfig,
} from "./subscriber.js";

const metadata = {
  schemaVersion: 1,
  publisherId: "publisher-1",
  connectionId: "connection-1",
  sequence: 1,
  hostId: "workstation",
  generatedAt: "2026-09-13T00:00:00.000Z",
  timezone: "Asia/Singapore",
  range: { from: "2025-09-09", to: "2026-09-13" },
};

function usage(hostId = metadata.hostId, data: unknown = { daily: [{ date: "2026-09-13", cost: 2 }] }): string {
  return JSON.stringify({ ...metadata, hostId, data });
}

function status(statusValue: string, hostId = metadata.hostId): string {
  return JSON.stringify({ ...metadata, hostId, status: statusValue });
}

test("parses only the configured host topic shape", () => {
  const topics = makeMqttSubscriptionTopics("example/v1");
  assert.deepEqual(parseMqttSubscriptionTopic(topics.usage.replace("+", "workstation"), "example/v1"), { hostId: "workstation", kind: "usage" });
  assert.equal(parseMqttSubscriptionTopic("example/v1/hosts/workstation/usage/extra", "example/v1"), null);
  assert.equal(parseMqttSubscriptionTopic("example/v1/hosts/bad/host/usage", "example/v1"), null);
  assert.equal(parseMqttSubscriptionTopic("example/v1/hosts/+/usage", "example/v1"), null);
});

test("rejects malformed, wrong-version, mismatched, and oversize envelopes", () => {
  const topic = makeMqttSubscriptionTopics().usage.replace("+", "workstation");
  assert.equal(parseRemoteMqttMessage(topic, "not json"), null);
  assert.equal(parseRemoteMqttMessage(topic, JSON.stringify({ ...metadata, schemaVersion: 2, data: {} })), null);
  assert.equal(parseRemoteMqttMessage(topic, usage("another-host")), null);
  assert.equal(parseRemoteMqttMessage(topic, Buffer.alloc(DEFAULT_MQTT_MAX_PAYLOAD_BYTES + 1)), null);
  assert.equal(parseRemoteMqttMessage(topic, JSON.stringify({ ...metadata, data: undefined })), null);
  assert.equal(parseRemoteMqttMessage(topic, JSON.stringify({ ...metadata, range: { from: "2026-02-31", to: "2026-09-13" }, data: {} })), null);
  const statusTopic = makeMqttSubscriptionTopics().status.replace("+", "workstation");
  assert.equal(parseRemoteMqttMessage(statusTopic, JSON.stringify({ ...metadata, status: "error", error: "x".repeat(16_385) })), null);
  assert.equal(parseRemoteMqttMessage(topic, usage("workstation", { daily: [{ agents: Array(65).fill({}) }] })), null);
});

test("keeps timezone metadata and the data document untouched", () => {
  const data = { daily: [{ date: "2026-09-13", nullValue: null, nested: { keep: true } }], extra: [1, false] };
  const parsed = parseRemoteMqttMessage(
    "quota-dashboard/v1/hosts/workstation/usage",
    usage("workstation", data),
  );
  assert.ok(parsed && parsed.message);
  assert.equal(parsed.message.timezone, "Asia/Singapore");
  assert.deepEqual((parsed.message as { data: unknown }).data, data);
});

test("stores status and error independently of the last usage", () => {
  const store = new RemoteMqttStore({ mqttUrl: "mqtt://broker" });
  const usageTopic = "quota-dashboard/v1/hosts/workstation/usage";
  const statusTopic = "quota-dashboard/v1/hosts/workstation/status";
  const errorTopic = "quota-dashboard/v1/hosts/workstation/error";
  assert.equal(store.processMessage(usageTopic, usage()), true);
  assert.equal(store.processMessage(errorTopic, JSON.stringify({ ...metadata, error: "ccusage failed" })), true);
  assert.equal(store.processMessage(statusTopic, status("error")), true);
  let snapshot = store.getSnapshot();
  assert.equal(snapshot.hosts.workstation.status?.status, "error");
  assert.equal(snapshot.hosts.workstation.error?.error, "ccusage failed");
  assert.deepEqual(snapshot.hosts.workstation.usage?.data, { daily: [{ date: "2026-09-13", cost: 2 }] });

  assert.equal(store.processMessage(statusTopic, JSON.stringify({ ...metadata, sequence: 2, status: "ok" })), true);
  snapshot = store.getSnapshot();
  assert.equal(snapshot.hosts.workstation.status?.status, "ok");
  assert.equal(snapshot.hosts.workstation.error?.error, "ccusage failed");
  assert.equal(store.processMessage(errorTopic, JSON.stringify({ ...metadata, sequence: 2, generatedAt: "2026-09-13T00:01:00.000Z", error: null })), true);
  assert.equal(store.getSnapshot().hosts.workstation.error?.error, null);
});

test("rejects older snapshots while accepting a last will from the active publisher", () => {
  const store = new RemoteMqttStore({ mqttUrl: "mqtt://broker" });
  const usageTopic = "quota-dashboard/v1/hosts/workstation/usage";
  const statusTopic = "quota-dashboard/v1/hosts/workstation/status";
  const newer = { ...metadata, sequence: 2, generatedAt: "2026-09-13T01:00:00.000Z" };
  assert.equal(store.processMessage(usageTopic, JSON.stringify({ ...newer, data: { daily: [{ date: "2026-09-13", cost: 2 }] } })), true);
  assert.equal(store.processMessage(usageTopic, usage()), false);
  assert.equal(store.getSnapshot().hosts.workstation.usage?.generatedAt, newer.generatedAt);

  assert.equal(store.processMessage(statusTopic, JSON.stringify({ ...newer, status: "ok" })), true);
  assert.equal(store.processMessage(statusTopic, status("offline")), true);
  assert.equal(store.getSnapshot().hosts.workstation.status?.status, "offline");
  const reconnected = { ...newer, connectionId: "connection-2", sequence: 3, generatedAt: "2026-09-13T02:00:00.000Z" };
  assert.equal(store.processMessage(statusTopic, JSON.stringify({ ...reconnected, status: "ok" })), true);
  assert.equal(store.processMessage(statusTopic, status("offline")), false);
  assert.equal(store.getSnapshot().hosts.workstation.status?.status, "ok");
});

test("stores reserved host IDs without changing the snapshot prototype", () => {
  const store = new RemoteMqttStore({ mqttUrl: "mqtt://broker" });
  assert.equal(store.processMessage("quota-dashboard/v1/hosts/__proto__/usage", usage("__proto__")), true);
  const snapshot = store.getSnapshot();
  assert.equal(Object.getPrototypeOf(snapshot.hosts), null);
  assert.equal(snapshot.hosts.__proto__.usage?.hostId, "__proto__");
});

test("returns a copy and notifies on accepted state changes", () => {
  const changes: string[] = [];
  const store = new RemoteMqttStore({ mqttUrl: "mqtt://broker", onChange: (snapshot) => changes.push(snapshot.connection) });
  store.processMessage("quota-dashboard/v1/hosts/workstation/usage", usage());
  const snapshot = store.getSnapshot();
  assert.throws(() => ((snapshot.hosts.workstation.usage?.data as { daily: unknown[] }).daily.length = 0), TypeError);
  assert.equal((store.getSnapshot().hosts.workstation.usage?.data as { daily: unknown[] }).daily.length, 1);
  assert.equal(changes.length, 1);
});

test("does not connect when MQTT is not configured", async () => {
  let connectCalls = 0;
  const store = new RemoteMqttStore({ mqttUrl: null }, { connect: (() => { connectCalls += 1; throw new Error("must not connect"); }) as never });
  await store.start();
  assert.equal(connectCalls, 0);
  assert.equal(store.getSnapshot().configured, false);
  assert.equal(store.getSnapshot().connection, "disabled");
});

test("omits empty subscriber credentials from config and connect options", async () => {
  const envConfig = readRemoteMqttSubscriberConfig({
    MQTT_URL: "mqtt://broker",
    MQTT_USERNAME: "",
    MQTT_PASSWORD: " pass word ",
  });
  assert.equal("username" in envConfig, false);
  assert.equal(envConfig.password, " pass word ");

  const client = new EventEmitter();
  let options: Record<string, any> | undefined;
  const store = new RemoteMqttStore({
    mqttUrl: "mqtt://broker",
    username: "",
    password: "",
    clientOptions: { username: "", password: "" },
  }, {
    connect: ((_url: string, connectOptions: Record<string, any>) => {
      options = connectOptions;
      return client;
    }) as never,
  });

  await store.start();
  assert.equal("username" in (options || {}), false);
  assert.equal("password" in (options || {}), false);
  assert.equal("username" in store.config, false);
  assert.equal("password" in store.config, false);
});

test("connects, subscribes to all three wildcard topics, and shuts down", async () => {
  class FakeClient extends EventEmitter {
    subscriptions: string[] = [];
    ended = false;
    subscribe(topics: string[], _options: unknown, callback: (error?: Error | null) => void): void {
      this.subscriptions = topics;
      callback(null);
    }
    end(_force: boolean, _options: unknown, callback: () => void): void {
      this.ended = true;
      callback();
    }
  }
  const client = new FakeClient();
  const store = new RemoteMqttStore({ mqttUrl: "mqtt://broker" }, { connect: (() => client) as never });
  const started = store.start();
  client.emit("connect");
  await started;
  assert.deepEqual(client.subscriptions, [...makeMqttSubscriptionTopics().all]);
  assert.equal(store.getSnapshot().connection, "connected");
  await store.stop();
  assert.equal(client.ended, true);
  assert.equal(store.getSnapshot().connection, "disconnected");
});
