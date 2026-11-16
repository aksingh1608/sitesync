// POST   /api/push/subscribe { scope, deviceId, subscription }: save this browser's push subscription
// DELETE /api/push/subscribe { endpoint }: forget it
// Identity (demo mode): the field actor cookie for scope "field", the office
// actor cookie for scope "office". One browser can hold both in demo mode.
import { and, eq, inArray, ne } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ACTOR_COOKIE } from "@/lib/config";
import { describeError } from "@/lib/db/errors";
import { people, pushSubscriptions } from "@/lib/db/schema";
import { withDb } from "@/lib/db/server";
import { FIELD_ROLES, OFFICE_ROLES, isFieldRole } from "@/lib/domain";
import { officeActorId } from "@/lib/office/auth";
import { uuidv4 } from "@/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const Sub = z.object({
  endpoint: z.url().max(2000).refine((u) => u.startsWith("https://"), "https only"),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});
const Post = z.object({ scope: z.enum(["field", "office"]), deviceId: z.string().max(100).nullable().optional(), subscription: Sub });
const Del = z.object({ endpoint: z.string().max(2000) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function json(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const parsed = Post.safeParse(await json(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_subscription" }, { status: 400, headers: noStore });
  const { scope, deviceId, subscription } = parsed.data;
  const personId = scope === "field" ? request.cookies.get(ACTOR_COOKIE)?.value : officeActorId(request.cookies);
  if (!personId || !UUID.test(personId)) return NextResponse.json({ error: "pick_a_person" }, { status: 401, headers: noStore });
  try {
    return await withDb(async (db) => {
      const [p] = await db.select().from(people).where(eq(people.id, personId));
      if (!p || !p.active) return NextResponse.json({ error: "unknown_actor" }, { status: 401, headers: noStore });
      if ((scope === "field") !== isFieldRole(p.role)) return NextResponse.json({ error: "wrong_scope" }, { status: 403, headers: noStore });
      const row = {
        personId,
        deviceId: deviceId ?? null,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
        failureCount: 0,
      };
      await db.transaction(async (tx) => {
        // Demo actor switch on this browser: the previous field (or office) person stops getting its pushes.
        const sameScope = await tx
          .select({ id: people.id })
          .from(people)
          .where(inArray(people.role, scope === "field" ? [...FIELD_ROLES] : [...OFFICE_ROLES]));
        await tx.delete(pushSubscriptions).where(
          and(
            eq(pushSubscriptions.endpoint, subscription.endpoint),
            ne(pushSubscriptions.personId, personId),
            inArray(pushSubscriptions.personId, sameScope.map((x) => x.id)),
          ),
        );
        await tx
          .insert(pushSubscriptions)
          .values({ id: uuidv4(), ...row })
          .onConflictDoUpdate({ target: [pushSubscriptions.endpoint, pushSubscriptions.personId], set: row });
      });
      return NextResponse.json({ ok: true, personId }, { headers: noStore });
    });
  } catch (err) {
    console.error(`[api/push/subscribe] failed:\n${describeError(err)}`);
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: noStore });
  }
}

export async function DELETE(request: NextRequest) {
  const parsed = Del.safeParse(await json(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: noStore });
  try {
    await withDb((db) => db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, parsed.data.endpoint)));
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch (err) {
    console.error(`[api/push/subscribe] delete failed:\n${describeError(err)}`);
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: noStore });
  }
}
