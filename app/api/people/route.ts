// Demo-mode directory for the role picker. No real login.
import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { withDb } from "@/lib/db/server";
import { people } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await withDb((db) =>
      db
        .select({ id: people.id, name: people.name, role: people.role, trade: people.trade })
        .from(people)
        .where(eq(people.active, true))
        .orderBy(asc(people.name)),
    );
    return NextResponse.json({ people: rows }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[api/people] failed", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
