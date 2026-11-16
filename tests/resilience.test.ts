// Transient database failures: classification, one server-side retry, 503 +
// retryable, and the client keeping events in its outbox with backoff.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeError, isTransientDbError, withTransientRetry } from "@/lib/db/errors";
import { getMeta, localDb } from "@/lib/db/local";
import { enqueue, setActor, setTransport, sync } from "@/lib/sync/client";
import { handleSync } from "@/lib/sync/http";
import { processSync, type SyncOutcome } from "@/lib/sync/service";
import type { Db } from "@/lib/sync/store-drizzle";
import type { WireSyncResponse } from "@/lib/sync/protocol";
import { ids, makeDb } from "./helpers";

/** What Neon over ws actually threw on this machine: Drizzle wrapper -> AggregateError of connect errors. */
function neonConnectFailure() {
  const v4 = Object.assign(new Error("connect ETIMEDOUT 3.14.138.241:443"), { code: "ETIMEDOUT", syscall: "connect", address: "3.14.138.241", port: 443 });
  const v6 = Object.assign(new Error("connect ENETUNREACH 2600:1f16::1:443"), { code: "ENETUNREACH", syscall: "connect" });
  const agg = new AggregateError([v4, v6], "");
  return new Error('Failed query: select "id" from "people" where "people"."id" = $1', { cause: agg });
}
class ErrorEvent {
  type = "error";
}

describe("isTransientDbError", () => {
  it("recognises dropped / timed-out connections in every shape seen", () => {
    expect(isTransientDbError(neonConnectFailure())).toBe(true);
    expect(isTransientDbError(new Error("Failed query: select 1", { cause: new ErrorEvent() }))).toBe(true); // ws ErrorEvent ({} in logs)
    expect(isTransientDbError(Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }))).toBe(true);
    expect(isTransientDbError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("does not retry real query errors", () => {
    expect(isTransientDbError(new Error("Failed query: insert ...", { cause: Object.assign(new Error("duplicate key"), { code: "23505" }) }))).toBe(false);
    expect(isTransientDbError(new Error("Failed query: selec", { cause: Object.assign(new Error('syntax error at or near "selec"'), { code: "42601" }) }))).toBe(false);
    expect(isTransientDbError(new Error("boom"))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
  });

  it("logs the whole cause chain, not '{}'", () => {
    const text = describeError(neonConnectFailure());
    expect(text).toContain("AggregateError");
    expect(text).toContain("code=ETIMEDOUT");
    expect(text).toContain("address=3.14.138.241:443");
    expect(text).toContain("code=ENETUNREACH");
  });

  it("retries once, only for transient errors", async () => {
    const flaky = vi.fn().mockRejectedValueOnce(neonConnectFailure()).mockResolvedValue("ok");
    await expect(withTransientRetry(flaky, { delayMs: 0 })).resolves.toBe("ok");
    expect(flaky).toHaveBeenCalledTimes(2);
    const broken = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(withTransientRetry(broken, { delayMs: 0 })).rejects.toThrow("boom");
    expect(broken).toHaveBeenCalledTimes(1);
  });
});

describe("handleSync (POST /api/sync)", () => {
  const body = { deviceId: "d", actorId: ids.techA, cursor: null, events: [] };
  const okOutcome: SyncOutcome = {
    ok: true,
    response: { accepted: [], duplicates: [], rejected: [], changes: {} as never, revocations: [], cursor: "0", hasMore: false, serverTime: "x" },
  };
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("retries a transient failure once on the server", async () => {
    const run = vi.fn().mockRejectedValueOnce(neonConnectFailure()).mockResolvedValue(okOutcome);
    const res = await handleSync(body, run, { retryDelayMs: 0 });
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("returns 503 retryable when the database is still unavailable", async () => {
    const run = vi.fn().mockRejectedValue(neonConnectFailure());
    const res = await handleSync(body, run, { retryDelayMs: 0 });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toEqual({ error: "db_unavailable", retryable: true });
    expect(run).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain("ETIMEDOUT");
  });

  it("does not retry other errors (500, not retryable) and rejects bad bodies (400)", async () => {
    const run = vi.fn().mockRejectedValue(new Error("bug"));
    const res = await handleSync(body, run, { retryDelayMs: 0 });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error", retryable: false });
    expect(run).toHaveBeenCalledTimes(1);
    expect((await handleSync({ nope: 1 }, run)).status).toBe(400);
  });
});

describe("client outbox on 503", () => {
  let db: Db;
  let close: () => Promise<void>;
  const realFetch = globalThis.fetch;
  beforeEach(async () => {
    ({ db, close } = await makeDb());
    await localDb.delete({ disableAutoOpen: false });
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    setTransport(null);
    await close();
  });

  it("keeps the events pending with attempts + backoff, never rejected, then delivers them", async () => {
    const server = async (req: Parameters<Parameters<typeof setTransport>[0] & object>[0]) => {
      const out = await processSync(db, JSON.parse(JSON.stringify(req)));
      if (!out.ok) throw new Error(out.error);
      return JSON.parse(JSON.stringify(out.response)) as WireSyncResponse;
    };
    await setActor(ids.techA);
    setTransport(server);
    expect(await sync({ manual: true })).toMatchObject({ status: "ok" }); // device knows the directory
    // The real HTTP transport, against a server that answers 503 retryable.
    setTransport(null);
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: "db_unavailable", retryable: true }, { status: 503, headers: { "retry-after": "5" } }),
    ) as typeof fetch;

    await enqueue({ type: "status.set", payload: { status: "on_site", note: null } });
    const first = await sync({ manual: true });
    expect(first).toMatchObject({ status: "error" });
    let [item] = await localDb.outbox.toArray();
    expect(item).toMatchObject({ status: "pending", attempts: 1, rejectReason: null });
    expect(item.lastError).toMatch(/503.*will retry/);
    const meta1 = await getMeta();
    expect(meta1?.consecutiveFailures).toBe(1);
    const wait1 = Date.parse(meta1.nextRetryAt!) - Date.now();
    expect(wait1).toBeGreaterThan(1000); // 2 s ±20 %

    // An automatic trigger inside the backoff window does not hammer the server.
    expect(await sync()).toMatchObject({ status: "skipped" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Fails again: longer backoff, still pending.
    await sync({ manual: true });
    [item] = await localDb.outbox.toArray();
    expect(item).toMatchObject({ status: "pending", attempts: 2 });
    const meta2 = await getMeta();
    expect(Date.parse(meta2.nextRetryAt!) - Date.now()).toBeGreaterThan(wait1);

    // The database is back: the same events go through, exactly once.
    setTransport(server);
    expect(await sync({ manual: true })).toMatchObject({ status: "ok", accepted: 1 });
    expect(await localDb.outbox.count()).toBe(0);
  });
});
