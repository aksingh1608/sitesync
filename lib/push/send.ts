// Server-side Web Push (VAPID) with the `web-push` library. Only called by the
// escalation runner (lib/escalation/run.ts), never from reducers.
import { and, eq, inArray, sql } from "drizzle-orm";
import webpush from "web-push";
import { people, pushSubscriptions } from "../db/schema";
import { isFieldRole, type Role } from "../domain";
import type { Db } from "../sync/store-drizzle";

/** What the service worker receives (app/sw.ts shows it). */
export type PushPayload = { title: string; body: string; url: string; tag: string };

export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };
/** Swappable for tests. Resolves on 2xx; rejects with `{ statusCode }` otherwise. */
export type PushSender = (target: PushTarget, payload: string, opts: { urgency: "normal" | "high"; TTL: number }) => Promise<unknown>;

export function vapidKeys() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

export const webPushSender: PushSender = (target, payload, opts) => {
  const keys = vapidKeys();
  if (!keys) return Promise.reject(Object.assign(new Error("push_not_configured"), { statusCode: 0 }));
  return webpush.sendNotification(target, payload, {
    vapidDetails: keys,
    TTL: opts.TTL,
    urgency: opts.urgency,
  });
};

/** Field people open the task in the field app; office people in the dashboard drawer. */
export const taskUrlFor = (role: Role, taskId: string) =>
  isFieldRole(role) ? `/field/task?id=${taskId}` : `/office/tasks?task=${taskId}`;

export type PushResult = { delivered: number; failed: number; removed: number; subscriptions: number; errors: string[] };

/**
 * Push one message to every subscription of these people. Subscriptions the
 * push service reports as gone (404 / 410) are deleted.
 */
export async function pushToPeople(
  db: Db,
  personIds: string[],
  message: { title: string; body: string; taskId: string },
  opts: { urgent?: boolean; sender?: PushSender; real?: Date } = {},
): Promise<PushResult> {
  const out: PushResult = { delivered: 0, failed: 0, removed: 0, subscriptions: 0, errors: [] };
  if (personIds.length === 0) return out;
  const send = opts.sender ?? webPushSender;
  const at = opts.real ?? new Date();
  const subs = await db
    .select({ sub: pushSubscriptions, role: people.role })
    .from(pushSubscriptions)
    .innerJoin(people, eq(people.id, pushSubscriptions.personId))
    .where(inArray(pushSubscriptions.personId, personIds));
  out.subscriptions = subs.length;

  await Promise.all(
    subs.map(async ({ sub, role }) => {
      const payload: PushPayload = {
        title: message.title,
        body: message.body,
        url: taskUrlFor(role, message.taskId),
        tag: `task-${message.taskId}`,
      };
      try {
        await send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
          urgency: opts.urgent ? "high" : "normal",
          TTL: 6 * 60 * 60,
        });
        out.delivered++;
        await db
          .update(pushSubscriptions)
          .set({ lastSuccessAt: at, failureCount: 0 })
          .where(eq(pushSubscriptions.id, sub.id));
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode ?? 0;
        if (code === 404 || code === 410) {
          out.removed++;
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
        } else {
          out.failed++;
          await db
            .update(pushSubscriptions)
            .set({ lastFailureAt: at, failureCount: sql`${pushSubscriptions.failureCount} + 1` })
            .where(and(eq(pushSubscriptions.id, sub.id)));
        }
        const text = (err as Error).message || "push failed";
        out.errors.push(code ? `${code}: ${text.slice(0, 120)}` : text.slice(0, 120));
      }
    }),
  );
  return out;
}
