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
  publishErrors = new Map<string, Error>();
  options: Record<string, any> = {};

  subscribe(topics: string | string[], _options: unknown, callback: (error?: Error | null) => void): void {
    this.subscriptions = typeof topics === "string" ? [topics] : topics;
    callback(null);
  }

  publish(topic: string, payload: string, options: { qos: number; retain: boolean }, callback: (error?: Error | null) => void): void {
    this.publications.push({ topic, payload, options });
    callback(this.publishErrors.get(topic) || null);
  }

  end(_force: boolean, _options: unknown, callback: (error?: Error | null) => void): void {
    callback(null);
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function startPublisher(dependencies: Record<string, unknown> = {}, overrides: Partial<RemotePublisherConfig> = {}): { publisher: RemoteMqttPublisher; client: FakeClient } {
  const client = new FakeClient();
  const publisher = new RemoteMqttPublisher({ ...config, ...overrides }, {
    connect: ((_url: string, options: Record<string, any>) => {
      client.options = options;
      return client;
    }) as never,
    now: () => new Date("2026-09-13T12:00:00.000Z"),
    runCcusage: (async () => ({ document: { daily: [] }, stdout: "{}", stderr: "" })) as never,
    log: () => {},
    infoLog: () => {},
    ...(dependencies as any),
  });
  return { publisher, client };
}

test("publishes retained date-level hot usage with the hot timeout", async () => {
  const calls: Array<{ from: string; to: string; timeoutMs?: number; offline?: boolean }> = [];
  const { publisher, client } = startPublisher({
    runCcusage: (async ({ range, timeoutMs, offline }: any) => {
      calls.push({ from: range.from, to: range.to, timeoutMs, offline });
      return { document: { daily: [{ date: "2026-09-12", cost: 2 }, { date: "2026-09-13", cost: 3 }] }, stdout: "{}", stderr: "" };
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
    { from: "2026-09-12", to: "2026-09-13", timeoutMs: 600_000, offline: false },
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
  assert.deepEqual(calls, [{ timeoutMs: 1_800_000, offline: true }]);
  await publisher.stop();
});

test("publishes a successful cold range newest-first with an empty day snapshot", async () => {
  const { publisher, client } = startPublisher({
    runCcusage: (async () => ({
      document: { daily: [{ date: "2026-09-01", cost: 1 }, { date: "2026-09-03", cost: 3 }] },
      stdout: "{}",
      stderr: "",
    })) as never,
  });
  publisher.start();
  client.emit("connect");
  await flush();
  client.publications.length = 0;

  assert.equal(publisher.requestCold("2026-09-01", "2026-09-03"), true);
  await flush();

  const usage = client.publications.filter((publication) => publication.topic.includes("/usage/") && JSON.parse(publication.payload).category === "cold");
  assert.deepEqual(usage.map((publication) => publication.topic), [
    "quota-dashboard/v1/hosts/workstation/usage/2026-09-03",
    "quota-dashboard/v1/hosts/workstation/usage/2026-09-02",
    "quota-dashboard/v1/hosts/workstation/usage/2026-09-01",
  ]);
  assert.deepEqual(usage.map((publication) => JSON.parse(publication.payload).data), [
    { daily: [{ date: "2026-09-03", cost: 3 }] },
    { daily: [] },
    { daily: [{ date: "2026-09-01", cost: 1 }] },
  ]);
  await publisher.stop();
});

test("counts MQTT publication failures as day failures and keeps publishing the range", async () => {
  const logs: string[] = [];
  const { publisher, client } = startPublisher({
    log: (message: string) => logs.push(message),
    runCcusage: (async () => ({ document: { daily: [] }, stdout: "{}", stderr: "" })) as never,
  });
  publisher.start();
  client.emit("connect");
  await flush();
  client.publications.length = 0;
  logs.length = 0;
  client.publishErrors.set(
    "quota-dashboard/v1/hosts/workstation/usage/2026-09-02",
    new Error("socket closed"),
  );

  assert.equal(publisher.requestCold("2026-09-01", "2026-09-03"), true);
  await flush();

  const usage = client.publications.filter((publication) => publication.topic.includes("/usage/") && JSON.parse(publication.payload).category === "cold");
  assert.deepEqual(usage.map((publication) => publication.topic), [
    "quota-dashboard/v1/hosts/workstation/usage/2026-09-03",
    "quota-dashboard/v1/hosts/workstation/usage/2026-09-02",
    "quota-dashboard/v1/hosts/workstation/usage/2026-09-01",
  ]);
  assert.ok(logs.some((line) => line.includes("day 2026-09-02 failure") && line.includes("error=socket closed")));
  assert.ok(logs.some((line) => line.includes("summary succeeded=2 failed=1")));
  assert.equal(logs.some((line) => line.includes("ccusage was not found")), false);
  await publisher.stop();
});

test("runs a cold range once and publishes no days when collection fails", async () => {
  const calls: Array<{ from: string; to: string }> = [];
  const logs: string[] = [];
  const { publisher, client } = startPublisher({
    log: (message: string) => logs.push(message),
    runCcusage: (async ({ range }: any) => {
      calls.push({ from: range.from, to: range.to });
      throw new Error("range failed");
    }) as never,
  });
  publisher.start();
  client.emit("connect");
  await flush();
  calls.length = 0;
  logs.length = 0;

  const command = JSON.stringify({ schemaVersion: 2, requestId: "cold-request-1", category: "cold", from: "2026-09-01", to: "2026-09-03", mode: "offline" });
  assert.equal(publisher.processCommand("quota-dashboard/v1/hosts/workstation/command", command), true);
  await flush();

  assert.deepEqual(calls, [{ from: "2026-09-01", to: "2026-09-03" }]);
  assert.ok(logs.some((line) => line.includes("[cold] [cold-request-1] receipt range=2026-09-01..2026-09-03 mode=offline")));
  assert.ok(logs.some((line) => line.includes("[cold] [cold-request-1] start days=3 reverse=true")));
  assert.ok(logs.some((line) => line.match(/\[cold\] \[cold-request-1\] range failure elapsed=\d+\.\d{3}s error=range failed/)));
  assert.ok(logs.some((line) => line.includes("[cold] [cold-request-1] summary succeeded=0 failed=3")));
  assert.equal(client.publications.some((publication) => JSON.parse(publication.payload).status === "error" && JSON.parse(publication.payload).category === "cold"), false);
  const usage = client.publications
    .filter((publication) => publication.topic.includes("/usage/") && JSON.parse(publication.payload).category === "cold" && JSON.parse(publication.payload).runId === "cold-request-1")
    .map((publication) => JSON.parse(publication.payload));
  assert.deepEqual(usage, []);
  await publisher.stop();
});

test("keeps cold jobs FIFO while publishing each range newest-first", async () => {
  const calls: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const { publisher, client } = startPublisher({
    runCcusage: (async ({ range }: any) => {
      calls.push(`${range.from}..${range.to}`);
      if (range.from === "2026-09-01") await firstGate;
      return { document: { daily: [] }, stdout: "{}", stderr: "" };
    }) as never,
  });
  publisher.start();
  client.emit("connect");
  await flush();
  calls.length = 0;
  assert.equal(publisher.requestCold("2026-09-01", "2026-09-03"), true);
  assert.equal(publisher.requestCold("2026-09-04", "2026-09-05"), true);
  await flush();
  assert.deepEqual(calls, ["2026-09-01..2026-09-03"]);
  releaseFirst();
  await flush();
  assert.deepEqual(calls, ["2026-09-01..2026-09-03", "2026-09-04..2026-09-05"]);
  await publisher.stop();
});

test("deduplicates validated commands and does not block the MQTT callback", async () => {
  const commands: string[] = [];
  const logs: string[] = [];
  const { publisher, client } = startPublisher({ log: (message: string) => logs.push(message), onCommand: (command: any) => commands.push(command.requestId) });
  publisher.start();
  const topic = "quota-dashboard/v1/hosts/workstation/command";
  const command = JSON.stringify({ schemaVersion: 2, requestId: "request-1", category: "cold", from: "2026-09-01", to: "2026-09-01", mode: "offline" });
  assert.equal(publisher.processCommand(topic, command), true);
  assert.equal(publisher.processCommand(topic, command), false);
  assert.equal(publisher.processCommand("quota-dashboard/v1/hosts/workstation/status", command), false);
  assert.deepEqual(commands, ["request-1"]);
  assert.equal(logs.filter((line) => line.includes("[cold] [request-1] receipt")).length, 1);
  assert.ok(logs.some((line) => line.includes("command ignored request=request-1") && line.includes("duplicate request")));
  assert.ok(logs.findIndex((line) => line.includes("[cold] [request-1] receipt")) < logs.findIndex((line) => line.includes("[cold] [request-1] start")));
  await flush();
  assert.equal(publisher.processCommand(topic, command), true);
  await publisher.stop();
  assert.equal(client.listenerCount("message"), 0);
});

test("scheduled hot successes stay quiet, while failures and the first recovery are logged", async (t) => {
  const logs: string[] = [];
  let shouldFail = false;
  const { publisher, client } = startPublisher({
    log: (message: string) => logs.push(message),
    runCcusage: (async () => {
      if (shouldFail) throw new Error("temporary failure");
      return { document: { daily: [] }, stdout: "{}", stderr: "" };
    }) as never,
  });
  t.after(() => publisher.stop());
  publisher.start();
  client.emit("connect");
  await flush();
  logs.length = 0;
  await publisher.publishHot(false);
  assert.equal(logs.length, 0);

  shouldFail = true;
  await publisher.publishHot(false);
  assert.ok(logs.some((line) => line.includes("hot job failure")));
  const afterFailure = logs.length;
  await publisher.publishHot(false);
  assert.equal(logs.slice(afterFailure).some((line) => line.includes("hot job failure")), true);

  shouldFail = false;
  await publisher.publishHot(false);
  assert.ok(logs.some((line) => line.includes("hot job recovered")));
  const afterRecovery = logs.length;
  await publisher.publishHot(false);
  assert.equal(logs.length, afterRecovery);
  await publisher.stop();
});

test("daily logs trace scheduled jobs and publications, and cold recovery stays independent", async (t) => {
  const main: string[] = [];
  const info: string[] = [];
  let hotFails = false;
  let coldFails = false;
  const { publisher } = startPublisher({
    log: (line: string) => main.push(line),
    infoLog: (line: string) => info.push(line),
    runCcusage: (async ({ offline }: { offline?: boolean }) => {
      if (offline ? coldFails : hotFails) throw new Error("temporary failure");
      return { document: { daily: [] }, stdout: "{}", stderr: "" };
    }) as never,
  });
  t.after(() => publisher.stop());
  await publisher.start();
  publisher.scheduleColdHistory();
  await flush();
  await publisher.publishHot(false);
  assert.equal(main.length, 0);
  assert.ok(info.some((line) => line.includes("[cold]") && line.includes("source=scheduled")));
  assert.ok(info.some((line) => line.includes("[hot]") && line.includes("completion duration=")));
  assert.ok(info.some((line) => line.includes("mqtt response sent kind=usage") && line.includes("duration=")));
  assert.ok(info.some((line) => line.includes("mqtt response sent kind=status")));
  assert.ok(info.some((line) => line.includes("mqtt response sent kind=error")));

  hotFails = true;
  await publisher.publishHot(false);
  coldFails = true;
  publisher.scheduleColdHistory();
  await flush();
  coldFails = false;
  publisher.scheduleColdHistory();
  await flush();
  assert.equal(main.filter((line) => line.includes("cold job recovered")).length, 1);
  assert.equal(main.filter((line) => line.includes("hot job recovered")).length, 0);
  hotFails = false;
  await publisher.publishHot(false);
  assert.equal(main.filter((line) => line.includes("hot job recovered")).length, 1);
  const count = main.length;
  publisher.scheduleColdHistory();
  await flush();
  await publisher.publishHot(false);
  assert.equal(main.length, count);
});

test("on-demand hot commands log their lifecycle to both destinations", async (t) => {
  const main: string[] = [];
  const info: string[] = [];
  let closed = false;
  const { publisher } = startPublisher({ log: (line: string) => main.push(line), infoLog: (line: string) => info.push(line), closeLog: async () => { closed = true; } });
  t.after(() => publisher.stop());
  await publisher.start();
  assert.equal(publisher.processCommand("quota-dashboard/v1/hosts/workstation/command", JSON.stringify({ schemaVersion: 2, requestId: "hot-123", category: "hot", from: "2026-09-12", to: "2026-09-13", mode: "online" })), true);
  await flush();
  for (const records of [main, info]) {
    for (const event of ["receipt", "start", "completion duration="]) assert.ok(records.some((line) => line.includes("[hot] [hot-123]") && line.includes(event)));
  }
  await publisher.stop();
  assert.equal(closed, true);
});

test("daily logs omit ccusage parse payloads while MQTT error payloads stay unchanged", async () => {
  const logs: string[] = [];
  const payload = '{"daily":[{"apiKey":"sensitive-value"}]}';
  const error = new SyntaxError(`Unexpected token in ccusage output ${payload}`);
  const { publisher, client } = startPublisher({
    log: (message: string) => logs.push(message),
    runCcusage: (async () => { throw error; }) as never,
  });
  publisher.start();
  client.emit("connect");
  await flush();
  logs.length = 0;

  const topic = "quota-dashboard/v1/hosts/workstation/command";
  const coldCommand = JSON.stringify({ schemaVersion: 2, requestId: "parse-error-cold", category: "cold", from: "2026-09-13", to: "2026-09-13", mode: "offline" });
  assert.equal(publisher.processCommand(topic, coldCommand), true);
  await flush();

  assert.ok(logs.some((line) => line.includes("invalid ccusage output (SyntaxError)")));
  assert.equal(logs.some((line) => line.includes("sensitive-value")), false);
  const hotCommand = JSON.stringify({ schemaVersion: 2, requestId: "parse-error-hot", category: "hot", from: "2026-09-13", to: "2026-09-13", mode: "online" });
  assert.equal(publisher.processCommand(topic, hotCommand), true);
  await flush();
  assert.equal(logs.some((line) => line.includes("sensitive-value")), false);
  assert.ok(client.publications.some((publication) => publication.topic.endsWith("/error") && publication.payload.includes("sensitive-value")));
  await publisher.stop();
});

test("allows one hot and one cold ccusage job concurrently", async () => {
  let resolveHot: (() => void) | undefined;
  let resolveCold: (() => void) | undefined;
  const hotGate = new Promise<void>((resolve) => { resolveHot = resolve; });
  const coldGate = new Promise<void>((resolve) => { resolveCold = resolve; });
  const calls: string[] = [];
  const { publisher, client } = startPublisher({
    runCcusage: (async ({ offline, range }: any) => {
      calls.push(`${offline ? "cold" : "hot"}:${range.from}..${range.to}`);
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
  assert.equal(result.reconnectTimeoutMs, 90_000);
  assert.equal(readRemotePublisherConfig({ MQTT_RECONNECT_TIMEOUT_MS: "60000" }).reconnectTimeoutMs, 60_000);
  for (const value of ["", "0", "-1", "NaN", "Infinity"]) {
    assert.equal(readRemotePublisherConfig({ MQTT_RECONNECT_TIMEOUT_MS: value }).reconnectTimeoutMs, 90_000);
  }
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

test("reconnect schedules the newest stale date after hot collection", async () => {
  const calls: string[] = [];
  const { publisher, client } = startPublisher({
    runCcusage: (async ({ range, offline }: any) => {
      calls.push(`${offline ? "cold" : "hot"}:${range.from}..${range.to}`);
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
  assert.deepEqual(calls, ["hot:2026-09-12..2026-09-13", "cold:2026-09-11..2026-09-11"]);
  await publisher.stop();
});

for (const hotFails of [false, true]) {
  test(`startup waits for hot collection before cold collection, hotFails=${hotFails}`, async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const { publisher, client } = startPublisher({
      runCcusage: async ({ offline }: { offline?: boolean }) => {
        calls.push(offline ? "cold" : "hot");
        if (!offline) {
          await gate;
          if (hotFails) throw new Error("hot failed");
        }
        return { document: { daily: [] }, stdout: "{}", stderr: "" };
      },
    });
    t.after(async () => { release(); await publisher.stop(); });
    await publisher.start();
    client.emit("connect");
    await flush();
    assert.deepEqual(calls, ["hot"]);
    release();
    await flush();
    assert.deepEqual(calls, ["hot", "cold"]);
  });
}

test("watchdog exits on sustained startup failure without resetting on retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const exits: number[] = [];
  const logs: string[] = [];
  const { publisher, client } = startPublisher({ exit: (code: number) => exits.push(code), log: (line: string) => logs.push(line) }, { reconnectTimeoutMs: 60_000 });
  t.after(() => publisher.stop());
  await publisher.start();
  for (let attempt = 0; attempt < 11; attempt += 1) {
    t.mock.timers.tick(5_000);
    client.emit("error", new Error("connect EHOSTUNREACH"));
    client.emit("reconnect");
    client.emit("close");
    client.emit("offline");
  }
  assert.deepEqual(exits, []);
  t.mock.timers.tick(5_000);
  assert.deepEqual(exits, [1]);
  assert.ok(logs.some((line) => line.includes("FATAL") && line.includes("60000ms")));
  t.mock.timers.tick(60_000);
  assert.deepEqual(exits, [1]);
});

for (const event of ["offline", "close"]) {
  test(`watchdog resets on successful connection and rearms on ${event}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const exits: number[] = [];
    const { publisher, client } = startPublisher({ exit: (code: number) => exits.push(code) });
    t.after(() => publisher.stop());
    await publisher.start();
    t.mock.timers.tick(80_000);
    client.emit("connect");
    await flush();
    client.emit("error", new Error("nonfatal MQTT error"));
    t.mock.timers.tick(100_000);
    assert.deepEqual(exits, []);
    client.emit(event);
    t.mock.timers.tick(80_000);
    client.emit("connect");
    await flush();
    t.mock.timers.tick(100_000);
    assert.deepEqual(exits, []);
    client.emit(event);
    t.mock.timers.tick(89_999);
    assert.deepEqual(exits, []);
    t.mock.timers.tick(1);
    assert.deepEqual(exits, [1]);
  });
}

test("stop cancels the watchdog", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const exits: number[] = [];
  const { publisher, client } = startPublisher({ exit: (code: number) => exits.push(code) });
  await publisher.start();
  await publisher.stop();
  t.mock.timers.tick(180_000);
  assert.deepEqual(exits, []);
  assert.equal(client.listenerCount("close"), 0);
});

test("watchdog exits even while a job is stuck waiting for an MQTT acknowledgement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const exits: number[] = [];
  const { publisher, client } = startPublisher({ exit: (code: number) => exits.push(code) });
  let acknowledge!: () => void;
  client.publish = (_topic, _payload, _options, callback) => { acknowledge = () => callback(null); };
  t.after(async () => { acknowledge?.(); await publisher.stop(); });
  await publisher.start();
  const job = publisher.publishHot();
  await flush();
  client.emit("offline");
  t.mock.timers.tick(90_000);
  assert.deepEqual(exits, [1]);
  acknowledge();
  await job;
});
