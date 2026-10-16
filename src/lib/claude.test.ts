import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchClaude, parseClaudeQuota, parseRetryAfter, resolveClaudeCredentials } from "./providers.js";

const now = Date.parse("2026-10-16T12:00:00Z");

test("Claude windows preserve fractions, real zero, model order, durations, and microsecond reset times", () => {
  const windows = parseClaudeQuota({ seven_day_opus: { utilization: 101 }, seven_day_sonnet: { utilization: 7.25 },
    five_hour: { utilization: 0, resets_at: "2026-04-11T07:00:00.528743+00:00" }, seven_day: { utilization: 33.123 },
    limits: [{ unknown: "not a verified schema" }], extra_usage: { utilization: 100 } });
  assert.deepEqual(windows.map((w) => [w.name, w.usedPercent, w.windowSeconds]), [
    ["5-hour", 0, 18_000], ["Weekly", 33.123, 604_800], ["Sonnet (Weekly)", 7.25, 604_800], ["Opus (Weekly)", 100, 604_800] ]);
  assert.equal(windows[0].resetAt, "2026-04-11T07:00:00.528Z");
  assert.equal(windows[0].windowEnd, windows[0].resetAt);
  assert.equal(windows[0].windowStart, "2026-04-11T02:00:00.528Z");
  assert.equal(windows[1].windowStart, null);
  assert.equal(windows[1].usedValue, null);
  assert.equal(windows[1].limitValue, null);
  assert.equal(parseClaudeQuota({ seven_day: { utilization: 12, resets_at: "2026-10-20T00:00:00Z" } })[0].windowStart, "2026-10-13T00:00:00.000Z");
});

test("Claude null, absent, and malformed data never becomes zero", () => {
  for (const payload of [null, [], {}, { five_hour: null }, { five_hour: [] }, { limits: [] }]) assert.deepEqual(parseClaudeQuota(payload), []);
  for (const utilization of [null, undefined, "", "2", false, NaN, Infinity]) {
    const [window] = parseClaudeQuota({ five_hour: { utilization, resets_at: "2026-10-16T18:00:00Z" } });
    assert.equal(window.usedPercent, null);
  }
  for (const resets_at of [null, 123, "garbage", "2026-02-30T00:00:00Z", "2026-10-16", "2026-10-16T00:00:00", "2026-10-16T24:00:00Z"]) {
    const [window] = parseClaudeQuota({ five_hour: { utilization: 15.5, resets_at } });
    assert.equal(window.usedPercent, 15.5);
    assert.equal(window.resetAt, null);
    assert.equal(window.windowStart, null);
    assert.equal(window.windowEnd, null);
  }
});

test("Claude credential precedence, source identity, and file rotation are read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-claude-"));
  try {
    const configDir = join(root, "alternate");
    await mkdir(configDir);
    await mkdir(join(root, ".claude"));
    const path = join(root, "explicit.json");
    const original = JSON.stringify({ claudeAiOauth: { accessToken: "file-token", refreshToken: "never-use-refresh" } });
    await writeFile(path, original);
    await writeFile(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { access_token: "directory-token" } }));
    await writeFile(join(root, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "default-token" } }));
    assert.equal((await resolveClaudeCredentials({ CLAUDE_OAUTH_TOKEN: " direct-token ", CLAUDE_AUTH_PATH: "/not-present" }, now, root)).accessToken, "direct-token");
    assert.equal((await resolveClaudeCredentials({ CLAUDE_AUTH_PATH: path, CLAUDE_CONFIG_DIR: configDir }, now, root)).accessToken, "file-token");
    assert.equal((await resolveClaudeCredentials({ CLAUDE_CONFIG_DIR: configDir }, now, root)).accessToken, "directory-token");
    assert.equal((await resolveClaudeCredentials({}, now, root)).accessToken, "default-token");
    for (const env of [{ CLAUDE_AUTH_PATH: "/not-present", CLAUDE_CONFIG_DIR: configDir }, { CLAUDE_AUTH_PATH: "" }, { CLAUDE_CONFIG_DIR: "" }, { CLAUDE_OAUTH_TOKEN: "bad\ntoken", CLAUDE_AUTH_PATH: path }]) {
      const result = await resolveClaudeCredentials(env, now, root);
      assert.equal(result.accessToken, undefined);
      assert.equal(result.errorKind, "configuration");
      assert.doesNotMatch(result.error!, /not-present|bad\ntoken/);
    }
    const first = await resolveClaudeCredentials({ CLAUDE_AUTH_PATH: path }, now, root);
    assert.equal(await readFile(path, "utf8"), original);
    await writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: "rotated-token" } }));
    const rotated = await resolveClaudeCredentials({ CLAUDE_AUTH_PATH: path }, now, root);
    assert.notEqual(first.identity, rotated.identity);
    await writeFile(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "rotated-token" } }));
    assert.notEqual(rotated.identity, (await resolveClaudeCredentials({ CLAUDE_CONFIG_DIR: configDir }, now, root)).identity);
    const sameFile = join(configDir, ".credentials.json");
    assert.notEqual((await resolveClaudeCredentials({ CLAUDE_AUTH_PATH: sameFile }, now, root)).identity,
      (await resolveClaudeCredentials({ CLAUDE_CONFIG_DIR: configDir }, now, root)).identity);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Claude metadata aliases, scopes, and expiry validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-claude-metadata-"));
  const path = join(root, "credentials.json");
  const resolve = async (oauth: unknown) => {
    await writeFile(path, JSON.stringify({ claudeAiOauth: oauth }));
    return resolveClaudeCredentials({ CLAUDE_AUTH_PATH: path }, now, root);
  };
  try {
    for (const expiresAt of [now + 60_000, (now + 60_000) / 1000, new Date(now + 60_000).toISOString()]) {
      for (const scopes of [["user:inference", "user:profile"], "user:inference user:profile"]) {
        assert.equal((await resolve({ accessToken: "token", expiresAt, scopes })).accessToken, "token");
        assert.equal((await resolve({ access_token: "token", expires_at: expiresAt, scopes })).accessToken, "token");
      }
    }
    assert.equal((await resolve({ accessToken: "first", access_token: "second", expiresAt: now + 1000, expires_at: 0 })).accessToken, "first");
    assert.equal((await resolve({ accessToken: "token" })).accessToken, "token");
    for (const expiresAt of [null, "", "garbage", "2026-02-30T00:00:00Z", 0, -1, 1e30, {}, "1900000000"]) {
      assert.equal((await resolve({ accessToken: "token", expiresAt })).errorKind, "configuration");
    }
    for (const expiresAt of [now, (now - 1000) / 1000, "2026-10-15T12:00:00Z"]) {
      const expired = await resolve({ accessToken: "token", expiresAt });
      assert.equal(expired.errorKind, "authentication");
      assert.match(expired.error!, /expired/);
    }
    for (const scopes of [null, {}, 1, [1], ["user:profile", null]]) {
      assert.equal((await resolve({ accessToken: "token", scopes })).errorKind, "configuration");
    }
    for (const scopes of [[], "", ["user:inference"], "user:inference"]) {
      const missingScope = await resolve({ accessToken: "token", scopes });
      assert.equal(missingScope.errorKind, "authentication");
      assert.match(missingScope.error!, /subscription.*inference-only/);
    }
    await writeFile(path, "not JSON");
    assert.equal((await resolveClaudeCredentials({ CLAUDE_AUTH_PATH: path }, now, root)).errorKind, "configuration");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Retry-After has strict HTTP syntax and bounded timestamp arithmetic", () => {
  assert.equal(parseRetryAfter(" 120 ", now), now + 120_000);
  assert.equal(parseRetryAfter("0", now), now);
  assert.equal(parseRetryAfter("Fri, 16 Oct 2026 13:00:00 GMT", now), now + 3_600_000);
  assert.equal(parseRetryAfter("Fri, 16 Oct 2026 11:00:00 GMT", now), now - 3_600_000);
  for (const value of [null, "", " ", "-1", "+1", "1.5", "1e3", "0x10", "Infinity", "9999999999999999999999", "8640000000000",
    "2026-10-16T13:00:00Z", "Tue, 30 Feb 2027 13:00:00 GMT", "Sat, 16 Oct 2026 13:00:00 GMT", "garbage"]) {
    assert.equal(parseRetryAfter(value, now), undefined, String(value));
  }
});

test("Claude requests use OAuth headers and safe structured failures without exposing secrets", async (t) => {
  const secret = "FAKE_CLAUDE_SECRET";
  const credentials = { configured: true, identity: "private-fingerprint", accessToken: secret };
  let status = 200;
  let body = JSON.stringify({ five_hour: { utilization: 0 } });
  let challenge = false;
  let calls = 0;
  let throwNetwork = false;
  let interruptBody = false;
  const originalAgent = process.env.CLAUDE_USER_AGENT;
  delete process.env.CLAUDE_USER_AGENT;
  t.after(() => { if (originalAgent === undefined) delete process.env.CLAUDE_USER_AGENT; else process.env.CLAUDE_USER_AGENT = originalAgent; });
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(String(url), "https://api.anthropic.com/api/oauth/usage");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${secret}`);
    assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("user-agent"), process.env.CLAUDE_USER_AGENT ?? "claude-code/2.1.69");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    if (throwNetwork) throw new Error(secret);
    if (interruptBody) {
      const response = new Response("{}", { status: 200 });
      Object.defineProperty(response, "json", { value: async () => { throw new TypeError(secret); } });
      return response;
    }
    return new Response(body, { status, headers: { "retry-after": "7200", ...(challenge ? { "cf-mitigated": "challenge" } : {}) } });
  });
  assert.equal((await fetchClaude(credentials)).windows[0].usedPercent, 0);
  process.env.CLAUDE_USER_AGENT = "claude-code/test";
  assert.equal((await fetchClaude(credentials)).status, "ok");
  for (const [code, kind] of [[401, "authentication"], [403, "authentication"], [429, "rate_limit"], [500, "server"], [502, "server"], [400, "response"]] as const) {
    status = code;
    body = secret;
    const result = await fetchClaude(credentials);
    assert.equal(result.errorKind, kind);
    assert.ok(result.cooldownUntil! > Date.now() + 7_000_000);
    assert.doesNotMatch(JSON.stringify(result), /FAKE_CLAUDE_SECRET|private-fingerprint|authorization/i);
  }
  status = 403; challenge = true;
  const blocked = await fetchClaude(credentials);
  assert.match(blocked.error!, /Cloudflare/);
  assert.doesNotMatch(blocked.error!, /expired|Sign in/);
  status = 200; challenge = false;
  for (const badBody of ["not JSON", "{}", '{"five_hour":{"utilization":null}}', '{"limits":[]}']) {
    body = badBody;
    assert.equal((await fetchClaude(credentials)).errorKind, "response");
  }
  interruptBody = true;
  assert.equal((await fetchClaude(credentials)).errorKind, "network");
  interruptBody = false;
  throwNetwork = true;
  const failed = await fetchClaude(credentials);
  assert.equal(failed.errorKind, "network");
  assert.doesNotMatch(JSON.stringify(failed), /FAKE_CLAUDE_SECRET/);
  const before = calls;
  for (const userAgent of ["", "bad\nagent", "é"]) {
    process.env.CLAUDE_USER_AGENT = userAgent;
    assert.equal((await fetchClaude(credentials)).errorKind, "configuration");
  }
  assert.equal((await fetchClaude({ configured: false, identity: "invalid", error: "Missing credentials", errorKind: "configuration" })).errorKind, "configuration");
  assert.equal(calls, before);
});
