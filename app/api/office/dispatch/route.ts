// Dispatch agent. GET: the drafts inbox. POST { text, siteId? }: run the agent
// on a service request and store a pending draft (coordinators and managers).
// Nothing is assigned here: approval is a separate, human step (./decide).
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { listDrafts, runDispatchAgent, SAMPLE_REQUESTS } from "@/lib/agents/dispatch";
import { canManageTasks } from "@/lib/domain";
import { officeGet, officePost } from "@/lib/office/route";
import { agentLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.strictObject({ text: z.string().trim().min(5).max(5000), siteId: z.uuid().nullable().optional() });

export function GET(request: NextRequest) {
  return officeGet(request, async (db, actor) => {
    if (!canManageTasks(actor.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return { drafts: await listDrafts(db), samples: SAMPLE_REQUESTS };
  });
}

export function POST(request: NextRequest) {
  return officePost(request, canManageTasks, async (db, actor, body) => {
    const limited = await agentLimit(db, actor.id, request.headers);
    if (limited) return limited;
    const parsed = Body.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Describe the request (at least a few words)." }, { status: 400 });
    return runDispatchAgent(db, { text: parsed.data.text, siteHintId: parsed.data.siteId ?? null, actorId: actor.id, trigger: "office" });
  });
}
