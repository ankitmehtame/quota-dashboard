import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { RemoteMqttPublisher, type RemotePublisherConfig } from "./publisher.js";

const config: RemotePublisherConfig = {
  mqttUrl: "mqtt://broker",
  mqttPrefix: "quota-dashboard/v1",
  hostId: "workstation",
  timezone: "UTC",
  ccusageBinary: "ccusage",
  rollingDays: 370,
  publishIntervalMs: 60_000,
  ccusageTimeoutMs: 30_000,
  ccusageMaxBuffer: 1024,
};

test("publishes retained lifecycle, usage, and error-clear messages", async () => {
  class FakeClient extends EventEmitter {
    publications: Array<{ topic: string; payload: string; options: { qos: number; retain: boolean } }> = [];
    options: Record<string, any> = {};

    publish(topic: string, payload: string, options: { qos: number; retain: boolean }, callback: (error?: Error | null) => void): void {
      this.publications.push({ topic, payload, options });
      callback(null);
    }

    end(_force: boolean, _options: unknown, callback: (error?: Error | null) => void): void {
      callback(null);
    }
  }

  const client = new FakeClient();
  let connectOptions: Record<string, any> | undefined;
  const publisher = new RemoteMqttPublisher(config, {
    connect: ((_url: string, options: Record<string, any>) => {
      connectOptions = options;
      client.options = options;
      return client;
    }) as never,
    now: () => new Date("2026-09-13T12:00:00.000Z"),
    runCcusage: (async () => ({ document: { daily: [] }, stdout: "{}", stderr: "" })) as never,
  });

  const starting = publisher.start();
  client.emit("connect");
  await starting;

  assert.equal(connectOptions?.will.qos, 1);
  assert.equal(connectOptions?.will.retain, true);
  assert.match(connectOptions?.clientId || "", /^quota-dashboard-remote-workstation-[a-f0-9]{12}$/);
  assert.deepEqual(client.publications.map(({ topic, payload, options }) => [topic.split("/").at(-1), payload && JSON.parse(payload).status, options]), [
    ["status", "online", { qos: 1, retain: true }],
    ["usage", undefined, { qos: 1, retain: true }],
    ["status", "ok", { qos: 1, retain: true }],
    ["error", undefined, { qos: 1, retain: true }],
  ]);
  const usage = JSON.parse(client.publications[1].payload);
  const initialWill = JSON.parse(connectOptions?.will.payload);
  assert.equal(usage.publisherId, initialWill.publisherId);
  assert.equal(usage.connectionId, initialWill.connectionId);
  assert.deepEqual(usage.data, { daily: [] });

  client.emit("reconnect");
  const reconnectWill = JSON.parse(client.options.will.payload);
  assert.equal(reconnectWill.publisherId, initialWill.publisherId);
  assert.notEqual(reconnectWill.connectionId, initialWill.connectionId);
  client.emit("connect");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const reconnectOnline = JSON.parse(client.publications[4].payload);
  assert.equal(reconnectOnline.status, "online");
  assert.equal(reconnectOnline.connectionId, reconnectWill.connectionId);

  await publisher.stop();
  assert.equal(JSON.parse(client.publications.at(-1)?.payload || "{}").status, "offline");
});
