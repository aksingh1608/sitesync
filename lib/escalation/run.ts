// Runs the escalation rules: load state -> evaluateEscalations (pure) -> claim
// each action in `escalations` -> only the claimer sends push / SMS.
//
// Concurrency: a step is claimed with INSERT ... ON CONFLICT DO NOTHING on the
// unique (task, rule, episode, level) key, committed before anything is sent.
// Two runs at the same moment both evaluate the same step; exactly one insert
// wins and only that run sends it. Sending is at-most-once: a crash between
// claim and send leaves the row `pending` (visible in the timeline), never a
// duplicate SMS.
import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { claimRunSlot, loadClock, realNow, type Clock } from "../clock";
import { escalations, people, sites, taskReceipts, tasks } from "../db/schema";
import { TERMINAL_STATUSES } from "../domain";
import { pushToPeople, type PushSender } from "../push/send";
import { deliverSms, type SmsDeps } from "../sms/send";
import type { Db } from "../sync/store-drizzle";
import { uuidv4 } from "../uuid";
import { ESCALATION_POLICY } from "./policy";
import { evaluateEscalations, type EscalationState, type StepAction } from "./rules";

export type RunTrigger = "sync" | "poll" | "clock" | "cron" | "manual" | "test";
export type RunSummary = {
  trigger: RunTrigger;
  ran: boolean;
  now: string;
  offsetMs: number;
  sent: number;
  skipped: number;
  failed: number;
  resolved: number;
  /** Steps another concurrent run claimed first. */
  lost: number;
};

export type RunDeps = { push?: PushSender; sms?: SmsDeps; real?: Date };

/** Public base URL for links in SMS (production domain on Vercel). */
export function baseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.VERCEL_PROJECT_PRODUCTION_URL;
  return host ? `https://${host}` : "http://localhost:3000";
}
/** Short task code for SMS links: /t/<last 10 hex digits of the task id>. */
export const shortCode = (taskId: string) => taskId.replace(/-/g, "").slice(-10);
export const shortLink = (taskId: string, env?: NodeJS.ProcessEnv) => `${baseUrl(env)}/t/${shortCode(taskId)}`;

export async function loadEscalationState(db: Db): Promise<EscalationState> {
  const openAlertTasks = db
    .select({ id: escalations.taskId })
    .from(escalations)
    .where(and(eq(escalations.channel, "coordinator_alert"), isNull(escalations.resolvedAt)));
  const tk = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      siteId: tasks.siteId,
      assigneeId: tasks.assigneeId,
      createdBy: tasks.createdBy,
      kind: tasks.kind,
      priority: tasks.priority,
      status: tasks.status,
      dueAt: tasks.dueAt,
      createdAt: tasks.createdAt,
      fieldTs: tasks.fieldTs,
    })
    .from(tasks)
    .where(or(notInArray(tasks.status, [...TERMINAL_STATUSES]), inArray(tasks.id, openAlertTasks)));
  const ids = tk.map((t) => t.id);
  const [rc, ppl, st, steps] = await Promise.all([
    ids.length
      ? db
          .select({ taskId: taskReceipts.taskId, personId: taskReceipts.personId, sentAt: taskReceipts.sentAt, acknowledgedAt: taskReceipts.acknowledgedAt })
          .from(taskReceipts)
          .where(inArray(taskReceipts.taskId, ids))
      : [],
    db.select({ id: people.id, name: people.name, role: people.role, active: people.active }).from(people),
    db.select({ id: sites.id, name: sites.name }).from(sites),
    ids.length
      ? db
          .select({
            id: escalations.id,
            taskId: escalations.taskId,
            rule: escalations.rule,
            episode: escalations.episode,
            level: escalations.level,
            channel: escalations.channel,
            status: escalations.status,
            scheduledFor: escalations.scheduledFor,
            resolvedAt: escalations.resolvedAt,
          })
          .from(escalations)
          .where(inArray(escalations.taskId, ids))
      : [],
  ]);
  return { tasks: tk, receipts: rc, people: ppl, sites: st, steps };
}

/**
 * Evaluate and act. `throttle` (dashboard polls, idle syncs) skips the run if
 * another one happened in the last 30 s on any instance.
 */
export async function runEscalations(
  db: Db,
  opts: { trigger: RunTrigger; throttle?: boolean; deps?: RunDeps } = { trigger: "manual" },
): Promise<RunSummary> {
  const real = opts.deps?.real ?? realNow();
  const clock = await loadClock(db, real);
  const summary: RunSummary = {
    trigger: opts.trigger,
    ran: false,
    now: clock.now.toISOString(),
    offsetMs: clock.offsetMs,
    sent: 0,
    skipped: 0,
    failed: 0,
    resolved: 0,
    lost: 0,
  };
  const slot = await claimRunSlot(db, opts.throttle ? ESCALATION_POLICY.pollThrottleSec : 0, real);
  if (opts.throttle && !slot) return summary;
  summary.ran = true;

  const actions = evaluateEscalations(await loadEscalationState(db), clock);
  for (const a of actions) {
    if (a.kind === "resolve") {
      const done = await db
        .update(escalations)
        .set({
          status: "resolved",
          resolvedAt: clock.now,
          detail: sql`coalesce(${escalations.detail}, '{}'::jsonb) || ${JSON.stringify({ resolvedBy: "auto", why: a.why })}::jsonb`,
        })
        .where(and(eq(escalations.id, a.escalationId), isNull(escalations.resolvedAt)))
        .returning({ id: escalations.id });
      summary.resolved += done.length;
      continue;
    }
    const outcome = await claimAndSend(db, a, clock, opts.deps ?? {});
    summary[outcome]++;
  }
  return summary;
}

async function claimAndSend(db: Db, a: StepAction, clock: Clock, deps: RunDeps): Promise<"sent" | "skipped" | "failed" | "lost"> {
  const id = uuidv4();
  const claimed = await db
    .insert(escalations)
    .values({
      id,
      taskId: a.taskId,
      personId: a.personId,
      rule: a.rule,
      episode: a.episode,
      level: a.level,
      channel: a.channel,
      status: a.skip ? "skipped" : "pending",
      reason: a.reason,
      scheduledFor: a.dueAt,
      sentAt: a.skip ? clock.now : null,
      error: a.skip,
      detail: { title: a.message.title, body: a.message.body, pushTo: a.pushTo },
    })
    .onConflictDoNothing()
    .returning({ id: escalations.id });
  if (claimed.length === 0) return "lost";
  if (a.skip) return "skipped";

  let status: "sent" | "failed" | "skipped" = "sent";
  let providerId: string | null = null;
  let error: string | null = null;
  let extra: Record<string, unknown> = {};

  try {
    if (a.channel === "sms") {
      const r = await deliverSms(
        db,
        { personId: a.personId, body: `${a.message.body} ${shortLink(a.taskId)}`, escalationId: id, at: clock.now },
        deps.sms,
      );
      status = r.ok ? "sent" : "failed";
      providerId = r.providerId ?? r.provider;
      error = r.error;
      extra = { sms: { id: r.id, provider: r.provider, to: r.toMasked } };
    } else {
      const p = await pushToPeople(db, a.pushTo, { ...a.message, taskId: a.taskId }, { urgent: a.urgent, sender: deps.push, real: deps.real });
      extra = { push: p };
      providerId = `${p.delivered}/${p.subscriptions} devices`;
      if (a.channel === "coordinator_alert") {
        status = "sent"; // the alert itself is the dashboard row; push is a bonus
        if (p.subscriptions === 0) error = "no push subscription (dashboard alert only)";
      } else if (p.subscriptions === 0) {
        status = "skipped";
        error = "no push subscription";
      } else if (p.delivered === 0) {
        status = "failed";
        error = p.errors[0] ?? "push failed";
      }
    }
  } catch (err) {
    status = "failed";
    error = (err as Error).message.slice(0, 300);
  }

  await db
    .update(escalations)
    .set({
      status,
      sentAt: clock.now,
      providerId,
      error,
      detail: sql`coalesce(${escalations.detail}, '{}'::jsonb) || ${JSON.stringify(extra)}::jsonb`,
    })
    .where(eq(escalations.id, id));
  return status;
}

/** For route handlers: never throws (logs instead); escalation must not break a sync. */
export async function runEscalationsSafe(
  open: <T>(fn: (db: Db) => Promise<T>) => Promise<T>,
  opts: { trigger: RunTrigger; throttle?: boolean; deps?: RunDeps },
) {
  try {
    return await open((db) => runEscalations(db, opts));
  } catch (err) {
    console.error(`[escalations] run (${opts.trigger}) failed:`, err);
    return null;
  }
}
