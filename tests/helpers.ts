import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { branches, people, rollouts, sites } from "@/lib/db/schema";
import type { SyncEventInput } from "@/lib/events";
import { processSync } from "@/lib/sync/service";
import type { SyncResponse } from "@/lib/sync/protocol";
import type { Db } from "@/lib/sync/store-drizzle";

export const ids = {
  branch: "b0000000-0000-4000-8000-000000000001",
  coordinator: "a0000000-0000-4000-8000-000000000001",
  techA: "a0000000-0000-4000-8000-000000000002",
  techB: "a0000000-0000-4000-8000-000000000003",
  manager: "a0000000-0000-4000-8000-000000000004",
  rollout: "c0000000-0000-4000-8000-000000000001",
  siteA: "d0000000-0000-4000-8000-000000000001",
  siteB: "d0000000-0000-4000-8000-000000000002",
  siteRollout: "d0000000-0000-4000-8000-000000000003",
};

export const SITE_A = { lat: 40.7505, lng: -73.8472, radius: 150 };

export async function makeDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: "./db/migrations" });
  await db.insert(branches).values({ id: ids.branch, name: "Test Branch", timezone: "America/New_York" });
  await db.insert(people).values([
    { id: ids.coordinator, branchId: ids.branch, name: "Cora Coordinator", role: "coordinator", trade: "general" },
    { id: ids.techA, branchId: ids.branch, name: "Tess Tech", role: "technician", trade: "electrical" },
    { id: ids.techB, branchId: ids.branch, name: "Theo Tech", role: "technician", trade: "lighting" },
    { id: ids.manager, branchId: ids.branch, name: "Max Manager", role: "manager", trade: "general" },
  ]);
  await db.insert(rollouts).values({ id: ids.rollout, name: "Test Rollout", customerName: "Fictional Co", scope: "LED" });
  await db.insert(sites).values([
    {
      id: ids.siteA,
      branchId: ids.branch,
      name: "Site A",
      kind: "construction",
      address: "1 Test Ave",
      lat: SITE_A.lat,
      lng: SITE_A.lng,
      geofenceRadiusM: SITE_A.radius,
    },
    { id: ids.siteB, branchId: ids.branch, name: "Site B", kind: "service", address: "2 Test St", lat: 40.68, lng: -73.97 },
    {
      id: ids.siteRollout,
      branchId: ids.branch,
      name: "Store 1",
      kind: "rollout_store",
      address: "3 Test Rd",
      lat: 40.7,
      lng: -73.9,
      rolloutId: ids.rollout,
      rolloutStage: "install",
    },
  ]);
  return { db, close: () => client.close() };
}

let counter = 0;
/** A deterministic, valid UUID v4 for tests. */
export function uuid(): string {
  counter += 1;
  return `e0000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
}

export const at = (iso: string) => new Date(iso).toISOString();
export const NOW = new Date("2026-11-15T15:00:00Z");

type Draft = Omit<SyncEventInput, "id" | "deviceId"> & { id?: string; deviceId?: string };
export function event(e: Draft): SyncEventInput {
  return { id: uuid(), deviceId: "test-device", ...e } as SyncEventInput;
}

export function taskCreated(
  actorId: string,
  taskId: string,
  clientTs: string,
  extra: Partial<{ assigneeId: string; siteId: string; title: string; kind: string }> = {},
) {
  return event({
    type: "task.created",
    actorId,
    clientTs,
    payload: { taskId, title: "Test task", siteId: ids.siteA, assigneeId: ids.techA, ...extra },
  } as Draft);
}

export async function sync(
  db: Db,
  actorId: string,
  events: unknown[],
  cursor: string | null = null,
): Promise<SyncResponse> {
  const out = await processSync(db, { deviceId: "test-device", actorId, cursor, events }, { now: () => NOW });
  if (!out.ok) throw new Error(out.error);
  return out.response;
}
