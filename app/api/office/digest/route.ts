// Daily digests. GET: latest digest per day. POST { day? }: generate the
// digest for a branch day (default: today on the demo clock), coordinators and managers.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { generateDigest, listDigests } from "@/lib/agents/digest";
import { loadClock } from "@/lib/clock";
import { BRANCH_TIMEZONE } from "@/lib/config";
import { canManageTasks } from "@/lib/domain";
import { officeGet, officePost } from "@/lib/office/route";
import { agentLimit } from "@/lib/ratelimit";
import { dayKey } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.strictObject({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).nullable();

export function GET(request: NextRequest) {
  return officeGet(request, async (db, actor) => {
    const clock = await loadClock(db);
    return { today: dayKey(clock.now, BRANCH_TIMEZONE), canGenerate: canManageTasks(actor.role), digests: await listDigests(db) };
  });
}

export function POST(request: NextRequest) {
  return officePost(request, canManageTasks, async (db, actor, body) => {
    const limited = await agentLimit(db, actor.id, request.headers);
    if (limited) return limited;
    const parsed = Body.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    const clock = await loadClock(db);
    const day = parsed.data?.day ?? dayKey(clock.now, BRANCH_TIMEZONE);
    const out = await generateDigest(db, { day, now: clock.now, trigger: "office", actorId: actor.id });
    return { id: out.id, day, mode: out.content.mode };
  });
}
