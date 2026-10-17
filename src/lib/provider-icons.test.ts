import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createIconCache, ICON_REFRESH_MS, ICON_SOURCES, ICON_TIMEOUT_MS, MAX_ICON_BYTES, validateIconSvg } from "./provider-icons.js";

const bundledDirectory = fileURLToPath(new URL("../public/icons/", import.meta.url));
const svg = (color = "#abc") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="${color}" d="M0 0h10v10H0z"/></svg>`;
const response = (body = svg(), headers: Record<string, string> = {}) => new Response(body, { headers: { "content-type": "image/svg+xml", ...headers } });

test("bundled icons validate, retain artwork, and are copied with attribution", async () => {
  for (const id of Object.keys(ICON_SOURCES)) {
    const content = await readFile(join(bundledDirectory, `${id}.svg`), "utf8");
    assert.equal(validateIconSvg(content), content);
    assert.doesNotMatch(content, /currentColor/);
  }
  const antigravity = await readFile(join(bundledDirectory, "antigravity.svg"), "utf8");
  assert.match(antigravity, /<filter /);
  assert.match(antigravity, /<mask /);
  assert.match(antigravity, /fill="#3186FF"/);
  const ollama = await readFile(join(bundledDirectory, "ollama.svg"), "utf8");
  // Its white disc relies on implicit black artwork. A global light fill washes it out.
  assert.doesNotMatch(ollama.match(/^<svg[^>]*>/)![0], /fill=/);
  assert.match(await readFile(join(bundledDirectory, "ATTRIBUTION.md"), "utf8"), /creativecommons.org\/licenses\/by\/4.0/);
});

test("static SVG validation rejects executable content, external references, and malformed XML", () => {
  for (const body of [
    '<script>alert(1)</script>', '<foreignObject/>', '<image href="https://evil.test/a"/>', '<animate attributeName="href"/>',
    '<path onload="alert(1)"/>', '<use href="https://evil.test/a#b"/>', '<use href="data:image/svg+xml,x"/>',
    '<path fill="url(https://evil.test/a)"/>', '<path style="fill:url(https://evil.test/a)"/>',
    '<path style="fill:u\\72l(https://evil.test/a)"/>', '<path style="position:fixed"/>',
    '<use href="#missing"/>', '<path xmlns="http://www.w3.org/1999/xhtml"/>',
    '<path fill="url(&#104;ttps://evil.test/a)"/>', '<![CDATA[<script/>]]>',
    '<path id="x"/><path id="x"/>', '<use href="#x" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#x"/><path id="x"/>',
  ]) assert.throws(() => validateIconSvg(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`), body);
  for (const content of ["", "<html/>", '<!DOCTYPE svg [<!ENTITY x "unsafe">]>' + svg(), '<?xml-stylesheet href="https://evil.test"?>' + svg(), svg().slice(0, -6), " ".repeat(MAX_ICON_BYTES + 1)]) assert.throws(() => validateIconSvg(content));
  assert.match(validateIconSvg(svg("currentColor")), /fill="#f0f5f1"/);
  assert.doesNotMatch(validateIconSvg('<svg xmlns="http://www.w3.org/2000/svg"><circle fill="white" r="5"/><path d="M0 0h1"/></svg>').match(/^<svg[^>]*>/)![0], /fill=/);
});

test("refreshes coalesce, serve bundled immediately, persist updates, and revalidate daily", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "quota-icons-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 1_000_000;
  let calls = 0;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetching = new Promise<void>((resolve) => { started = resolve; });
  const fetchMock: typeof fetch = async (url, init) => {
    assert.ok(Object.values(ICON_SOURCES).includes(String(url) as typeof ICON_SOURCES.claude));
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    calls++;
    started();
    await gate;
    return response(svg(), { etag: '"upstream-v1"', "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT" });
  };
  const cache = createIconCache({ directory, bundledDirectory, now: () => now, fetch: fetchMock });
  const bundled = await cache.get("claude");
  const pending = cache.refresh();
  assert.equal(cache.refresh(), pending);
  await fetching;
  assert.equal((await cache.get("claude")).revision, bundled.revision);
  release();
  await pending;
  assert.equal(calls, 7);
  const updated = await cache.get("claude");
  assert.match(updated.svg, /#abc/);
  assert.notEqual(updated.revision, bundled.revision);
  await cache.refresh();
  assert.equal(calls, 7);
  const requests: Headers[] = [];
  const restarted = createIconCache({ directory, bundledDirectory, now: () => now, fetch: async (_, init) => {
    requests.push(new Headers(init?.headers));
    return new Response(null, { status: 304 });
  } });
  await restarted.refresh();
  assert.equal(requests.length, 0);
  assert.equal((await restarted.get("claude")).revision, updated.revision);
  now += ICON_REFRESH_MS;
  await restarted.refresh();
  assert.equal(requests.length, 7);
  assert.equal(requests[0].get("if-none-match"), '"upstream-v1"');
  assert.equal(requests[0].get("if-modified-since"), "Wed, 01 Jan 2025 00:00:00 GMT");
  assert.equal((await restarted.get("claude")).revision, updated.revision);
  assert.equal((await readdir(directory)).filter((name) => name.endsWith(".tmp")).length, 0);
});

test("failed and unsafe downloads preserve valid files and bound retries across restarts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "quota-icons-failures-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 1_000_000;
  let attempt = 0;
  const logs: string[] = [];
  const failures = [
    () => new Response("upstream secret", { status: 503 }),
    () => response('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
    () => response(" ".repeat(MAX_ICON_BYTES + 1)),
    () => response(svg(), { "content-length": String(MAX_ICON_BYTES + 1) }),
    () => new Response("html", { headers: { "content-type": "text/html" } }),
    () => { throw new Error("network failure secret"); },
    () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
  ];
  const cache = createIconCache({ directory, bundledDirectory, now: () => now, log: (message) => logs.push(message), fetch: async () => response(svg("#def")) });
  await cache.refresh();
  const good = await cache.get("claude");
  const failing = createIconCache({ directory, bundledDirectory, now: () => now, log: (message) => logs.push(message), fetch: async () => { attempt++; return failures[attempt - 1](); } });
  now += ICON_REFRESH_MS;
  await failing.refresh();
  assert.equal(attempt, 7);
  assert.equal((await failing.get("claude")).revision, good.revision);
  assert.equal(logs.length, 7);
  assert.doesNotMatch(logs.join("\n"), /secret|evil/);
  let retries = 0;
  const restarted = createIconCache({ directory, bundledDirectory, now: () => now, fetch: async () => { retries++; throw new Error("Should not retry"); } });
  assert.equal((await restarted.get("claude")).revision, good.revision);
  await restarted.refresh();
  assert.equal(retries, 0);
  assert.equal(JSON.parse(await readFile(join(directory, "claude.json"), "utf8")).attemptedAt, now);
});

test("missing or invalid durable cache falls back to bundled icons", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "quota-icons-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "claude.json"), JSON.stringify({ source: ICON_SOURCES.claude, svg: '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>' }));
  const cache = createIconCache({ directory, bundledDirectory, fetch: async () => { throw new Error("Offline"); } });
  const first = await cache.manifest();
  await cache.refresh();
  assert.deepEqual(await cache.manifest(), first);
  assert.equal(Object.keys(first).length, 7);
});

test("upstream timeout aborts stalled requests and retains fallback icons", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "quota-icons-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started!: () => void;
  let calls = 0;
  const fetching = new Promise<void>((resolve) => { started = resolve; });
  const cache = createIconCache({ directory, bundledDirectory, fetch: async (_, init) => {
    if (++calls === 7) started();
    return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
  } });
  const before = await cache.get("claude");
  const refresh = cache.refresh();
  await fetching;
  t.mock.timers.tick(ICON_TIMEOUT_MS);
  await refresh;
  assert.equal((await cache.get("claude")).revision, before.revision);
});
