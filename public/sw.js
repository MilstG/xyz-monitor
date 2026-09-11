/* Service worker for the Milst Screener PWA (build 2026.09.11-66).
   Deliberately thin: no offline cache (the app is a live terminal — stale markets are worse
   than no markets), just the two things a page cannot do for itself: make the app installable,
   and receive web push while every tab is closed. Payloads are built server-side by the same
   escalation sweep that feeds Telegram; this file only renders them. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
// A fetch handler must exist for installability; passing through keeps the network the truth.
self.addEventListener("fetch", () => {});

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
  // Focus an open terminal if one exists, else open one — landing on the Messages tab.
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((tabs) => {
    for (const t of tabs) { if ("focus" in t) { t.focus(); try { t.navigate("/#dm"); } catch (_) {} return; } }
    return self.clients.openWindow ? self.clients.openWindow("/#dm") : null;
  }));
});
