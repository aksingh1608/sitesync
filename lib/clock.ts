// Server-side rule clock. Every escalation rule asks THIS for "now": real time
// plus a demo offset stored in `demo_settings` (the office "Demo clock"
// fast-forward). Rule code never calls Date.now() itself; it receives a Clock.
import { eq, sql } from "drizzle-orm";
import { demoSettings } from "./db/schema";
import type { Db } from "./sync/store-drizzle";

export type Clock = {
  /** Demo time: real time + offset. Rules compare against this. */
  now: Date;
  /** How far the demo clock is ahead of real time. */
  offsetMs: number;
};

/** The single place that reads the machine clock for rule purposes. */
export const realNow = (): Date => new Date();

/** Pure: a clock at real time `real` with `offsetMs`. Used by tests with a fixed time. */
export const clockAt = (real: Date, offsetMs = 0): Clock => ({ now: new Date(real.getTime() + offsetMs), offsetMs });

/** Real time behind a clock (for "is this fresh?" checks that must ignore fast-forward). */
export const realOf = (clock: Clock): Date => new Date(clock.now.getTime() - clock.offsetMs);

export const SETTINGS_ID = 1;

/** Makes sure the singleton settings row exists (migrations insert it; tests may truncate). */
export async function ensureSettings(db: Db): Promise<void> {
  await db.insert(demoSettings).values({ id: SETTINGS_ID }).onConflictDoNothing();
}

export async function loadClock(db: Db, real: Date = realNow()): Promise<Clock> {
  const [row] = await db
    .select({ offsetMs: demoSettings.clockOffsetMs })
    .from(demoSettings)
    .where(eq(demoSettings.id, SETTINGS_ID));
  return clockAt(real, Number(row?.offsetMs ?? 0));
}

/** Demo clock moves (office "Fast-forward"). Offsets only grow, or reset to 0. */
export const CLOCK_STEPS = { "+15m": 15, "+30m": 30, "+1h": 60 } as const;
export type ClockAction = keyof typeof CLOCK_STEPS | "reset";
export const CLOCK_ACTIONS = [...Object.keys(CLOCK_STEPS), "reset"] as ClockAction[];

export async function moveClock(db: Db, action: ClockAction, by: string, real: Date = realNow()): Promise<Clock> {
  await ensureSettings(db);
  const addMs = action === "reset" ? null : CLOCK_STEPS[action] * 60_000;
  await db
    .update(demoSettings)
    .set({
      clockOffsetMs: addMs === null ? 0 : sql`${demoSettings.clockOffsetMs} + ${addMs}`,
      updatedAt: real,
      updatedBy: by,
    })
    .where(eq(demoSettings.id, SETTINGS_ID));
  return loadClock(db, real);
}

/**
 * Throttle shared by every server instance: true at most once per `seconds`
 * (an atomic conditional UPDATE, so two instances can't both win).
 */
export async function claimRunSlot(db: Db, seconds: number, real: Date = realNow()): Promise<boolean> {
  await ensureSettings(db);
  const cutoff = new Date(real.getTime() - seconds * 1000);
  const rows = await db
    .update(demoSettings)
    .set({ lastEscalationRunAt: real })
    .where(
      sql`${demoSettings.id} = ${SETTINGS_ID} and (${demoSettings.lastEscalationRunAt} is null or ${demoSettings.lastEscalationRunAt} <= ${cutoff.toISOString()}::timestamptz)`,
    )
    .returning({ id: demoSettings.id });
  return rows.length > 0;
}
