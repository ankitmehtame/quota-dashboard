const CACHE = "quota-dashboard-shell-v1";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.webmanifest", "/icon.svg"];
const worker = self as unknown as ServiceWorkerGlobalScope;
worker.addEventListener("install", (event: ExtendableEvent) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))));
worker.addEventListener("activate", (event: ExtendableEvent) => event.waitUntil(worker.clients.claim()));
worker.addEventListener("fetch", (event: FetchEvent) => {
  if (new URL(event.request.url).pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).catch(async () => (await caches.match(event.request)) || new Response("Offline", { status: 503 })));
});
