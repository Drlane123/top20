/* Top 20 service worker — installability + fast repeat loads.
   Conservative by design: online behavior is unchanged.
   - Static brand assets (icons, manifest): cache-first.
   - Pages: network-first, cached copy as fallback so the shell opens.
   - NEVER cached: audio/video streams, API calls, admin routes, uploads. */
const CACHE = "top20-v1";
const PRECACHE = [
  "/manifest.webmanifest",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
  "/icons/icon-maskable-512x512.png",
  "/icons/apple-touch-icon.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isNeverCache(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/admin/") ||
    url.pathname.startsWith("/audio/") ||
    url.pathname.startsWith("/videos/") ||
    url.pathname.startsWith("/uploads/") ||
    /\.(mp3|wav|flac|m4a|ogg|mp4|webm|mov)$/i.test(url.pathname)
  );
}

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === "/apple-touch-icon.png" ||
    url.pathname === "/favicon.ico"
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isNeverCache(url)) return; // straight to network, untouched

  if (isStaticAsset(url)) {
    // Cache-first for static brand assets.
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    // Network-first for pages; cached shell as fallback.
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match("/")))
    );
  }
});
