// GET /api/office/snapshot: the live board, task table, rollouts and material
// queue, plus the demo clock and open escalations. Times are judged on the demo
// clock. Each poll also runs the escalation rules (throttled to once per 30 s)
// and, as a safety net, the report agent for one waiting note.
import { after, type NextRequest } from "next/server";
import { loadClock } from "@/lib/clock";
import { withDb } from "@/lib/db/server";
import { afterSyncAgents } from "@/lib/agents/hooks";
import { loadOpenEscalations, loadSnapshot } from "@/lib/office/queries";
import { officeGet } from "@/lib/office/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  after(() => afterSyncAgents(withDb, { trigger: "poll", throttleEscalations: true }));
  return officeGet(request, async (db, actor) => {
    const clock = await loadClock(db);
    const [snap, alerts] = await Promise.all([loadSnapshot(db, clock.now), loadOpenEscalations(db)]);
    return { actor, ...snap, clock: { offsetMs: clock.offsetMs }, escalations: alerts };
  });
}
