"use client";
import { useMemo, useState } from "react";
import { BRANCH_TIMEZONE } from "@/lib/config";
import { STATUS_TRANSITIONS, TASK_KINDS, TASK_PRIORITIES, TRADES, type TaskKind, type TaskPriority, type TaskStatus, type Trade } from "@/lib/domain";
import { derive, isOpen, type TaskView } from "@/lib/office/derive";
import { defaultTradeFor, RECEIPT_STAGES, suggestAssignees } from "@/lib/office/rules";
import type { TaskDetail } from "@/lib/office/queries";
import { fromZonedInput, toZonedInput } from "@/lib/time";
import { uuidv4 } from "@/lib/uuid";
import { cn } from "@/lib/utils";
import { useSnapshot, usePolling, type Json, type Snap } from "./data";
import { EscalationTimeline } from "./escalations";
import {
  capabilities,
  Drawer,
  ErrorLine,
  fmtDateTime,
  inputClass,
  KIND_LABEL,
  MATERIAL_LABEL,
  Pill,
  priorityTone,
  ReceiptChain,
  Select,
  STATUS_LABEL,
  statusTone,
} from "./ui";

type D = ReturnType<typeof derive<Snap>>;
type SnapTask = Snap["tasks"][number];

export const VIEW_LABEL: Record<TaskView, string> = {
  overdue: "Overdue",
  unacked: "Not acknowledged",
  blocked: "Blocked",
  materials: "Open material requests",
  clocked_in: "Assigned to people clocked in now",
};

type Filters = { site: string; assignee: string; status: string; priority: string; kind: string; stage: string };
const NO_FILTERS: Filters = { site: "", assignee: "", status: "active", priority: "", kind: "", stage: "" };

export function TaskTable({ view, onClearView, initialTaskId = null }: { view: TaskView | null; onClearView: () => void; initialTaskId?: string | null }) {
  const { data, send } = useSnapshot();
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [openId, setOpenId] = useState<string | null>(initialTaskId);
  const [creating, setCreating] = useState(false);
  const d = useMemo(() => (data ? derive(data) : null), [data]);
  if (!data || !d) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const can = capabilities(data.actor.role);

  const rows = data.tasks
    .filter((t) => (view ? d.inView(t, view) : true))
    .filter((t) => !f.site || t.siteId === f.site)
    .filter((t) => !f.assignee || t.assigneeId === f.assignee)
    .filter((t) => (f.status === "active" ? isOpen(t) : !f.status || t.status === f.status))
    .filter((t) => !f.priority || t.priority === f.priority)
    .filter((t) => !f.kind || t.kind === f.kind)
    .filter((t) => !f.stage || d.stageOf(t) === f.stage)
    .sort((a, b) => Number(d.ackLate(b)) - Number(d.ackLate(a)) || (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9"));
  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Select label="Site" value={f.site} onChange={set("site")}>
          <option value="">All sites</option>
          {data.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Select label="Assignee" value={f.assignee} onChange={set("assignee")}>
          <option value="">Everyone</option>
          {data.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Select label="Status" value={f.status} onChange={set("status")} data-testid="filter-status">
          <option value="active">Not closed</option>
          <option value="">All</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Select label="Priority" value={f.priority} onChange={set("priority")}>
          <option value="">Any</option>
          {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Select label="Kind" value={f.kind} onChange={set("kind")}>
          <option value="">Any</option>
          {TASK_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </Select>
        <Select label="Receipt reached" value={f.stage} onChange={set("stage")}>
          <option value="">Any</option>
          {RECEIPT_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        {view && (
          <button onClick={onClearView} className="h-8 rounded-md border border-blue-300 bg-blue-50 px-2 text-sm text-blue-900 dark:bg-blue-950 dark:text-blue-100">
            {VIEW_LABEL[view]} ✕
          </button>
        )}
        {(f !== NO_FILTERS) && (
          <button onClick={() => setF(NO_FILTERS)} className="h-8 px-2 text-sm text-muted-foreground hover:underline">Reset filters</button>
        )}
        {can.editTasks && (
          <button onClick={() => setCreating(true)} className="ml-auto h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground" data-testid="new-task">
            New task
          </button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 font-medium">Task</th>
              <th className="px-2 py-1.5 font-medium">Site</th>
              <th className="px-2 py-1.5 font-medium">Assignee</th>
              <th className="px-2 py-1.5 font-medium">Status</th>
              <th className="px-2 py-1.5 font-medium">Due</th>
              <th className="px-2 py-1.5 font-medium">Receipt</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const late = d.ackLate(t);
              return (
                <tr
                  key={t.id}
                  onClick={() => setOpenId(t.id)}
                  className={cn("cursor-pointer border-t hover:bg-muted/50", late && "bg-amber-50 dark:bg-amber-950/30")}
                  data-testid={`task-row-${t.id}`}
                >
                  <td className="max-w-80 px-2 py-1.5">
                    <div className="truncate font-medium">{t.title}</div>
                    <div className="flex gap-1">
                      {t.kind !== "task" && <Pill>{KIND_LABEL[t.kind]}</Pill>}
                      {t.priority !== "normal" && <Pill tone={priorityTone(t.priority)}>{t.priority}</Pill>}
                      {t.kind === "material_request" && <Pill tone="blue">{MATERIAL_LABEL[t.materialStatus ?? "requested"]}</Pill>}
                    </div>
                  </td>
                  <td className="max-w-56 truncate px-2 py-1.5">{d.site.get(t.siteId)?.name}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{d.person.get(t.assigneeId)?.name}</td>
                  <td className="px-2 py-1.5"><Pill tone={statusTone(t.status)}>{STATUS_LABEL[t.status]}</Pill></td>
                  <td className={cn("px-2 py-1.5 whitespace-nowrap", t.dueAt && d.inView(t, "overdue") && "font-medium text-red-700 dark:text-red-400")}>
                    {t.dueAt ? fmtDateTime(t.dueAt) : "—"}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <ReceiptChain receipt={d.receiptOf(t)} warn={late} />
                    {late && <div className="text-[0.7rem] text-amber-800 dark:text-amber-300">Sent over 30 min ago, not acknowledged</div>}
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr><td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">No tasks match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{rows.length} task{rows.length === 1 ? "" : "s"}. Hover a receipt step for its time. Amber rows: sent over 30 minutes ago and not acknowledged (each task&apos;s drawer shows its escalations).</p>

      <Drawer open={creating} onClose={() => setCreating(false)} title="New task">
        <TaskForm d={d} snap={data} onDone={() => setCreating(false)} send={send} />
      </Drawer>
      <Drawer open={!!openId} onClose={() => setOpenId(null)} title={openId ? d.open.concat(data.tasks).find((t) => t.id === openId)?.title ?? "Task" : ""}>
        {openId && <TaskPanel key={openId} taskId={openId} d={d} snap={data} />}
      </Drawer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------
type FormState = { title: string; description: string; siteId: string; assigneeId: string; priority: TaskPriority; kind: TaskKind; due: string };

export function TaskForm({ d, snap, task, onDone, send }: { d: D; snap: Snap; task?: SnapTask & { description?: string }; onDone?: () => void; send: ReturnType<typeof useSnapshot>["send"] }) {
  const initial: FormState = task
    ? {
        title: task.title,
        description: task.description ?? "",
        siteId: task.siteId,
        assigneeId: task.assigneeId,
        priority: task.priority as TaskPriority,
        kind: task.kind as TaskKind,
        due: task.dueAt ? toZonedInput(task.dueAt, BRANCH_TIMEZONE) : "",
      }
    : { title: "", description: "", siteId: "", assigneeId: "", priority: "normal", kind: "task", due: "" };
  const [v, setV] = useState<FormState>(initial);
  const [trade, setTrade] = useState<Trade | "any">(() => (task ? "any" : "any"));
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const site = snap.sites.find((s) => s.id === v.siteId);
  const effTrade = trade === "any" && !task ? defaultTradeFor(site?.kind) : trade;

  const suggestions = useMemo(
    () =>
      suggestAssignees({
        people: snap.people,
        trade: showAll ? "any" : effTrade,
        siteId: v.siteId || null,
        openTasks: d.open,
        clockedInAt: new Map(snap.openEntries.map((e) => [e.personId, e.siteId])),
      }),
    [snap, d.open, effTrade, v.siteId, showAll],
  );
  // Office people can be assignees too (e.g. a follow-up for the coordinator).
  const office = snap.people.filter((p) => p.active && !suggestions.some((s) => s.id === p.id) && ["coordinator", "manager"].includes(p.role));
  const current = task ? snap.people.find((p) => p.id === task.assigneeId) : null;

  const set = <K extends keyof FormState>(k: K, val: FormState[K]) => {
    setV((x) => ({ ...x, [k]: val }));
    setSaved(false);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!v.title.trim() || !v.siteId || !v.assigneeId) return setError("Title, site and assignee are required.");
    const dueAt = v.due ? fromZonedInput(v.due, BRANCH_TIMEZONE)?.toISOString() ?? null : null;
    setBusy(true);
    let r;
    if (!task) {
      r = await send([
        {
          type: "task.created",
          payload: { taskId: uuidv4(), title: v.title.trim(), description: v.description, siteId: v.siteId, assigneeId: v.assigneeId, priority: v.priority, kind: v.kind, dueAt },
        },
      ]);
    } else {
      const changes: Record<string, unknown> = {};
      if (v.title.trim() !== initial.title) changes.title = v.title.trim();
      if (v.description !== initial.description) changes.description = v.description;
      if (v.siteId !== initial.siteId) changes.siteId = v.siteId;
      if (v.assigneeId !== initial.assigneeId) changes.assigneeId = v.assigneeId;
      if (v.priority !== initial.priority) changes.priority = v.priority;
      if (v.kind !== initial.kind) changes.kind = v.kind;
      if (v.due !== initial.due) changes.dueAt = dueAt;
      if (!Object.keys(changes).length) {
        setBusy(false);
        return setError("Nothing changed.");
      }
      r = await send([{ type: "task.updated", payload: { taskId: task.id, changes } }]);
    }
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setSaved(true);
    onDone?.();
  }

  return (
    <form onSubmit={submit} className="space-y-2" data-testid={task ? "edit-task-form" : "create-task-form"}>
      <label className="block text-xs text-muted-foreground">Title
        <input className={inputClass} value={v.title} onChange={(e) => set("title", e.target.value)} maxLength={200} data-testid="task-title" />
      </label>
      <label className="block text-xs text-muted-foreground">Description
        <textarea className={cn(inputClass, "h-20 py-1")} value={v.description} onChange={(e) => set("description", e.target.value)} maxLength={5000} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <Select label="Site" value={v.siteId} onChange={(e) => set("siteId", e.target.value)} data-testid="task-site">
          <option value="">Pick a site…</option>
          {snap.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Select label="Trade (filters assignees)" value={trade === "any" && !task ? effTrade : trade} onChange={(e) => setTrade(e.target.value as Trade | "any")}>
          <option value="any">Any trade</option>
          {TRADES.filter((t) => t !== "general").map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
      </div>
      <Select label={`Assignee${v.siteId ? " (people at this site first)" : ""}`} value={v.assigneeId} onChange={(e) => set("assigneeId", e.target.value)} data-testid="task-assignee">
        <option value="">Pick a person…</option>
        {current && !suggestions.some((s) => s.id === current.id) && !office.some((o) => o.id === current.id) && (
          <option value={current.id}>{current.name} (current)</option>
        )}
        {suggestions.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {p.trade}{p.atSite ? " · at this site" : ""} · {p.openCount} open
          </option>
        ))}
        {office.length > 0 && (
          <optgroup label="Office">
            {office.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.role})</option>)}
          </optgroup>
        )}
      </Select>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show every trade
      </label>
      <div className="grid grid-cols-3 gap-2">
        <Select label="Priority" value={v.priority} onChange={(e) => set("priority", e.target.value as TaskPriority)}>
          {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Select label="Kind" value={v.kind} onChange={(e) => set("kind", e.target.value as TaskKind)}>
          {TASK_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </Select>
        <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">Due (branch time)
          <input type="datetime-local" className={inputClass} value={v.due} onChange={(e) => set("due", e.target.value)} />
        </label>
      </div>
      <ErrorLine error={error} />
      <div className="flex items-center gap-2">
        <button disabled={busy} className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="task-save">
          {busy ? "Saving…" : task ? "Save changes" : "Create and send"}
        </button>
        {saved && task && <span className="text-sm text-green-700">Saved.</span>}
        {task && v.assigneeId !== initial.assigneeId && (
          <span className="text-xs text-muted-foreground">Reassigning removes it from {current?.name}&apos;s phone on their next sync.</span>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------
const EVENT_LABEL: Record<string, string> = {
  "task.created": "Created",
  "task.updated": "Edited",
  "task.status_changed": "Status changed",
  "task.delivered": "Delivered to phone",
  "task.seen": "Seen",
  "task.acknowledged": "Acknowledged (Got it)",
  "note.created": "Note added",
  "note.media_uploaded": "Media uploaded",
  "material.status_changed": "Material request",
};

function describeEvent(h: Json<TaskDetail["history"][number]>, d: D): string {
  const p = h.payload as Record<string, unknown>;
  if (h.type === "task.status_changed") return `→ ${STATUS_LABEL[String(p.to)] ?? p.to}${p.reason ? ` (“${p.reason}”)` : ""}`;
  if (h.type === "material.status_changed") return `→ ${MATERIAL_LABEL[String(p.to)]}`;
  if (h.type === "task.updated") {
    const c = (p.changes ?? {}) as Record<string, unknown>;
    return Object.entries(c)
      .map(([k, val]) => (k === "assigneeId" ? `reassigned to ${d.person.get(String(val))?.name ?? val}` : k === "siteId" ? `site → ${d.site.get(String(val))?.name}` : k === "dueAt" ? `due → ${val ? fmtDateTime(String(val)) : "none"}` : `${k} changed`))
      .join(", ");
  }
  if (h.type === "task.created") return `for ${d.person.get(String(p.assigneeId))?.name}`;
  if (h.type === "note.created") return String(p.kind);
  return "";
}

function TaskPanel({ taskId, d, snap }: { taskId: string; d: D; snap: Snap }) {
  const { send } = useSnapshot();
  const { data, error } = usePolling<Json<TaskDetail>>(`/api/office/tasks/${taskId}`);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const can = capabilities(snap.actor.role);
  if (error) return <ErrorLine error={error} />;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const t = data.task;
  const snapTask = snap.tasks.find((x) => x.id === taskId);
  const receipt = data.receipts.find((r) => r.personId === t.assigneeId) ?? null;
  const older = data.receipts.filter((r) => r.personId !== t.assigneeId);

  async function status(to: TaskStatus) {
    if (to === "cancelled" && !reason.trim()) return setActionError("Give a reason to cancel.");
    setBusy(true);
    const r = await send([{ type: "task.status_changed", payload: { taskId, to, ...(reason.trim() ? { reason: reason.trim() } : {}) } }]);
    setBusy(false);
    setActionError(r.ok ? null : r.error);
    if (r.ok) setReason("");
  }

  return (
    <div className="space-y-4 text-sm" data-testid="task-panel">
      <div className="flex flex-wrap gap-1.5">
        <Pill tone={statusTone(t.status)}>{STATUS_LABEL[t.status]}</Pill>
        <Pill tone={priorityTone(t.priority)}>{t.priority}</Pill>
        <Pill>{KIND_LABEL[t.kind]}</Pill>
        {t.kind === "material_request" && <Pill tone="blue">{MATERIAL_LABEL[t.materialStatus ?? "requested"]}</Pill>}
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-y-1">
        <dt className="text-muted-foreground">Site</dt><dd>{d.site.get(t.siteId)?.name}</dd>
        <dt className="text-muted-foreground">Assignee</dt><dd>{d.person.get(t.assigneeId)?.name}</dd>
        <dt className="text-muted-foreground">Created by</dt><dd>{d.person.get(t.createdBy)?.name} · {fmtDateTime(t.createdAt)}</dd>
        <dt className="text-muted-foreground">Due</dt><dd>{fmtDateTime(t.dueAt)}</dd>
        <dt className="text-muted-foreground">Receipt</dt><dd><ReceiptChain receipt={receipt} warn={snapTask ? d.ackLate(snapTask) : false} /></dd>
        <dt className="text-muted-foreground">Receipt times</dt>
        <dd className="text-xs text-muted-foreground" data-testid="receipt-times">
          Sent {fmtDateTime(receipt?.sentAt)} · delivered {receipt?.deliveredAt ? fmtDateTime(receipt.deliveredAt) : "not yet"} · seen {receipt?.seenAt ? fmtDateTime(receipt.seenAt) : "not yet"} · acknowledged {receipt?.acknowledgedAt ? fmtDateTime(receipt.acknowledgedAt) : "not yet"}
        </dd>
        {data.parent && (<><dt className="text-muted-foreground">Follow-up of</dt><dd>{data.parent.title}</dd></>)}
      </dl>
      {t.description && <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-2">{t.description}</p>}
      {older.length > 0 && (
        <p className="text-xs text-muted-foreground">Earlier assignees: {older.map((r) => `${d.person.get(r.personId)?.name} (${r.acknowledgedAt ? "acknowledged" : r.seenAt ? "seen" : r.deliveredAt ? "delivered" : "sent"})`).join(", ")}</p>
      )}

      {can.editTasks && (
        <section className="space-y-2 rounded-lg border p-3">
          <h3 className="font-semibold">Status</h3>
          <div className="flex flex-wrap items-center gap-2">
            {STATUS_TRANSITIONS[t.status].map((to) => (
              <button key={to} disabled={busy} onClick={() => status(to)} className="h-7 rounded-md border px-2 text-xs hover:bg-muted disabled:opacity-50" data-testid={`status-${to}`}>
                {to === "open" && (t.status === "done" || t.status === "cancelled") ? "Reopen" : STATUS_LABEL[to]}
              </button>
            ))}
            <input className={cn(inputClass, "h-7 w-48 text-xs")} placeholder="Reason (needed to cancel)" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <ErrorLine error={actionError} />
        </section>
      )}

      {can.editTasks && snapTask && (
        <section className="space-y-2 rounded-lg border p-3">
          <h3 className="font-semibold">Edit / reassign</h3>
          <TaskForm d={d} snap={snap} task={{ ...snapTask, description: t.description }} send={send} />
        </section>
      )}

      <section className="space-y-1">
        <h3 className="font-semibold">Notifications and escalations</h3>
        <EscalationTimeline rows={data.escalations} people={d.person} />
      </section>

      <section className="space-y-2">
        <h3 className="font-semibold">Notes</h3>
        {data.notes.length === 0 && <p className="text-muted-foreground">No notes.</p>}
        {data.notes.map((n) => (
          <div key={n.id} className="rounded-md border p-2">
            <div className="text-xs text-muted-foreground">{d.person.get(n.personId)?.name} · {fmtDateTime(n.createdAt)} · {n.kind}</div>
            {n.text && <p className="whitespace-pre-wrap">{n.text}</p>}
            {n.mediaUrl && n.kind === "voice" && <audio controls preload="none" src={n.mediaUrl} className="mt-1 w-full" />}
            {n.mediaUrl && n.kind === "photo" && (
              <a href={n.mediaUrl} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element -- private, authenticated media route */}
                <img src={n.mediaUrl} alt="Photo note" loading="lazy" className="mt-1 h-28 rounded object-cover" />
              </a>
            )}
            {!n.mediaUrl && n.mediaId && <p className="text-xs text-amber-800 dark:text-amber-300">Media still uploading from the phone.</p>}
          </div>
        ))}
      </section>

      {data.followUps.length > 0 && (
        <section className="space-y-1">
          <h3 className="font-semibold">Linked follow-ups</h3>
          <ul className="list-disc pl-5">
            {data.followUps.map((f) => <li key={f.id}>{f.title} · {STATUS_LABEL[f.status]} · {d.person.get(f.assigneeId)?.name}</li>)}
          </ul>
        </section>
      )}

      <section className="space-y-1">
        <h3 className="font-semibold">History</h3>
        <ol className="space-y-1 border-l pl-3">
          {data.history.map((h) => (
            <li key={h.id} className={cn(!h.applied && "text-muted-foreground line-through decoration-red-500/50")}>
              <span className="font-medium">{EVENT_LABEL[h.type] ?? h.type}</span> {describeEvent(h, d)}
              <div className="text-xs text-muted-foreground">
                {d.person.get(h.actorId)?.name} · {fmtDateTime(h.clientTs)} on device <code>{h.deviceId}</code>
                {Math.abs(Date.parse(h.serverTs) - Date.parse(h.clientTs)) > 120_000 && ` · reached server ${fmtDateTime(h.serverTs)}`}
                {h.rejectReason && <span className="text-red-700"> · rejected: {h.rejectReason}</span>}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
