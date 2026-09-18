import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { readRemotePublisherConfig, RemoteMqttPublisher, sanitizeMqttUrl, type RemotePublisherConfig } from "./publisher.js";

const config: RemotePublisherConfig = {
  mqttUrl: "mqtt://broker",
  mqttPrefix: "quota-dashboard/v1",
  hostId: "workstation",
  timezone: "UTC",
  ccusageBinary: "ccusage",
  rollingDays: 370,
  publishIntervalMs: 60_000,
  hotTimeoutMs: 10 * 60 * 1000,
  coldTimeoutMs: 30 * 60 * 1000,
  ccusageMaxBuffer: 1024,
};

class FakeClient extends EventEmitter {
  publications: Array<{ topic: string; payload: string; options: { qos: number; retain: boolean } }> = [];
  subscriptions: string[] = [];
  options: Record<string, any> = {};

  subscribe(topics: string | string[], _options: unknown, callback: (error?: Error | null) => void): void {
    this.subscriptions = typeof topics === "string" ? [topics] : topics;
    callback(null);
  }

  publish(topic: string, payload: string, options: { qos: number; retain: boolean }, callback: (error?: Error | null) => void): void {
    this.publications.push({ topic, payload, options });
    callback(null);
  }

  end(_force: boolean, _options: unknown, callback: (error?: Error | null) => void): void {
    callback(null);
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function startPublisher(dependencies: Record<string, unknown> = {}): { publisher: RemoteMqttPublisher; client: FakeClient } {
  const client = new FakeClient();
  const publisher = new RemoteMqttPublisher(config, {
    connect: ((_url: string, options: Record<string, any>) => {
      client.options = options;
      return client;
    }) as never,
    now: () => new Date("2026-09-13T12:00:00.000Z"),
    runCcusage: (async () => ({ document: { daily: [] }, stdout: "{}", stderr: "" })) as never,
    ...(dependencies as any),
  });
  return { publisher, client };
}

test("publishes retained date-level hot usage with the hot timeout", async () => {
  const calls: Array<{ from: string; to: string; timeoutMs?: number; offline?: boolean }> = [];
  const { publisher, client } = startPublisher({
    runCcusage: (async ({ range, timeoutMs, offline }: any) => {
      calls.push({ from: range.from, to: range.to, timeoutMs, offline });
      return { document: { daily: [{ date: range.from, cost: 2 }] }, stdout: "{}", stderr: "" };
    }) as never,
  });
  const starting = publisher.start();
  client.emit("connect");
  await starting;
  await flush();

  const usage = client.publications.filter((publication) => publication.topic.includes("/usage/") && JSON.parse(publication.payload).category === "hot");
  assert.deepEqual(usage.map((publication) => publication.topic), [
    "quota-dashboard/v1/hosts/workstation/usage/2026-09-12",
    "quota-dashboard/v1/hosts/workstation/usage/2026-09-13",
  ]);
  assert.deepEqual(calls.filter((call) => !call.offline), [
    { from: "2026-09-12", to: "2026-09-12", timeoutMs: 600_000, offline: false },
    { from: "2026-09-13", to: "2026-09-13", timeoutMs: 600_000, offline: false },
  ]);
  assert.ok(usage.every((publication) => publication.options.retain && publication.options.qos === 1));
  assert.equal(JSON.parse(usage[0].payload).date, "2026-09-12");
  assert.ok(client.subscriptions.includes("quota-dashboard/v1/hosts/workstation/command"));
  await publisher.stop();
});

test("uses offline cold jobs and the cold timeout", async () => {
  const calls: Array<{ timeoutMs?: number; offline?: boolean }> = [];
  const { publisher, client } = startPublisher({
    runCcusage: (async ({ timeoutMs, offline }: any) => {
      calls.push({ timeoutMs, offline });
      return { document: { daily: [] }, stdout: "{}", stderr: "" };
    }) as never,
  });
  publisher.start();
  client.emit("connect");
  await flush();
  calls.length = 0;
  assert.equal(publisher.requestCold("2026-09-01", "2026-09-02"), true);
  await flush();
  assert.deepEqual(calls, [{ timeoutMs: 1_800_000, offline: true }, { timeoutMs: 1_800_000, offline: true }]);
  await publisher.stop();
});

test("deduplicates validated commands and does not block the MQTT callback", async () => {
  const commands: string[] = [];
  const { publisher, client } = startPublisher({ onCommand: (command: any) => commands.push(command.requestId) });
  publisher.start();
  const topic = "quota-dashboard/v1/hosts/workstation/command";
  const command = JSON.stringify({ schemaVersion: 2, requestId: "request-1", category: "cold", from: "2026-09-01", to: "2026-09-01", mode: "offline" });
  assert.equal(publisher.processCommand(topic, command), true);
  assert.equal(publisher.processCommand(topic, command), false);
  assert.equal(publisher.processCommand("quota-dashboard/v1/hosts/workstation/status", command), false);
  assert.deepEqual(commands, ["request-1"]);
  await flush();
  assert.equal(publisher.processCommand(topic, command), true);
  await publisher.stop();
  assert.equal(client.listenerCount("message"), 0);
});

test("allows one hot and one cold ccusage job concurrently", async () => {
  let resolveHot: (() => void) | undefined;
  let resolveCold: (() => void) | undefined;
  const hotGate = new Promise<void>((resolve) => { resolveHot = resolve; });
  const coldGate = new Promise<void>((resolve) => { resolveCold = resolve; });
  const calls: string[] = [];
  const { publisher, client } = startPublisher({
    runCcusage: (async ({ offline, range }: any) => {
      calls.push(`${offline ? "cold" : "hot"}:${range.from}`);
      if (offline) await coldGate;
      else await hotGate;
      return { document: { daily: [] }, stdout: "{}", stderr: "" };
    }) as never,
  });
  publisher.start();
  client.emit("connect");
  await flush();
  assert.equal(publisher.requestCold("2026-09-01"), true);
  await flush();
  assert.equal(calls.length, 2);
  assert.ok(calls.some((call) => call.startsWith("hot:")));
  assert.ok(calls.some((call) => call.startsWith("cold:")));
  resolveHot?.();
  resolveCold?.();
  await publisher.stop();
});

test("reads timeout defaults and keeps URL logging redacted", () => {
  const result = readRemotePublisherConfig({ MQTT_URL: "mqtt://broker" });
  assert.equal(result.publishIntervalMs, 600_000);
  assert.equal(result.hotTimeoutMs, 600_000);
  assert.equal(result.coldTimeoutMs, 1_800_000);
  assert.equal(result.coldMode, "offline");
  assert.equal(sanitizeMqttUrl("mqtt://user:pass@broker.local:1883/path?token=secret"), "mqtt://broker.local:1883");
});

test("scheduled cold collection runs only the newest stale date and deduplicates while active", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const { publisher } = startPublisher({
    runCcusage: (async ({ range, offline }: any) => {
      calls.push(`${range.from}:${range.to}:${offline}`);
      await gate;
      return { document: { daily: [] }, stdout: "{}", stderr: "" };
    }) as never,
  });
  publisher.start();
  assert.equal(publisher.scheduleColdHistory(), true);
  assert.equal(publisher.scheduleColdHistory(), false);
  await flush();
  assert.deepEqual(calls, ["2026-09-11:2026-09-11:true"]);
  release?.();
  await flush();
  await publisher.stop();
});

test("rejects impossible calendar dates for cold jobs", async () => {
  const { publisher } = startPublisher();
  publisher.start();
  assert.equal(publisher.requestCold("2026-02-31"), false);
  await publisher.stop();
});

test("reconnect schedules the newest stale date alongside hot collection", async () => {
  const calls: string[] = [];
  const { publisher, client } = startPublisher({
    runCcusage: (async ({ range, offline }: any) => {
      calls.push(`${offline ? "cold" : "hot"}:${range.from}`);
      return { document: { daily: [] }, stdout: "{}", stderr: "" };
    }) as never,
  });
  publisher.start();
  client.emit("connect");
  await flush();
  calls.length = 0;
  client.emit("reconnect");
  client.emit("connect");
  await flush();
  assert.deepEqual(calls, ["cold:2026-09-11", "hot:2026-09-12", "hot:2026-09-13"]);
  await publisher.stop();
});
