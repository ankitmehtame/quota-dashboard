import test from "node:test";
import assert from "node:assert/strict";
import { aggregateUsageSeverity, offlineUsageWarning } from "./usage-health.js";

const offline = {
  local: false, brokerConnected: true, publisherStatus: "offline", error: null,
  included: true, generatedAt: "2025-01-01T00:00:00Z", today: "2026-01-02",
  now: Date.parse("2026-01-02T12:00:00Z"),
  missingDates: ["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"],
};

test("offline trailing gaps have no duration limit and can cover the entire range", () => {
  assert.equal(offlineUsageWarning(offline), true);
  const dates = Array.from({ length: 370 }, (_, index) => {
    const date = new Date("2026-01-02T12:00:00Z");
    date.setUTCDate(date.getUTCDate() - index);
    return date.toISOString().slice(0, 10);
  });
  assert.equal(offlineUsageWarning({ ...offline, missingDates: dates, generatedAt: null }), true);
});

test("offline complete coverage remains a warning", () => {
  assert.equal(offlineUsageWarning({ ...offline, missingDates: [] }), true);
});

test("historical and interior gaps are not offline warnings", () => {
  for (const missingDates of [["2026-01-01"], ["2025-12-30", "2026-01-01", "2026-01-02"]]) {
    assert.equal(offlineUsageWarning({ ...offline, missingDates }), false);
  }
});

test("offline evidence and valid timestamps are required, real errors win", () => {
  for (const override of [
    { local: true }, { brokerConnected: false }, { publisherStatus: "online" },
    { publisherStatus: undefined }, { error: "Collection failed" }, { included: false },
    { generatedAt: "invalid" }, { generatedAt: "2026-01-02T12:02:00Z" },
  ]) assert.equal(offlineUsageWarning({ ...offline, ...override }), false);
});

test("aggregate errors take priority over warnings", () => {
  assert.equal(aggregateUsageSeverity([null, "warning"]), "warning");
  assert.equal(aggregateUsageSeverity(["warning", "error"]), "error");
  assert.equal(aggregateUsageSeverity([null]), null);
});
