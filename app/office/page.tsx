"use client";
// Live board: one card per active site, plus "Not clocked in". Refreshes every 5 s.
import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { UpdatedAgo, useSnapshot, type Snap } from "@/components/office/data";
import { AlertsPanel } from "@/components/office/escalations";
import { fmtTime, Kpi, PageHeader, Pill, WORKER_STATUS_LABEL } from "@/components/office/ui";
import { derive } from "@/lib/office/derive";
import { agoLabel, freshness } from "@/lib/office/rules";
import { cn } from "@/lib/utils";

export default function BoardPage() {
  const { data, error, updatedAt } = useSnapshot();
  const router = useRouter();
  useEffect(() => {
    if (data?.actor.role === "hr") router.replace("/office/timesheets");
  }, [data?.actor.role, router]);

  return (
    <>
      <PageHeader title="Live board">
        <UpdatedAgo at={updatedAt} error={error} />
      </PageHeader>
      {data ? <Board snap={data} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </>
  );
}

function Board({ snap }: { snap: Snap }) {
  const d = useMemo(() => derive(snap), [snap]);
  const lanes = useMemo(() => {
    const bySite = new Map<string, string[]>();
    for (const e of snap.openEntries) bySite.set(e.siteId, [...(bySite.get(e.siteId) ?? []), e.personId]);
    const active = snap.sites
      .map((s) => ({ site: s, workers: bySite.get(s.id) ?? [], open: d.open.filter((t) => t.siteId === s.id) }))
      .filter((l) => l.workers.length || l.open.length)
      .sort((a, b) => b.workers.length - a.workers.length || b.open.length - a.open.length || a.site.name.localeCompare(b.site.name));
    const off = d.fieldPeople.filter((p) => !d.openEntry.has(p.id)).map((p) => p.id);
    return { active, off, quiet: snap.sites.length - active.length };
  }, [snap, d]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Kpi label="Clocked in now" value={d.counts.clockedIn} href="/office/tasks?view=clocked_in" testId="kpi-clocked-in" />
        <Kpi label="Tasks overdue" value={d.counts.overdue} href="/office/tasks?view=overdue" tone="red" testId="kpi-overdue" />
        <Kpi label="Not acknowledged" value={d.counts.unacked} href="/office/tasks?view=unacked" tone="amber" testId="kpi-unacked" />
        <Kpi label="Blocked" value={d.counts.blocked} href="/office/tasks?view=blocked" tone="red" testId="kpi-blocked" />
        <Kpi label="Open material requests" value={d.counts.materials} href="/office/tasks/materials" testId="kpi-materials" />
      </div>

      <AlertsPanel snap={snap} />

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))]">
        {lanes.active.map(({ site, workers, open }) => (
          <section key={site.id} className="rounded-lg border p-3" data-testid="board-site">
            <header className="mb-2">
              <h2 className="text-sm font-semibold leading-tight">{site.name}</h2>
              <p className="text-xs text-muted-foreground">
                {open.length} open task{open.length === 1 ? "" : "s"}
                {open.some((t) => t.status === "blocked") && " · has blocked work"}
              </p>
            </header>
            {workers.length ? (
              <ul className="space-y-2">{workers.map((id) => <Worker key={id} id={id} d={d} />)}</ul>
            ) : (
              <p className="text-xs text-muted-foreground">Nobody clocked in here.</p>
            )}
          </section>
        ))}
        <section className="rounded-lg border border-dashed p-3" data-testid="board-unassigned">
          <header className="mb-2">
            <h2 className="text-sm font-semibold">Not clocked in</h2>
            <p className="text-xs text-muted-foreground">Field workers without an open clock-in</p>
          </header>
          <ul className="space-y-2">{lanes.off.map((id) => <Worker key={id} id={id} d={d} />)}</ul>
        </section>
      </div>
      {lanes.quiet > 0 && <p className="text-xs text-muted-foreground">{lanes.quiet} other sites have no open work and nobody clocked in.</p>}
    </div>
  );
}

function Worker({ id, d }: { id: string; d: ReturnType<typeof derive<Snap>> }) {
  const p = d.person.get(id);
  if (!p) return null;
  const entry = d.openEntry.get(id);
  const status = d.status.get(id);
  const synced = d.lastSync.get(id) ?? null;
  const fresh = freshness(synced, d.now);
  const c = d.workerCounts(id);
  return (
    <li className="rounded-md bg-muted/50 p-2 text-sm" data-testid={`worker-${id}`}>
      <div className="flex items-baseline gap-2">
        <span className="font-medium">{p.name}</span>
        <span className="text-xs text-muted-foreground">{p.trade} · {p.role}</span>
        {status?.status && <Pill tone="blue" className="ml-auto">{WORKER_STATUS_LABEL[status.status]}</Pill>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span>{entry ? `Clocked in since ${fmtTime(entry.clockInAt)}` : "Not clocked in"}</span>
        <span
          className={cn(fresh === "fresh" ? "text-muted-foreground" : fresh === "stale" ? "text-amber-700 dark:text-amber-400" : "text-red-700 dark:text-red-400")}
          title="When this person's device last reached the server. Not a live online indicator."
        >
          Last synced {agoLabel(synced, d.now)}
        </span>
      </div>
      {status?.note && <p className="mt-1 text-xs italic text-muted-foreground">“{status.note}”</p>}
      <div className="mt-1 flex gap-1.5 text-xs">
        <Pill>{c.open} open</Pill>
        {c.overdue > 0 && <Pill tone="red">{c.overdue} overdue</Pill>}
        {c.blocked > 0 && <Pill tone="red">{c.blocked} blocked</Pill>}
      </div>
    </li>
  );
}
