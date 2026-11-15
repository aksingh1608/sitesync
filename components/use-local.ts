"use client";
import { useLiveQuery } from "dexie-react-hooks";
import { BRANCH_TIMEZONE } from "@/lib/config";
import { getMeta, localDb } from "@/lib/db/local";
import { formatInZone } from "@/lib/time";

/** Live view of the client meta row (actor, cursor, last sync...). */
export const useMeta = () => useLiveQuery(() => getMeta(), []);

export const useActor = (actorId: string | null | undefined) =>
  useLiveQuery(async () => (actorId ? ((await localDb.people.get(actorId)) ?? null) : null), [actorId]);

export const usePendingCount = (actorId: string | null | undefined) =>
  useLiveQuery(
    () => (actorId ? localDb.outbox.where("[actorId+status]").equals([actorId, "pending"]).count() : 0),
    [actorId],
  );

/** Date + time in the branch timezone (not the device's). */
export function formatTime(d: Date | string | null | undefined) {
  if (!d) return "—";
  return formatInZone(d, BRANCH_TIMEZONE);
}

/** Time of day only, in the branch timezone. */
export function formatClock(d: Date | string | null | undefined) {
  if (!d) return "—";
  return formatInZone(d, BRANCH_TIMEZONE, { hour: "numeric", minute: "2-digit" });
}
