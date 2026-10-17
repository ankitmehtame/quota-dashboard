import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("service worker precaches icons, stores refreshed responses, and uses them offline across query versions", async () => {
  const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const stores = new Map<string, Map<string, Response>>();
  const listeners = new Map<string, (event: unknown) => void>();
  const key = (request: Request | string) => typeof request === "string" ? new URL(request, "https://dashboard.test").href : request.url;
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        async addAll(paths: string[]) { for (const path of paths) store.set(key(path), new Response("bundled " + path, { headers: { "content-type": "image/svg+xml" } })); },
        async put(request: Request, response: Response) { store.set(key(request), response); },
        async match(request: Request) { return store.get(key(request))?.clone(); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name: string) { return stores.delete(name); },
    async match(request: Request) { for (const store of stores.values()) { const response = store.get(key(request)); if (response) return response.clone(); } },
  };
  let network: (request: Request) => Promise<Response> = async () => new Response("updated", { headers: { "content-type": "image/svg+xml" } });
  stores.set("quota-dashboard-shell-v1", new Map());
  runInNewContext(source, { Request, Response, URL, caches, fetch: (request: Request) => network(request), self: {
    location: { origin: "https://dashboard.test" }, clients: { claim: async () => {} },
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
  } });
  const lifecycle = async (type: string) => { let pending!: Promise<unknown>; listeners.get(type)!({ waitUntil: (promise: Promise<unknown>) => { pending = promise; } }); await pending; };
  await lifecycle("install");
  await lifecycle("activate");
  assert.equal(stores.has("quota-dashboard-shell-v1"), false);
  const shell = stores.get("quota-dashboard-shell-v2")!;
  assert.equal([...shell.keys()].filter((url) => url.includes("/icons/")).length, 7);
  const request = async (path: string, method = "GET") => {
    const pending: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    listeners.get("fetch")!({ request: new Request(new URL(path, "https://dashboard.test"), { method }),
      waitUntil: (promise: Promise<unknown>) => pending.push(promise), respondWith: (promise: Promise<Response>) => { response = promise; },
    });
    const result = await response;
    await Promise.all(pending);
    return result;
  };
  assert.equal(await (await request("/icons/openai.svg?v=first"))!.text(), "updated");
  assert.equal(stores.get("quota-dashboard-icons-v1")!.size, 1);
  network = async () => { throw new Error("Offline"); };
  assert.equal(await (await request("/icons/openai.svg?v=second"))!.text(), "updated");
  assert.equal(await (await request("/icons/hermes.svg?v=second"))!.text(), "bundled /icons/hermes.svg");
  network = async () => new Response("Not an SVG", { status: 500 });
  assert.equal(await (await request("/icons/openai.svg"))!.text(), "updated");
  assert.equal(await request("/api/v1/icons/refresh", "POST"), undefined);
});
