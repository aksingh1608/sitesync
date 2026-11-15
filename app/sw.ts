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
