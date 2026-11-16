// GET  /api/office/sms: the SMS log (mock and real), provider mode, demo recipient.
// POST /api/office/sms { action: "set_demo_person", personId | null } | { action: "test" }
// Coordinators and managers. The real demo number is never returned (masked).
import { desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ensureSettings, loadClock, SETTINGS_ID } from "@/lib/clock";
import { demoSettings, people, smsMessages } from "@/lib/db/schema";
import { canManageTasks, isFieldRole } from "@/lib/domain";
import { officeGet, officePost } from "@/lib/office/route";
import { maskNumber, smsEnv } from "@/lib/sms/provider";
import { deliverSms, demoSmsPersonId, refreshSmsStatuses } from "@/lib/sms/send";
import { twilioAccountType } from "@/lib/sms/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export function GET(request: NextRequest) {
  return officeGet(request, async (db, actor) => {
    if (!canManageTasks(actor.role)) return Response.json({ error: "forbidden" }, { status: 403 });
    const list = () => db.select().from(smsMessages).orderBy(desc(smsMessages.createdAt)).limit(200);
    let rows = await list();
    if (await refreshSmsStatuses(db, rows)) rows = await list();
    const env = smsEnv();
    return {
      rows,
      mode: env.provider,
      twilioConfigured: !!env.twilio,
      twilioAccount: env.provider === "twilio" && env.twilio ? await twilioAccountType(env.twilio) : null,
      demoNumber: env.demoTo ? maskNumber(env.demoTo) : null,
      demoPersonId: await demoSmsPersonId(db),
      people: await db.select({ id: people.id, name: people.name, role: people.role, phone: people.phone }).from(people),
    };
  });
}

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set_demo_person"), personId: z.uuid().nullable() }),
  z.object({ action: z.literal("test") }),
]);

export function POST(request: NextRequest) {
  return officePost(request, canManageTasks, async (db, actor, body) => {
    const parsed = Body.safeParse(body);
    if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
    await ensureSettings(db);
    if (parsed.data.action === "set_demo_person") {
      const id = parsed.data.personId;
      if (id) {
        const [p] = await db.select().from(people).where(eq(people.id, id));
        if (!p || !isFieldRole(p.role)) return Response.json({ error: "pick a technician or foreman" }, { status: 400 });
      }
      await db.update(demoSettings).set({ smsDemoPersonId: id, updatedBy: actor.id, updatedAt: new Date() }).where(eq(demoSettings.id, SETTINGS_ID));
      return { demoPersonId: id };
    }
    const personId = await demoSmsPersonId(db);
    if (!personId) return Response.json({ error: "Pick the demo recipient first." }, { status: 400 });
    const { now } = await loadClock(db);
    const r = await deliverSms(db, { personId, body: "SiteSync test message (Demo Electrical Co. demo).", escalationId: null, at: now });
    return { sms: { id: r.id, provider: r.provider, status: r.status, error: r.error } };
  });
}
