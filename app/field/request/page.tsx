"use client";
// Material request: a `material_request` task assigned to the branch
// coordinator, on the current task's site and linked to it (parentTaskId).
import { useLiveQuery } from "dexie-react-hooks";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { BigButton, Field, inputClass, PageTitle, Panel } from "@/components/field/ui";
import { useMeta } from "@/components/use-local";
import { BRANCH_TIMEZONE } from "@/lib/config";
import { localDb } from "@/lib/db/local";
import { enqueue, LocalRejectError } from "@/lib/sync/client";
import { tomorrowKey } from "@/lib/tasks/grouping";
import { zonedTime } from "@/lib/time";
import { uuidv4 } from "@/lib/uuid";

export default function RequestPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <RequestForm />
    </Suspense>
  );
}

function RequestForm() {
  const taskId = useSearchParams().get("taskId");
  const router = useRouter();
  const meta = useMeta();
  const actorId = meta?.actorId ?? null;
  const [item, setItem] = useState("");
  const [qty, setQty] = useState("1");
  const [neededBy, setNeededBy] = useState(() => tomorrowKey(new Date(), BRANCH_TIMEZONE));
  const [note, setNote] = useState("");
  const [siteId, setSiteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const data = useLiveQuery(async () => {
    const [task, people, sites] = await Promise.all([
      taskId ? localDb.tasks.get(taskId) : Promise.resolve(undefined),
      localDb.people.where("role").equals("coordinator").toArray(),
      localDb.sites.toArray(),
    ]);
    const coordinator = people.filter((p) => p.active).sort((a, b) => a.name.localeCompare(b.name))[0];
    return { task, coordinator, sites: sites.sort((a, b) => a.name.localeCompare(b.name)) };
  }, [taskId]);

  if (!data) return <p>Loading…</p>;
  const site = siteId ?? data.task?.siteId ?? data.sites[0]?.id ?? "";
  const quantity = Number(qty);
  const valid = item.trim() && Number.isFinite(quantity) && quantity > 0 && site && data.coordinator && neededBy;

  async function submit() {
    if (!valid || !actorId) return;
    setError(null);
    try {
      await enqueue({
        type: "task.created",
        payload: {
          taskId: uuidv4(),
          kind: "material_request",
          title: `Material: ${quantity} × ${item.trim()}`.slice(0, 200),
          description: [
            `Item: ${item.trim()}`,
            `Quantity: ${quantity}`,
            `Needed by: ${neededBy}`,
            data!.task ? `For task: ${data!.task.title}` : null,
            note.trim() ? `Note: ${note.trim()}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
          siteId: site,
          assigneeId: data!.coordinator!.id,
          parentTaskId: data!.task?.id ?? null,
          priority: "normal",
          dueAt: zonedTime(neededBy, 7, 0, BRANCH_TIMEZONE).toISOString(),
        },
      });
      router.push(taskId ? `/field/task?id=${taskId}` : "/field");
    } catch (e) {
      setError(e instanceof LocalRejectError ? `Not allowed: ${e.reason}` : String(e));
    }
  }

  return (
    <>
      <PageTitle sub={data.coordinator ? `Goes to ${data.coordinator.name} (coordinator)` : "No coordinator on this device yet: sync first"}>
        Request material
      </PageTitle>
      {data.task && <p className="text-base">For: <strong>{data.task.title}</strong></p>}
      <Panel>
        <Field label="Item">
          <input className={inputClass} value={item} onChange={(e) => setItem(e.target.value)} placeholder="e.g. 4/0 THHN, 500 ft reel" />
        </Field>
        <Field label="Quantity">
          <input className={inputClass} inputMode="decimal" type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label="Needed by">
          <input className={inputClass} type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
        </Field>
        {!data.task && (
          <Field label="Site">
            <select className={inputClass} value={site} onChange={(e) => setSiteId(e.target.value)}>
              {data.sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Note (optional)">
          <textarea className={inputClass} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Panel>
      {error && <p className="rounded-lg bg-red-100 p-3 font-semibold text-red-800">{error}</p>}
      <BigButton disabled={!valid} onClick={submit} data-testid="submit-request">Send request</BigButton>
    </>
  );
}
