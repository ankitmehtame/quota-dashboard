import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { readRemotePublisherConfig, RemoteMqttPublisher, type RemotePublisherConfig } from "./publisher.js";

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

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

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
  await flush();

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
  assert.equal(client.listenerCount("error"), 0);
});

test("omits empty publisher credentials without trimming non-empty values", async () => {
  const envConfig = readRemotePublisherConfig({
    MQTT_URL: "mqtt://broker",
    MQTT_USERNAME: "",
    MQTT_PASSWORD: " user password ",
  });
  assert.equal("username" in envConfig, false);
  assert.equal(envConfig.password, " user password ");

  class FakeClient extends EventEmitter {
    options: Record<string, any> = {};

    end(_force: boolean, _options: unknown, callback: (error?: Error | null) => void): void {
      callback(null);
    }
  }

  const client = new FakeClient();
  let options: Record<string, any> | undefined;
  const publisher = new RemoteMqttPublisher({ ...config, username: "", password: "" }, {
    connect: ((_url: string, connectOptions: Record<string, any>) => {
      options = connectOptions;
      return client;
    }) as never,
  });
  publisher.start();
  assert.equal("username" in (options || {}), false);
  assert.equal("password" in (options || {}), false);
  await publisher.stop();
});

test("keeps running after an initial broker error and publishes after a later connect", async () => {
  class FakeClient extends EventEmitter {
    publications: string[] = [];
    options: Record<string, any> = {};

    publish(_topic: string, payload: string, _options: unknown, callback: (error?: Error | null) => void): void {
      this.publications.push(payload);
      callback(null);
    }

    end(_force: boolean, _options: unknown, callback: (error?: Error | null) => void): void {
      callback(null);
    }
  }

  const client = new FakeClient();
  const publisher = new RemoteMqttPublisher(config, {
    connect: ((_url: string, options: Record<string, any>) => {
      client.options = options;
      return client;
    }) as never,
    runCcusage: (async () => ({ document: { daily: [] }, stdout: "{}", stderr: "" })) as never,
  });
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => errors.push(String(message));
  try {
    publisher.start();
    client.emit("error", new Error("broker unavailable"));
    client.emit("connect");
    await flush();
  } finally {
    console.error = originalError;
  }

  assert.equal(errors.length, 1);
  assert.equal(client.publications.length, 4);
  assert.equal(JSON.parse(client.publications[0]).status, "online");
  await publisher.stop();
});

test("handles a post-connect error and does not duplicate the connection publication", async () => {
  class FakeClient extends EventEmitter {
    publications: string[] = [];
    options: Record<string, any> = {};

    publish(_topic: string, payload: string, _options: unknown, callback: (error?: Error | null) => void): void {
      this.publications.push(payload);
      callback(null);
    }

    end(_force: boolean, _options: unknown, callback: (error?: Error | null) => void): void {
      callback(null);
    }
  }

  const client = new FakeClient();
  const publisher = new RemoteMqttPublisher(config, {
    connect: ((_url: string, options: Record<string, any>) => {
      client.options = options;
      return client;
    }) as never,
    runCcusage: (async () => ({ document: { daily: [] }, stdout: "{}", stderr: "" })) as never,
  });
  const originalError = console.error;
  console.error = () => undefined;
  try {
    publisher.start();
    client.emit("connect");
    client.emit("connect");
    await flush();
    assert.equal(client.publications.length, 4);

    client.emit("error", new Error("connection dropped"));
    client.emit("reconnect");
    client.emit("connect");
    await flush();
    assert.equal(client.publications.length, 8);
  } finally {
    console.error = originalError;
  }
  await publisher.stop();
});

test("does not publish graceful offline status after mqtt reports offline", async () => {
  class FakeClient extends EventEmitter {
    publicationCount = 0;
    options: Record<string, any> = {};

    publish(_topic: string, _payload: string, _options: unknown, callback: (error?: Error | null) => void): void {
      this.publicationCount += 1;
      callback(null);
    }

    end(_force: boolean, _options: unknown, callback: (error?: Error | null) => void): void {
      callback(null);
    }
  }

  const client = new FakeClient();
  const publisher = new RemoteMqttPublisher(config, {
    connect: ((_url: string, options: Record<string, any>) => {
      client.options = options;
      return client;
    }) as never,
    runCcusage: (async () => ({ document: { daily: [] }, stdout: "{}", stderr: "" })) as never,
  });

  publisher.start();
  client.emit("connect");
  await flush();
  assert.equal(client.publicationCount, 4);

  client.emit("offline");
  await publisher.stop();
  assert.equal(client.publicationCount, 4);
  assert.equal(client.listenerCount("offline"), 0);
});
