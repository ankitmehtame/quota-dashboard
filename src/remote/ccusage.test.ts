import test from "node:test";
import assert from "node:assert/strict";

import { ccusageArgs, rollingDateRange, runCcusage } from "./ccusage.js";

test("uses daily JSON by-agent with the configured date range and timezone", () => {
  assert.deepEqual(ccusageArgs({ from: "2025-09-09", to: "2026-09-13", timezone: "Asia/Singapore" }), [
    "daily", "--json", "--by-agent", "--since", "2025-09-09", "--until", "2026-09-13", "--timezone", "Asia/Singapore",
  ]);
});

test("calculates an inclusive rolling 370-day range in the configured timezone", () => {
  assert.deepEqual(rollingDateRange("Asia/Singapore", new Date("2026-09-13T00:30:00.000Z")), {
    from: "2025-09-09",
    to: "2026-09-13",
    timezone: "Asia/Singapore",
  });
});

test("parses stdout without modifying the JSON document", async () => {
  const stdout = '{"daily":[{"date":"2026-09-13","newField":[1,null,false]}],"metadata":{"x":"y"}}';
  const result = await runCcusage({
    binary: "ccusage-test",
    range: { from: "2025-09-09", to: "2026-09-13", timezone: "UTC" },
    runner: (_file, args, options, callback) => {
      assert.deepEqual(args, ["daily", "--json", "--by-agent", "--since", "2025-09-09", "--until", "2026-09-13", "--timezone", "UTC"]);
      assert.equal(options.timeout, 30_000);
      assert.equal(options.maxBuffer, 32 * 1024 * 1024);
      callback(null, stdout, "");
    },
  });
  assert.deepEqual(result.document, JSON.parse(stdout));
});
