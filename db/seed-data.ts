// Deterministic demo data for "Demo Electrical Co." (all fictional).
// Reference data (branch, people, rollout, sites) is inserted directly; all
// operational data (tasks, receipts, status changes, clock-ins, notes) goes
// through processSync, i.e. the same validation and reducers as real clients.
// IDs are fixed. Dates are relative to "now" so Today / This Week stay useful.
import { sql } from "drizzle-orm";
import { branches, devices, people, rollouts, sites } from "../lib/db/schema";
import type { SyncEventInput } from "../lib/events";
import type { RolloutStage, TaskKind, TaskPriority, TaskStatus } from "../lib/domain";
import { offsetNorth } from "../lib/geo";
import { addDays, dayKey, zonedTime } from "../lib/time";
import { processSync } from "../lib/sync/service";
import type { Db } from "../lib/sync/store-drizzle";

const TZ = "America/New_York";

/** Fixed, valid UUID v4s: kind prefix + counter. */
const uid = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export const SEED_IDS = {
  branch: uid(0x1, 1),
  people: {
    dana: uid(0x2, 1), // coordinator
    priya: uid(0x2, 2), // hr
    marcus: uid(0x2, 3), // manager
    luis: uid(0x2, 4), // foreman
    grace: uid(0x2, 5), // foreman
    sam: uid(0x2, 6), // technician
    aisha: uid(0x2, 7), // technician
    tom: uid(0x2, 8), // technician
  },
  rollout: uid(0x3, 1),
  sites: {
    hospital: uid(0x4, 1),
    store: uid(0x4, 2),
    // rollout stores r1..r12 are uid(0x4, 101..112)
  },
};
const P = SEED_IDS.people;
const rolloutSite = (n: number) => uid(0x4, 100 + n);

const PEOPLE = [
  { id: P.dana, name: "Dana Whitfield", role: "coordinator", trade: "general", phone: "+12125550101" },
  { id: P.priya, name: "Priya Raman", role: "hr", trade: "general", phone: "+12125550102" },
  { id: P.marcus, name: "Marcus Bell", role: "manager", trade: "electrical", phone: "+12125550103" },
  { id: P.luis, name: "Luis Ortega", role: "foreman", trade: "electrical", phone: "+12125550104" },
  { id: P.grace, name: "Grace Kim", role: "foreman", trade: "lighting", phone: "+12125550105" },
  { id: P.sam, name: "Sam Novak", role: "technician", trade: "electrical", phone: "+12125550106" },
  { id: P.aisha, name: "Aisha Bello", role: "technician", trade: "lighting", phone: "+12125550107" },
  { id: P.tom, name: "Tom Reyes", role: "technician", trade: "ev", phone: "+12125550108" },
] as const;

const HOSPITAL = { lat: 40.7163, lng: -73.803 };
const STORE = { lat: 40.6806, lng: -73.996 };

/** Days each store has been in its current stage (some are past ROLLOUT_STAGE_EXPECTED_DAYS). */
const STAGE_DAYS: Record<number, number> = { 1: 20, 2: 15, 3: 2, 4: 6, 5: 3, 6: 9, 7: 2, 8: 7, 9: 1, 10: 2, 11: 1, 12: 5 };

const ROLLOUT_STORES: { n: number; area: string; address: string; lat: number; lng: number; stage: RolloutStage }[] = [
  { n: 1, area: "Flushing", address: "41-17 Main Street Plaza, Flushing, NY 11355", lat: 40.759, lng: -73.8303, stage: "done" },
  { n: 2, area: "Astoria", address: "30-12 Ditmars Way, Astoria, NY 11105", lat: 40.7644, lng: -73.9235, stage: "done" },
  { n: 3, area: "Bay Ridge", address: "8515 Harbor View Ave, Brooklyn, NY 11209", lat: 40.6262, lng: -74.03, stage: "closeout" },
  { n: 4, area: "Fordham", address: "2470 Grand Concourse Row, Bronx, NY 10458", lat: 40.8616, lng: -73.8904, stage: "punch_list" },
  { n: 5, area: "Park Slope", address: "244 Seventh Ave Mews, Brooklyn, NY 11215", lat: 40.671, lng: -73.9814, stage: "install" },
  { n: 6, area: "Harlem", address: "160 W 125th Commons, New York, NY 10027", lat: 40.8116, lng: -73.9465, stage: "install" },
  { n: 7, area: "New Dorp", address: "2655 Hylan Crossing, Staten Island, NY 10306", lat: 40.5733, lng: -74.117, stage: "install" },
  { n: 8, area: "Jamaica", address: "165-30 Merrick Court, Jamaica, NY 11432", lat: 40.7027, lng: -73.789, stage: "materials_shipped" },
  { n: 9, area: "Yonkers", address: "1950 Central Park Ave West, Yonkers, NY 10710", lat: 40.9312, lng: -73.8988, stage: "materials_shipped" },
  { n: 10, area: "Long Island City", address: "28-07 Jackson Square, Long Island City, NY 11101", lat: 40.7447, lng: -73.9485, stage: "punch_list" },
  { n: 11, area: "Hoboken", address: "512 Washington Terrace, Hoboken, NJ 07030", lat: 40.744, lng: -74.0324, stage: "survey" },
  { n: 12, area: "White Plains", address: "125 Mamaroneck Park Rd, White Plains, NY 10605", lat: 41.034, lng: -73.7629, stage: "survey" },
];

type ReceiptState = "sent" | "delivered" | "seen" | "ack";
type TaskSpec = {
  n: number;
  assignee: string;
  site: string;
  title: string;
  kind?: TaskKind;
  priority?: TaskPriority;
  /** [days from today, hour, minute] in branch time, or null for no due date. */
  due: [number, number, number] | null;
  status?: Exclude<TaskStatus, "open">;
  receipt: ReceiptState;
  createdBy?: string;
  createdDaysAgo?: number;
  parent?: number;
};

const H = SEED_IDS.sites.hospital;
const S = SEED_IDS.sites.store;
const TASKS: TaskSpec[] = [
  // Sam Novak, technician (electrical): hospital + one service call. The main demo login.
  { n: 1, assignee: P.sam, site: H, title: "Pull feeders to 3rd floor panel LP-3B", priority: "high", due: [-2, 15, 0], status: "in_progress", receipt: "ack", createdDaysAgo: 6 },
  { n: 2, assignee: P.sam, site: H, title: "Submit RFI for corridor fixture conflict", due: [-1, 12, 0], receipt: "seen", createdDaysAgo: 4 },
  { n: 3, assignee: P.sam, site: H, title: "Toolbox talk: arc flash PPE", due: [0, 7, 30], status: "done", receipt: "ack", createdDaysAgo: 2 },
  { n: 4, assignee: P.sam, site: H, title: "Terminate branch circuits in OR suite 2", priority: "urgent", due: [0, 10, 0], receipt: "ack", createdDaysAgo: 2 },
  { n: 5, assignee: P.sam, site: S, title: "Service call: breaker tripping in stockroom", kind: "service_call", priority: "high", due: [0, 14, 0], receipt: "delivered", createdDaysAgo: 1 },
  { n: 6, assignee: P.sam, site: H, title: "Label panelboards L1-L4", due: [0, 16, 0], receipt: "sent", createdDaysAgo: 1 },
  { n: 7, assignee: P.sam, site: H, title: "Install emergency lighting inverter, level 2", priority: "high", due: [2, 9, 0], receipt: "seen", createdDaysAgo: 3 },
  { n: 8, assignee: P.sam, site: H, title: "Rough-in inspection walkthrough with inspector", due: [5, 10, 30], receipt: "ack", createdDaysAgo: 5 },
  { n: 9, assignee: P.sam, site: H, title: "Order 2-inch EMT and fittings for level 4", kind: "material_request", due: [12, 12, 0], receipt: "sent", createdDaysAgo: 1 },
  { n: 10, assignee: P.sam, site: H, title: "Follow up: confirm transfer switch delivery date", kind: "follow_up", due: [1, 11, 0], receipt: "delivered", createdDaysAgo: 2 },
  { n: 11, assignee: P.sam, site: H, title: "Follow up: photograph as-built conduit routing", kind: "follow_up", priority: "low", due: [3, 15, 0], receipt: "ack", createdBy: P.sam, createdDaysAgo: 1 },
  { n: 12, assignee: P.sam, site: H, title: "Fire alarm device rough-in, level 3", due: [20, 8, 0], receipt: "sent", createdDaysAgo: 1 },

  // Aisha Bello, technician (lighting): rollout stores.
  { n: 13, assignee: P.aisha, site: rolloutSite(4), title: "Punch list: replace 2 flickering troffers, Store #104", priority: "high", due: [-3, 16, 0], receipt: "ack", createdDaysAgo: 7 },
  { n: 14, assignee: P.aisha, site: rolloutSite(6), title: "LED retrofit install, aisles 1-6, Store #106", priority: "high", due: [0, 9, 0], status: "in_progress", receipt: "ack", createdDaysAgo: 3 },
  { n: 15, assignee: P.aisha, site: rolloutSite(6), title: "Photo documentation, Store #106", due: [0, 13, 0], receipt: "seen", createdDaysAgo: 3 },
  { n: 16, assignee: P.aisha, site: rolloutSite(6), title: "LED retrofit install, aisles 7-12, Store #106", due: [1, 9, 0], receipt: "delivered", createdDaysAgo: 3, parent: 14 },
  { n: 17, assignee: P.aisha, site: rolloutSite(7), title: "Install occupancy sensors, Store #107", due: [3, 8, 0], receipt: "sent", createdDaysAgo: 1 },
  { n: 18, assignee: P.aisha, site: rolloutSite(11), title: "Pre-install survey, Store #111", due: [10, 9, 0], receipt: "sent", createdDaysAgo: 1 },
  { n: 19, assignee: P.aisha, site: rolloutSite(6), title: "Follow up: return damaged fixture cartons", kind: "follow_up", priority: "low", due: [2, 12, 0], receipt: "seen", createdBy: P.aisha, createdDaysAgo: 1 },
  { n: 20, assignee: P.aisha, site: rolloutSite(3), title: "Closeout walk with store manager, Store #103", due: [-1, 10, 0], status: "done", receipt: "ack", createdDaysAgo: 5 },

  // Tom Reyes, technician (EV): Brooklyn retail service site.
  { n: 21, assignee: P.tom, site: S, title: "Service call: diagnose EV charger fault, rear lot", kind: "service_call", priority: "urgent", due: [0, 11, 0], receipt: "ack", createdDaysAgo: 1 },
  { n: 22, assignee: P.tom, site: S, title: "Install two Level 2 EV chargers, rear lot", due: [4, 8, 0], receipt: "delivered", createdDaysAgo: 2 },
  { n: 23, assignee: P.tom, site: S, title: "Load calculation for EV expansion", due: [15, 12, 0], receipt: "sent", createdDaysAgo: 1 },
  { n: 24, assignee: P.tom, site: S, title: "Replace exit sign batteries", priority: "low", due: [-4, 12, 0], status: "cancelled", receipt: "delivered", createdDaysAgo: 8 },
  { n: 25, assignee: P.tom, site: S, title: "Follow up: utility service upgrade application", kind: "follow_up", due: [6, 10, 0], status: "blocked", receipt: "seen", createdDaysAgo: 4 },

  // Luis Ortega, foreman (electrical): hospital.
  { n: 26, assignee: P.luis, site: H, title: "Daily huddle and manpower plan", due: [0, 7, 0], status: "done", receipt: "ack", createdDaysAgo: 1 },
  { n: 27, assignee: P.luis, site: H, title: "Coordinate ceiling close-up inspection", priority: "high", due: [1, 13, 0], receipt: "ack", createdBy: P.luis, createdDaysAgo: 2 },
  { n: 28, assignee: P.luis, site: H, title: "Review switchgear submittals", due: [9, 10, 0], receipt: "seen", createdDaysAgo: 2 },

  // Grace Kim, foreman (lighting): rollout.
  { n: 29, assignee: P.grace, site: rolloutSite(5), title: "QA check, Store #105 install", due: [0, 12, 0], receipt: "ack", createdDaysAgo: 2 },
  { n: 30, assignee: P.grace, site: rolloutSite(8), title: "Schedule crews for Stores #108-#110", due: [6, 9, 0], receipt: "delivered", createdDaysAgo: 2, createdBy: P.marcus },
  { n: 31, assignee: P.grace, site: rolloutSite(1), title: "Assemble closeout docs for completed stores", priority: "low", due: [25, 12, 0], receipt: "sent", createdDaysAgo: 1 },

  // Material requests from the field to the coordinator (office queue).
  { n: 32, assignee: P.dana, site: H, title: "Material: 2 reels of 4/0 copper for LP-3B", kind: "material_request", priority: "high", due: [1, 9, 0], receipt: "seen", createdBy: P.sam, createdDaysAgo: 0.2 },
  { n: 33, assignee: P.dana, site: rolloutSite(4), title: "Material: 6 replacement troffer lenses, Store #104", kind: "material_request", due: [3, 12, 0], receipt: "ack", createdBy: P.aisha, createdDaysAgo: 2 },
];

export const SEED_TASK_ID = (n: number) => uid(0x5, n);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type SeedSummary = { tasks: number; events: number; people: number; sites: number };

export async function seed(db: Db, opts: { now?: Date } = {}): Promise<SeedSummary> {
  const now = opts.now ?? new Date();
  const today = dayKey(now, TZ);
  const local = (days: number, hh: number, mm: number) => zonedTime(addDays(today, days), hh, mm, TZ);
  /** Clamp so no seeded action is in the future. */
  const past = (d: Date) => new Date(Math.min(d.getTime(), now.getTime() - MIN));

  // 1. Wipe. sync_seq is deliberately NOT restarted: cursors only move forward.
  await db.execute(sql`
    TRUNCATE events, field_notes, status_updates, time_entries, task_receipts, sms_messages, escalations,
      push_subscriptions, digests, agent_runs, dispatch_drafts, revocations, devices, tasks, sites, rollouts, people, branches
    RESTART IDENTITY CASCADE`);
  // Day 4: a reseed also resets the demo clock (escalations start from scratch).
  await db.execute(sql`UPDATE demo_settings SET clock_offset_ms = 0, last_escalation_run_at = NULL`);

  // 2. Reference data.
  await db.insert(branches).values({ id: SEED_IDS.branch, name: "Demo Electrical Co. - New York Branch", timezone: TZ });
  await db.insert(people).values(PEOPLE.map((p) => ({ ...p, branchId: SEED_IDS.branch, active: true })));
  await db.insert(rollouts).values({
    id: SEED_IDS.rollout,
    name: "LED Retrofit - RetailCo (fictional), 12 stores",
    customerName: "RetailCo (fictional)",
    scope: "LED retrofit",
    targetEndDate: addDays(today, 60),
  });
  await db.insert(sites).values([
    {
      id: SEED_IDS.sites.hospital,
      branchId: SEED_IDS.branch,
      name: "Northfield Medical Center - East Wing Expansion",
      kind: "construction",
      address: "82-40 Parsons Crescent, Jamaica, Queens, NY 11432",
      ...HOSPITAL,
      geofenceRadiusM: 250,
    },
    {
      id: SEED_IDS.sites.store,
      branchId: SEED_IDS.branch,
      name: "Cobble Corner Home Goods (service account)",
      kind: "service",
      address: "347 Court Lane, Brooklyn, NY 11231",
      ...STORE,
      geofenceRadiusM: 100,
    },
    ...ROLLOUT_STORES.map((s) => ({
      id: rolloutSite(s.n),
      branchId: SEED_IDS.branch,
      name: `RetailCo #${100 + s.n} - ${s.area}`,
      kind: "rollout_store" as const,
      address: s.address,
      lat: s.lat,
      lng: s.lng,
      geofenceRadiusM: 120,
      rolloutId: SEED_IDS.rollout,
      rolloutStage: s.stage,
      stageChangedAt: new Date(now.getTime() - STAGE_DAYS[s.n] * DAY),
    })),
  ]);

  // 3. Operational data as events.
  let eventN = 0;
  const events: SyncEventInput[] = [];
  const push = (e: Omit<SyncEventInput, "id" | "deviceId" | "clientTs"> & { at: Date }) => {
    const { at, ...rest } = e;
    events.push({ ...rest, id: uid(0xe, ++eventN), deviceId: "seed", clientTs: past(at).toISOString() } as SyncEventInput);
  };

  for (const t of TASKS) {
    const taskId = SEED_TASK_ID(t.n);
    const created = new Date(now.getTime() - (t.createdDaysAgo ?? 1) * DAY + t.n * MIN);
    push({
      type: "task.created",
      actorId: t.createdBy ?? P.dana,
      at: created,
      payload: {
        taskId,
        title: t.title,
        description: "",
        siteId: t.site,
        assigneeId: t.assignee,
        kind: t.kind ?? "task",
        priority: t.priority ?? "normal",
        dueAt: t.due ? local(...t.due).toISOString() : null,
        parentTaskId: t.parent ? SEED_TASK_ID(t.parent) : null,
      },
    });
    const steps: ReceiptState[] = ["delivered", "seen", "ack"];
    const upto = steps.indexOf(t.receipt as (typeof steps)[number]);
    const receiptType = { delivered: "task.delivered", seen: "task.seen", ack: "task.acknowledged" } as const;
    for (let i = 0; i <= upto; i++) {
      push({
        type: receiptType[steps[i] as keyof typeof receiptType],
        actorId: t.assignee,
        at: new Date(created.getTime() + [10, 45, 90][i] * MIN),
        payload: { taskId },
      });
    }
    if (t.status) {
      const path: TaskStatus[] =
        t.status === "done" ? ["in_progress", "done"] : t.status === "cancelled" ? ["cancelled"] : [t.status];
      path.forEach((to, i) =>
        push({
          type: "task.status_changed",
          actorId: to === "cancelled" ? P.dana : t.assignee,
          at: new Date(created.getTime() + (3 + i * 2) * HOUR),
          payload: { taskId, to, ...(to === "cancelled" ? { reason: "Customer replaced batteries themselves" } : {}) },
        }),
      );
    }
  }

  // Time entries. Location only at clock-in / clock-out.
  const near = (site: { lat: number; lng: number }, m: number) => offsetNorth(site.lat, site.lng, m);
  const store6 = ROLLOUT_STORES[5];
  const store5 = ROLLOUT_STORES[4];
  const clockIn = (n: number, actorId: string, siteId: string, at: Date, p: { lat: number; lng: number }, accuracyM: number) =>
    push({
      type: "time.clock_in",
      actorId,
      at,
      payload: { timeEntryId: uid(0x6, n), siteId, lat: p.lat, lng: p.lng, accuracyM, safetyCheckDone: true },
    });
  const clockOut = (n: number, actorId: string, at: Date, p: { lat: number; lng: number }) =>
    push({ type: "time.clock_out", actorId, at, payload: { timeEntryId: uid(0x6, n), lat: p.lat, lng: p.lng, accuracyM: 10 } });

  // Yesterday: Aisha clocked in ~850 m from Store #106 (the flagged one), Tom on site.
  clockIn(1, P.aisha, rolloutSite(6), local(-1, 7, 10), near(store6, 850), 12);
  clockOut(1, P.aisha, local(-1, 15, 30), near(store6, 20));
  // Tom forgot to clock out yesterday (shows as "missing clock-out" for HR).
  clockIn(2, P.tom, S, local(-1, 8, 0), near(STORE, 30), 6);
  // Grace, three days ago: location permission denied (flagged, needs HR review).
  push({
    type: "time.clock_in",
    actorId: P.grace,
    at: local(-3, 7, 30),
    payload: { timeEntryId: uid(0x6, 6), siteId: rolloutSite(8), lat: null, lng: null, accuracyM: null, safetyCheckDone: true, locationError: "denied" },
  });
  push({ type: "time.clock_out", actorId: P.grace, at: local(-3, 14, 45), payload: { timeEntryId: uid(0x6, 6), lat: null, lng: null, locationError: "denied" } });
  clockIn(3, P.grace, rolloutSite(5), local(-2, 7, 45), near(store5, 60), 9);
  clockOut(3, P.grace, local(-2, 15, 0), near(store5, 40));
  // Today: Sam and Luis are on the hospital site now (open entries).
  clockIn(4, P.sam, H, new Date(now.getTime() - 3 * HOUR), near(HOSPITAL, 40), 8);
  clockIn(5, P.luis, H, new Date(now.getTime() - 4 * HOUR), near(HOSPITAL, 120), 15);

  push({ type: "status.set", actorId: P.sam, at: new Date(now.getTime() - 3 * HOUR), payload: { status: "on_site", note: null } });
  push({ type: "status.set", actorId: P.luis, at: new Date(now.getTime() - 4 * HOUR), payload: { status: "on_site", note: null } });
  push({
    type: "status.set",
    actorId: P.aisha,
    at: new Date(now.getTime() - 30 * MIN),
    payload: { status: "traveling", note: "Heading to Store #106" },
  });
  push({
    type: "note.created",
    actorId: P.sam,
    at: new Date(now.getTime() - 2 * HOUR),
    payload: {
      noteId: uid(0x7, 1),
      siteId: H,
      taskId: SEED_TASK_ID(1),
      kind: "text",
      text: "Feeder pull about 80% done. Need 2 more reels of 4/0 before we can finish LP-3B.",
    },
  });

  // The coordinator already approved the Store #104 lens request.
  push({
    type: "material.status_changed",
    actorId: P.dana,
    at: new Date(now.getTime() - 20 * HOUR),
    payload: { taskId: SEED_TASK_ID(33), to: "approved" },
  });

  // Replay in order, one request per run of same-actor events (like real devices).
  for (let i = 0; i < events.length; ) {
    let j = i;
    while (j < events.length && events[j].actorId === events[i].actorId && j - i < 200) j++;
    const out = await processSync(
      db,
      { deviceId: "seed", actorId: events[i].actorId, cursor: null, events: events.slice(i, j) },
      { now: () => now },
    );
    if (!out.ok) throw new Error(`seed sync failed: ${out.error}`);
    if (out.response.rejected.length) {
      throw new Error(`seed event rejected: ${JSON.stringify(out.response.rejected)}`);
    }
    i = j;
  }

  // Device freshness for the office board ("last synced X min ago").
  const ago = (ms: number) => new Date(now.getTime() - ms);
  await db.insert(devices).values([
    { id: "seed-phone-sam", personId: P.sam, lastSyncAt: ago(2 * MIN), appVersion: "0.3.0" },
    { id: "seed-phone-luis", personId: P.luis, lastSyncAt: ago(1 * MIN), appVersion: "0.3.0" },
    { id: "seed-phone-aisha", personId: P.aisha, lastSyncAt: ago(25 * MIN), appVersion: "0.3.0" },
    { id: "seed-phone-tom", personId: P.tom, lastSyncAt: ago(3 * HOUR), appVersion: "0.2.0" },
    { id: "seed-phone-grace", personId: P.grace, lastSyncAt: ago(26 * HOUR), appVersion: "0.3.0" },
  ]);

  return { tasks: TASKS.length, events: events.length, people: PEOPLE.length, sites: 2 + ROLLOUT_STORES.length };
}
