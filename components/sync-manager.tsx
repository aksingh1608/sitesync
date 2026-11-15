"use client";
// Sync triggers. No Background Sync API (iOS Safari does not support it):
// app start, `online`, tab becomes visible, every 30 s while open. The manual
// "Sync now" button calls sync({ manual: true }) directly.
import { useEffect } from "react";
import { ensureDeviceId, sync } from "@/lib/sync/client";

const INTERVAL_MS = 30_000;

export function SyncManager() {
  useEffect(() => {
    const run = () => void sync().catch((e) => console.warn("[sync]", e));
    void ensureDeviceId().then(run);

    const onVisible = () => document.visibilityState === "visible" && run();
    window.addEventListener("online", run);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => document.visibilityState === "visible" && run(), INTERVAL_MS);
    return () => {
      window.removeEventListener("online", run);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, []);
  return null;
}
