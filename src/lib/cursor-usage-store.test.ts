import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CursorUsageEvent } from "./cursor-usage.js";
import { CursorUsageStore } from "./cursor-usage-store.js";

const event = (id: string, time: string, inputTokens = 1): CursorUsageEvent => ({ id, time, model: "m", usageType: "included", inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

test("keys events by billing ID across hosts and reports new, updated and moved rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-store-"));
  try {
    const store = new CursorUsageStore(join(root, "cursor-usage"));
    assert.equal(await store.hasEvents(), false);
    assert.deepEqual(await store.upsert([event("a", "2026-11-27T10:00:00.000Z"), event("b", "2026-11-27T11:00:00.000Z")], "host-1"), { added: 2, updated: 0, moved: 0 });
    // Same date range, different rows, different machine: both machines keep their rows.
    assert.deepEqual(await store.upsert([event("c", "2026-11-27T10:30:00.000Z")], "host-2"), { added: 1, updated: 0, moved: 0 });
    // Overlapping rows: the same host updates, another host takes them over. Nothing is duplicated.
    assert.deepEqual(await store.upsert([event("a", "2026-11-27T10:00:00.000Z", 5)], "host-1"), { added: 0, updated: 1, moved: 0 });
    assert.deepEqual(await store.upsert([event("b", "2026-11-27T11:00:00.000Z")], "host-2"), { added: 0, updated: 0, moved: 1 });
    const events = await store.read("2026-11-27", "2026-11-27");
    assert.deepEqual(events.map((item) => [item.id, item.hostId, item.inputTokens]), [["a", "host-1", 5], ["c", "host-2", 1], ["b", "host-2", 1]]);
    assert.equal(await store.hasEvents(), true);
    assert.equal((await stat(join(root, "cursor-usage"))).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, "cursor-usage", "2026-11.json"))).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("serializes concurrent uploads, shards by UTC month and pads reads for timezones", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-store-"));
  try {
    const store = new CursorUsageStore(join(root, "data"));
    const batches = Array.from({ length: 6 }, (_, index) => [event(`row-${index}`, "2026-11-30T20:00:00.000Z"), event(`next-${index}`, "2026-12-01T01:00:00.000Z")]);
    const results = await Promise.all(batches.map((batch, index) => store.upsert(batch, `host-${index}`)));
    assert.ok(results.every((result) => result.added === 2));
    assert.deepEqual((await readdir(join(root, "data"))).sort(), ["2026-11.json", "2026-12.json"]);
    // A December 1 local date can include late November UTC events.
    assert.equal((await store.read("2026-12-01", "2026-12-01")).length, 12);
    assert.equal((await store.read("2026-10-01", "2026-10-15")).length, 0);
    await writeFile(join(root, "data", "2026-12.json"), "{broken");
    await assert.rejects(store.read("2026-12-01", "2026-12-01"));
    assert.doesNotMatch(await readFile(join(root, "data", "2026-11.json"), "utf8"), /email|principal/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
