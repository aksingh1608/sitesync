"use client";
import { useLiveQuery } from "dexie-react-hooks";
import { getMeta, localDb } from "@/lib/db/local";

/** Live view of the client meta row (actor, cursor, last sync...). */
export const useMeta = () => useLiveQuery(() => getMeta(), []);

export const useActor = (actorId: string | null | undefined) =>
  useLiveQuery(async () => (actorId ? ((await localDb.people.get(actorId)) ?? null) : null), [actorId]);

export const usePendingCount = (actorId: string | null | undefined) =>
  useLiveQuery(
    () => (actorId ? localDb.outbox.where("[actorId+status]").equals([actorId, "pending"]).count() : 0),
    [actorId],
  );

export function formatTime(d: Date | string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
