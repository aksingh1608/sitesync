"use client";
// Team page charts, split out so recharts loads only with them (next/dynamic).
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";

const C = { completed: "#2563eb", ack: "#0d9488", overdue: "#f59e0b", blocked: "#dc2626" };

type Row = { name: string; completed: number; medianAckMin: number | null; overdue: number; blocked: number };

export default function TeamCharts({ daily, people, sites }: { daily: { day: string; completed: number }[]; people: Row[]; sites: Row[] }) {
  return (
          <div className="grid gap-4 lg:grid-cols-2">
            <Chart title="Completed per day">
              <LineChart responsive style={{ width: "100%", height: 220 }} data={daily.map((d) => ({ ...d, label: d.day.slice(5) }))}>
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
