// /t/<code>: short task link used in SMS. <code> = last 10 hex digits of the
// task id (lib/escalation/run.ts shortCode). Redirects to the field task page
// (behind the demo access gate like every page).
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { tasks } from "@/lib/db/schema";
import { withDb } from "@/lib/db/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, ctx: RouteContext<"/t/[code]">) {
  const { code } = await ctx.params;
  const to = new URL("/field", request.url);
  if (/^[0-9a-f]{10}$/i.test(code)) {
    try {
      const rows = await withDb((db) =>
        db.select({ id: tasks.id }).from(tasks).where(sql`replace(${tasks.id}::text, '-', '') like ${"%" + code.toLowerCase()}`).limit(2),
      );
      if (rows.length === 1) {
        to.pathname = "/field/task";
        to.searchParams.set("id", rows[0].id);
      }
    } catch {
      // Fall through to the task list.
    }
  }
  return NextResponse.redirect(to, { status: 302, headers: { "cache-control": "no-store" } });
}
