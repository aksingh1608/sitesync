"use client";
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { usePendingRefs, useSyncView } from "@/components/field/hooks";
import { BigButton, BigLink, PageTitle, Panel, WaitingMarker } from "@/components/field/ui";
import { NotificationsCard } from "@/components/push/field-card";
import { formatTime, useActor, useMeta } from "@/components/use-local";
import { localDb } from "@/lib/db/local";
import { WORKER_STATUSES, type WorkerStatus } from "@/lib/domain";
import { canSeeDebug, DEMO_MODE } from "@/lib/config";
import { enqueue, resetLocalData, sync } from "@/lib/sync/client";
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
  const view = useSyncView();

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

      <NotificationsCard />

      <Panel>
        <h2 className="text-xl font-bold">Sync</h2>
        <p className="text-base" data-testid="me-last-sync">
          Last sync:{" "}
          <strong>{view.tone === "loading" ? "…" : (view.lastSyncAt ?? "not yet")}</strong>
        </p>
        {view.tone === "offline" ? (
          <p className="rounded-lg bg-slate-100 p-3 text-base font-semibold text-slate-900" data-testid="me-no-signal">
            {view.detail}
          </p>
        ) : view.error ? (
          <p className="text-base font-semibold text-red-700" data-testid="me-sync-error">
            Last attempt failed: {view.error}
          </p>
        ) : null}
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
        {canSeeDebug(actor?.role) && <BigLink href="/debug">Debug console</BigLink>}
      </div>

      {DEMO_MODE && <ResetDevice pending={pending.count} />}
    </>
  );
}

/** Demo only: wipe this phone's local data (after the office reset the demo). */
function ResetDevice({ pending }: { pending: number }) {
  const [armed, setArmed] = useState(false);
  return (
    <Panel>
      <h2 className="text-xl font-bold">Demo: reset this device</h2>
      <p className="text-base">
        Use after &ldquo;Reset demo&rdquo; in the office. Clears this phone&apos;s copy of the data and goes back to the
        person picker. The server is not touched.
      </p>
      {pending > 0 && (
        <p className="rounded-lg bg-amber-100 p-3 text-base font-semibold text-amber-950">
          {pending} change{pending === 1 ? "" : "s"} on this phone have not synced yet and will be lost.
        </p>
      )}
      <BigButton
        tone="neutral"
        onClick={async () => {
          if (!armed) return setArmed(true);
          await resetLocalData();
          // A full reload on purpose: the local database was just deleted, so no client state may survive.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign("/");
        }}
      >
        {armed ? "Tap again to reset this device" : "Reset this device"}
      </BigButton>
    </Panel>
  );
}
