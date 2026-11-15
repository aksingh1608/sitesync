"use client";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { sync } from "@/lib/sync/client";
import { formatTime, useMeta, usePendingCount } from "./use-local";

function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

export function SyncStatus() {
  const meta = useMeta();
  const pending = usePendingCount(meta?.actorId);
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const offline = !online || meta?.simulateOffline;
  const last = meta?.lastSyncResult;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Badge variant={offline ? "destructive" : "secondary"} data-testid="net-status">
        {meta?.simulateOffline ? "Offline (simulated)" : online ? "Online" : "Offline"}
      </Badge>
      <Badge variant={pending ? "outline" : "secondary"} data-testid="pending-count">
        {pending ?? 0} unsynced
      </Badge>
      <span className="text-muted-foreground">
        {last?.status === "error"
          ? `Sync failed, retry ${formatTime(last.retryAt)}`
          : meta?.lastSyncAt
            ? `Synced ${formatTime(meta.lastSyncAt)}`
            : "Never synced"}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await sync({ manual: true });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Syncing…" : "Sync now"}
      </Button>
    </div>
  );
}
