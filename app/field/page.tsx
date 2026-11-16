"use client";
// Task list. Reads ONLY from Dexie (useLiveQuery).
import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { useState } from "react";
import { usePendingRefs, useNow } from "@/components/field/hooks";
import { TaskCard } from "@/components/field/task-card";
import { Chip, PageTitle } from "@/components/field/ui";
import { NotificationsCard } from "@/components/push/field-card";
import { useActor, useMeta } from "@/components/use-local";
import { BRANCH_TIMEZONE } from "@/lib/config";
import { localDb } from "@/lib/db/local";
import { TERMINAL_STATUSES } from "@/lib/domain";
import { groupTasks, isOverdue, type GroupKey } from "@/lib/tasks/grouping";
import type { TaskRow } from "@/lib/sync/reducers";
import { cn } from "@/lib/utils";

const GROUPS: { key: GroupKey; label: string; alwaysShow?: boolean }[] = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today", alwaysShow: true },
  { key: "next7", label: "Next 7 days", alwaysShow: true },
  { key: "later", label: "Later", alwaysShow: true },
  { key: "followUps", label: "Follow-ups", alwaysShow: true },
  { key: "closed", label: "Done / cancelled" },
];

const FILTERS = {
  all: { label: "All", test: () => true },
  open: { label: "Open", test: (t: TaskRow) => t.status === "open" || t.status === "in_progress" },
  blocked: { label: "Blocked", test: (t: TaskRow) => t.status === "blocked" },
  done: { label: "Done", test: (t: TaskRow) => TERMINAL_STATUSES.includes(t.status) },
} as const;
type FilterKey = keyof typeof FILTERS;

export default function FieldPage() {
  const meta = useMeta();
  const actorId = meta?.actorId ?? null;
  const actor = useActor(actorId);
  const pending = usePendingRefs(actorId);
  const now = useNow(60_000);
  const [filter, setFilter] = useState<FilterKey>("all");

  const data = useLiveQuery(async () => {
    if (!actorId) return null;
    const [mine, created, receipts, sites] = await Promise.all([
      localDb.tasks.where("assigneeId").equals(actorId).toArray(),
      localDb.tasks.where("createdBy").equals(actorId).toArray(),
      localDb.taskReceipts.where("personId").equals(actorId).toArray(),
      localDb.sites.toArray(),
    ]);
    return {
      mine,
      // Requests I sent to someone else (material requests, follow-ups).
      requests: created.filter((t) => t.assigneeId !== actorId),
      receipts: new Map(receipts.map((r) => [r.taskId, r])),
      sites: new Map(sites.map((s) => [s.id, s.name])),
    };
  }, [actorId]);

  if (meta && !actorId) {
    return (
      <p className="text-lg">
        No one selected.{" "}
        <Link className="font-bold underline" href="/">
          Pick a person
        </Link>
        .
      </p>
    );
  }

  const visible = data ? data.mine.filter(FILTERS[filter].test) : [];
  const groups = data ? groupTasks(visible, now, BRANCH_TIMEZONE) : null;
  const counts = data ? Object.fromEntries(Object.entries(FILTERS).map(([k, f]) => [k, data.mine.filter(f.test).length])) : {};

  return (
    <>
      <PageTitle sub={actor ? `${actor.name} · ${actor.role}` : "Loading…"}>My tasks</PageTitle>

      <NotificationsCard compact />

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter tasks">
        {(Object.keys(FILTERS) as FilterKey[]).map((k) => (
          <Chip key={k} active={filter === k} onClick={() => setFilter(k)} data-testid={`filter-${k}`}>
            {FILTERS[k].label} ({counts[k] ?? 0})
          </Chip>
        ))}
      </div>

      {!groups ? (
        <p className="text-slate-700">Loading from this device…</p>
      ) : data!.mine.length === 0 ? (
        <p className="text-slate-700">No tasks on this device yet. Tap the bar at the top to sync.</p>
      ) : (
        GROUPS.map(({ key, label, alwaysShow }) => {
          const list = groups[key];
          if (!list.length && (!alwaysShow || filter !== "all")) return null;
          const red = key === "overdue";
          return (
            <section key={key} className="space-y-2" data-testid={`group-${key}`}>
              <h2 className={cn("flex items-center gap-2 text-xl font-bold", red ? "text-red-700" : "text-slate-950")}>
                {label}
                <span
                  className={cn(
                    "rounded-full px-2.5 text-base",
                    red ? "bg-red-700 text-white" : "bg-slate-800 text-white",
                  )}
                >
                  {list.length}
                </span>
              </h2>
              {list.length === 0 ? (
                <p className="text-base text-slate-600">Nothing here.</p>
              ) : (
                <ul className="space-y-2">
                  {list.map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      siteName={data!.sites.get(t.siteId)}
                      receipt={data!.receipts.get(t.id)}
                      overdue={isOverdue(t, now, BRANCH_TIMEZONE)}
                      pending={pending.tasks.has(t.id) || t.seq === undefined}
                      showDate={key !== "today"}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}

      {data && data.requests.length > 0 && filter === "all" && (
        <section className="space-y-2" data-testid="group-requests">
          <h2 className="text-xl font-bold">My requests ({data.requests.length})</h2>
          <ul className="space-y-2">
            {data.requests.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                siteName={data.sites.get(t.siteId)}
                receipt={undefined}
                overdue={false}
                pending={pending.tasks.has(t.id) || t.seq === undefined}
                showDate
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
