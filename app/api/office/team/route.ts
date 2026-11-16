// GET /api/office/team?from=YYYY-MM-DD&to=YYYY-MM-DD (branch days, inclusive; default last 30 days)
import type { NextRequest } from "next/server";
import { BRANCH_TIMEZONE } from "@/lib/config";
import { teamStats } from "@/lib/office/queries";
import { DAY_KEY, officeGet } from "@/lib/office/route";
import { addDays, dayKey } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return officeGet(request, async (db) => {
    const now = new Date();
    const p = request.nextUrl.searchParams;
    const today = dayKey(now, BRANCH_TIMEZONE);
    const to = DAY_KEY.test(p.get("to") ?? "") ? p.get("to")! : today;
    let from = DAY_KEY.test(p.get("from") ?? "") ? p.get("from")! : addDays(to, -29);
    if (from > to) from = to;
    if (addDays(from, 366) < to) from = addDays(to, -366);
    return teamStats(db, from, to, now);
  });
}
