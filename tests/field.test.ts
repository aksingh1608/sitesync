// Phone-test fixes: one sync status, calm offline text, site preselection, save reasons.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRANCH_TIMEZONE } from "@/lib/config";
import { localDb, setMeta, type Meta } from "@/lib/db/local";
import { saveBlockedReason } from "@/lib/field/notes";
import { defaultSiteId, rankSites } from "@/lib/field/sites";
import { setActor, setTransport, sync } from "@/lib/sync/client";
import { processSync } from "@/lib/sync/service";
import { describeSync, isNetworkError, NO_SIGNAL_TEXT } from "@/lib/sync/status";
import type { WireSyncResponse } from "@/lib/sync/protocol";
import type { Db } from "@/lib/sync/store-drizzle";
import { at, ids, makeDb, taskCreated, uuid } from "./helpers";

const clock = (iso: string) => `T${iso.slice(11, 16)}`;
type M = Pick<Meta, "lastSyncAt" | "lastSyncResult" | "simulateOffline">;
const meta = (m: Partial<M> = {}): M => ({ lastSyncAt: null, lastSyncResult: null, simulateOffline: false, ...m });
const view = (m: M | undefined, online = true, pending = 0, uploads = 0) =>
  describeSync({ meta: m, online, pending, uploads, formatClock: clock });

describe("describeSync (one source for the top bar and the Me page)", () => {
  const synced = meta({ lastSyncAt: "2026-11-15T20:39:00.000Z", lastSyncResult: { status: "ok", at: "2026-11-15T20:39:00.000Z", accepted: 0, duplicates: 0, rejected: [], pulled: 0 } });

  it("reports the same last sync time whatever the state", () => {
    expect(view(synced).headline).toBe("Synced T20:39");
    for (const v of [view(synced), view(synced, false), view({ ...synced, simulateOffline: true }), view(synced, true, 3)]) {
      expect(v.lastSyncAt).toBe("T20:39");
    }
  });

  it("never says 'never' while loading, and 'not yet' only before the first sync", () => {
    expect(view(undefined)).toMatchObject({ tone: "loading", lastSyncAt: null });
    expect(view(meta())).toMatchObject({ tone: "ok", headline: "Not synced yet", lastSyncAt: null });
  });

  it("is calm when offline, even if the last attempt failed", () => {
    const failed = meta({
      lastSyncAt: synced.lastSyncAt,
      lastSyncResult: { status: "error", at: "x", error: "Failed to fetch", retryAt: "2026-11-15T20:41:00.000Z" },
    });
    const v = view(failed, false, 2, 1);
    expect(v).toMatchObject({ tone: "offline", headline: "No signal", error: null });
    expect(v.detail).toContain(NO_SIGNAL_TEXT);
    expect(v.waiting).toBe("2 waiting to sync · 1 upload");
    // navigator.onLine can claim "online" in airplane mode: a network failure is still "no signal".
    expect(view(failed, true)).toMatchObject({ tone: "offline", error: null });
  });

  it("shows real errors only when online", () => {
    const server = meta({ lastSyncResult: { status: "error", at: "x", error: "HTTP 500: internal_error", retryAt: "2026-11-15T20:41:00.000Z" } });
    expect(view(server, true)).toMatchObject({ tone: "error", error: "HTTP 500: internal_error", headline: "Sync failed · retry T20:41" });
    expect(view(server, false)).toMatchObject({ tone: "offline", error: null });
  });

  it("recognises network failures across browsers", () => {
    for (const m of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource.", "The operation timed out.", "signal is aborted without reason"]) {
      expect(isNetworkError(m), m).toBe(true);
    }
    for (const m of ["HTTP 500: internal_error", "HTTP 403: unknown_actor", "Access code needed: reload the app and enter it"]) {
      expect(isNetworkError(m), m).toBe(false);
    }
  });
});

describe("defaultSiteId / rankSites (Clock and Notes)", () => {
  const now = new Date("2026-11-15T15:00:00Z"); // 10:00 NY
  const sites = [
    { id: "a", name: "Alpha" },
    { id: "b", name: "Bravo" },
    { id: "c", name: "Charlie" },
  ];
  const t = (siteId: string, due: string | null, status = "open" as const) => ({ siteId, status, dueAt: due ? new Date(due) : null });
  const base = { sites, now, tz: BRANCH_TIMEZONE };

  it("prefers the task's site, then where I'm clocked in, then work due today, then any open work", () => {
    const myTasks = [t("b", "2026-11-20T15:00:00Z"), t("c", "2026-11-15T20:00:00Z")];
    expect(defaultSiteId({ ...base, myTasks, taskSiteId: "a" })).toBe("a");
    expect(defaultSiteId({ ...base, myTasks, myEntries: [{ siteId: "b", clockOutAt: null }] })).toBe("b");
    expect(defaultSiteId({ ...base, myTasks, myEntries: [{ siteId: "a", clockOutAt: new Date() }] })).toBe("c");
    expect(defaultSiteId({ ...base, myTasks: [t("b", "2026-11-20T15:00:00Z")] })).toBe("b");
    expect(defaultSiteId({ ...base, myTasks: [] })).toBe("a");
    expect(defaultSiteId({ ...base, sites: [], myTasks })).toBeNull();
  });

  it("ignores done work and sites not on this device", () => {
    expect(defaultSiteId({ ...base, myTasks: [t("c", "2026-11-15T20:00:00Z", "done" as never), t("zzz", "2026-11-15T20:00:00Z")] })).toBe("a");
    expect(defaultSiteId({ ...base, myTasks: [], taskSiteId: "zzz" })).toBe("a");
  });

  it("lists sites with today's work first", () => {
    const ranked = rankSites(sites, [t("b", "2026-11-20T15:00:00Z"), t("c", "2026-11-14T15:00:00Z")], now, BRANCH_TIMEZONE);
    expect(ranked.map((s) => s.id)).toEqual(["c", "b", "a"]);
  });
});

describe("saveBlockedReason", () => {
  const base = { site: "a", kind: "text" as const, text: "", hasRecording: false, hasPhoto: false, sitesAvailable: true };
  it("explains why Save is disabled", () => {
    expect(saveBlockedReason({ ...base, site: null })).toBe("Pick a site first.");
    expect(saveBlockedReason({ ...base, site: null, sitesAvailable: false })).toMatch(/No sites on this device/);
    expect(saveBlockedReason(base)).toBe("Write your note first.");
    expect(saveBlockedReason({ ...base, kind: "voice" })).toBe("Record a voice note first.");
    expect(saveBlockedReason({ ...base, kind: "photo" })).toBe("Take a photo first.");
    expect(saveBlockedReason({ ...base, text: "ok" })).toBeNull();
    expect(saveBlockedReason({ ...base, kind: "voice", hasRecording: true })).toBeNull();
  });
});

describe("site list offline", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await makeDb());
    setTransport(async (req) => {
      const out = await processSync(db, JSON.parse(JSON.stringify(req)));
      if (!out.ok) throw new Error(out.error);
      return JSON.parse(JSON.stringify(out.response)) as WireSyncResponse;
    });
    await localDb.delete({ disableAutoOpen: false });
  });
  afterEach(async () => {
    setTransport(null);
    await close();
  });

  it("keeps my sites on the device and preselects one with the network gone", async () => {
    const r = await processSync(db, {
      deviceId: "office",
      actorId: ids.coordinator,
      cursor: null,
      events: [taskCreated(ids.coordinator, uuid(), at("2026-11-15T09:00:00Z"), { siteId: ids.siteB })],
    });
    if (!r.ok) throw new Error(r.error);
    await setActor(ids.techA);
    await sync();
    setTransport(async () => {
      throw new TypeError("Failed to fetch");
    });
    await setMeta({ simulateOffline: true });
    const [sites, myTasks] = [await localDb.sites.toArray(), await localDb.tasks.where("assigneeId").equals(ids.techA).toArray()];
    expect(sites.map((s) => s.id)).toEqual([ids.siteB]);
    expect(defaultSiteId({ sites, myTasks, now: new Date(), tz: BRANCH_TIMEZONE })).toBe(ids.siteB);
  });
});
