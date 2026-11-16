"use client";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { formatClock, useMeta } from "@/components/use-local";
import { localDb, type OutboxItem } from "@/lib/db/local";
import { describeSync, type SyncView } from "@/lib/sync/status";

export type PendingRefs = {
  tasks: Set<string>;
  notes: Set<string>;
  timeEntries: Set<string>;
  status: boolean;
  count: number;
};

const EMPTY: PendingRefs = { tasks: new Set(), notes: new Set(), timeEntries: new Set(), status: false, count: 0 };

/** Which rows have unsynced changes, from the outbox: drives "waiting to sync" markers. */
export function usePendingRefs(actorId: string | null | undefined): PendingRefs {
  return (
    useLiveQuery(async () => {
      if (!actorId) return EMPTY;
      const items: OutboxItem[] = await localDb.outbox.where("[actorId+status]").equals([actorId, "pending"]).toArray();
      const refs: PendingRefs = { tasks: new Set(), notes: new Set(), timeEntries: new Set(), status: false, count: items.length };
      for (const { event } of items) {
        const p = event.payload as Record<string, unknown>;
        if (typeof p.taskId === "string") refs.tasks.add(p.taskId);
        if (typeof p.noteId === "string") refs.notes.add(p.noteId);
        if (typeof p.timeEntryId === "string") refs.timeEntries.add(p.timeEntryId);
        if (event.type === "status.set") refs.status = true;
      }
      return refs;
    }, [actorId]) ?? EMPTY
  );
}

export const usePendingUploads = (actorId: string | null | undefined) =>
  useLiveQuery(
    () => (actorId ? localDb.media.where("[actorId+status]").equals([actorId, "pending"]).count() : 0),
    [actorId],
  ) ?? 0;

/** Re-render every `ms` (for "today's hours", overdue edges...). */
export function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export function useOnline() {
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

/** The one view of sync state (top bar + Me page). */
export function useSyncView(busy = false): SyncView {
  const meta = useMeta();
  const online = useOnline();
  const pending = usePendingRefs(meta?.actorId);
  const uploads = usePendingUploads(meta?.actorId);
  return describeSync({ meta, online, pending: pending.count, uploads, formatClock: (iso) => formatClock(iso), busy });
}
