// GET: is the AI available for the copilot (so the panel can say so up front), and which
// tools the caller's role gets.
// POST { question }: the ops copilot (read-only tools scoped to the caller's role).
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { aiDailyCap, aiRunsLast24h } from "@/lib/agents/budget";
import { askCopilot, TOOLS_BY_ROLE } from "@/lib/agents/copilot";
import { modelsFromEnv } from "@/lib/agents/ai";
import { loadClock } from "@/lib/clock";
import { officeGet, officePost } from "@/lib/office/route";
import { agentLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.strictObject({ question: z.string().trim().min(3).max(500) });

export function POST(request: NextRequest) {
  return officePost(request, () => true, async (db, actor, body) => {
    const limited = await agentLimit(db, actor.id, request.headers);
    if (limited) return limited;
    const parsed = Body.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Ask a question (3 to 500 characters)." }, { status: 400 });
    const clock = await loadClock(db);
    return askCopilot(db, { question: parsed.data.question, actor: { id: actor.id, role: actor.role }, now: clock.now });
  });
}

export function GET(request: NextRequest) {
  return officeGet(request, async (db, actor) => {
    const models = modelsFromEnv();
    let reason: "no_key" | "daily_cap" | null = null;
    if (!models.language) reason = "no_key";
    else if ((await aiRunsLast24h(db)) >= aiDailyCap()) reason = "daily_cap";
    return { ai: reason === null, reason, tools: TOOLS_BY_ROLE[actor.role] };
  });
}
