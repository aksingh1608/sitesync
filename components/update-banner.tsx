"use client";
// "Update available, tap to reload". A new service worker waits (skipWaiting is
// off in app/sw.ts) until the user taps; then it takes over and we reload.
// Pending outbox items and recorded media live in IndexedDB, which a service
// worker update never touches, so nothing unsynced can be lost. We still let
// an in-flight sync finish first so its response is merged before reload.
import { useSerwist } from "@serwist/turbopack/react";
import { useEffect, useState } from "react";
import { whenIdle } from "@/lib/sync/client";

export function UpdateBanner() {
  const { serwist } = useSerwist();
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!serwist) return;
    const onWaiting = () => setWaiting(true);
    serwist.addEventListener("waiting", onWaiting);
    // Check for a new deploy whenever the app comes back to the foreground.
    const onVisible = () => document.visibilityState === "visible" && void serwist.update().catch(() => {});
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      serwist.removeEventListener("waiting", onWaiting);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [serwist]);

  // Another tab upgraded the local database: this tab's code is stale.
  useEffect(() => {
    const onStale = () => setWaiting(true);
    window.addEventListener("sitesync:stale", onStale);
    return () => window.removeEventListener("sitesync:stale", onStale);
  }, []);

  if (!waiting) return null;

  async function apply() {
    setBusy(true);
    await whenIdle();
    if (serwist) {
      serwist.addEventListener("controlling", () => window.location.reload());
      serwist.messageSkipWaiting();
      // If no worker was actually waiting (e.g. DB upgrade case), just reload.
      window.setTimeout(() => window.location.reload(), 3000);
    } else {
      window.location.reload();
    }
  }

  return (
    <button
      type="button"
      onClick={apply}
      disabled={busy}
      className="fixed inset-x-0 top-0 z-50 flex min-h-12 w-full items-center justify-center bg-blue-700 px-4 py-3 text-base font-semibold text-white shadow-lg"
      data-testid="update-banner"
    >
      {busy ? "Updating…" : "Update available, tap to reload"}
    </button>
  );
}
