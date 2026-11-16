"use client";
// Rollout board: stores by stage. Moving a store is a site.stage_changed event.
import { useMemo, useState } from "react";
import { UpdatedAgo, useSnapshot, type Snap } from "@/components/office/data";
import { capabilities, ErrorLine, PageHeader, Pill } from "@/components/office/ui";
import { ROLLOUT_STAGE_EXPECTED_DAYS } from "@/lib/config";
import { PHOTO_REQUIRED_STAGES, ROLLOUT_STAGES, type RolloutStage } from "@/lib/domain";
import { derive } from "@/lib/office/derive";
import { behindSchedule, rolloutProgress, STAGE_LABEL } from "@/lib/office/rules";
import { cn } from "@/lib/utils";

export default function RolloutsPage() {
  const { data, error, updatedAt } = useSnapshot();
  return (
    <>
      <PageHeader title="Rollouts"><UpdatedAgo at={updatedAt} error={error} /></PageHeader>
      {data ? data.rollouts.map((r) => <Rollout key={r.id} snap={data} rolloutId={r.id} />) : <p className="text-sm text-muted-foreground">Loading…</p>}
    </>
  );
}

function Rollout({ snap, rolloutId }: { snap: Snap; rolloutId: string }) {
  const { send } = useSnapshot();
  const d = useMemo(() => derive(snap), [snap]);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const rollout = snap.rollouts.find((r) => r.id === rolloutId)!;
  const stores = snap.sites.filter((s) => s.rolloutId === rolloutId);
  const now = new Date(snap.now);
  const can = capabilities(snap.actor.role);
  const progress = rolloutProgress(stores.map((s) => s.rolloutStage), ROLLOUT_STAGES);
  const behind = stores.map((s) => ({ s, b: behindSchedule(s, now) })).filter((x) => x.b.behind).sort((a, b) => (b.b.days ?? 0) - (a.b.days ?? 0));

  async function move(siteId: string, from: RolloutStage, to: RolloutStage) {
    const photos = snap.photoCounts[siteId] ?? 0;
    if (PHOTO_REQUIRED_STAGES.includes(to) && photos === 0) {
      return setErrors((e) => ({ ...e, [siteId]: `Blocked: ${STAGE_LABEL[to]} needs at least one uploaded photo note on this store. Ask the crew to add one from the field app (Notes → Photo).` }));
    }
    setBusy(siteId);
    const r = await send([{ type: "site.stage_changed", payload: { siteId, from, to } }]);
    setBusy(null);
    setErrors((e) => ({ ...e, [siteId]: r.ok ? null : r.error }));
  }

  return (
    <section className="mb-8 space-y-3">
      <div>
        <h2 className="font-semibold">{rollout.name}</h2>
        <p className="text-xs text-muted-foreground">{rollout.scope} · target end {rollout.targetEndDate ?? "—"}</p>
      </div>
      <div>
        <div className="mb-1 flex justify-between text-xs text-muted-foreground">
          <span>{progress.done} of {progress.total} stores done</span>
          <span>{Math.round(progress.weighted * 100)}% through all stages</span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(progress.weighted * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-green-600" style={{ width: `${progress.weighted * 100}%` }} />
        </div>
      </div>
      {behind.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/30" data-testid="behind-schedule">
          <h3 className="mb-1 font-semibold">Behind schedule ({behind.length})</h3>
          <ul className="space-y-0.5">
            {behind.map(({ s, b }) => (
              <li key={s.id}>{s.name}: {b.days} days in {STAGE_LABEL[s.rolloutStage!]} (expected {b.expected})</li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-2 overflow-x-auto [grid-template-columns:repeat(6,minmax(11rem,1fr))]">
        {ROLLOUT_STAGES.map((stage) => {
          const here = stores.filter((s) => s.rolloutStage === stage);
          return (
            <div key={stage} className="rounded-lg bg-muted/40 p-2" data-testid={`stage-${stage}`}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {STAGE_LABEL[stage]} · {here.length}
                {ROLLOUT_STAGE_EXPECTED_DAYS[stage] !== null && <span className="font-normal normal-case"> (≤{ROLLOUT_STAGE_EXPECTED_DAYS[stage]}d)</span>}
              </h3>
              <div className="space-y-2">
                {here.map((s) => {
                  const b = behindSchedule(s, now);
                  const photos = snap.photoCounts[s.id] ?? 0;
                  const open = d.open.filter((t) => t.siteId === s.id).length;
                  return (
                    <div key={s.id} className={cn("rounded-md border bg-background p-2 text-xs", b.behind && "border-amber-400")} data-testid={`store-${s.id}`}>
                      <div className="text-sm font-medium leading-tight">{s.name.replace(/^RetailCo /, "")}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {b.days !== null && <Pill tone={b.behind ? "amber" : "slate"}>{b.days}d in stage</Pill>}
                        <Pill tone={photos ? "green" : "slate"}>{photos} photo{photos === 1 ? "" : "s"}</Pill>
                        {open > 0 && <Pill>{open} open</Pill>}
                      </div>
                      {can.moveStages && (
                        <select
                          className="mt-2 h-7 w-full rounded border bg-background px-1 text-xs"
                          value=""
                          disabled={busy === s.id}
                          onChange={(e) => e.target.value && move(s.id, stage, e.target.value as RolloutStage)}
                          data-testid={`move-${s.id}`}
                        >
                          <option value="">Move to…</option>
                          {ROLLOUT_STAGES.filter((x) => x !== stage).map((x) => (
                            <option key={x} value={x}>
                              {STAGE_LABEL[x]}{PHOTO_REQUIRED_STAGES.includes(x) && !photos ? " (needs a photo)" : ""}
                            </option>
                          ))}
                        </select>
                      )}
                      {errors[s.id] && <div className="mt-1"><ErrorLine error={errors[s.id]!} /></div>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
