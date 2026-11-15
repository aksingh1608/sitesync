"use client";
import Link from "next/link";
// Day 1 placeholder for the field app. Reads ONLY from Dexie (useLiveQuery).
import { useLiveQuery } from "dexie-react-hooks";
import { Badge } from "@/components/ui/badge";
import { SyncStatus } from "@/components/sync-status";
import { formatTime, useActor, useMeta } from "@/components/use-local";
import { BRANCH_TIMEZONE } from "@/lib/config";
import { localDb } from "@/lib/db/local";
import { groupTasks, isOverdue, type TaskGroups } from "@/lib/tasks/grouping";
import type { ReceiptRow, TaskRow } from "@/lib/sync/reducers";

const GROUPS: [keyof TaskGroups, string][] = [
  ["today", "Today"],
  ["thisWeek", "This Week"],
  ["thisMonth", "This Month"],
  ["followUps", "Follow-ups"],
  ["later", "Later / no date"],
  ["closed", "Done / cancelled"],
];

function receiptLabel(r: ReceiptRow | undefined) {
  if (!r) return "not sent";
  if (r.acknowledgedAt) return "acknowledged";
  if (r.seenAt) return "seen";
  if (r.deliveredAt) return "delivered";
  return "sent";
}

export default function FieldPage() {
  const meta = useMeta();
  const actorId = meta?.actorId ?? null;
  const actor = useActor(actorId);
  const data = useLiveQuery(async () => {
    if (!actorId) return null;
    const [tasks, receipts, sites] = await Promise.all([
      localDb.tasks.where("assigneeId").equals(actorId).toArray(),
      localDb.taskReceipts.where("personId").equals(actorId).toArray(),
      localDb.sites.toArray(),
    ]);
    return {
      tasks,
      receipts: new Map(receipts.map((r) => [r.taskId, r])),
      sites: new Map(sites.map((s) => [s.id, s.name])),
    };
  }, [actorId]);

  if (meta && !actorId) {
    return (
      <main className="mx-auto max-w-xl p-4">
        <p>
          No one selected.{" "}
          <Link className="underline" href="/">
            Pick a person
          </Link>
          .
        </p>
      </main>
    );
  }

  const now = new Date();
  const groups = data ? groupTasks(data.tasks, now, BRANCH_TIMEZONE) : null;

  return (
    <main className="mx-auto w-full max-w-xl p-4 space-y-4">
      <header className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-semibold">My tasks</h1>
          <nav className="flex gap-3 text-sm">
            <Link className="underline" href="/debug">
              Debug
            </Link>
            <Link className="underline" href="/">
              Switch person
            </Link>
          </nav>
        </div>
        <p className="text-sm text-muted-foreground">
          {actor ? `${actor.name} · ${actor.role} · ${actor.trade}` : "Loading…"}
        </p>
        <SyncStatus />
      </header>

      {!groups ? (
        <p className="text-sm text-muted-foreground">Loading from this device…</p>
      ) : data!.tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tasks on this device yet. Sync to fetch them.</p>
      ) : (
        GROUPS.map(([key, label]) => {
          const list = groups[key];
          if (!list.length && (key === "later" || key === "closed")) return null;
          return (
            <section key={key} className="space-y-2" data-testid={`group-${key}`}>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {label} <span className="font-normal">({list.length})</span>
              </h2>
              {list.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing here.</p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {list.map((t) => (
                    <TaskItem
                      key={t.id}
                      task={t}
                      site={data!.sites.get(t.siteId)}
                      receipt={data!.receipts.get(t.id)}
                      overdue={isOverdue(t, now, BRANCH_TIMEZONE)}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}
    </main>
  );
}

function TaskItem({
  task,
  site,
  receipt,
  overdue,
}: {
  task: TaskRow;
  site: string | undefined;
  receipt: ReceiptRow | undefined;
  overdue: boolean;
}) {
  return (
    <li className="p-3 space-y-1" data-testid="task-item">
      <div className="flex items-start justify-between gap-2">
        <span className={task.status === "done" ? "line-through" : "font-medium"}>{task.title}</span>
        <span className="flex shrink-0 gap-1">
          {task.seq === undefined && <Badge variant="outline">not synced</Badge>}
          {overdue && <Badge variant="destructive">overdue</Badge>}
          {(task.priority === "high" || task.priority === "urgent") && <Badge>{task.priority}</Badge>}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>{site ?? "Unknown site"}</span>
        <span>Due {formatTime(task.dueAt)}</span>
        <span>{task.status.replace("_", " ")}</span>
        <span>Receipt: {receiptLabel(receipt)}</span>
      </div>
    </li>
  );
}
