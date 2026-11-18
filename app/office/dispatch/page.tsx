"use client";
// Dispatch drafts: paste a service request, the dispatch agent drafts a work
// order, a coordinator edits and approves (task created through a normal
// event, source dispatch_agent) or rejects it with a reason.
import Link from "next/link";
import { useMemo, useState } from "react";
import { ModeBadge, postJson, Principles, timed } from "@/components/office/agents";
import { UpdatedAgo, usePolling, useSnapshot, webDeviceId, type Json, type Snap } from "@/components/office/data";
import { ErrorLine, fmtDateTime, inputClass, KIND_LABEL, PageHeader, Pill, priorityTone, Select } from "@/components/office/ui";
import type { DraftListItem } from "@/lib/agents/dispatch";
import { BRANCH_TIMEZONE } from "@/lib/config";
import { canManageTasks, isFieldRole, TASK_KINDS, TASK_PRIORITIES } from "@/lib/domain";
import { fromZonedInput, toZonedInput } from "@/lib/time";
import { cn } from "@/lib/utils";

type Draft = Json<DraftListItem>;
type Data = { drafts: Draft[]; samples: string[] };

export default function DispatchPage() {
  const snap = useSnapshot();
  const { data, error, updatedAt, refresh } = usePolling<Data>("/api/office/dispatch");
  if (snap.data && !canManageTasks(snap.data.actor.role)) return <p className="text-sm text-muted-foreground">Coordinators and managers only.</p>;
  const pending = data?.drafts.filter((d) => d.status === "pending") ?? [];
  const decided = data?.drafts.filter((d) => d.status !== "pending") ?? [];
  return (
    <>
      <PageHeader title="Dispatch drafts">
        <UpdatedAgo at={updatedAt} error={error} />
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_1fr]">
        <div className="space-y-3">
          <RequestForm samples={data?.samples ?? []} snap={snap.data} onDone={refresh} />
          <Principles />
        </div>
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Waiting for a decision ({pending.length})</h2>
          {pending.length === 0 && <p className="text-sm text-muted-foreground">No drafts waiting. Paste a request or inject a sample.</p>}
          {snap.data && pending.map((d) => <DraftCard key={d.id} draft={d} snap={snap.data!} onDone={refresh} />)}
          {decided.length > 0 && (
            <section className="space-y-1 pt-2">
              <h2 className="text-sm font-semibold">Decided</h2>
              <ul className="divide-y rounded-lg border text-sm">
                {decided.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid="decided-draft">
                    <Pill tone={d.status === "approved" ? "green" : "red"}>{d.status}</Pill>
                    {d.taskId ? (
                      <Link href={`/office/tasks?task=${d.taskId}`} className="font-medium underline-offset-2 hover:underline">{d.draft.title}</Link>
                    ) : (
                      <span className="font-medium">{d.draft.title}</span>
                    )}
                    <ModeBadge mode={d.mode} />
                    <span className="text-xs text-muted-foreground">
                      {snap.data?.people.find((p) => p.id === d.decidedBy)?.name} · {fmtDateTime(d.decidedAt)}
                      {d.rejectReason && ` · “${d.rejectReason}”`}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function RequestForm({ samples, snap, onDone }: { samples: string[]; snap: Snap | null; onDone: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [siteId, setSiteId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);

  async function run(body: { text: string; siteId: string | null }) {
    setBusy(true);
    setError(null);
    const [r, ms] = await timed(() => postJson<{ mode: string }>("/api/office/dispatch", body));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setLast(`Draft ready in ${(ms / 1000).toFixed(1)} s (${r.data.mode === "ai" ? "AI" : "fallback"}).`);
    setText("");
    await onDone();
  }

  return (
    <form
      className="space-y-2 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run({ text, siteId: siteId || null });
      }}
    >
      <h2 className="text-sm font-semibold">New service request</h2>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        maxLength={5000}
        placeholder="Paste the customer's email or describe the request…"
        className="w-full rounded-md border bg-background p-2 text-sm"
        data-testid="dispatch-text"
      />
      <Select label="Site (optional)" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
        <option value="">Let the agent find it</option>
        {snap?.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </Select>
      <div className="flex flex-wrap gap-2">
        <button disabled={busy || text.trim().length < 5} className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="dispatch-submit">
          {busy ? "Drafting…" : "Draft work order"}
        </button>
        <button
          type="button"
          disabled={busy || samples.length === 0}
          onClick={() => void run({ text: samples[Math.floor(Math.random() * samples.length)], siteId: null })}
          className="h-8 rounded-md border px-3 text-sm hover:bg-muted disabled:opacity-50"
          data-testid="dispatch-sample"
        >
          Inject sample request
        </button>
      </div>
      <ErrorLine error={error} />
      {last && <p className="text-xs text-muted-foreground">{last}</p>}
    </form>
  );
}

function DraftCard({ draft, snap, onDone }: { draft: Draft; snap: Snap; onDone: () => Promise<void> }) {
  const d = draft.draft;
  const fieldPeople = useMemo(() => snap.people.filter((p) => p.active && isFieldRole(p.role)), [snap.people]);
  const [edit, setEdit] = useState({
    title: d.title,
    siteId: d.siteId ?? "",
    assigneeId: d.suggestedAssigneeId ?? "",
    priority: d.priority,
    kind: d.kind,
    due: d.dueAt ? toZonedInput(d.dueAt, BRANCH_TIMEZONE) : "",
  });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = (id: string) => snap.people.find((p) => p.id === id)?.name ?? "?";
  const ranked = [d.suggestedAssigneeId, ...d.alternativeAssigneeIds].filter((x): x is string => !!x);

  async function decide(body: object) {
    setBusy(true);
    setError(null);
    const r = await postJson("/api/office/dispatch/decide", { draftId: draft.id, ...body });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    await onDone();
  }
  const approve = () => {
    const due = edit.due ? fromZonedInput(edit.due, BRANCH_TIMEZONE) : null;
    return decide({
      decision: "approve",
      deviceId: webDeviceId(),
      edits: {
        title: edit.title,
        ...(edit.siteId ? { siteId: edit.siteId } : {}),
        ...(edit.assigneeId ? { assigneeId: edit.assigneeId } : {}),
        priority: edit.priority,
        kind: edit.kind,
        dueAt: due ? due.toISOString() : null,
      },
    });
  };

  return (
    <article className="space-y-3 rounded-lg border p-3 text-sm" data-testid="dispatch-draft">
      <div className="flex flex-wrap items-center gap-2">
        <ModeBadge mode={draft.mode} />
        <Pill tone={priorityTone(edit.priority)}>{edit.priority}</Pill>
        <Pill>{d.trade}</Pill>
        {d.siteId && <span className="text-xs text-muted-foreground">site match {Math.round(d.matchedSiteConfidence * 100)}%</span>}
        <span className="ml-auto text-xs text-muted-foreground">
          {fmtDateTime(draft.createdAt)}
          {draft.run.latencyMs !== null && ` · ${(draft.run.latencyMs / 1000).toFixed(1)} s`}
        </span>
      </div>
      <blockquote className="whitespace-pre-wrap border-l-2 pl-2 text-xs text-muted-foreground">{draft.requestText}</blockquote>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-0.5 text-xs text-muted-foreground sm:col-span-2">
          Title
          <input className={inputClass} value={edit.title} maxLength={200} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
        </label>
        <Select label="Site" value={edit.siteId} onChange={(e) => setEdit({ ...edit, siteId: e.target.value })}>
          <option value="">Pick a site…</option>
          {snap.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Select label="Assignee" value={edit.assigneeId} onChange={(e) => setEdit({ ...edit, assigneeId: e.target.value })} data-testid="dispatch-assignee">
          <option value="">Pick a person…</option>
          {ranked.map((id, i) => <option key={id} value={id}>{name(id)} {i === 0 ? "(suggested)" : "(alternative)"}</option>)}
          {fieldPeople.filter((p) => !ranked.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.trade})</option>)}
        </Select>
        <Select label="Priority" value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value as typeof edit.priority })}>
          {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Select label="Kind" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value as typeof edit.kind })}>
          {TASK_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </Select>
        <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          Due (branch time)
          <input type="datetime-local" className={inputClass} value={edit.due} onChange={(e) => setEdit({ ...edit, due: e.target.value })} />
        </label>
      </div>

      {d.description && <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-xs">{d.description}</p>}
      <div className="rounded-md bg-blue-50 p-2 text-xs text-blue-950 dark:bg-blue-950/40 dark:text-blue-100">
        <span className="font-semibold">Why: </span>
        {d.reasoning}
      </div>
      {d.missingInfo.length > 0 && (
        <div className="text-xs">
          <span className="font-semibold">Missing info: </span>
          {d.missingInfo.join(" · ")}
        </div>
      )}
      {(draft.run.notes.length > 0 || draft.run.error) && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Validation notes ({draft.run.notes.length + (draft.run.error ? 1 : 0)})</summary>
          <ul className="mt-1 list-disc pl-5">
            {draft.run.error && <li>Fallback used: {draft.run.error}</li>}
            {draft.run.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </details>
      )}

      <div className="flex flex-wrap items-end gap-2 border-t pt-2">
        <button disabled={busy} onClick={approve} className="h-8 rounded-md bg-green-700 px-3 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50" data-testid="dispatch-approve">
          Approve and send
        </button>
        <input
          className={cn(inputClass, "w-56")}
          placeholder="Reason to reject (required)"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          disabled={busy || reason.trim().length < 3}
          onClick={() => decide({ decision: "reject", reason })}
          className="h-8 rounded-md border border-red-300 px-3 text-sm text-red-800 hover:bg-red-50 disabled:opacity-50 dark:text-red-200"
          data-testid="dispatch-reject"
        >
          Reject
        </button>
      </div>
      <ErrorLine error={error} />
    </article>
  );
}
