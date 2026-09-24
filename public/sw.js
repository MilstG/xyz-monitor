/* Service worker for the Milst Screener PWA (build 2026.09.16-80); versioned-asset cache (build 2026.09.24-103).
   Deliberately thin: no offline cache (the app is a live terminal — stale markets are worse
   than no markets), just the things a page cannot do for itself: make the app installable,
   receive web push while every tab is closed — and, since -103, answer the build's OWN immutable
   static assets from a per-build cache. Payloads are built server-side by the same escalation
   sweep that feeds Telegram; this file only renders them.

   The asset cache (build 2026.09.24-103) is narrow by construction, so it cannot reintroduce the
   stale-client bug class the version-stamped shell exists to kill:
   - only GETs for same-origin /app.js, /styles.css and /js/<module>.js whose query is EXACTLY
     ?v=<this worker's build> — the URLs the server marks immutable. The server stamps BUILD into
     this file when it serves it (the "{{build}}" slot); unstamped, BUILD never matches a real ?v=
     and the worker caches nothing at all;
   - never /api/*, never HTML (the shell is audience-specific and no-store), never an unversioned or
     other-build URL — those pass straight to the network, as every request did before;
   - one cache per build ("xyz-static-<build>"); a new deploy serves a byte-different sw.js, the
     browser installs it, and activate deletes every other xyz-static-* cache.
   A new build's shell asks for new ?v= URLs, which miss the old cache by definition — so the
   worst a stale cache can ever do is sit unused until activate purges it. */
const BUILD = "{{build}}";
const ASSET_CACHE = "xyz-static-" + BUILD;
const ASSET_PREFIX = "xyz-static-";
function isVersionedAsset(url) {
  if (!url || url.origin !== self.location.origin) return false;
  if (BUILD.indexOf("{{") === 0 || url.search !== "?v=" + BUILD) return false;
  const p = url.pathname;
  return p === "/app.js" || p === "/styles.css" || /^\/js\/[a-z0-9_-]+\.js$/.test(p);
}
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.indexOf(ASSET_PREFIX) === 0 && k !== ASSET_CACHE).map((k) => caches.delete(k))))
    .catch(() => {})
    .then(() => self.clients.claim())));
// A fetch handler must exist for installability. Everything that is not one of this build's
// versioned static assets is NOT intercepted (the handler returns without answering) — the network stays the truth.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (!req || req.method !== "GET") return;
  let url; try { url = new URL(req.url); } catch (_) { return; }
  if (!isVersionedAsset(url)) return;
  e.respondWith(caches.open(ASSET_CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
    // Only a complete same-origin 200 is worth keeping; a 304/opaque/error answer passes through uncached.
    if (res && res.status === 200 && res.type === "basic") { const copy = res.clone(); c.put(req, copy).catch(() => {}); }
    return res;
  }))).catch(() => fetch(req)));
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  const title = String(d.title || "Milst Screener");
  e.waitUntil(self.registration.showNotification(title, {
    body: String(d.body || "new message"),
    tag: "dm-" + (d.thread || "x"),          // one notification per conversation, newest wins
    icon: "/icon.svg",
    data: { thread: d.thread || null },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  // Focus an open terminal if one exists and ASK it to switch to Messages (the page listens for
  // {go:'dm'} — a navigate() reloaded the whole app and dropped a half-typed message); only a
  // window that isn't open gets a real navigation.
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((tabs) => {
    for (const t of tabs) { if ("focus" in t) { t.focus(); try { t.postMessage({ go: "dm" }); } catch (_) {} return; } }
    return self.clients.openWindow ? self.clients.openWindow("/#dm") : null;
  }));
});
