// GET /api/office/agents?agent=: the agent activity log (every run: status,
// latency, tokens, cost estimate, output). Office roles.
import { desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { modelsFromEnv } from "@/lib/agents/ai";
import { agentRuns, people } from "@/lib/db/schema";
import { AGENT_NAMES, type AgentName } from "@/lib/domain";
import { officeGet } from "@/lib/office/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const a = request.nextUrl.searchParams.get("agent");
  const agent = AGENT_NAMES.includes(a as AgentName) ? (a as AgentName) : null;
  return officeGet(request, async (db) => {
    const runs = await db
      .select({ run: agentRuns, actor: people.name })
      .from(agentRuns)
      .leftJoin(people, eq(people.id, agentRuns.actorId))
      .where(agent ? eq(agentRuns.agent, agent) : undefined)
      .orderBy(desc(agentRuns.createdAt))
      .limit(100);
    const m = modelsFromEnv();
    return {
      config: { model: m.languageId, transcription: m.transcriptionId, aiAvailable: !!m.language, transcriptionAvailable: !!m.transcription },
      runs: runs.map((r) => ({ ...r.run, actorName: r.actor })),
    };
  });
}
