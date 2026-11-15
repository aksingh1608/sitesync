"use client";
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { usePendingRefs } from "@/components/field/hooks";
import { BigButton, BigLink, PageTitle, Panel, WaitingMarker } from "@/components/field/ui";
import { formatTime, useActor, useMeta } from "@/components/use-local";
import { localDb } from "@/lib/db/local";
import { WORKER_STATUSES, type WorkerStatus } from "@/lib/domain";
import { enqueue, sync } from "@/lib/sync/client";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<WorkerStatus, string> = {
  on_site: "On site",
  lunch: "Lunch",
  traveling: "Traveling",
  off: "Off",
};

export default function MePage() {
  const meta = useMeta();
  const actorId = meta?.actorId ?? null;
  const actor = useActor(actorId);
  const pending = usePendingRefs(actorId);
  const [busy, setBusy] = useState(false);
  const current = useLiveQuery(async () => {
    if (!actorId) return null;
    const rows = await localDb.statusUpdates.where("personId").equals(actorId).toArray();
    return rows.sort((a, b) => +b.at - +a.at)[0] ?? null;
  }, [actorId]);
  const status = current?.status ?? null;
  const last = meta?.lastSyncResult;

  const set = (s: WorkerStatus | null) => enqueue({ type: "status.set", payload: { status: s } });

  return (
    <>
      <PageTitle sub={actor ? `${actor.role} · ${actor.trade}` : undefined}>{actor?.name ?? "Me"}</PageTitle>

      <Panel>
        <h2 className="text-xl font-bold">My status</h2>
        <p className="text-base text-slate-700">
          Optional. Lets the office know where you are. You don&apos;t have to set it.
        </p>
        <p className="flex flex-wrap items-center gap-2 text-base">
          Now: <strong>{status ? STATUS_LABEL[status] : "Not set"}</strong>
          {current && <span className="text-slate-700">since {formatTime(current.at)}</span>}
          {pending.status && <WaitingMarker />}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {WORKER_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => set(s)}
              aria-pressed={status === s}
              className={cn(
                "min-h-14 rounded-xl border-2 text-lg font-bold",
                status === s ? "border-blue-800 bg-blue-700 text-white" : "border-slate-700 bg-white text-slate-950",
              )}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <BigButton tone="neutral" disabled={!status} onClick={() => set(null)}>
          Clear status
        </BigButton>
      </Panel>

      <Panel>
        <h2 className="text-xl font-bold">Sync</h2>
        <p className="text-base">
          Last sync: <strong>{meta?.lastSyncAt ? formatTime(meta.lastSyncAt) : "never"}</strong>
        </p>
        {last?.status === "error" && <p className="text-base font-semibold text-red-700">Last attempt failed: {last.error}</p>}
        <p className="text-base">{pending.count} change{pending.count === 1 ? "" : "s"} waiting to sync.</p>
        <BigButton
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await sync({ manual: true });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Syncing…" : "Sync now"}
        </BigButton>
      </Panel>

      <div className="grid grid-cols-2 gap-2">
        <BigLink href="/">Switch person</BigLink>
        <BigLink href="/debug">Debug console</BigLink>
      </div>
    </>
  );
}
