import test from "node:test";
import assert from "node:assert/strict";
import { createConnection, createServer as createTcpServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../server.js", import.meta.url));

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 12_000, description = "condition", diagnostics?: () => Promise<string>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out after ${timeoutMs}ms waiting for ${description}${diagnostics ? `; ${await diagnostics()}` : ""}`);
}

async function readLog(directory: string): Promise<string> {
  try {
    const files = (await readdir(directory)).filter((name) => /^server-info-\d{4}-\d{2}-\d{2}\.log$/.test(name));
    return (await Promise.all(files.map((name) => readFile(join(directory, name), "utf8")))).join("\n");
  } catch {
    return "";
  }
}

async function startServer(options: { enabled: boolean; hotIntervalMs?: number; coldIntervalMs?: number }): Promise<{
  root: string;
  port: number;
  process: ChildProcess;
  logs: string;
  stdout: () => string;
  stop(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "quota-server-log-test-"));
  const home = join(root, "home");
  const logs = join(root, "logs");
  const data = join(root, "usage");
  const configPath = join(root, "config.json");
  const binary = join(root, "ccusage-stub.sh");
  const port = await freePort();
  await mkdir(home, { recursive: true });
  const enabled = options.enabled;
  await writeFile(configPath, JSON.stringify({ usageSources: Object.fromEntries(["codex", "opencode", "hermes", "antigravity"].map((id) => [id, { enabled }])) }));
  await writeFile(binary, `#!/bin/sh
case " $* " in
  *" --no-offline "*)
    n=$(cat "$HOT_COUNTER" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "$HOT_COUNTER"
    if [ "$n" -le 3 ]; then printf '{"token":"%s"' "$CCUSAGE_TEST_SECRET"; exit 0; fi
    ;;
  *" --offline "*)
    if [ ! -e "$COLD_GATE" ]; then echo "$CCUSAGE_TEST_SECRET" >&2; exit 1; fi
    ;;
esac
printf '{"daily":[]}\n'
`);
  const { chmod } = await import("node:fs/promises");
  await chmod(binary, 0o700);
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      HOME: home,
      HOST: "127.0.0.1",
      PORT: String(port),
      CONFIG_PATH: configPath,
      USAGE_DATA_DIR: data,
      USAGE_TIMEZONE: "UTC",
      QUOTA_LOG_DIR: logs,
      CCUSAGE_BIN: binary,
      CCUSAGE_HOT_TIMEOUT_MS: "8000",
      CCUSAGE_COLD_TIMEOUT_MS: "8000",
      CCUSAGE_HOT_INTERVAL_MS: String(options.hotIntervalMs ?? 600),
      CCUSAGE_COLD_INTERVAL_MS: String(options.coldIntervalMs ?? 60_000),
      CCUSAGE_DAYS: "3",
      HOT_COUNTER: join(root, "hot-counter"),
      COLD_GATE: join(root, "cold-gate"),
      CCUSAGE_TEST_SECRET: "TEST_CCUSAGE_SECRET_DO_NOT_LOG",
      MQTT_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    await rm(root, { recursive: true, force: true });
  };

  try {
    await waitFor(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/api/v1/providers`)).ok; }
      catch { return false; }
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { root, port, process: child, logs, stdout: () => output, stop };
}

test("server process logs hot request lifecycle, scheduled recovery, cold recovery, and no ccusage payloads", { timeout: 35_000 }, async () => {
  const server = await startServer({ enabled: true });
  try {
    const scheduledDateValue = new Date();
    scheduledDateValue.setUTCDate(scheduledDateValue.getUTCDate() - 2);
    const scheduledDate = scheduledDateValue.toISOString().slice(0, 10);
    await waitFor(async () => (await readLog(server.logs)).includes(`job start range=${scheduledDate}..${scheduledDate}`), 5000, "scheduled cold job start");
    const coldInitialLog = await readLog(server.logs);
    const originalJob = coldInitialLog.match(new RegExp(`\\[cold\\] \\[local\\] \\[([^\\]]+)\\] local enqueue range=${scheduledDate}\\.\\.${scheduledDate}`));
    assert.ok(originalJob, "scheduled cold queue records its original job ID");
    const duplicateResponse = await fetch(`http://127.0.0.1:${server.port}/api/v1/usage/cold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: scheduledDate, to: scheduledDate, requestId: "duplicate-cold-request" }),
    });
    assert.equal(duplicateResponse.status, 202);
    await waitFor(async () => (await readLog(server.logs)).includes(`deduplicated jobId=${originalJob[1]}`));

    await waitFor(async () => {
      const log = await readLog(server.logs);
      return log.includes("[hot] [local]") && log.includes("[cold] [local]")
        && log.includes("job complete status=failure") && log.includes("job failed error=ccusage-failure");
    }, 12_000, `initial failures; stdout=${server.stdout()} daily=${await readLog(server.logs)}`);
    const initialLog = await readLog(server.logs);
    assert.match(initialLog, /scheduler check complete reason=enabled/);
    assert.match(initialLog, /scheduler check complete reason=queued/);

    const now = new Date();
    now.setUTCDate(now.getUTCDate() - 3);
    const yesterday = now.toISOString().slice(0, 10);
    await writeFile(join(server.root, "cold-gate"), "ready");
    const coldResponse = await fetch(`http://127.0.0.1:${server.port}/api/v1/usage/cold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: yesterday, to: yesterday }),
    });
    assert.equal(coldResponse.status, 202);
    await waitFor(async () => /\[cold\] \[local\] \[[^\]]+\] health recovered/.test(server.stdout()), 12_000, "cold recovery", async () => `stdout=${server.stdout()} daily=${await readLog(server.logs)}`);
    await waitFor(async () => /\[hot\] \[local\] \[[^\]]+\] health recovered/.test(server.stdout()));
    await waitFor(async () => ((await readLog(server.logs)).match(/job complete status=success/g) || []).length >= 2);
    const scheduledSuccesses = [...(await readLog(server.logs)).matchAll(/\[hot\] \[local\] \[([^\]]+)\] job complete status=success[^\n]*checkId=/g)];
    assert.ok(scheduledSuccesses.length >= 2, "the recovery and a following scheduled hot run succeed");
    const nextScheduledJobId = scheduledSuccesses.at(-1)![1];
    assert.doesNotMatch(server.stdout(), new RegExp(`\\[hot\\] \\[local\\] \\[${nextScheduledJobId}\\] job complete status=success`), "scheduled success progress stays out of the main log");

    const hotResponse = await fetch(`http://127.0.0.1:${server.port}/api/v1/usage/refresh`, { method: "POST" });
    assert.equal(hotResponse.status, 202);
    await waitFor(async () => server.stdout().includes("job complete status=success") && server.stdout().includes("http complete"));
    await hotResponse.json();
    const output = server.stdout();
    const httpCompletion = output.match(/http complete id=([^ ]+) method=POST path=\/api\/v1\/usage\/refresh status=202/);
    assert.ok(httpCompletion, "HTTP completion includes correlation ID and pathname");
    const httpId = httpCompletion[1];
    const apiReceipt = output.match(new RegExp(`API receipt httpId=${httpId} requestId=([^ ]+)`));
    assert.ok(apiReceipt, "HTTP ID is linked to the existing command request ID");
    const requestId = apiReceipt[1];
    assert.match(output, new RegExp(`job accepted source=on-demand httpId=${httpId} requestId=${requestId}`));
    assert.match(output, /job complete status=success duration=\d+\.\d{3}s/);

    await waitFor(async () => (await readLog(server.logs)).includes("health recovered"));
    const daily = await readLog(server.logs);
    assert.equal((output.match(/health recovered/g) || []).length, 2, "each local category logs its first success to the main log once");
    assert.equal((daily.match(/health recovered/g) || []).length, 2, "each local category logs recovery daily once");
    const fullLog = `${daily}\n${output}`;
    assert.doesNotMatch(fullLog, /TEST_CCUSAGE_SECRET_DO_NOT_LOG/);
    assert.match(fullLog, /reason=covered|reason=already-running/);
  } finally {
    await server.stop();
  }
});

test("disabled scheduled checks are traced without running ccusage", { timeout: 10_000 }, async () => {
  const server = await startServer({ enabled: false, hotIntervalMs: 1000, coldIntervalMs: 1000 });
  try {
    await waitFor(async () => {
      const log = await readLog(server.logs);
      return log.includes("[hot] [local]") && log.includes("[cold] [local]")
        && log.includes("scheduler check complete reason=disabled");
    });
    assert.match(await readLog(server.logs), /scheduler check complete reason=disabled/);
    assert.equal(server.stdout().includes("Local hot usage refresh failed"), false);
  } finally {
    await server.stop();
  }
});

test("HTTP access logs cover static, error, and aborted responses without query strings", { timeout: 15_000 }, async () => {
  const server = await startServer({ enabled: false, hotIntervalMs: 60_000 });
  try {
    for (const [path, status] of [["/", 200], ["/api/v1/missing", 404]] as const) {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}?token=DO_NOT_LOG_QUERY`);
      assert.equal(response.status, status);
      await response.text();
      await waitFor(async () => server.stdout().includes(`method=GET path=${path} status=${status}`));
      assert.equal(server.stdout().split("\n").filter((line) => line.includes(`method=GET path=${path} status=${status}`)).length, 1);
    }
    const invalid = await fetch(`http://127.0.0.1:${server.port}/api/v1/usage/cold`, { method: "POST", body: "{" });
    assert.equal(invalid.status, 500);
    await invalid.text();
    await waitFor(async () => server.stdout().includes("method=POST path=/api/v1/usage/cold status=500"));

    const socket = createConnection({ host: "127.0.0.1", port: server.port });
    try {
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      socket.write("POST /api/v1/usage/cold?secret=DO_NOT_LOG_QUERY HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{\"from\":");
      await waitFor(async () => (await readLog(server.logs)).split("\n").filter((line) => line.includes("http arrival") && line.includes("path=/api/v1/usage/cold")).length >= 2);
      socket.destroy();
      await waitFor(async () => server.stdout().includes("aborted=true"));
    } finally { socket.destroy(); }
    const aborted = server.stdout().split("\n").filter((line) => line.includes("aborted=true"));
    assert.equal(aborted.length, 1);
    const abortedId = aborted[0].match(/id=([^ ]+)/)![1];
    assert.equal(server.stdout().split("\n").filter((line) => line.includes(`http complete id=${abortedId} `)).length, 1);
    assert.doesNotMatch(`${server.stdout()}\n${await readLog(server.logs)}`, /DO_NOT_LOG_QUERY|\?token=|\?secret=/);
  } finally { await server.stop(); }
});

test("shutdown closes idle keep-alive connections and flushes their access records", { timeout: 10_000 }, async () => {
  const server = await startServer({ enabled: false, hotIntervalMs: 60_000 });
  const socket = createConnection({ host: "127.0.0.1", port: server.port });
  try {
    let response = "";
    socket.on("data", (chunk: Buffer) => { response += chunk.toString(); });
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n");
    await waitFor(async () => response.includes("HTTP/1.1 200") && server.stdout().includes("method=GET path=/ status=200"));
    assert.equal(socket.destroyed, false, "client leaves the idle keep-alive socket open");
    let exitCode: number | null | undefined;
    server.process.once("exit", (code) => { exitCode = code; });
    server.process.kill("SIGTERM");
    await waitFor(async () => exitCode !== undefined, 3000, "shutdown without waiting for the keep-alive timeout", async () => server.stdout());
    assert.equal(exitCode, 0);
    const daily = await readLog(server.logs);
    assert.match(daily, /http complete .*method=GET path=\/ status=200/);
    assert.doesNotMatch(server.stdout(), /shutdown timed out/);
  } finally {
    socket.destroy();
    await server.stop();
  }
});
