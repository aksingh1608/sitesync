// POST /api/office/demo-clock { action: "+15m" | "+30m" | "+1h" | "reset" }
// Managers and coordinators only. Moves the rule clock, then runs the rules.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { CLOCK_ACTIONS, moveClock, type ClockAction } from "@/lib/clock";
import { canManageTasks } from "@/lib/domain";
import { runEscalations } from "@/lib/escalation/run";
import { officePost } from "@/lib/office/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({ action: z.enum(CLOCK_ACTIONS as [ClockAction, ...ClockAction[]]) });

export function POST(request: NextRequest) {
  return officePost(request, canManageTasks, async (db, actor, body) => {
    const parsed = Body.safeParse(body);
    if (!parsed.success) return Response.json({ error: "invalid_action" }, { status: 400 });
    const clock = await moveClock(db, parsed.data.action, actor.id);
    const run = await runEscalations(db, { trigger: "clock" });
    return { clock: { now: clock.now.toISOString(), offsetMs: clock.offsetMs }, run };
  });
}
