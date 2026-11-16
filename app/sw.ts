/// <reference lib="webworker" />
import { defaultCache } from "@serwist/turbopack/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { NetworkOnly, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}
declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  // Field pages take ?id= / ?taskId=; they are all served by the same precached shell.
  precacheOptions: { ignoreURLParametersMatching: [/^utm_/, /^id$/, /^taskId$/] },
  // Updates: a new worker WAITS instead of taking over a running page (whose
  // JS chunks it would otherwise delete). The page shows "Update available",
  // and on tap posts SKIP_WAITING (handled by Serwist), then reloads once the
  // new worker controls it. The outbox lives in IndexedDB, which an update
  // never touches. clientsClaim only matters for the very first install.
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // Sync must never be answered from a cache: the client's outbox handles offline.
    { matcher: ({ url }) => url.pathname.startsWith("/api/"), handler: new NetworkOnly() },
    ...defaultCache,
  ],
  fallbacks: {
    entries: [
      {
        url: "/~offline",
        matcher: ({ request }) => request.destination === "document",
      },
    ],
  },
});

serwist.addEventListeners();

// ---------------------------------------------------------------------------
// Web Push (Day 4). The server sends { title, body, url, tag } (lib/push/send.ts).
// iOS requires every push to show a notification, so we always show one.
// ---------------------------------------------------------------------------
type PushData = { title?: string; body?: string; url?: string; tag?: string };

self.addEventListener("push", (event) => {
  let data: PushData = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "SiteSync", {
      body: data.body ?? "",
      tag: data.tag,
      data: { url: data.url ?? "/field" },
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = (event.notification.data as { url?: string } | null)?.url ?? "/field";
  const url = new URL(raw, self.location.origin);
  if (url.origin !== self.location.origin) return; // only ever open our own pages
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Reuse an open window of the same app area (field or office), else open a new one.
      const area = url.pathname.split("/")[1];
      const existing = windows.find((w) => new URL(w.url).pathname.split("/")[1] === area) ?? windows[0];
      if (existing) {
        try {
          const focused = await existing.focus();
          await focused.navigate(url.href);
          return;
        } catch {
          // navigate() fails for windows this worker doesn't control: open a new one.
        }
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
