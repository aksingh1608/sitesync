// GET /api/office/timesheets?week=YYYY-MM-DD (any day; snapped to Monday) [&format=csv]
import { NextResponse, type NextRequest } from "next/server";
import { BRANCH_TIMEZONE } from "@/lib/config";
import { loadTimesheets } from "@/lib/office/queries";
import { DAY_KEY, officeGet } from "@/lib/office/route";
import { timesheetCsv } from "@/lib/office/timesheets";
import { dayKey, startOfWeekKey } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return officeGet(request, async (db) => {
    const now = new Date();
    const q = request.nextUrl.searchParams.get("week");
    const week = startOfWeekKey(q && DAY_KEY.test(q) ? q : dayKey(now, BRANCH_TIMEZONE));
    const data = await loadTimesheets(db, week, now);
    if (request.nextUrl.searchParams.get("format") !== "csv") return { now: now.toISOString(), ...data };
    return new NextResponse(timesheetCsv(data, now), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="timesheets-${week}.csv"`,
        "cache-control": "no-store",
      },
    });
  });
}
