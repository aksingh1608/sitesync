"use client";
// Clock in / out. Location is taken once at clock-in and once at clock-out,
// never continuously. The distance shown here uses the same haversine as the
// server, which stays authoritative (it re-computes and flags).
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { useNow, usePendingRefs } from "@/components/field/hooks";
import { BigButton, PageTitle, Panel, WaitingMarker } from "@/components/field/ui";
import { formatClock, useMeta } from "@/components/use-local";
import { BRANCH_TIMEZONE } from "@/lib/config";
import { localDb } from "@/lib/db/local";
import { TERMINAL_STATUSES } from "@/lib/domain";
import { getLocationOnce, LOCATION_ERROR_TEXT, type Fix, type NoFix } from "@/lib/geolocate";
import { haversineM, isOutsideGeofence } from "@/lib/geo";
import { enqueue, LocalRejectError } from "@/lib/sync/client";
import type { SiteRow, TimeEntryRow } from "@/lib/sync/reducers";
import { dayKey } from "@/lib/time";
import { uuidv4 } from "@/lib/uuid";
import { cn } from "@/lib/utils";

const CHECKS = [
  { key: "ppe", label: "PPE on (hard hat, glasses, gloves, boots)" },
  { key: "hazards", label: "Site hazards reviewed" },
  { key: "loto", label: "Lockout/tagout procedure understood" },
] as const;

function hoursToday(entries: TimeEntryRow[], now: Date) {
  const today = dayKey(now, BRANCH_TIMEZONE);
  const ms = entries
    .filter((e) => dayKey(e.clockInAt, BRANCH_TIMEZONE) === today)
    .reduce((sum, e) => sum + ((e.clockOutAt ?? now).getTime() - e.clockInAt.getTime()), 0);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h} h ${String(m).padStart(2, "0")} min`;
}

type LocResult = { fix: Fix | NoFix; site: SiteRow; distanceM: number | null };

function LocationLine({ r }: { r: LocResult }) {
  if (!r.fix.ok) {
    return (
      <p className="rounded-lg bg-amber-100 p-3 text-base font-semibold text-amber-950">
        {LOCATION_ERROR_TEXT[r.fix.error]}. Recorded anyway; the office will review it.
      </p>
    );
  }
  const outside = r.distanceM !== null && isOutsideGeofence(r.distanceM, r.site.geofenceRadiusM);
  return (
    <p className={cn("rounded-lg p-3 text-base font-semibold", outside ? "bg-amber-100 text-amber-950" : "bg-green-100 text-green-950")}>
      {Math.round(r.distanceM ?? 0)} m from {r.site.name} (±{r.fix.accuracyM} m).{" "}
      {outside ? `Outside the ${r.site.geofenceRadiusM} m site radius: the office will review it.` : "On site."}
    </p>
  );
}

export default function ClockPage() {
  const meta = useMeta();
  const actorId = meta?.actorId ?? null;
  const pending = usePendingRefs(actorId);
  const now = useNow(30_000);
  const [pickedSiteId, setSiteId] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [phase, setPhase] = useState<"idle" | "locating">("idle");
  const [last, setLast] = useState<LocResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const data = useLiveQuery(async () => {
    if (!actorId) return null;
    const [entries, sites, tasks] = await Promise.all([
      localDb.timeEntries.where("personId").equals(actorId).toArray(),
      localDb.sites.toArray(),
      localDb.tasks.where("assigneeId").equals(actorId).toArray(),
    ]);
    const today = dayKey(new Date(), BRANCH_TIMEZONE);
    const active = tasks.filter((t) => !TERMINAL_STATUSES.includes(t.status));
    const todays = active.filter((t) => t.dueAt && dayKey(t.dueAt, BRANCH_TIMEZONE) <= today);
    const suggested = todays[0]?.siteId ?? active[0]?.siteId ?? sites[0]?.id ?? null;
    // Sites I have work at first.
    const rank = (s: SiteRow) => (todays.some((t) => t.siteId === s.id) ? 0 : active.some((t) => t.siteId === s.id) ? 1 : 2);
    return {
      entries: entries.sort((a, b) => +b.clockInAt - +a.clockInAt),
      open: entries.find((e) => e.clockOutAt === null),
      sites: sites.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)),
      siteById: new Map(sites.map((s) => [s.id, s])),
      suggested,
    };
  }, [actorId]);

  if (!data) return <p>Loading…</p>;
  // Preselected: the site the worker has tasks at today, until they pick another.
  const siteId = pickedSiteId ?? data.suggested;
  const open = data.open;
  const allChecked = CHECKS.every((c) => checks[c.key]);

  async function locate(site: SiteRow): Promise<LocResult> {
    setPhase("locating");
    try {
      const fix = await getLocationOnce();
      const distanceM = fix.ok ? haversineM(fix.lat, fix.lng, site.lat, site.lng) : null;
      const r = { fix, site, distanceM };
      setLast(r);
      return r;
    } finally {
      setPhase("idle");
    }
  }

  async function clockIn() {
    const site = siteId ? data!.siteById.get(siteId) : undefined;
    if (!site) return;
    setError(null);
    const { fix } = await locate(site);
    try {
      await enqueue({
        type: "time.clock_in",
        payload: {
          timeEntryId: uuidv4(),
          siteId: site.id,
          lat: fix.ok ? fix.lat : null,
          lng: fix.ok ? fix.lng : null,
          accuracyM: fix.ok ? fix.accuracyM : null,
          locationError: fix.ok ? null : fix.error,
          safetyCheckDone: true,
        },
      });
      setChecks({});
    } catch (e) {
      setError(e instanceof LocalRejectError ? `Not recorded: ${e.reason}` : String(e));
    }
  }

  async function clockOut(entry: TimeEntryRow) {
    const site = data!.siteById.get(entry.siteId);
    setError(null);
    const fix = site ? (await locate(site)).fix : await getLocationOnce();
    try {
      await enqueue({
        type: "time.clock_out",
        payload: {
          timeEntryId: entry.id,
          lat: fix.ok ? fix.lat : null,
          lng: fix.ok ? fix.lng : null,
          accuracyM: fix.ok ? fix.accuracyM : null,
          locationError: fix.ok ? null : fix.error,
        },
      });
    } catch (e) {
      setError(e instanceof LocalRejectError ? `Not recorded: ${e.reason}` : String(e));
    }
  }

  return (
    <>
      <PageTitle sub={`Today: ${hoursToday(data.entries, now)}`}>Clock</PageTitle>

      {open ? (
        <Panel className="border-green-700">
          <p className="text-xl font-bold">Clocked in at {data.siteById.get(open.siteId)?.name ?? "site"}</p>
          <p className="text-base">Since {formatClock(open.clockInAt)}</p>
          {open.flagged && open.seq !== undefined && (
            <p className="text-base font-semibold text-amber-800">Flagged for review: {open.flagReason}</p>
          )}
          {pending.timeEntries.has(open.id) && <WaitingMarker />}
          {last && <LocationLine r={last} />}
          <BigButton tone="danger" className="min-h-16 text-xl" disabled={phase === "locating"} onClick={() => clockOut(open)} data-testid="clock-out">
            {phase === "locating" ? "Getting location…" : "Clock out"}
          </BigButton>
        </Panel>
      ) : (
        <>
          <Panel>
            <h2 className="text-xl font-bold">1. Site</h2>
            {data.sites.length === 0 && <p className="text-base">No sites on this device yet. Sync first.</p>}
            <div className="space-y-2" role="radiogroup">
              {data.sites.map((s) => (
                <label
                  key={s.id}
                  className={cn(
                    "flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border-2 p-3",
                    siteId === s.id ? "border-blue-700 bg-blue-50" : "border-slate-300 bg-white",
                  )}
                >
                  <input type="radio" name="site" className="size-6" checked={siteId === s.id} onChange={() => setSiteId(s.id)} />
                  <span>
                    <span className="block font-bold">{s.name}</span>
                    <span className="block text-base text-slate-700">{s.address}</span>
                  </span>
                </label>
              ))}
            </div>
          </Panel>

          <Panel>
            <h2 className="text-xl font-bold">2. Safety check</h2>
            {CHECKS.map((c) => (
              <label key={c.key} className="flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border-2 border-slate-300 bg-white p-3">
                <input
                  type="checkbox"
                  className="size-7"
                  checked={!!checks[c.key]}
                  onChange={(e) => setChecks((v) => ({ ...v, [c.key]: e.target.checked }))}
                  data-testid={`check-${c.key}`}
                />
                <span className="font-semibold">{c.label}</span>
              </label>
            ))}
          </Panel>

          <BigButton
            tone="success"
            className="min-h-16 text-xl"
            disabled={!allChecked || !siteId || phase === "locating"}
            onClick={clockIn}
            data-testid="clock-in"
          >
            {phase === "locating" ? "Getting location… (up to 10 s)" : allChecked ? "Clock in" : "Complete the safety check"}
          </BigButton>
          {last && <LocationLine r={last} />}
        </>
      )}

      {error && <p className="rounded-lg bg-red-100 p-3 font-semibold text-red-800">{error}</p>}

      <Panel>
        <h2 className="text-xl font-bold">Recent</h2>
        {data.entries.length === 0 && <p className="text-base">No time entries yet.</p>}
        <ul className="space-y-2 text-base">
          {data.entries.slice(0, 6).map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{data.siteById.get(e.siteId)?.name ?? "Site"}</span>
              <span>
                {formatClock(e.clockInAt)} – {e.clockOutAt ? formatClock(e.clockOutAt) : "now"}
              </span>
              {e.flagged && e.seq !== undefined && <span className="font-semibold text-amber-800">flagged</span>}
              {pending.timeEntries.has(e.id) && <WaitingMarker />}
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
