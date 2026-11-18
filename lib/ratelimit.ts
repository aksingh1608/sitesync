// Simple fixed-window rate limits shared by all server instances (Postgres).
// Enough for a demo behind an access code: it stops a runaway client or a
// leaked code from hammering sync, uploads or the (paid) agent routes.
import { lt, sql } from "drizzle-orm";
import { rateLimits } from "./db/schema";
import type { Db } from "./sync/store-drizzle";

export type Limit = { key: string; max: number; windowSec: number };

/** Limits per route family. Normal use stays far below them. */
export const LIMITS = {
  // A phone syncs every 30 s plus triggers and paging bursts.
  syncDevice: { max: 120, windowSec: 60 },
  syncIp: { max: 600, windowSec: 60 },
  uploadActor: { max: 20, windowSec: 60 },
  uploadIp: { max: 60, windowSec: 60 },
  // Agent routes call a paid model.
  agentActor: { max: 12, windowSec: 60 },
  agentIp: { max: 30, windowSec: 60 },
} as const;

/** The caller's IP (Vercel sets x-forwarded-for; the first entry is the client). */
export function clientIp(headers: Headers): string {
  return (headers.get("x-forwarded-for")?.split(",")[0] ?? headers.get("x-real-ip") ?? "unknown").trim().slice(0, 64);
}

export type RateResult = { ok: true } | { ok: false; retryAfterSec: number; key: string };

/**
 * Counts one request against every limit; refuses if any is over. One
 * statement per limit (upsert ... returning count).
 */
export async function hit(db: Db, limits: Limit[], now: Date = new Date()): Promise<RateResult> {
  let refused: RateResult = { ok: true };
  for (const l of limits) {
    const windowMs = l.windowSec * 1000;
    const start = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const [row] = await db
      .insert(rateLimits)
      .values({ key: l.key, windowStart: start, count: 1 })
      .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1` } })
      .returning({ count: rateLimits.count });
    if (row.count > l.max && refused.ok) {
      refused = { ok: false, key: l.key, retryAfterSec: Math.max(1, Math.ceil((start.getTime() + windowMs - now.getTime()) / 1000)) };
    }
  }
  // Prune old windows now and then (cheap, indexed).
  if (Math.random() < 0.02) await db.delete(rateLimits).where(lt(rateLimits.windowStart, new Date(now.getTime() - 3_600_000)));
  return refused;
}

export const tooMany = (r: Extract<RateResult, { ok: false }>) =>
  Response.json(
    { error: "rate_limited", retryable: true, message: "Too many requests; slowing down." },
    { status: 429, headers: { "retry-after": String(r.retryAfterSec), "cache-control": "no-store" } },
  );

export const limitsFor = (family: keyof typeof LIMITS, id: string): Limit => ({ key: `${family}:${id}`, ...LIMITS[family] });

/** Agent routes (paid model calls): per office person and per IP. Null = allowed. */
export async function agentLimit(db: Db, actorId: string, headers: Headers): Promise<Response | null> {
  const r = await hit(db, [limitsFor("agentActor", actorId), limitsFor("agentIp", clientIp(headers))]);
  return r.ok ? null : tooMany(r);
}
