"use client";
import Link from "next/link";
// Developer/demo console for the sync engine. Reads only from Dexie.
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { SyncStatus } from "@/components/sync-status";
import { formatTime, useActor, useMeta } from "@/components/use-local";
import { BRANCH_TIMEZONE } from "@/lib/config";
import { localDb } from "@/lib/db/local";
import { isOfficeRole } from "@/lib/domain";
import { groupTasks } from "@/lib/tasks/grouping";
import { dayKey, zonedTime } from "@/lib/time";
import { enqueue, resetLocalData, setSimulateOffline, sync } from "@/lib/sync/client";
import { uuidv4 } from "@/lib/uuid";

export default function DebugPage() {
  const meta = useMeta();
  const actorId = meta?.actorId ?? null;
  const actor = useActor(actorId);
  const outbox = useLiveQuery(() => localDb.outbox.orderBy("seq").toArray(), []);
  const counts = useLiveQuery(
    async () => ({
      tasks: await localDb.tasks.count(),
      receipts: await localDb.taskReceipts.count(),
      timeEntries: await localDb.timeEntries.count(),
      sites: await localDb.sites.count(),
      people: await localDb.people.count(),
    }),
    [],
  );
  const [message, setMessage] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const run = async (label: string, fn: () => Promise<string>) => {
    try {
      setMessage(`${label}: ${await fn()}`);
    } catch (e) {
      setMessage(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  async function createTestTask() {
    if (!actor) throw new Error("no actor selected");
    const [sites, people, mine] = await Promise.all([
      localDb.sites.orderBy("id").toArray(),
      localDb.people.toArray(),
      localDb.tasks.where("assigneeId").equals(actor.id).first(),
    ]);
    const site = sites.find((s) => s.id === mine?.siteId) ?? sites[0];
    if (!site) throw new Error("no sites on this device yet; sync first");
    const assignee = isOfficeRole(actor.role) ? people.find((p) => p.role === "technician") : actor;
    if (!assignee) throw new Error("no technician on this device");
    const due = zonedTime(dayKey(new Date(), BRANCH_TIMEZONE), 17, 0, BRANCH_TIMEZONE);
    const stamp = new Date().toLocaleTimeString();
    await enqueue({
      type: "task.created",
      payload: {
        taskId: uuidv4(),
        title: `Test task ${stamp}`,
        description: "Created from /debug",
        siteId: site.id,
        assigneeId: assignee.id,
        dueAt: due.toISOString(),
      },
    });
    return `queued for ${assignee.name} at ${site.name}`;
  }

  async function acknowledgeFirst() {
    if (!actorId) throw new Error("no actor selected");
    const [tasks, receipts] = await Promise.all([
      localDb.tasks.where("assigneeId").equals(actorId).toArray(),
      localDb.taskReceipts.where("personId").equals(actorId).toArray(),
    ]);
    const acked = new Set(receipts.filter((r) => r.acknowledgedAt).map((r) => r.taskId));
    const g = groupTasks(tasks, new Date(), BRANCH_TIMEZONE);
    const target = [...g.today, ...g.thisWeek, ...g.thisMonth, ...g.followUps, ...g.later].find(
      (t) => !acked.has(t.id),
    );
    if (!target) return "no unacknowledged task assigned to you";
    await enqueue({ type: "task.acknowledged", payload: { taskId: target.id } });
    return `acknowledged "${target.title}"`;
  }

  const pending = outbox?.filter((i) => i.status === "pending") ?? [];
  const rejected = outbox?.filter((i) => i.status === "rejected") ?? [];

  return (
    <main className="mx-auto w-full max-w-3xl p-4 space-y-4">
      <header className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-semibold">Sync debug</h1>
          <nav className="flex gap-3 text-sm">
            <Link className="underline" href="/field">
              Field
            </Link>
            <Link className="underline" href="/">
              Switch person
            </Link>
          </nav>
        </div>
        <SyncStatus />
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Device</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">deviceId</dt>
            <dd className="font-mono break-all" data-testid="device-id">{meta?.deviceId || "—"}</dd>
            <dt className="text-muted-foreground">actor</dt>
            <dd>
              {actor ? `${actor.name} (${actor.role})` : (actorId ?? "none")}
              {actorId && <span className="ml-2 font-mono text-xs text-muted-foreground">{actorId}</span>}
            </dd>
            <dt className="text-muted-foreground">cursor</dt>
            <dd className="font-mono" data-testid="cursor">{meta?.cursor ?? "null"}</dd>
            <dt className="text-muted-foreground">last sync</dt>
            <dd>{formatTime(meta?.lastSyncAt)}</dd>
            <dt className="text-muted-foreground">cache</dt>
            <dd className="text-xs">
              {counts &&
                `${counts.tasks} tasks · ${counts.receipts} receipts · ${counts.timeEntries} time entries · ${counts.sites} sites · ${counts.people} people`}
            </dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Actions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-3 text-sm">
            <Switch
              checked={meta?.simulateOffline ?? false}
              onCheckedChange={(v) => void setSimulateOffline(v)}
              data-testid="simulate-offline"
            />
            Simulate offline (sync never calls the network)
          </label>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => run("Sync", async () => JSON.stringify(await sync({ manual: true })))}>
              Sync now
            </Button>
            <Button variant="secondary" onClick={() => run("Create test task", createTestTask)}>
              Create test task
            </Button>
            <Button variant="secondary" onClick={() => run("Acknowledge", acknowledgeFirst)}>
              Acknowledge first task
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!confirmReset) {
                  setConfirmReset(true);
                  return;
                }
                await resetLocalData();
                // A full reload on purpose: the IndexedDB database was just deleted.
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                window.location.assign("/");
              }}
              onBlur={() => setConfirmReset(false)}
            >
              {confirmReset ? "Click again: deletes unsynced events too" : "Reset local data"}
            </Button>
          </div>
          {message && (
            <p className="text-sm break-all" data-testid="debug-message">
              {message}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Outbox <Badge variant="outline" data-testid="outbox-count">{pending.length} pending</Badge>{" "}
            {rejected.length > 0 && <Badge variant="destructive">{rejected.length} rejected</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!outbox?.length ? (
            <p className="text-sm text-muted-foreground">Empty. Everything on this device has reached the server.</p>
          ) : (
            <ul className="space-y-2 text-xs">
              {outbox.map((i) => (
                <li key={i.id} className="rounded border p-2 space-y-1" data-testid="outbox-item">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={i.status === "rejected" ? "destructive" : "outline"}>{i.status}</Badge>
                    <span className="font-mono font-semibold">{i.type}</span>
                    <span className="text-muted-foreground">{formatTime(i.createdAt)}</span>
                    <span className="text-muted-foreground">attempts: {i.attempts}</span>
                    {i.actorId !== actorId && <Badge variant="secondary">other actor</Badge>}
                  </div>
                  <div className="font-mono text-muted-foreground break-all">{i.id}</div>
                  {i.lastError && <div className="text-amber-700">last error: {i.lastError}</div>}
                  {i.rejectReason && <div className="text-destructive">rejected: {i.rejectReason}</div>}
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">payload</summary>
                    <pre className="overflow-x-auto">{JSON.stringify(i.event.payload, null, 2)}</pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Last sync result</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto text-xs" data-testid="last-sync">
            {JSON.stringify(meta?.lastSyncResult ?? null, null, 2)}
          </pre>
        </CardContent>
      </Card>
    </main>
  );
}
