"use client";
// HR timesheets: "Needs review" first, then the selected week per person.
// Approve / reject are time.approved / time.rejected events (HR and managers only).
import { useMemo, useState } from "react";
import { sendEvents, UpdatedAgo, usePolling, useSnapshot, type Json } from "@/components/office/data";
import { capabilities, ErrorLine, fmtDay, fmtTime, inputClass, PageHeader, Pill } from "@/components/office/ui";
import { BRANCH_TIMEZONE } from "@/lib/config";
import type { Timesheets } from "@/lib/office/queries";
import { entryFlags, entryHours, FLAG_LABEL } from "@/lib/office/rules";
import { timesheetRows } from "@/lib/office/timesheets";
import { addDays, dayKey, startOfWeekKey } from "@/lib/time";
import { cn } from "@/lib/utils";

type Data = Json<Timesheets> & { now: string };
type Entry = Data["review"][number];

export default function TimesheetsPage() {
  const { data: snap } = useSnapshot();
  const [week, setWeek] = useState(() => startOfWeekKey(dayKey(new Date(), BRANCH_TIMEZONE)));
  const { data, error, updatedAt, refresh } = usePolling<Data>(`/api/office/timesheets?week=${week}`);
  const thisWeek = startOfWeekKey(dayKey(new Date(), BRANCH_TIMEZONE));
  const can = snap ? capabilities(snap.actor.role) : null;

  return (
    <>
      <PageHeader title="Timesheets">
        <UpdatedAgo at={updatedAt} error={error} />
        <div className="flex items-center gap-1">
          <button className="h-8 rounded-md border px-2" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">←</button>
          <span className="min-w-40 text-center font-medium" data-testid="week-label">Week of {fmtDay(`${week}T12:00:00Z`)}</span>
          <button className="h-8 rounded-md border px-2" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week">→</button>
          {week !== thisWeek && <button className="h-8 px-2 text-muted-foreground hover:underline" onClick={() => setWeek(thisWeek)}>This week</button>}
        </div>
        <a href={`/api/office/timesheets?week=${week}&format=csv`} className="h-8 rounded-md border px-3 leading-8 hover:bg-muted" data-testid="export-csv" download>
          Export CSV
        </a>
      </PageHeader>
      <p className="mb-4 rounded-md bg-muted/60 px-3 py-2 text-sm">
        Location is recorded only at clock-in and clock-out. No tracking in between.
        {can && !can.reviewTime && " Approval is done by HR or a manager; this view is read-only."}
      </p>
      {!data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <Review data={data} canReview={!!can?.reviewTime} actorId={snap?.actor.id ?? ""} onChange={refresh} />
          <Week data={data} />
        </>
      )}
    </>
  );
}

function Review({ data, canReview, actorId, onChange }: { data: Data; canReview: boolean; actorId: string; onChange: () => Promise<void> }) {
  const now = new Date(data.now);
  const name = new Map(data.people.map((p) => [p.id, p.name]));
  const site = new Map(data.sites.map((s) => [s.id, s.name]));
  const list = data.review.filter((e) => entryFlags(e, now).length > 0);
  return (
    <section className="mb-6" data-testid="needs-review">
      <h2 className="mb-2 font-semibold">Needs review ({list.length})</h2>
      {list.length === 0 && <p className="text-sm text-muted-foreground">Nothing flagged in the last 30 days.</p>}
      <div className="space-y-2">
        {list.map((e) => (
          <ReviewRow key={e.id} e={e} now={now} who={name.get(e.personId) ?? ""} where={site.get(e.siteId) ?? ""} canReview={canReview} actorId={actorId} onChange={onChange} />
        ))}
      </div>
    </section>
  );
}

function ReviewRow({ e, now, who, where, canReview, actorId, onChange }: { e: Entry; now: Date; who: string; where: string; canReview: boolean; actorId: string; onChange: () => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flags = entryFlags(e, now);
  async function decide(approve: boolean) {
    if (!approve && !reason.trim()) return setError("Give a reason to reject.");
    setBusy(true);
    const r = await sendEvents(actorId, [
      approve ? { type: "time.approved", payload: { timeEntryId: e.id } } : { type: "time.rejected", payload: { timeEntryId: e.id, reason: reason.trim() } },
    ]);
    setBusy(false);
    setError(r.ok ? null : r.error);
    if (r.ok) await onChange();
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 p-3 text-sm" data-testid={`review-${e.id}`}>
      <div className="min-w-60 flex-1">
        <div className="font-medium">{who} · {fmtDay(e.clockInAt)}</div>
        <div className="text-xs text-muted-foreground">
          {where} · {fmtTime(e.clockInAt)}–{e.clockOutAt ? fmtTime(e.clockOutAt) : "no clock-out"} · {entryHours(e, now).toFixed(1)} h
          {e.clockInDistanceM !== null && ` · ${Math.round(e.clockInDistanceM)} m from site at clock-in`}
          {!e.safetyCheckDone && " · safety check not done"}
        </div>
      </div>
      <div className="flex gap-1">{flags.map((f) => <Pill key={f} tone="amber">{FLAG_LABEL[f]}</Pill>)}</div>
      {canReview && (
        <div className="flex items-center gap-1.5">
          <button disabled={busy || !e.clockOutAt} title={e.clockOutAt ? "" : "No clock-out yet: reject it, or wait"} onClick={() => decide(true)} className="h-7 rounded-md border border-green-600 px-2 text-xs text-green-800 hover:bg-green-50 disabled:opacity-40 dark:text-green-300" data-testid="approve">
            Approve
          </button>
          <input className={cn(inputClass, "h-7 w-44 text-xs")} placeholder="Reason (to reject)" value={reason} onChange={(ev) => setReason(ev.target.value)} data-testid="reject-reason" />
          <button disabled={busy} onClick={() => decide(false)} className="h-7 rounded-md border border-red-600 px-2 text-xs text-red-800 hover:bg-red-50 disabled:opacity-40 dark:text-red-300" data-testid="reject">
            Reject
          </button>
        </div>
      )}
      {error && <div className="w-full"><ErrorLine error={error} /></div>}
    </div>
  );
}

function Week({ data }: { data: Data }) {
  const now = new Date(data.now);
  const rows = useMemo(() => timesheetRows(data, now), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const byPerson = useMemo(() => {
    const m = new Map<string, typeof rows>();
    for (const r of rows) m.set(r.person, [...(m.get(r.person) ?? []), r]);
    return [...m.entries()];
  }, [rows]);
  return (
    <section>
      <h2 className="mb-2 font-semibold">Week</h2>
      {byPerson.length === 0 && <p className="text-sm text-muted-foreground">No clock-ins this week.</p>}
      <div className="space-y-4">
        {byPerson.map(([person, list]) => (
          <div key={person} className="overflow-x-auto rounded-lg border">
            <div className="flex items-baseline justify-between bg-muted/60 px-2 py-1.5 text-sm">
              <span className="font-medium">{person}</span>
              <span className="tabular-nums text-muted-foreground">{list.reduce((n, r) => n + r.hours, 0).toFixed(2)} h</span>
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 font-medium">Day</th>
                  <th className="px-2 py-1 font-medium">Site</th>
                  <th className="px-2 py-1 font-medium">In</th>
                  <th className="px-2 py-1 font-medium">Out</th>
                  <th className="px-2 py-1 font-medium text-right">Hours</th>
                  <th className="px-2 py-1 font-medium text-right">From site</th>
                  <th className="px-2 py-1 font-medium">Safety</th>
                  <th className="px-2 py-1 font-medium">Flags</th>
                  <th className="px-2 py-1 font-medium">Review</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id} className="border-t" data-testid={`entry-${r.id}`}>
                    <td className="px-2 py-1 whitespace-nowrap">{fmtDay(`${r.day}T12:00:00Z`)}</td>
                    <td className="max-w-56 truncate px-2 py-1">{r.site}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{r.clockIn}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{r.clockOut || <span className="text-amber-700">open</span>}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{r.hours.toFixed(2)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{r.distanceM === null ? "no location" : `${r.distanceM} m`}</td>
                    <td className="px-2 py-1">{r.safety ? "✓" : <span className="text-red-700">not done</span>}</td>
                    <td className="px-2 py-1">{r.flags.map((f) => <Pill key={f} tone="amber" className="mr-1">{f}</Pill>)}</td>
                    <td className="px-2 py-1">
                      <Pill tone={r.review === "approved" ? "green" : r.review === "rejected" ? "red" : "slate"}>{r.review}</Pill>
                      {r.reason && <span className="ml-1 text-xs text-muted-foreground">{r.reason}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}
