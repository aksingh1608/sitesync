// The sync transaction: insert events -> apply reducers to newly inserted ones
// -> read changes since the cursor for this actor. All in one transaction.
import { eq, sql } from "drizzle-orm";
import { EventSchema, SERVER_ONLY_EVENT_TYPES } from "../events";
import { events, people } from "../db/schema";
import { applyEvent } from "./apply";
import type { SyncRequest, SyncResponse } from "./protocol";
import { drizzleStore, type Db } from "./store-drizzle";
import { emptyChanges, pullChanges } from "./visibility";

/**
 * Serializes sync writers so `seq` order matches commit order. Without this, a
 * reader could advance its cursor past a row from a transaction that commits
 * later with a lower seq, and never see that row.
 */
const SYNC_LOCK_KEY = 7_240_001;

export type SyncOutcome =
  | { ok: true; response: SyncResponse }
  | { ok: false; status: 403; error: string };

export async function processSync(
  db: Db,
  req: SyncRequest,
  opts: {
    now?: () => Date;
    pageSize?: number;
    /** Server-internal callers only (e.g. POST /api/media). Allows SERVER_ONLY_EVENT_TYPES. */
    trusted?: boolean;
    /** Skip the cursor pull (server-internal writes don't need one). */
    skipPull?: boolean;
  } = {},
): Promise<SyncOutcome> {
  const now = opts.now ?? (() => new Date());

  return db.transaction(async (tx) => {
    const [actor] = await tx.select().from(people).where(eq(people.id, req.actorId));
    if (!actor) return { ok: false as const, status: 403 as const, error: "unknown_actor" };
    if (!actor.active) return { ok: false as const, status: 403 as const, error: "inactive_actor" };

    const accepted: string[] = [];
    const duplicates: string[] = [];
    const rejected: { id: string; reason: string }[] = [];

    if (req.events.length > 0) {
      await tx.execute(sql`select pg_advisory_xact_lock(${SYNC_LOCK_KEY})`);
    }

    for (const [index, raw] of req.events.entries()) {
      const rawId =
        raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
          ? (raw as { id: string }).id
          : `index:${index}`;

      const parsed = EventSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        rejected.push({ id: rawId, reason: `invalid_event: ${issue?.path.join(".") || "event"}: ${issue?.message}` });
        continue;
      }
      const ev = parsed.data;
      if (ev.actorId !== req.actorId) {
        rejected.push({ id: ev.id, reason: "actor_mismatch: event actorId differs from request actorId" });
        continue;
      }
      if (!opts.trusted && SERVER_ONLY_EVENT_TYPES.includes(ev.type)) {
        // Not stored: a device must never be able to claim where a blob lives.
        rejected.push({ id: ev.id, reason: "forbidden" });
        continue;
      }

      try {
        // Savepoint per event: an unexpected failure rolls back only this event.
        const outcome = await tx.transaction(async (sp) => {
          const inserted = await sp
            .insert(events)
            .values({
              id: ev.id,
              type: ev.type,
              actorId: ev.actorId,
              deviceId: ev.deviceId,
              clientTs: new Date(ev.clientTs),
              payload: ev.payload,
            })
            .onConflictDoNothing({ target: events.id })
            .returning({ id: events.id });

          if (inserted.length === 0) {
            const [prior] = await sp
              .select({ rejectReason: events.rejectReason })
              .from(events)
              .where(eq(events.id, ev.id));
            return prior?.rejectReason
              ? ({ kind: "rejected", reason: prior.rejectReason } as const)
              : ({ kind: "duplicate" } as const);
          }

          const result = await applyEvent(drizzleStore(sp), ev, now());
          await sp
            .update(events)
            .set(result.ok ? { applied: true } : { applied: false, rejectReason: result.reason })
            .where(eq(events.id, ev.id));
          return result.ok ? ({ kind: "accepted" } as const) : ({ kind: "rejected", reason: result.reason } as const);
        });

        if (outcome.kind === "accepted") accepted.push(ev.id);
        else if (outcome.kind === "duplicate") duplicates.push(ev.id);
        else rejected.push({ id: ev.id, reason: outcome.reason });
      } catch (err) {
        // Not stored, so a later resend can still succeed.
        console.error("[sync] event failed", ev.id, ev.type, err);
        rejected.push({ id: ev.id, reason: "internal_error" });
      }
    }

    const cursor = req.cursor === null ? 0 : Number(req.cursor);
    const pulled = opts.skipPull
      ? { changes: emptyChanges(), revocations: [], cursor, hasMore: false }
      : await pullChanges(tx, actor, cursor, opts.pageSize);
    return {
      ok: true as const,
      response: {
        accepted,
        duplicates,
        rejected,
        changes: pulled.changes,
        revocations: pulled.revocations,
        cursor: String(pulled.cursor),
        hasMore: pulled.hasMore,
        serverTime: now().toISOString(),
      },
    };
  });
}
