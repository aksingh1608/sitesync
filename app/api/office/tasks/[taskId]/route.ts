// GET /api/office/tasks/<id>: event history, notes (media via /api/media), follow-ups.
import type { NextRequest } from "next/server";
import { loadTaskDetail } from "@/lib/office/queries";
import { officeGet } from "@/lib/office/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, ctx: RouteContext<"/api/office/tasks/[taskId]">) {
  const { taskId } = await ctx.params;
  return officeGet(request, async (db) => (UUID.test(taskId) ? loadTaskDetail(db, taskId) : null));
}
