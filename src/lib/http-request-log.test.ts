import test from "node:test";
import assert from "node:assert/strict";
import { createHttpRequestLog } from "./http-request-log.js";

test("HTTP request lines retain correlation and pathname but omit query strings", () => {
  const log = createHttpRequestLog({ id: "request-1", method: "GET", pathname: "/api/v1/dashboard", startedAt: 100 });
  assert.equal(log.arrival, "http arrival id=request-1 method=GET path=/api/v1/dashboard");
  const completion = log.completion(200, 12.25, false);
  assert.match(completion, /status=200 latency=12\.3ms/);
  assert.doesNotMatch(completion, /\?/);
  assert.match(log.completion(499, 4, true), /aborted=true/);
});
