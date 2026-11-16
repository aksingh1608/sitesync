// The default escalation policy (fixed rules, not AI). Times in minutes on the
// demo clock (lib/clock.ts). Pure data; read by lib/escalation/rules.ts.
import type { TaskPriority } from "../domain";

export const ESCALATION_POLICY = {
  /**
   * "Sent but not acknowledged" ladder for high/urgent tasks, counted from the
   * moment the engine first saw the task as sent (its level-0 push):
   *   level 1 (+30 min) push again to the assignee
   *   level 2 (+60 min) SMS to the assignee
   *   level 3 (+90 min) coordinator alert (dashboard + push)
   */
  ackLadderMin: { 1: 30, 2: 60, 3: 90 } as const,
  /** Multiplier on the ladder per priority; null = no escalation (level-0 push only). */
  priorityFactor: { urgent: 1, high: 1, normal: 2, low: null } as Record<TaskPriority, number | null>,
  /** Overdue: remind the assignee once (level 1), alert the coordinator this long after the reminder (level 2). */
  overdueAlertAfterMin: 120,
  /** Blocked: push coordinators at once (level 0), alert this long after (level 1). */
  blockedAlertAfterMin: 120,
  /**
   * First notifications (new task, changed, blocked) are only pushed if what
   * triggered them happened within this many REAL minutes; older ones are
   * recorded as skipped ("stale"). Stops a first run after a deploy or reseed
   * from pushing days-old news. Real time, so fast-forward never makes a
   * brand-new task look stale.
   */
  notifyFreshMin: 60,
  /** Dashboard polls run the rules at most this often (all instances together). */
  pollThrottleSec: 30,
} as const;

export type EscalationPolicy = typeof ESCALATION_POLICY;
