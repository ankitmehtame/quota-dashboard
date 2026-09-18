import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archivePath = process.argv[2];

if (!archivePath) throw new Error("Usage: node scripts/smoke-test-remote-agent.mjs <archive>");

const tempDir = await mkdtemp(path.join(os.tmpdir(), "quota-dashboard-remote-agent-smoke-"));
const extractDir = path.join(tempDir, "archive");
const fakeBinDir = path.join(tempDir, "bin");
const homeDir = path.join(tempDir, "home");
const macHomeDir = path.join(tempDir, "mac-home");
const systemctlLog = path.join(tempDir, "systemctl.log");
const launchctlLog = path.join(tempDir, "launchctl.log");

function runSetup(setup, options, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(setup, [], options);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`setup failed (${code}): ${stderr}`)));
    child.stdin.end(input);
  });
}

try {
  const { stdout: archiveListing } = await execFileAsync("tar", ["-tzf", path.resolve(rootDir, archivePath)]);
  const archiveEntries = archiveListing.trim().split("\n");
  assert.ok(archiveEntries.includes("remote/package.json"));
  assert.ok(archiveEntries.includes("remote/package-lock.json"));
  assert.ok(archiveEntries.includes("remote/node_modules/"));
  assert.ok(archiveEntries.includes("remote/index.js"));
  assert.ok(archiveEntries.includes("remote/setup.sh"));
  const allowedArchiveEntry = /^remote\/(?:$|package(?:-lock)?\.json$|(?:index|publisher|ccusage|protocol)\.js$|setup\.sh$|node_modules\/.*$)/;
  assert.ok(archiveEntries.every((entry) => allowedArchiveEntry.test(entry)));

  await execFileAsync("tar", ["-xzf", path.resolve(rootDir, archivePath), "-C", tempDir]);
  await rename(path.join(tempDir, "remote"), extractDir);
  await mkdir(fakeBinDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });

  const ccusageStub = path.join(fakeBinDir, "ccusage");
  const systemctlStub = path.join(fakeBinDir, "systemctl");
  const launchctlStub = path.join(fakeBinDir, "launchctl");
  const unameStub = path.join(fakeBinDir, "uname");
  const npmStub = path.join(fakeBinDir, "npm");
  await writeFile(ccusageStub, "#!/bin/sh\nprintf 'ccusage smoke version\\n'\n");
  await writeFile(systemctlStub, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SMOKE_SYSTEMCTL_LOG\"\n");
  await writeFile(launchctlStub, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SMOKE_LAUNCHCTL_LOG\"\n");
  await writeFile(unameStub, "#!/bin/sh\nprintf 'Linux\\n'\n");
  await writeFile(npmStub, "#!/bin/sh\nprintf 'npm must not be called by the archive installer\\n' >&2\nexit 1\n");
  await Promise.all([
    chmod(ccusageStub, 0o755),
    chmod(systemctlStub, 0o755),
    chmod(launchctlStub, 0o755),
    chmod(unameStub, 0o755),
    chmod(npmStub, 0o755),
  ]);

  const setup = path.join(extractDir, "setup.sh");
  await runSetup(setup, {
    cwd: extractDir,
    env: {
      ...process.env,
      HOME: homeDir,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      SMOKE_SYSTEMCTL_LOG: systemctlLog,
      SMOKE_LAUNCHCTL_LOG: launchctlLog,
    },
  }, "mqtt://smoke-broker:1883\nsmoke-user\nsmoke-password\nsmoke-host\nUTC\n");
  await runSetup(setup, {
    cwd: extractDir,
    env: {
      ...process.env,
      HOME: homeDir,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      SMOKE_SYSTEMCTL_LOG: systemctlLog,
      SMOKE_LAUNCHCTL_LOG: launchctlLog,
    },
  }, "mqtt://smoke-broker:1883\nsmoke-user\nsmoke-password\nsmoke-host\nUTC\n");

  const envFile = path.join(homeDir, ".config/quota-dashboard/remote.env");
  const launcher = path.join(homeDir, ".local/bin/quota-dashboard-remote");
  const unit = path.join(homeDir, ".config/systemd/user/quota-dashboard-remote.service");
  const [envContents, launcherContents, unitContents] = await Promise.all([
    readFile(envFile, "utf8"),
    readFile(launcher, "utf8"),
    readFile(unit, "utf8"),
  ]);
  assert.match(envContents, /MQTT_URL='mqtt:\/\/smoke-broker:1883'/);
  assert.match(envContents, /CCUSAGE_BIN='.*\/ccusage'/);
  assert.equal(launcherContents.includes(`${extractDir}/index.js`), true);
  assert.match(unitContents, /quota-dashboard-remote/);
  const systemctlContents = await readFile(systemctlLog, "utf8");
  assert.match(systemctlContents, /enable quota-dashboard-remote\.service/);
  assert.equal((systemctlContents.match(/restart quota-dashboard-remote\.service/g) || []).length, 2);

  await writeFile(unameStub, "#!/bin/sh\nprintf 'Darwin\\n'\n");
  await runSetup(setup, {
    cwd: extractDir,
    env: {
      ...process.env,
      HOME: macHomeDir,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      SMOKE_SYSTEMCTL_LOG: systemctlLog,
      SMOKE_LAUNCHCTL_LOG: launchctlLog,
    },
  }, "mqtt://mac-broker:1883\nmac-user\nmac-password\nmac-host\nUTC\n");
  const macEnvFile = path.join(macHomeDir, ".config/quota-dashboard/remote.env");
  const macLauncher = path.join(macHomeDir, ".local/bin/quota-dashboard-remote");
  const plist = path.join(macHomeDir, "Library/LaunchAgents/local.quota-dashboard.remote.plist");
  const [macEnvContents, macLauncherContents, plistContents] = await Promise.all([
    readFile(macEnvFile, "utf8"),
    readFile(macLauncher, "utf8"),
    readFile(plist, "utf8"),
  ]);
  assert.match(macEnvContents, /MQTT_URL='mqtt:\/\/mac-broker:1883'/);
  assert.equal(macLauncherContents.includes(`${extractDir}/index.js`), true);
  assert.match(plistContents, /local\.quota-dashboard\.remote/);
  assert.match(await readFile(launchctlLog, "utf8"), /bootout gui\/\d+\/local\.quota-dashboard\.remote/);
  assert.match(await readFile(launchctlLog, "utf8"), /bootstrap gui\/\d+ .*local\.quota-dashboard\.remote\.plist/);

  const { RemoteMqttPublisher } = await import(pathToFileURL(path.join(extractDir, "publisher.js")).href);
  class FakeClient extends EventEmitter {
    publications = [];
    options = {};

    publish(topic, payload, options, callback) {
      this.publications.push({ topic, payload, options });
      callback(null);
    }

    end(_force, _options, callback) {
      callback(null);
    }
  }

  const client = new FakeClient();
  const publisher = new RemoteMqttPublisher({
    mqttUrl: "mqtt://smoke-broker",
    mqttPrefix: "quota-dashboard/v1",
    hostId: "smoke-host",
    timezone: "UTC",
    ccusageBinary: "ccusage",
    rollingDays: 2,
    publishIntervalMs: 60_000,
    ccusageTimeoutMs: 1000,
    ccusageMaxBuffer: 1024,
  }, {
    connect: () => client,
    now: () => new Date("2026-09-13T12:00:00.000Z"),
    runCcusage: async () => ({ document: { daily: [] }, stdout: "{}", stderr: "" }),
  });
  await publisher.start();
  client.emit("connect");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
   assert.deepEqual(client.publications.map(({ topic }) => topic.split("/").at(-1)), ["status", "2026-09-12", "2026-09-13", "status", "error"]);
   assert.equal(client.publications[1].options.retain, true);
   assert.equal(client.publications[2].options.retain, true);
  await publisher.stop();
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("Remote agent archive and offline installer smoke test passed.");
