// Escalation rules: a pure function from (state, clock) to the actions due.
// No I/O, no clock reads, no randomness. lib/escalation/run.ts loads the state,
// claims each action in the `escalations` table (unique per task + rule +
// episode + level, so it happens once) and only then sends push / SMS.
import { BRANCH_TIMEZONE } from "../config";
import {
  isFieldRole,
  isOfficeRole,
  TERMINAL_STATUSES,
  type EscalationChannel,
  type EscalationRule,
  type EscalationStatus,
  type Role,
  type TaskKind,
  type TaskPriority,
  type TaskStatus,
} from "../domain";
import type { TaskFieldStamps } from "../db/schema";
import { realOf, type Clock } from "../clock";
import { dayKey, formatInZone } from "../time";
import { ESCALATION_POLICY, type EscalationPolicy } from "./policy";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
export type EvalTask = {
  id: string;
  title: string;
  siteId: string;
  assigneeId: string;
  createdBy: string;
  kind: TaskKind;
  priority: TaskPriority;
  status: TaskStatus;
  dueAt: Date | null;
  createdAt: Date;
  fieldTs: TaskFieldStamps;
};
export type EvalReceipt = { taskId: string; personId: string; sentAt: Date; acknowledgedAt: Date | null };
export type EvalPerson = { id: string; name: string; role: Role; active: boolean };
export type EvalStep = {
  id: string;
  taskId: string;
  rule: EscalationRule;
  episode: string;
  level: number;
  channel: EscalationChannel;
  status: EscalationStatus;
  scheduledFor: Date;
  resolvedAt: Date | null;
};
export type EscalationState = {
  /** Open tasks, plus closed ones that still have an open coordinator alert. */
  tasks: EvalTask[];
  receipts: EvalReceipt[];
  people: EvalPerson[];
  sites: { id: string; name: string }[];
  /** Existing escalation rows for those tasks. */
  steps: EvalStep[];
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
export type Message = { title: string; body: string };
export type SkipReason = "stale" | "superseded";

export type StepAction = {
  kind: "step";
  taskId: string;
  rule: EscalationRule;
  episode: string;
  level: number;
  channel: EscalationChannel;
  /** Row owner: the assignee, or the coordinator for alerts. */
  personId: string;
  /** Who gets the push (assignee, or every coordinator for alerts / blocked). Empty for SMS. */
  pushTo: string[];
  /** Demo time the step became due. */
  dueAt: Date;
  reason: string;
  message: Message;
  /** Recorded but not sent. */
  skip: SkipReason | null;
  /** Push urgency hint. */
  urgent: boolean;
};
export type ResolveAction = { kind: "resolve"; escalationId: string; taskId: string; why: string };
export type EscalationAction = StepAction | ResolveAction;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MIN = 60_000;
const addMin = (d: Date, min: number) => new Date(d.getTime() + min * MIN);
const isTerminal = (s: TaskStatus) => TERMINAL_STATUSES.includes(s);
const PRIORITY_WORD: Record<TaskPriority, string> = { urgent: "Urgent", high: "High priority", normal: "", low: "" };

export const ackEpisode = (personId: string, sentAt: Date) => `${personId}@${sentAt.toISOString()}`;

/** "2:00 PM" today (branch time), otherwise "Tue, Nov 18, 2:00 PM". */
export function dueLabel(due: Date | null, now: Date, tz = BRANCH_TIMEZONE): string | null {
  if (!due) return null;
  const time = formatInZone(due, tz, { hour: "numeric", minute: "2-digit" });
  if (dayKey(due, tz) === dayKey(now, tz)) return time;
  return formatInZone(due, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "Urgent: Store 114 parking lot lights out" (normal priority: just the title). */
export function headline(t: Pick<EvalTask, "priority" | "title">, prefix?: string): string {
  const word = prefix ?? PRIORITY_WORD[t.priority];
  return word ? `${word}: ${t.title}` : t.title;
}

/** Who gets coordinator alerts: the task's creator if they are office staff, plus every active coordinator. */
export function coordinatorsFor(t: EvalTask, people: Map<string, EvalPerson>): string[] {
  const out: string[] = [];
  const creator = people.get(t.createdBy);
  if (creator?.active && isOfficeRole(creator.role) && creator.role !== "hr") out.push(creator.id);
  for (const p of people.values()) if (p.active && p.role === "coordinator" && !out.includes(p.id)) out.push(p.id);
  return out;
}

/** Where the "current" ack ladder of a task stands (null: nothing to chase). */
function ackTarget(t: EvalTask, receipts: EvalReceipt[]) {
  if (isTerminal(t.status)) return null;
  const r = receipts.find((x) => x.taskId === t.id && x.personId === t.assigneeId);
  if (!r || r.acknowledgedAt) return null;
  return { receipt: r, episode: ackEpisode(t.assigneeId, r.sentAt) };
}

/** The newest due-date / priority change after creation (creation stamps all fields at createdAt). */
function latestChange(t: EvalTask) {
  const created = t.createdAt.getTime();
  const stamps = (["dueAt", "priority"] as const)
    .map((f) => t.fieldTs[f])
    .filter((s): s is NonNullable<typeof s> => !!s && Date.parse(s.ts) > created);
  stamps.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || (b.ev > a.ev ? 1 : -1));
  return stamps[0] ?? null;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------
export function evaluateEscalations(
  state: EscalationState,
  clock: Clock,
  policy: EscalationPolicy = ESCALATION_POLICY,
): EscalationAction[] {
  const now = clock.now;
  const real = realOf(clock);
  const people = new Map(state.people.map((p) => [p.id, p]));
  const siteName = new Map(state.sites.map((s) => [s.id, s.name]));
  const stepsByTask = new Map<string, EvalStep[]>();
  for (const s of state.steps) stepsByTask.set(s.taskId, [...(stepsByTask.get(s.taskId) ?? []), s]);
  const fresh = (at: Date | string) => real.getTime() - new Date(at).getTime() <= policy.notifyFreshMin * MIN;

  const actions: EscalationAction[] = [];

  for (const t of state.tasks) {
    const steps = stepsByTask.get(t.id) ?? [];
    const find = (rule: EscalationRule, episode: string, level: number) =>
      steps.find((s) => s.rule === rule && s.episode === episode && s.level === level);
    const assignee = people.get(t.assigneeId);
    const site = siteName.get(t.siteId) ?? "the site";
    const due = dueLabel(t.dueAt, now);
    const dueText = due ? ` Due ${due}.` : "";
    const factor = policy.priorityFactor[t.priority];
    const coordinators = coordinatorsFor(t, people);
    const alertOwner = coordinators[0] ?? t.createdBy;
    const urgent = t.priority === "urgent" || t.priority === "high";
    const base = { kind: "step" as const, taskId: t.id, urgent };

    /** Emit the highest due level of a ladder; lower due ones are recorded as superseded. */
    const ladder = (
      rule: EscalationRule,
      episode: string,
      due: { level: number; at: Date; make: () => Omit<StepAction, "kind" | "taskId" | "urgent" | "rule" | "episode" | "level" | "dueAt" | "skip"> }[],
    ) => {
      const ready = due.filter((d) => d.at.getTime() <= now.getTime() && !find(rule, episode, d.level));
      const top = Math.max(...ready.map((d) => d.level));
      for (const d of ready) {
        actions.push({ ...base, rule, episode, level: d.level, dueAt: d.at, skip: d.level === top ? null : "superseded", ...d.make() });
      }
    };

    // --- 1. Sent but not acknowledged ------------------------------------
    const ack = ackTarget(t, state.receipts);
    if (ack && assignee) {
      const l0 = find("ack", ack.episode, 0);
      if (!l0) {
        const isRequest = t.kind === "material_request";
        actions.push({
          ...base,
          rule: "ack",
          episode: ack.episode,
          level: 0,
          channel: "push",
          personId: t.assigneeId,
          pushTo: [t.assigneeId],
          dueAt: now,
          reason: isRequest ? "New material request" : "New task assigned",
          message: {
            title: headline(t, isRequest ? "Material request" : undefined),
            body: `${isRequest ? "From the field" : "New task"} at ${site}.${dueText}`,
          },
          skip: fresh(ack.receipt.sentAt) ? null : "stale",
        });
      } else if (factor !== null && isFieldRole(assignee.role)) {
        // Office assignees (material requests) get the first push only: they have no "Got it".
        const anchor = l0.scheduledFor;
        const m = policy.ackLadderMin;
        const word = PRIORITY_WORD[t.priority] || "Task";
        ladder("ack", ack.episode, [
          {
            level: 1,
            at: addMin(anchor, m[1] * factor),
            make: () => ({
              channel: "push",
              personId: t.assigneeId,
              pushTo: [t.assigneeId],
              reason: `Not acknowledged after ${m[1] * factor} min: push again`,
              message: { title: headline(t, "Reminder"), body: `Not acknowledged yet. Open it and tap Got it.${dueText}` },
            }),
          },
          {
            level: 2,
            at: addMin(anchor, m[2] * factor),
            make: () => ({
              channel: "sms",
              personId: t.assigneeId,
              pushTo: [],
              reason: `Not acknowledged after ${m[2] * factor} min: SMS`,
              message: { title: "SMS", body: `SiteSync: ${word} not acknowledged: ${t.title} at ${site}.${dueText}` },
            }),
          },
          {
            level: 3,
            at: addMin(anchor, m[3] * factor),
            make: () => ({
              channel: "coordinator_alert",
              personId: alertOwner,
              pushTo: coordinators,
              reason: `Not acknowledged after ${m[3] * factor} min (push and SMS sent)`,
              message: {
                title: headline(t, "Not acknowledged"),
                body: `${assignee.name} hasn't acknowledged after ${m[3] * factor} min. ${site}.`,
              },
            }),
          },
        ]);
      }
    }

    // --- 2. Overdue (field work only; follow-ups have soft dates, low priority never escalates)
    if (
      t.dueAt &&
      t.dueAt.getTime() <= now.getTime() &&
      !isTerminal(t.status) &&
      t.kind !== "follow_up" &&
      factor !== null &&
      assignee &&
      isFieldRole(assignee.role)
    ) {
      const episode = t.dueAt.toISOString();
      const remind = find("overdue", episode, 1);
      if (!remind) {
        actions.push({
          ...base,
          rule: "overdue",
          episode,
          level: 1,
          channel: "push",
          personId: t.assigneeId,
          pushTo: [t.assigneeId],
          dueAt: now,
          reason: "Past due and not done: reminder",
          message: { title: headline(t, "Overdue"), body: `Was due ${due}. Update the status or tell the office. ${site}.` },
          skip: null,
        });
      } else {
        ladder("overdue", episode, [
          {
            level: 2,
            at: addMin(remind.scheduledFor, policy.overdueAlertAfterMin),
            make: () => ({
              channel: "coordinator_alert",
              personId: alertOwner,
              pushTo: coordinators,
              reason: `Still overdue ${policy.overdueAlertAfterMin / 60} h after the reminder`,
              message: { title: headline(t, "Overdue"), body: `${assignee.name}: was due ${due}, still ${t.status.replace("_", " ")}. ${site}.` },
            }),
          },
        ]);
      }
    }

    // --- 3. Blocked -------------------------------------------------------
    const blockedStamp = t.status === "blocked" ? t.fieldTs.status : undefined;
    if (blockedStamp) {
      const episode = blockedStamp.ev;
      const first = find("blocked", episode, 0);
      const who = assignee?.name ?? "Someone";
      if (!first) {
        actions.push({
          ...base,
          rule: "blocked",
          episode,
          level: 0,
          channel: "push",
          personId: alertOwner,
          pushTo: coordinators,
          dueAt: now,
          reason: "Task marked blocked",
          message: { title: headline(t, "Blocked"), body: `${who} marked it blocked. ${site}.` },
          skip: fresh(blockedStamp.ts) ? null : "stale",
        });
      } else {
        ladder("blocked", episode, [
          {
            level: 1,
            at: addMin(first.scheduledFor, policy.blockedAlertAfterMin),
            make: () => ({
              channel: "coordinator_alert",
              personId: alertOwner,
              pushTo: coordinators,
              reason: `Blocked for more than ${policy.blockedAlertAfterMin / 60} h`,
              message: { title: headline(t, "Still blocked"), body: `${who} has been blocked for over ${policy.blockedAlertAfterMin / 60} h. ${site}.` },
            }),
          },
        ]);
      }
    }

    // --- 4. Due date or priority changed (a notification, not an escalation)
    const change = latestChange(t);
    if (change && !isTerminal(t.status) && !find("changed", change.ev, 0) && fresh(change.ts)) {
      const parts = [due ? `Now due ${due}` : "No due date now", `priority ${t.priority}`];
      actions.push({
        ...base,
        rule: "changed",
        episode: change.ev,
        level: 0,
        channel: "push",
        personId: t.assigneeId,
        pushTo: [t.assigneeId],
        dueAt: now,
        reason: "Due date or priority changed",
        message: { title: headline(t, "Changed"), body: `${parts.join(", ")}. ${site}.` },
        skip: null,
      });
    }

    // --- 5. Open coordinator alerts whose cause is gone resolve themselves.
    for (const s of steps) {
      if (s.channel !== "coordinator_alert" || s.resolvedAt || s.status === "skipped" || s.status === "pending") continue;
      const why = alertGone(s, t, ack?.episode ?? null, now);
      if (why) actions.push({ kind: "resolve", escalationId: s.id, taskId: t.id, why });
    }
  }
  return actions;
}

/** Why an open alert no longer applies (null: it still does). */
function alertGone(s: EvalStep, t: EvalTask, currentAckEpisode: string | null, now: Date): string | null {
  if (t.status === "done") return "task done";
  if (t.status === "cancelled") return "task cancelled";
  if (s.rule === "ack" && s.episode !== currentAckEpisode) {
    return s.episode.startsWith(`${t.assigneeId}@`) ? "acknowledged" : "reassigned";
  }
  if (s.rule === "overdue" && (!t.dueAt || t.dueAt.toISOString() !== s.episode || t.dueAt > now)) return "due date moved";
  if (s.rule === "blocked" && (t.status !== "blocked" || t.fieldTs.status?.ev !== s.episode)) return "no longer blocked";
  return null;
}
