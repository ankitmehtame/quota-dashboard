import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createDailyLogger,
  formatLocalTimestamp,
  resolveDailyLogDirectory,
  type DailyLoggerFileSystem,
} from "./daily-logger.js";

async function tempDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "quota-daily-logger-"));
}

test("resolves platform defaults and environment override", () => {
  assert.equal(resolveDailyLogDirectory({ platform: "darwin", home: "/home/test", env: {} }), "/home/test/Library/Logs/quota-dashboard");
  assert.equal(resolveDailyLogDirectory({ platform: "linux", home: "/home/test", env: {} }), "/home/test/.local/state/quota-dashboard/logs");
  assert.equal(resolveDailyLogDirectory({ platform: "darwin", home: "/home/test", env: { QUOTA_LOG_DIR: "/custom/logs" } }), "/custom/logs");
});

test("retries failed retention cleanup during the same local day", async () => {
  let tick!: () => void;
  let attempts = 0;
  let expired = true;
  const fs: DailyLoggerFileSystem = {
    async mkdir() {}, async chmod() {}, async appendFile() {},
    async readdir() { return expired ? ["server-info-2024-12-01.log"] : []; },
    async unlink() {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error("temporarily denied"), { code: "EACCES" });
      expired = false;
    },
  };
  const logger = createDailyLogger({
    name: "server", directory: "/virtual", now: () => new Date(2025, 0, 1), fileSystem: fs, stderr: () => {},
    setIntervalFn: ((callback: () => void) => { tick = callback; return { unref() {} }; }) as unknown as typeof setInterval,
    clearIntervalFn: (() => {}) as typeof clearInterval,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  tick();
  await logger.close();
  assert.equal(attempts, 2);
  assert.equal(expired, false);
});

test("delayed writes cannot recreate expired files after a long stall", async () => {
  const directory = await tempDirectory();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let current = new Date(2025, 0, 1);
  let first = true;
  const actual = await import("node:fs/promises");
  const fs: DailyLoggerFileSystem = {
    mkdir: actual.mkdir, chmod: actual.chmod, readdir: actual.readdir, unlink: actual.unlink,
    async appendFile(path, data, options) {
      if (first) { first = false; entered(); await gate; }
      await actual.appendFile(path, data, options);
    },
  };
  const logger = createDailyLogger({ name: "server", directory, now: () => current, fileSystem: fs });
  try {
    logger.log("in-flight event");
    await started;
    logger.log("queued event");
    current = new Date(2025, 0, 12);
    release();
    await logger.close();
    assert.deepEqual(await readdir(directory), ["server-info-2025-01-12.log"]);
    assert.match(await readFile(join(directory, "server-info-2025-01-12.log"), "utf8"), /delayed-date=2025-01-01 queued event/);
  } finally {
    release();
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("writes local-offset timestamps, restrictive permissions, and trims retention to seven dates", async () => {
  const directory = await tempDirectory();
  try {
    const now = new Date(2025, 4, 10, 13, 4, 5, 6);
    for (const date of ["2025-05-03", "2025-05-04", "2025-05-09", "2025-05-10", "2025-05-11", "not-a-date"]) {
      await writeFile(join(directory, `remote-info-${date}.log`), "old\n");
    }
    await writeFile(join(directory, "server-info-2000-01-01.log"), "other logger\n");
    await writeFile(join(directory, "remote-info-2025-05-01.log.bak"), "unrelated\n");

    const logger = createDailyLogger({ name: "remote", directory, now: () => now });
    logger.log("hello");
    await logger.close();

    const names = await readdir(directory);
    assert(names.includes("remote-info-2025-05-04.log"));
    assert(names.includes("remote-info-2025-05-10.log"));
    assert(!names.includes("remote-info-2025-05-03.log"));
    assert(names.includes("remote-info-2025-05-11.log"));
    assert(names.includes("server-info-2000-01-01.log"));
    assert(names.includes("remote-info-2025-05-01.log.bak"));
    assert.equal(await readFile(join(directory, "remote-info-2025-05-10.log"), "utf8"), `old\n${formatLocalTimestamp(now)} hello\n`);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, "remote-info-2025-05-10.log"))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("date rollover prunes against the new local date and uses the matching filename", async () => {
  const directory = await tempDirectory();
  try {
    let current = new Date(2025, 0, 1, 23, 59);
    const logger = createDailyLogger({ name: "server", directory, now: () => current });
    logger.log("before midnight");
    await logger.close();
    // A logger is intentionally closed after its lifecycle; a separate instance observes the new date.
    current = new Date(2025, 0, 2, 0, 1);
    const next = createDailyLogger({ name: "server", directory, now: () => current });
    next.log("after midnight");
    await next.close();
    assert.match(await readFile(join(directory, "server-info-2025-01-01.log"), "utf8"), /before midnight/);
    assert.match(await readFile(join(directory, "server-info-2025-01-02.log"), "utf8"), /after midnight/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers after a file error and announces the lost-entry gap", async () => {
  const messages: string[] = [];
  const contents = new Map<string, string>();
  let fail = true;
  const fs: DailyLoggerFileSystem = {
    async mkdir() {},
    async chmod() {},
    async readdir() { return []; },
    async unlink() {},
    async appendFile(path, data) {
      if (fail) {
        fail = false;
        throw new Error("disk unavailable");
      }
      contents.set(path, (contents.get(path) ?? "") + data);
    },
  };
  const logger = createDailyLogger({
    name: "remote",
    directory: "/virtual",
    now: () => new Date(2025, 0, 1),
    fileSystem: fs,
    stderr: message => messages.push(message),
  });
  logger.log("lost to failure");
  logger.log("survives recovery");
  await logger.close();
  assert.equal([...contents.values()].join(""), `${formatLocalTimestamp(new Date(2025, 0, 1))} GAP: lost 1 log entry (filesystem failures: 1, queue overflow: 0)\n${formatLocalTimestamp(new Date(2025, 0, 1))} survives recovery\n`);
  assert(messages.some(message => message.includes("unable to write log entry")));
  assert(messages.some(message => message.includes("logging recovered")));
});

test("records overflow after a stalled final write without another application event", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const output: string[] = [];
  let first = true;
  const fs: DailyLoggerFileSystem = {
    async mkdir() {}, async chmod() {}, async readdir() { return []; }, async unlink() {},
    async appendFile(_path, data) {
      if (first) { first = false; entered(); await gate; }
      output.push(data);
    },
  };
  const logger = createDailyLogger({ name: "server", directory: "/virtual", fileSystem: fs, maxPending: 1, stderr: () => {} });
  logger.log("stalled");
  await started;
  logger.log("dropped");
  release();
  await logger.close();
  assert.match(output.join(""), /GAP: lost 1 log entry .*queue overflow: 1/);
});

test("retries a filesystem gap while idle without counting retry notices as lost events", async () => {
  let tick!: () => void;
  let writable = false;
  const output: string[] = [];
  const fs: DailyLoggerFileSystem = {
    async mkdir() {}, async chmod() {}, async readdir() { return []; }, async unlink() {},
    async appendFile(_path, data) { if (!writable) throw new Error("disk full"); output.push(data); },
  };
  const logger = createDailyLogger({
    name: "server", directory: "/virtual", fileSystem: fs, stderr: () => {},
    setIntervalFn: ((callback: () => void) => { tick = callback; return { unref() {} }; }) as unknown as typeof setInterval,
    clearIntervalFn: (() => {}) as typeof clearInterval,
  });
  logger.log("lost application event");
  await new Promise(resolve => setImmediate(resolve));
  tick();
  await new Promise(resolve => setImmediate(resolve));
  writable = true;
  tick();
  await logger.close();
  assert.match(output.join(""), /GAP: lost 1 log entry .*filesystem failures: 1/);
});

test("records overload gaps in the daily file and reports overload while writes are stalled", async () => {
  const messages: string[] = [];
  const contents = new Map<string, string>();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const fs: DailyLoggerFileSystem = {
    async mkdir() {},
    async chmod() {},
    async readdir() { return []; },
    async unlink() {},
    async appendFile(path, data) {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      contents.set(path, (contents.get(path) ?? "") + data);
    },
  };
  const date = new Date(2025, 0, 1);
  const logger = createDailyLogger({
    name: "server",
    directory: "/virtual",
    now: () => date,
    maxPending: 2,
    fileSystem: fs,
    stderr: message => messages.push(message),
  });
  logger.log("blocked");
  await started;
  logger.log("queued");
  logger.log("overflow one");
  logger.log("overflow two");
  assert(messages.some(message => message.includes("dropped 1 log entry")));
  release();
  await logger.close();
  const output = [...contents.values()].join("");
  assert.match(output, /GAP: lost 2 log entries \(filesystem failures: 0, queue overflow: 2\)/);
  assert.match(output, /queued\n/);
});

test("retention follows the current date while draining old entries and preserves future files", async () => {
  const directory = await tempDirectory();
  try {
    const currentFile = "server-info-2025-01-03.log";
    const futureFile = "server-info-2025-01-10.log";
    const oldFile = "server-info-2024-12-26.log";
    await writeFile(join(directory, currentFile), "today\n");
    await writeFile(join(directory, futureFile), "future\n");
    await writeFile(join(directory, oldFile), "old\n");
    let now = new Date(2025, 0, 2);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fs: DailyLoggerFileSystem = {
      async mkdir() { entered(); await gate; },
      async chmod(path, mode) { await import("node:fs/promises").then(fs => fs.chmod(path, mode)); },
      async readdir(path) { return readdir(path); },
      async unlink(path) { await import("node:fs/promises").then(fs => fs.unlink(path)); },
      async appendFile(path, data, options) { await import("node:fs/promises").then(fs => fs.appendFile(path, data, options)); },
    };
    const logger = createDailyLogger({ name: "server", directory, now: () => now, fileSystem: fs });
    await started;
    logger.log("yesterday");
    now = new Date(2025, 0, 3);
    release();
    await logger.close();
    const names = await readdir(directory);
    assert(names.includes(currentFile));
    assert(names.includes(futureFile));
    assert(!names.includes(oldFile));
    assert.match(await readFile(join(directory, "server-info-2025-01-02.log"), "utf8"), /yesterday/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("announces recovery after startup preparation fails, then succeeds", async () => {
  const messages: string[] = [];
  const contents: string[] = [];
  let fail = true;
  const fs: DailyLoggerFileSystem = {
    async mkdir() {},
    async chmod() {},
    async readdir() {
      if (fail) {
        fail = false;
        throw new Error("directory unavailable");
      }
      return [];
    },
    async unlink() {},
    async appendFile(_path, data) { contents.push(data); },
  };
  const logger = createDailyLogger({
    name: "remote",
    directory: "/virtual",
    now: () => new Date(2025, 0, 1),
    fileSystem: fs,
    stderr: message => messages.push(message),
  });
  logger.log("after preparation recovery");
  await logger.close();
  assert(messages.some(message => message.includes("unable to prepare log directory")));
  assert(messages.some(message => message.includes("logging recovered after a directory or retention preparation failure")));
  assert(contents.join("").includes("after preparation recovery"));
});

test("close waits for startup preparation within its timeout", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fs: DailyLoggerFileSystem = {
    async mkdir() { entered(); await gate; },
    async chmod() {},
    async readdir() { return []; },
    async unlink() {},
    async appendFile() {},
  };
  const logger = createDailyLogger({ name: "remote", directory: "/virtual", fileSystem: fs });
  await started;
  let closed = false;
  const closing = logger.close(1_000).then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal(closed, true);
});

test("replaces controls and caps message length", async () => {
  const contents: string[] = [];
  const fs: DailyLoggerFileSystem = {
    async mkdir() {},
    async chmod() {},
    async readdir() { return []; },
    async unlink() {},
    async appendFile(_path, data) { contents.push(data); },
  };
  const logger = createDailyLogger({ name: "remote", directory: "/virtual", fileSystem: fs });
  logger.log(`one\r\ntwo\u0000${"x".repeat(9_000)}`);
  await logger.close();
  const line = contents.join("").split(" ").slice(1).join(" ").trimEnd();
  assert(!/[\r\n\u0000-\u001f\u007f-\u009f]/.test(line));
  assert.equal(line.length, 8_192);
});

test("bounds the queue, reports overload, and reports leftovers after a shutdown timeout", async () => {
  const messages: string[] = [];
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fs: DailyLoggerFileSystem = {
    async mkdir() {},
    async chmod() {},
    async readdir() { return []; },
    async unlink() {},
    async appendFile() { entered(); await gate; },
  };
  const logger = createDailyLogger({
    name: "server",
    directory: "/virtual",
    now: () => new Date(2025, 0, 1),
    maxPending: 1,
    fileSystem: fs,
    stderr: message => messages.push(message),
  });
  logger.log("blocking write");
  await started;
  logger.log("overflow");
  const closing = logger.close(0);
  await closing;
  assert(messages.some(message => message.includes("shutdown timed out")));
  assert(messages.some(message => message.includes("dropped 1 log entry")));
  release();
});
