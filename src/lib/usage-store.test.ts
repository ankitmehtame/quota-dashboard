import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FilesystemUsageStore, normalizeUsageToolId, type RawUsageContainer } from "./usage-store.js";

async function withStore(run: (store: FilesystemUsageStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "quota-dashboard-store-"));
  try {
    await run(new FilesystemUsageStore({ dataRoot: root, now: () => new Date("2026-09-18T12:00:00.000Z") }), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function container(data: unknown, overrides: Partial<RawUsageContainer> = {}): RawUsageContainer {
  return {
    schemaVersion: 1,
    hostId: "my-laptop",
    date: "2026-09-18",
    timezone: "UTC",
    category: "daily",
    runId: "run-1",
    generatedAt: "2026-09-18T12:00:00.000Z",
    data,
    ...overrides,
  };
}

function row(agent: string, cost: number, model = "model-a") {
  return { date: "2026-09-18", agent, modelBreakdowns: [{ modelName: model, inputTokens: 1, outputTokens: 2, cost }] };
}

test("normalizes tool IDs and rejects empty or traversal values", () => {
  assert.equal(normalizeUsageToolId(" Open Code "), "open-code");
  assert.throws(() => normalizeUsageToolId(""), /non-empty/);
  assert.throws(() => normalizeUsageToolId("../outside"), /Unsafe/);
  assert.throws(() => normalizeUsageToolId("a/b"), /Unsafe/);
  assert.throws(() => normalizeUsageToolId("raw"), /Reserved/);
});

test("stores the raw document exactly and derives normalized tool files", async () => {
  await withStore(async (store, root) => {
    const data = { daily: [row("Codex", 1)], metadata: { keep: [null, false, { value: "as-is" }] } };
    await store.ingest(container(data, { ccusageVersion: "ccusage 20" }));

    const directory = join(root, "my-laptop", "2026", "09", "18");
    const raw = JSON.parse(await readFile(join(directory, "raw.json"), "utf8"));
    assert.deepEqual(raw.data, data);
    assert.deepEqual(raw, container(data, { ccusageVersion: "ccusage 20" }));

    const normalized = await store.readNormalized("my-laptop", "2026-09-18", "2026-09-18");
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].toolId, "codex");
    assert.equal(normalized[0].runId, "run-1");
    assert.equal(normalized[0].rawFile, "raw.json");
    assert.equal(normalized[0].records[0].costUsd, 1);
  });
});

test("lists hosts and reads normalized records across the configured range", async () => {
  await withStore(async (store) => {
    await store.ingest(container({ daily: [row("codex", 1)] }, { hostId: "my-laptop", date: "2026-09-18" }));
    await store.ingest(container({ daily: [row("opencode", 2)] }, { hostId: "remote-box", date: "2026-09-18" }));
    assert.deepEqual(await store.listHostIds(), ["my-laptop", "remote-box"]);
    const records = await store.readAllRecords("2026-09-17", "2026-09-18");
    assert.deepEqual(records.map((record) => [record.hostId, record.provider]), [["my-laptop", "codex"], ["remote-box", "opencode"]]);
  });
});

test("replaces present tools, retains missing tools, and archives a shrinking raw set", async () => {
  await withStore(async (store, root) => {
    await store.ingest(container({ daily: [row("codex", 1), row("opencode", 2)] }));
    await store.ingest(container({ daily: [row("codex", 3, "new-model")] }, { runId: "run-2" }));

    const records = await store.readRecords("my-laptop", "2026-09-18", "2026-09-18");
    assert.deepEqual(records.map((record) => [record.provider, record.costUsd]), [["codex", 3], ["opencode", 2]]);
    const names = await readdir(join(root, "my-laptop", "2026", "09", "18"));
    assert.equal(names.filter((name) => /^raw\..+\.json$/.test(name)).length, 1);
    const retained = JSON.parse(await readFile(join(root, "my-laptop", "2026", "09", "18", "opencode.json"), "utf8"));
    assert.equal(retained.runId, "run-1");
    assert.match(retained.rawFile, /^raw\..+\.json$/);
  });
});

test("archives and retargets retained provenance when an equal-size tool set changes", async () => {
  await withStore(async (store, root) => {
    await store.ingest(container({ daily: [row("codex", 1), row("opencode", 2)] }));
    await store.ingest(container({ daily: [row("codex", 3), row("hermes", 4)] }, { runId: "run-2" }));

    const directory = join(root, "my-laptop", "2026", "09", "18");
    const opencode = JSON.parse(await readFile(join(directory, "opencode.json"), "utf8"));
    const codex = JSON.parse(await readFile(join(directory, "codex.json"), "utf8"));
    const hermes = JSON.parse(await readFile(join(directory, "hermes.json"), "utf8"));
    assert.match(opencode.rawFile, /^raw\..+\.json$/);
    assert.equal(opencode.runId, "run-1");
    assert.equal(opencode.records[0].costUsd, 2);
    assert.equal(codex.rawFile, "raw.json");
    assert.equal(hermes.rawFile, "raw.json");
    assert.equal((await readdir(directory)).filter((name) => /^raw\..+\.json$/.test(name)).length, 1);
  });
});

test("does not archive when only values inside a present tool change, and rotates backups", async () => {
  await withStore(async (store, root) => {
    await store.ingest(container({ daily: [row("codex", 1)] }));
    await store.ingest(container({ daily: [row("codex", 2)] }, { runId: "run-2" }));
    let names = await readdir(join(root, "my-laptop", "2026", "09", "18"));
    assert.equal(names.filter((name) => /^raw\..+\.json$/.test(name)).length, 0);

    await store.ingest(container({ daily: [row("codex", 5), row("opencode", 6)] }, { runId: "run-3" }));
    await store.ingest(container({ daily: [row("codex", 7)] }, { runId: "run-4" }));
    await store.ingest(container({ daily: [row("codex", 8), row("opencode", 9)] }, { runId: "run-5" }));
    await store.ingest(container({ daily: [row("codex", 10)] }, { runId: "run-6" }));
    names = await readdir(join(root, "my-laptop", "2026", "09", "18"));
    assert.equal(names.filter((name) => /^raw\..+\.json$/.test(name)).length, 2);
    await store.ingest(container({ daily: [row("codex", 11), row("opencode", 12)] }, { runId: "run-7" }));
    await store.ingest(container({ daily: [row("codex", 13)] }, { runId: "run-8" }));
    names = await readdir(join(root, "my-laptop", "2026", "09", "18"));
    assert.equal(names.filter((name) => /^raw\..+\.json$/.test(name)).length, 3);
  });
});

test("skips corrupted normalized files while reading the remaining records", async () => {
  await withStore(async (store, root) => {
    await store.ingest(container({ daily: [row("codex", 1)] }));
    await writeFile(join(root, "my-laptop", "2026", "09", "18", "broken.json"), "not json");
    const records = await store.readRecords("my-laptop", "2026-09-18", "2026-09-18");
    assert.deepEqual(records.map((record) => record.costUsd), [1]);
  });
});

test("a present zero-usage result replaces the old normalized record", async () => {
  await withStore(async (store) => {
    await store.ingest(container({ daily: [row("codex", 4)] }));
    await store.ingest(container({ daily: [{ date: "2026-09-18", agent: "codex", totalCost: 0 }] }, { runId: "zero" }));
    const records = await store.readRecords("my-laptop", "2026-09-18", "2026-09-18");
    assert.equal(records.length, 1);
    assert.equal(records[0].costUsd, 0);
    assert.equal(records[0].model, "unknown");
  });
});

test("keeps an explicit tool with an empty breakdown present", async () => {
  await withStore(async (store) => {
    await store.ingest(container({ daily: [row("codex", 4)] }));
    await store.ingest(container({ daily: [{ date: "2026-09-18", agent: "codex", modelBreakdowns: [] }] }, { runId: "empty-breakdown" }));
    const normalized = await store.readNormalized("my-laptop", "2026-09-18", "2026-09-18");
    assert.deepEqual(normalized.map((file) => [file.toolId, file.records]), [["codex", []]]);
  });
});

test("missing messages and dates do not touch the store, while unsafe tools fail before writing", async () => {
  await withStore(async (store, root) => {
    assert.deepEqual(await store.ingest(null), { written: false });
    assert.deepEqual(await store.ingest({} as RawUsageContainer), { written: false });
    await assert.rejects(store.ingest(container({ daily: [row("../escape", 1)] })), /Unsafe/);
    assert.deepEqual(await readdir(root), []);
  });
});

test("rejects records outside the container date before writing", async () => {
  await withStore(async (store, root) => {
    await assert.rejects(
      store.ingest(container({ daily: [{ ...row("codex", 1), date: "2026-09-17" }] })),
      /must all use container date/,
    );
    assert.deepEqual(await readdir(root), []);
  });
});

test("reads only normalized files across an inclusive date range", async () => {
  await withStore(async (store, root) => {
    await store.ingest(container({ daily: [row("codex", 1)] }));
    await store.ingest(container({ daily: [{ ...row("codex", 2), date: "2026-09-19" }] }, { date: "2026-09-19", runId: "run-2" }));
    await writeFile(join(root, "my-laptop", "2026", "09", "18", "raw.json"), "not json");
    const records = await store.readRecords("my-laptop", "2026-09-18", "2026-09-19");
    assert.deepEqual(records.map((record) => record.costUsd), [1, 2]);
  });
});

test("creates private store files and directories", async () => {
  await withStore(async (store, root) => {
    await store.ingest(container({ daily: [row("codex", 1)] }));
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    const directory = join(root, "my-laptop", "2026", "09", "18");
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, "raw.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "codex.json"))).mode & 0o777, 0o600);
    await chmod(root, 0o700);
  });
});
