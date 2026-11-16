// GET /api/office/snapshot: the live board, task table, rollouts and material queue.
import type { NextRequest } from "next/server";
import { loadSnapshot } from "@/lib/office/queries";
import { officeGet } from "@/lib/office/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return officeGet(request, async (db, actor) => ({ actor, ...(await loadSnapshot(db, new Date())) }));
}
