"use client";
// Material request queue: Approve -> Ordered -> Delivered (delivered closes the request).
import { useMemo, useState } from "react";
import { UpdatedAgo, useSnapshot } from "@/components/office/data";
import { capabilities, ErrorLine, fmtDateTime, MATERIAL_LABEL, PageHeader, Pill, priorityTone, ReceiptChain, STATUS_LABEL } from "@/components/office/ui";
import { MATERIAL_STATUSES, type MaterialStatus } from "@/lib/domain";
import { derive } from "@/lib/office/derive";

const ACTION: Record<MaterialStatus, string> = { approved: "Approve", ordered: "Ordered", delivered: "Delivered" };

export default function MaterialsPage() {
  const { data, error, updatedAt, send } = useSnapshot();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const d = useMemo(() => (data ? derive(data) : null), [data]);
  if (!data || !d) return <PageHeader title="Material requests"><UpdatedAgo at={updatedAt} error={error} /></PageHeader>;
  const can = capabilities(data.actor.role);
  const all = data.tasks.filter((t) => t.kind === "material_request").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const queue = all.filter((t) => d.inView(t, "materials"));
  const closed = all.filter((t) => !d.inView(t, "materials")).slice(0, 10);

  async function move(taskId: string, to: MaterialStatus) {
    setBusy(taskId);
    const r = await send([{ type: "material.status_changed", payload: { taskId, to } }]);
    setBusy(null);
    setErrors((e) => ({ ...e, [taskId]: r.ok ? null : r.error }));
  }

  return (
    <>
      <PageHeader title="Material requests"><UpdatedAgo at={updatedAt} error={error} /></PageHeader>
      <div className="space-y-2">
        {queue.length === 0 && <p className="text-sm text-muted-foreground">No open requests.</p>}
        {queue.map((t) => {
          const cur = t.materialStatus as MaterialStatus | null;
          const next = MATERIAL_STATUSES.filter((s) => MATERIAL_STATUSES.indexOf(s) > (cur ? MATERIAL_STATUSES.indexOf(cur) : -1));
          return (
            <div key={t.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm" data-testid={`material-${t.id}`}>
              <div className="min-w-64 flex-1">
                <div className="font-medium">{t.title}</div>
                <div className="text-xs text-muted-foreground">
                  From {d.person.get(t.createdBy)?.name} · {d.site.get(t.siteId)?.name} · raised {fmtDateTime(t.createdAt)}
                  {t.dueAt && ` · needed by ${fmtDateTime(t.dueAt)}`}
                </div>
                {t.description && <p className="mt-1 text-xs">{t.description}</p>}
              </div>
              {t.priority !== "normal" && <Pill tone={priorityTone(t.priority)}>{t.priority}</Pill>}
              <Pill tone="blue">{MATERIAL_LABEL[cur ?? "requested"]}</Pill>
              <ReceiptChain receipt={d.receiptOf(t)} warn={d.ackLate(t)} />
              {can.materials && (
                <div className="flex gap-1.5">
                  {next.map((s) => (
                    <button key={s} disabled={busy === t.id} onClick={() => move(t.id, s)} className="h-7 rounded-md border px-2 text-xs hover:bg-muted disabled:opacity-50" data-testid={`material-${s}`}>
                      {ACTION[s]}
                    </button>
                  ))}
                </div>
              )}
              {errors[t.id] && <div className="w-full"><ErrorLine error={errors[t.id]!} /></div>}
            </div>
          );
        })}
      </div>
      {closed.length > 0 && (
        <>
          <h2 className="mt-6 mb-2 text-sm font-semibold">Recently closed</h2>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {closed.map((t) => (
              <li key={t.id}>{t.title} · {MATERIAL_LABEL[t.materialStatus ?? "requested"]} · {STATUS_LABEL[t.status]}{t.materialStatusAt && ` · ${fmtDateTime(t.materialStatusAt)}`}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
