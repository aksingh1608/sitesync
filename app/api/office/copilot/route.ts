// POST { question }: the ops copilot (read-only tools scoped to the caller's role).
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { askCopilot } from "@/lib/agents/copilot";
import { loadClock } from "@/lib/clock";
import { officePost } from "@/lib/office/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.strictObject({ question: z.string().trim().min(3).max(500) });

export function POST(request: NextRequest) {
  return officePost(request, () => true, async (db, actor, body) => {
    const parsed = Body.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Ask a question (3 to 500 characters)." }, { status: 400 });
    const clock = await loadClock(db);
    return askCopilot(db, { question: parsed.data.question, actor: { id: actor.id, role: actor.role }, now: clock.now });
  });
}
