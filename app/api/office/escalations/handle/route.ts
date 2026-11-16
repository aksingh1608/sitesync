// POST /api/office/escalations/handle { taskId }: "Mark handled". Closes every
// open escalation row of the task and stops those ladders (rules.ts checks
// `handled_by`). Coordinators and managers.
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { loadClock } from "@/lib/clock";
import { escalations } from "@/lib/db/schema";
import { canManageTasks } from "@/lib/domain";
import { officePost } from "@/lib/office/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ taskId: z.uuid() });

export function POST(request: NextRequest) {
  return officePost(request, canManageTasks, async (db, actor, body) => {
    const parsed = Body.safeParse(body);
    if (!parsed.success) return Response.json({ error: "invalid_task" }, { status: 400 });
    const { now } = await loadClock(db);
    const open = and(eq(escalations.taskId, parsed.data.taskId), isNull(escalations.resolvedAt));
    const alerts = await db
      .update(escalations)
      .set({ status: "resolved", resolvedAt: now, handledBy: actor.id })
      .where(and(open, eq(escalations.channel, "coordinator_alert")))
      .returning({ id: escalations.id });
    const others = await db
      .update(escalations)
      .set({ resolvedAt: now, handledBy: actor.id })
      .where(open)
      .returning({ id: escalations.id });
    return { handled: alerts.length + others.length };
  });
}
