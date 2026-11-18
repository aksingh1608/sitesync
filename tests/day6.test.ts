// Day 6 hardening: rate limits (shared counters), the daily AI cap, and the
// sync route's 429 that keeps events on the device.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aiRunsLast24h, budgetedModels } from "@/lib/agents/budget";
import { agentRuns } from "@/lib/db/schema";
import { clientIp, hit } from "@/lib/ratelimit";
import { handleSync } from "@/lib/sync/http";
import type { Db } from "@/lib/sync/store-drizzle";
import { makeDb, NOW } from "./helpers";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await makeDb());
});
afterEach(async () => close());

describe("rate limits", () => {
  it("counts per key and window, refuses over the limit with retry-after", async () => {
    const l = { key: "t:a", max: 3, windowSec: 60 };
    for (let i = 0; i < 3; i++) expect((await hit(db, [l], NOW)).ok).toBe(true);
    const r = await hit(db, [l], NOW);
    expect(r).toMatchObject({ ok: false, key: "t:a" });
    expect(r.ok ? 0 : r.retryAfterSec).toBeGreaterThan(0);
    // Another key and the next window are independent.
    expect((await hit(db, [{ ...l, key: "t:b" }], NOW)).ok).toBe(true);
    expect((await hit(db, [l], new Date(NOW.getTime() + 60_000))).ok).toBe(true);
  });

  it("refuses if any of several limits is over", async () => {
    const device = { key: "d:1", max: 100, windowSec: 60 };
    const ip = { key: "ip:1", max: 1, windowSec: 60 };
    expect((await hit(db, [device, ip], NOW)).ok).toBe(true);
    expect(await hit(db, [device, ip], NOW)).toMatchObject({ ok: false, key: "ip:1" });
  });

  it("reads the client IP from x-forwarded-for", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIp(new Headers())).toBe("unknown");
  });

  it("a rate-limited sync is a retryable 429 (the device keeps its events)", async () => {
    const res = await handleSync({ deviceId: "d", actorId: "a0000000-0000-4000-8000-000000000002", cursor: null, events: [] }, async () => ({
      ok: false,
      status: 429,
      error: "rate_limited",
      retryAfterSec: 12,
    }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
    expect(await res.json()).toMatchObject({ retryable: true });
  });
});

describe("daily AI cap", () => {
  it("switches agents to the fallback once the cap is used up", async () => {
    const env = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.AI_DAILY_RUN_CAP = "2";
    try {
      expect((await budgetedModels(db, NOW)).language).not.toBeNull();
      const row = (i: number) => ({ id: `e1000000-0000-4000-8000-00000000000${i}`, agent: "ops_copilot" as const, trigger: "t", inputSummary: "q", status: "ok" as const, model: "claude-opus-5-5", createdAt: NOW });
      await db.insert(agentRuns).values([row(1), row(2)]);
      // Fallback runs (no model) do not count.
      await db.insert(agentRuns).values({ ...row(3), model: null, status: "fallback" });
      expect(await aiRunsLast24h(db, NOW)).toBe(2);
      expect((await budgetedModels(db, NOW)).language).toBeNull();
    } finally {
      process.env = env;
    }
  });
});
