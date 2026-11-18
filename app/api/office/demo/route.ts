// GET /api/office/demo: health strip for the demo control panel (managers).
import { NextResponse, type NextRequest } from "next/server";
import { SAMPLE_REQUESTS } from "@/lib/agents/dispatch";
import { loadHealth } from "@/lib/demo/health";
import { officeGet } from "@/lib/office/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return officeGet(request, async (db, actor) => {
    if (actor.role !== "manager") return NextResponse.json({ error: "managers_only" }, { status: 403 });
    return { health: await loadHealth(db), samples: SAMPLE_REQUESTS };
  });
}
