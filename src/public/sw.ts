const CACHE = "quota-dashboard-shell-v2";
const ICON_CACHE = "quota-dashboard-icons-v1";
const ICON_NAMES = ["claude", "openai", "openrouter", "ollama", "hermes", "antigravity", "opencode"];
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.webmanifest", "/icon.svg", ...ICON_NAMES.map((id) => `/icons/${id}.svg`)];
const worker = self as unknown as ServiceWorkerGlobalScope;
worker.addEventListener("install", (event: ExtendableEvent) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))));
worker.addEventListener("activate", (event: ExtendableEvent) => event.waitUntil((async () => {
  await Promise.all((await caches.keys()).filter((key) => key.startsWith("quota-dashboard-shell-") && key !== CACHE).map((key) => caches.delete(key)));
  await worker.clients.claim();
})()));
worker.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.origin !== worker.location.origin || event.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  if (ICON_NAMES.some((id) => url.pathname === `/icons/${id}.svg`)) {
    // One entry per icon, regardless of opening/version query, preserves the latest offline copy.
    const key = new Request(`${url.origin}${url.pathname}`);
    const network = fetch(event.request).then(async (response) => {
      if (!response.ok || !response.headers.get("content-type")?.startsWith("image/svg+xml")) throw new Error("Icon unavailable");
      const copy = response.clone();
      await caches.open(ICON_CACHE).then((cache) => cache.put(key, copy)).catch(() => {});
      return response;
    });
    event.waitUntil(network.then(() => {}, () => {}));
    event.respondWith(network.catch(async () => (await (await caches.open(ICON_CACHE)).match(key)) || (await (await caches.open(CACHE)).match(key)) || new Response("Offline", { status: 503 })));
    return;
  }
  event.respondWith(fetch(event.request).catch(async () => (await caches.match(event.request)) || new Response("Offline", { status: 503 })));
});
