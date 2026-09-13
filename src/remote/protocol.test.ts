import test from "node:test";
import assert from "node:assert/strict";

import {
  makeErrorMessage,
  makeMqttTopics,
  makeStatusMessage,
  makeUsageSnapshot,
  sanitizeHostId,
} from "./protocol.js";

const metadata = {
  publisherId: "publisher-1",
  connectionId: "connection-1",
  sequence: 1,
  hostId: "workstation",
  generatedAt: "2026-09-13T00:00:00.000Z",
  timezone: "Asia/Singapore",
  range: { from: "2025-09-09", to: "2026-09-13" },
};

test("keeps the parsed ccusage value under data without changing it", () => {
  const data = { daily: [{ date: "2026-09-13", extra: [null, false, "x"] }], unknownField: { value: 7 } };
  const snapshot = makeUsageSnapshot(metadata, data);
  assert.strictEqual(snapshot.data, data);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)).data, data);
  assert.equal(snapshot.schemaVersion, 1);
});

test("builds the three host topics and sanitizes topic injection", () => {
  assert.deepEqual(makeMqttTopics(undefined, "bad/host+#"), {
    usage: "quota-dashboard/v1/hosts/bad-host/usage",
    status: "quota-dashboard/v1/hosts/bad-host/status",
    error: "quota-dashboard/v1/hosts/bad-host/error",
  });
});

test("sanitizes empty and traversal-like host IDs", () => {
  assert.equal(sanitizeHostId("../+/"), "host");
  assert.equal(sanitizeHostId("my machine"), "my-machine");
});

test("status and error messages share the metadata envelope", () => {
  assert.equal(makeStatusMessage(metadata, "ok").status, "ok");
  assert.equal(makeErrorMessage(metadata, "ccusage failed").error, "ccusage failed");
});
