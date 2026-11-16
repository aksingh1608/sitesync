// Lookups and counts over the office snapshot (JSON, dates as strings). Pure.
import { BRANCH_TIMEZONE } from "../config";
import { isFieldRole, TERMINAL_STATUSES, type Role, type TaskStatus } from "../domain";
import { dayKey } from "../time";
import { ackOverdue, receiptStage, type ReceiptStage } from "./rules";

type SnapTask = {
  id: string;
  title: string;
  siteId: string;
  assigneeId: string;
  createdBy: string;
  kind: string;
  priority: string;
  status: TaskStatus;
  dueAt: string | null;
  createdAt: string;
  materialStatus: string | null;
};
type SnapReceipt = { taskId: string; personId: string; sentAt: string; deliveredAt: string | null; seenAt: string | null; acknowledgedAt: string | null };
type SnapEntry = { id: string; personId: string; siteId: string; clockInAt: string };

export type SnapLike = {
  now: string;
  people: { id: string; name: string; role: Role; trade: string; active: boolean }[];
  sites: { id: string; name: string; kind: string }[];
  tasks: SnapTask[];
  receipts: SnapReceipt[];
  openEntries: SnapEntry[];
  statuses: { personId: string; status: string | null; note: string | null; at: string }[];
  lastSync: { personId: string; lastSyncAt: string }[];
};

export const isOpen = (t: { status: TaskStatus }) => !TERMINAL_STATUSES.includes(t.status);

/** Overdue = due before today (branch day), still open, not a follow-up (same rule as the field app). */
export const isOverdue = (t: SnapTask, now: Date) =>
  isOpen(t) && t.kind !== "follow_up" && !!t.dueAt && dayKey(new Date(t.dueAt), BRANCH_TIMEZONE) < dayKey(now, BRANCH_TIMEZONE);

/** Board strip filters, also used as ?view= on the task table. */
export const TASK_VIEWS = ["overdue", "unacked", "blocked", "materials", "clocked_in"] as const;
export type TaskView = (typeof TASK_VIEWS)[number];

export function derive<S extends SnapLike>(s: S) {
  const now = new Date(s.now);
  const person = new Map(s.people.map((p) => [p.id, p]));
  const site = new Map(s.sites.map((x) => [x.id, x]));
  const receipt = new Map(s.receipts.map((r) => [`${r.taskId}|${r.personId}`, r]));
  /** The receipt of the task's CURRENT assignee (a reassigned task starts a new chain). */
  const receiptOf = (t: SnapTask) => receipt.get(`${t.id}|${t.assigneeId}`) ?? null;
  const stageOf = (t: SnapTask): ReceiptStage => receiptStage(receiptOf(t));
  const ackLate = (t: SnapTask) => ackOverdue(t, receiptOf(t), now);
  const openEntry = new Map(s.openEntries.map((e) => [e.personId, e]));
  const status = new Map(s.statuses.map((x) => [x.personId, x]));
  const lastSync = new Map(s.lastSync.map((d) => [d.personId, d.lastSyncAt]));

  const open = s.tasks.filter(isOpen);
  const inView = (t: SnapTask, v: TaskView) =>
    v === "overdue"
      ? isOverdue(t, now)
      : v === "unacked"
        ? isOpen(t) && stageOf(t) !== "acknowledged"
        : v === "blocked"
          ? t.status === "blocked"
          : v === "materials"
            ? t.kind === "material_request" && isOpen(t) && t.materialStatus !== "delivered"
            : isOpen(t) && openEntry.has(t.assigneeId);

  const counts = {
    clockedIn: s.openEntries.length,
    overdue: open.filter((t) => isOverdue(t, now)).length,
    unacked: open.filter((t) => inView(t, "unacked")).length,
    blocked: open.filter((t) => t.status === "blocked").length,
    materials: s.tasks.filter((t) => inView(t, "materials")).length,
  };

  const workerCounts = (personId: string) => {
    const mine = open.filter((t) => t.assigneeId === personId);
    return { open: mine.length, overdue: mine.filter((t) => isOverdue(t, now)).length, blocked: mine.filter((t) => t.status === "blocked").length };
  };

  const fieldPeople = s.people.filter((p) => p.active && isFieldRole(p.role));
  return { now, person, site, receiptOf, stageOf, ackLate, openEntry, status, lastSync, open, inView, counts, workerCounts, fieldPeople };
}
