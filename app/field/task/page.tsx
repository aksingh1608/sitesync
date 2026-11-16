"use client";
// Task detail: /field/task?id=<taskId>. One route (not /field/tasks/[id]) so
// the service worker can precache a single shell that works for every task
// offline, including tasks that arrived after the app was installed.
import { useLiveQuery } from "dexie-react-hooks";
import { CheckCircle2, MapPin, Navigation } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { usePendingRefs } from "@/components/field/hooks";
import { PhotoInput, useObjectUrl } from "@/components/field/photo-input";
import { receiptStage, StatusPill } from "@/components/field/task-card";
import { BigButton, BigLink, Field, inputClass, PageTitle, Panel, Pill, PRIORITY_STYLE, WaitingMarker } from "@/components/field/ui";
import { formatTime, useMeta } from "@/components/use-local";
import { localDb } from "@/lib/db/local";
import { STATUS_TRANSITIONS, type TaskStatus } from "@/lib/domain";
import { enqueue, LocalRejectError, markSeen } from "@/lib/sync/client";
import { saveNote } from "@/lib/sync/media";
import { canActOnTask } from "@/lib/sync/reducers";

export default function TaskPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <TaskDetail />
    </Suspense>
  );
}

function directionsUrl(lat: number, lng: number) {
  const apple = typeof navigator !== "undefined" && /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  return apple
    ? `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`
    : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

function TaskDetail() {
  const id = useSearchParams().get("id") ?? "";
  const meta = useMeta();
  const actorId = meta?.actorId ?? null;
  const pending = usePendingRefs(actorId);
  const [mode, setMode] = useState<null | "blocked" | "done">(null);
  const [reason, setReason] = useState("");
  const [photo, setPhoto] = useState<Blob | null>(null);
  const photoUrl = useObjectUrl(photo);
  const [error, setError] = useState<string | null>(null);

  const data = useLiveQuery(async () => {
    if (!id || !actorId) return null;
    const task = await localDb.tasks.get(id);
    if (!task) return { task: undefined };
    const [site, creator, actor, receipt, notes] = await Promise.all([
      localDb.sites.get(task.siteId),
      localDb.people.get(task.createdBy),
      localDb.people.get(actorId),
      localDb.taskReceipts.get([task.id, task.assigneeId]),
      localDb.fieldNotes.where("taskId").equals(task.id).toArray(),
    ]);
    return { task, site, creator, actor, receipt, notes: notes.sort((a, b) => +b.createdAt - +a.createdAt) };
  }, [id, actorId]);

  // task.seen: once, the first time this person opens the task on this device.
  const taskLoaded = !!data?.task;
  useEffect(() => {
    if (taskLoaded) void markSeen(id).catch(() => {});
  }, [id, taskLoaded]);

  if (data === undefined || meta === undefined) return <p>Loading…</p>;
  if (!data?.task) {
    return (
      <Panel>
        <p className="font-semibold">This task is not on this device.</p>
        <p className="text-base text-slate-700">It may have been reassigned, or it has not synced yet.</p>
        <BigLink href="/field">Back to tasks</BigLink>
      </Panel>
    );
  }
  const { task, site, creator, actor, receipt, notes } = data;
  const mine = task.assigneeId === actorId;
  const canAct = !!actor && canActOnTask(actor, task);
  const allowed = STATUS_TRANSITIONS[task.status];
  const can = (to: TaskStatus) => canAct && allowed.includes(to) && task.status !== to;
  const stage = receiptStage(receipt);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      setMode(null);
      setReason("");
      setPhoto(null);
    } catch (e) {
      setError(e instanceof LocalRejectError ? `Not allowed: ${e.reason}` : e instanceof Error ? e.message : String(e));
    }
  }
  const setStatus = (to: TaskStatus, why?: string) =>
    enqueue({ type: "task.status_changed", payload: { taskId: task.id, to, ...(why ? { reason: why } : {}) } });

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={task.status} />
        <Pill className={PRIORITY_STYLE[task.priority]}>{task.priority}</Pill>
        {task.kind !== "task" && <Pill className="border border-slate-500 bg-white">{task.kind.replace("_", " ")}</Pill>}
        {(pending.tasks.has(task.id) || task.seq === undefined) && <WaitingMarker />}
      </div>
      <PageTitle>{task.title}</PageTitle>
      {task.description && <p className="whitespace-pre-wrap text-lg">{task.description}</p>}

      <Panel>
        <div className="flex items-start gap-2">
          <MapPin className="mt-1 size-6 shrink-0" aria-hidden />
          <div>
            <div className="font-bold">{site?.name ?? "Unknown site"}</div>
            <div className="text-base text-slate-800">{site?.address}</div>
          </div>
        </div>
        {site && (
          <a
            href={directionsUrl(site.lat, site.lng)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-12 items-center justify-center gap-2 rounded-xl border-2 border-slate-800 bg-white text-lg font-bold"
          >
            <Navigation className="size-5" aria-hidden /> Directions
          </a>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
          <dt className="font-semibold">Due</dt>
          <dd>{formatTime(task.dueAt)}</dd>
          <dt className="font-semibold">Assigned by</dt>
          <dd>{creator?.name ?? "—"}</dd>
        </dl>
      </Panel>

      {mine && stage !== "acknowledged" && (
        <BigButton tone="success" className="min-h-16 text-xl" onClick={() => run(() => enqueue({ type: "task.acknowledged", payload: { taskId: task.id } }))} data-testid="ack">
          <CheckCircle2 className="size-7" aria-hidden /> Got it
        </BigButton>
      )}

      {canAct && mode === null && (can("in_progress") || can("blocked") || can("done")) && (
        <div className="grid grid-cols-3 gap-2">
          <BigButton tone="primary" disabled={!can("in_progress")} onClick={() => run(() => setStatus("in_progress"))}>
            Start
          </BigButton>
          <BigButton tone="warning" disabled={!can("blocked")} onClick={() => setMode("blocked")}>
            Blocked
          </BigButton>
          <BigButton tone="success" disabled={!can("done")} onClick={() => setMode("done")}>
            Done
          </BigButton>
        </div>
      )}

      {mode === "blocked" && (
        <Panel>
          <Field label="What is blocking you?">
            <textarea className={inputClass} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </Field>
          <BigButton tone="warning" disabled={!reason.trim()} onClick={() => run(() => setStatus("blocked", reason.trim()))}>
            Mark blocked
          </BigButton>
          <BigButton tone="neutral" onClick={() => setMode(null)}>Cancel</BigButton>
        </Panel>
      )}

      {mode === "done" && (
        <Panel>
          <p className="font-semibold">Add a photo of the finished work? (optional)</p>
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl} alt="Finished work" className="max-h-64 w-full rounded-lg object-contain" />
          ) : (
            <PhotoInput onPhoto={setPhoto} />
          )}
          <BigButton
            tone="success"
            onClick={() =>
              run(async () => {
                if (photo) {
                  await saveNote({ kind: "photo", siteId: task.siteId, taskId: task.id, text: "Completion photo", media: { blob: photo, mimeType: "image/jpeg" } });
                }
                await setStatus("done");
              })
            }
          >
            {photo ? "Mark done with photo" : "Mark done"}
          </BigButton>
          <BigButton tone="neutral" onClick={() => { setMode(null); setPhoto(null); }}>Cancel</BigButton>
        </Panel>
      )}

      {error && <p className="rounded-lg bg-red-100 p-3 font-semibold text-red-800">{error}</p>}

      <div className="grid grid-cols-2 gap-2">
        <BigLink href={`/field/notes?taskId=${task.id}`}>Add note</BigLink>
        <BigLink href={`/field/request?taskId=${task.id}`}>Request material</BigLink>
      </div>

      <Panel aria-label="Receipt timeline">
        <h2 className="text-xl font-bold">Receipt</h2>
        <ol className="space-y-2">
          {(
            [
              ["Sent", receipt?.sentAt],
              ["Delivered to device", receipt?.deliveredAt],
              ["Seen", receipt?.seenAt],
              ["Acknowledged", receipt?.acknowledgedAt],
            ] as const
          ).map(([label, at]) => (
            <li key={label} className="flex items-center gap-3 text-base">
              <span className={at ? "size-4 rounded-full bg-green-700" : "size-4 rounded-full border-2 border-slate-400"} aria-hidden />
              <span className="font-semibold">{label}</span>
              <span className="ml-auto text-slate-800">{at ? formatTime(at) : "—"}</span>
            </li>
          ))}
        </ol>
      </Panel>

      {notes.length > 0 && (
        <Panel>
          <h2 className="text-xl font-bold">Notes on this task</h2>
          <ul className="space-y-2 text-base">
            {notes.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center gap-2">
                <span className="font-semibold capitalize">{n.kind}</span>
                <span>{n.text ?? (n.mediaId ? "attached" : "")}</span>
                <span className="text-slate-700">{formatTime(n.createdAt)}</span>
                {(pending.notes.has(n.id) || n.seq === undefined) && <WaitingMarker />}
              </li>
            ))}
          </ul>
          <Link href="/field/notes" className="font-bold underline">All notes</Link>
        </Panel>
      )}
    </>
  );
}
