import { describe, expect, it } from "vitest";
import type { EventOf } from "@/lib/events";
import { haversineM, isOutsideGeofence, offsetNorth } from "@/lib/geo";
import {
  isNewer,
  reduceClockIn,
  reduceReceipt,
  reduceTaskStatusChanged,
  reduceTaskUpdated,
  type PersonRow,
  type SiteRow,
  type TaskRow,
} from "@/lib/sync/reducers";

const coordinator: PersonRow = {
  id: "a0000000-0000-4000-8000-000000000001",
  branchId: "b0000000-0000-4000-8000-000000000001",
  name: "C",
  role: "coordinator",
  trade: "general",
  phone: null,
  active: true,
};
const tech: PersonRow = { ...coordinator, id: "a0000000-0000-4000-8000-000000000002", role: "technician" };

const stamp = (ts: string, ev: string) => ({ ts: new Date(ts).toISOString(), ev });
const baseTask: TaskRow = {
  id: "t0000000-0000-4000-8000-000000000001",
  title: "T",
  description: "",
  materialStatus: null,
  materialStatusAt: null,
  siteId: "d0000000-0000-4000-8000-000000000001",
  assigneeId: tech.id,
  createdBy: coordinator.id,
  kind: "task",
  priority: "normal",
  status: "open",
  dueAt: null,
  parentTaskId: null,
  source: "manual",
  createdAt: new Date("2026-11-15T09:00:00Z"),
  updatedAt: new Date("2026-11-15T09:00:00Z"),
  fieldTs: { title: stamp("2026-11-15T09:00:00Z", "e0"), status: stamp("2026-11-15T09:00:00Z", "e0") },
};

const ev = <T extends string>(type: T, id: string, clientTs: string, actorId: string, payload: object) =>
  ({ type, id, clientTs, actorId, deviceId: "d", payload }) as never;

describe("isNewer", () => {
  it("orders by clientTs, then by event id", () => {
    expect(isNewer(stamp("2026-01-01T00:00:01Z", "a"), stamp("2026-01-01T00:00:00Z", "z"))).toBe(true);
    expect(isNewer(stamp("2026-01-01T00:00:00Z", "b"), stamp("2026-01-01T00:00:00Z", "a"))).toBe(true);
    expect(isNewer(stamp("2026-01-01T00:00:00Z", "a"), stamp("2026-01-01T00:00:00Z", "a"))).toBe(false);
    expect(isNewer(stamp("2026-01-01T00:00:00Z", "a"), undefined)).toBe(true);
  });

  it("compares instants, not strings, across time zone offsets", () => {
    // 10:00-05:00 is 15:00Z, which is later than 14:00Z.
    expect(isNewer({ ts: "2026-01-01T10:00:00-05:00", ev: "a" }, stamp("2026-01-01T14:00:00Z", "b"))).toBe(true);
  });
});

describe("reduceTaskUpdated", () => {
  it("is deterministic and does not mutate its input", () => {
    const e: EventOf<"task.updated"> = ev("task.updated", "e1", "2026-11-15T10:00:00Z", coordinator.id, {
      taskId: baseTask.id,
      changes: { title: "New" },
    });
    const snapshot = structuredClone(baseTask);
    const a = reduceTaskUpdated(baseTask, e, { actor: coordinator });
    const b = reduceTaskUpdated(baseTask, e, { actor: coordinator });
    expect(a).toEqual(b);
    expect(baseTask).toEqual(snapshot);
  });

  it("is idempotent: re-applying the winning event changes nothing", () => {
    const e: EventOf<"task.updated"> = ev("task.updated", "e1", "2026-11-15T10:00:00Z", coordinator.id, {
      taskId: baseTask.id,
      changes: { title: "New" },
    });
    const once = reduceTaskUpdated(baseTask, e, { actor: coordinator });
    if (!once.ok) throw new Error(once.reason);
    const twice = reduceTaskUpdated(once.value.task, e, { actor: coordinator });
    expect(twice.ok && twice.changed).toBe(false);
  });
});

describe("reduceTaskStatusChanged", () => {
  const done: TaskRow = { ...baseTask, status: "done", fieldTs: { status: stamp("2026-11-15T12:00:00Z", "e5") } };

  it("rejects an older event against a terminal task", () => {
    const r = reduceTaskStatusChanged(
      done,
      ev("task.status_changed", "e4", "2026-11-15T11:00:00Z", tech.id, { taskId: done.id, to: "open" }),
      { actor: tech },
    );
    expect(r.ok).toBe(false);
  });

  it("ignores (without rejecting) an older event against a non-terminal task", () => {
    const blocked: TaskRow = { ...baseTask, status: "blocked", fieldTs: { status: stamp("2026-11-15T12:00:00Z", "e5") } };
    const r = reduceTaskStatusChanged(
      blocked,
      ev("task.status_changed", "e4", "2026-11-15T11:00:00Z", tech.id, { taskId: blocked.id, to: "in_progress" }),
      { actor: tech },
    );
    expect(r).toMatchObject({ ok: true, changed: false, value: { status: "blocked" } });
  });

  it("enforces allowed transitions", () => {
    const r = reduceTaskStatusChanged(
      { ...baseTask, status: "cancelled" },
      ev("task.status_changed", "e9", "2026-11-15T13:00:00Z", coordinator.id, { taskId: baseTask.id, to: "done" }),
      { actor: coordinator },
    );
    expect(r).toEqual({ ok: false, reason: "invalid_transition: cancelled -> done" });
  });
});

describe("reduceReceipt", () => {
  it("never clears a timestamp", () => {
    const receipt = {
      taskId: baseTask.id,
      personId: tech.id,
      sentAt: new Date("2026-11-15T09:00:00Z"),
      deliveredAt: new Date("2026-11-15T09:01:00Z"),
      seenAt: new Date("2026-11-15T09:02:00Z"),
      acknowledgedAt: new Date("2026-11-15T09:03:00Z"),
    };
    const r = reduceReceipt(
      baseTask,
      receipt,
      ev("task.delivered", "e1", "2026-11-15T20:00:00Z", tech.id, { taskId: baseTask.id }),
    );
    expect(r).toEqual({ ok: true, changed: false, value: receipt });
  });
});

describe("geofence boundary", () => {
  const site: SiteRow = {
    id: "d0000000-0000-4000-8000-000000000001",
    branchId: coordinator.branchId,
    name: "S",
    kind: "construction",
    address: "x",
    lat: 40.75,
    lng: -73.85,
    geofenceRadiusM: 100,
    rolloutId: null,
    rolloutStage: null,
    stageChangedAt: null,
  };

  it("treats exactly-at-radius as inside and anything farther as outside", () => {
    expect(isOutsideGeofence(100, 100)).toBe(false);
    expect(isOutsideGeofence(100.000001, 100)).toBe(true);
  });

  it("haversine agrees with the offset helper", () => {
    const p = offsetNorth(site.lat, site.lng, 100);
    expect(haversineM(site.lat, site.lng, p.lat, p.lng)).toBeCloseTo(100, 6);
  });

  it("flags at 101 m but not at 99 m", () => {
    const at = (m: number) => {
      const p = offsetNorth(site.lat, site.lng, m);
      return reduceClockIn(
        undefined,
        undefined,
        site,
        ev("time.clock_in", "e1", "2026-11-15T07:00:00Z", tech.id, {
          timeEntryId: "f0000000-0000-4000-8000-000000000001",
          siteId: site.id,
          lat: p.lat,
          lng: p.lng,
          accuracyM: 3,
          safetyCheckDone: true,
        }),
      );
    };
    expect(at(99)).toMatchObject({ ok: true, value: { flagged: false } });
    expect(at(101)).toMatchObject({ ok: true, value: { flagged: true } });
  });
});
