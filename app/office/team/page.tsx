"use client";
// Team stats for a date range, aggregated on the server in SQL.
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { UpdatedAgo, usePolling, useSnapshot } from "@/components/office/data";
import { inputClass, PageHeader } from "@/components/office/ui";
import { BRANCH_TIMEZONE } from "@/lib/config";
import type { TeamStats } from "@/lib/office/queries";
import { addDays, dayKey } from "@/lib/time";

const STATS_POLL_MS = 60_000; // aggregates change slowly
// Explicit colours: this theme's --chart-* tokens are greys, which made Overdue and Blocked unreadable.
const C = { completed: "#2563eb", ack: "#0d9488", overdue: "#f59e0b", blocked: "#dc2626" };

export default function TeamPage() {
  const today = dayKey(new Date(), BRANCH_TIMEZONE);
  const [range, setRange] = useState({ from: addDays(today, -29), to: today });
  const { data: snap } = useSnapshot();
  const { data, error, updatedAt } = usePolling<TeamStats>(`/api/office/team?from=${range.from}&to=${range.to}`, STATS_POLL_MS);
  const name = useMemo(() => new Map((snap?.people ?? []).map((p) => [p.id, p.name])), [snap]);
  const siteName = useMemo(() => new Map((snap?.sites ?? []).map((s) => [s.id, s.name.replace(/^RetailCo /, "").replace(/ - .*/, "")])), [snap]);
  const preset = (days: number) => setRange({ from: addDays(today, -(days - 1)), to: today });

  const people = (data?.person ?? [])
    .map((p) => ({ ...p, name: name.get(p.key) ?? "?" }))
    .sort((a, b) => b.completed - a.completed || a.name.localeCompare(b.name));
  const sites = (data?.site ?? [])
    .map((s) => ({ ...s, name: siteName.get(s.key) ?? "?" }))
    .filter((s) => s.overdue || s.blocked || s.completed)
    .sort((a, b) => b.overdue + b.blocked - (a.overdue + a.blocked));

  return (
    <>
      <PageHeader title="Team">
        <UpdatedAgo at={updatedAt} error={error} />
        <div className="flex items-end gap-2">
          <label className="text-xs text-muted-foreground">From
            <input type="date" className={inputClass} value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} />
          </label>
          <label className="text-xs text-muted-foreground">To
            <input type="date" className={inputClass} value={range.to} min={range.from} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} />
          </label>
          {[7, 30, 90].map((n) => (
            <button key={n} className="h-8 rounded-md border px-2 text-xs hover:bg-muted" onClick={() => preset(n)}>Last {n} days</button>
          ))}
        </div>
      </PageHeader>
      {!data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2 text-sm" data-testid="branch-stats">
            <Stat label="Tasks completed" value={data.branch.completed} />
            <Stat label="Median sent → acknowledged" value={data.branch.medianAckMin === null ? "—" : `${data.branch.medianAckMin} min`} />
            <Stat label="Overdue (due in range, still open)" value={data.branch.overdue} />
            <Stat label="Blocked now" value={data.branch.blocked} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Chart title="Completed per day">
              <LineChart responsive style={{ width: "100%", height: 220 }} data={data.daily.map((d) => ({ ...d, label: d.day.slice(5) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" fontSize={11} interval="preserveStartEnd" />
                <YAxis allowDecimals={false} fontSize={11} width={28} />
                <Tooltip />
                <Line type="monotone" dataKey="completed" name="Completed" stroke={C.completed} strokeWidth={2} dot={false} />
              </LineChart>
            </Chart>
            <Chart title="Completed per person">
              <BarChart responsive style={{ width: "100%", height: 220 }} data={people}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" fontSize={11} />
                <YAxis allowDecimals={false} fontSize={11} width={28} />
                <Tooltip />
                <Bar dataKey="completed" name="Completed" fill={C.completed} />
              </BarChart>
            </Chart>
            <Chart title="Median minutes from sent to acknowledged">
              <BarChart responsive style={{ width: "100%", height: 220 }} data={people.filter((p) => p.medianAckMin !== null)}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" fontSize={11} />
                <YAxis fontSize={11} width={36} />
                <Tooltip />
                <Bar dataKey="medianAckMin" name="Median minutes" fill={C.ack} />
              </BarChart>
            </Chart>
            <Chart title="Overdue and blocked per site">
              <BarChart responsive style={{ width: "100%", height: 220 }} data={sites}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" fontSize={11} />
                <YAxis allowDecimals={false} fontSize={11} width={28} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="overdue" name="Overdue" stackId="a" fill={C.overdue} />
                <Bar dataKey="blocked" name="Blocked" stackId="a" fill={C.blocked} />
              </BarChart>
            </Chart>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm" data-testid="team-table">
              <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Person</th>
                  <th className="px-2 py-1.5 text-right font-medium">Completed</th>
                  <th className="px-2 py-1.5 text-right font-medium">Median ack (min)</th>
                  <th className="px-2 py-1.5 text-right font-medium">Overdue</th>
                  <th className="px-2 py-1.5 text-right font-medium">Blocked</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {people.map((p) => (
                  <tr key={p.key} className="border-t">
                    <td className="px-2 py-1.5">{p.name}</td>
                    <td className="px-2 py-1.5 text-right">{p.completed}</td>
                    <td className="px-2 py-1.5 text-right">{p.medianAckMin ?? "—"}</td>
                    <td className="px-2 py-1.5 text-right">{p.overdue}</td>
                    <td className="px-2 py-1.5 text-right">{p.blocked}</td>
                  </tr>
                ))}
                <tr className="border-t bg-muted/40 font-medium">
                  <td className="px-2 py-1.5">Branch</td>
                  <td className="px-2 py-1.5 text-right">{data.branch.completed}</td>
                  <td className="px-2 py-1.5 text-right">{data.branch.medianAckMin ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right">{data.branch.overdue}</td>
                  <td className="px-2 py-1.5 text-right">{data.branch.blocked}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Branch days ({BRANCH_TIMEZONE}), {data.from} to {data.to}. Completed = closed as done in the range. Median uses receipts sent in the range.
          </p>
        </div>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="min-w-44 flex-1 rounded-lg border p-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Chart({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border p-3">
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}
