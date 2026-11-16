// Sends one SMS (mock or real) and records it in `sms_messages` (the SMS log).
import { eq, inArray } from "drizzle-orm";
import { demoSettings, people, smsMessages } from "../db/schema";
import { SETTINGS_ID } from "../clock";
import type { Db } from "../sync/store-drizzle";
import { uuidv4 } from "../uuid";
import { maskNumber, mockProvider, routeSms, smsEnv, type SmsEnv, type SmsProvider } from "./provider";
import { twilioProvider } from "./twilio";

export type SmsDeps = { env?: SmsEnv; twilio?: SmsProvider };

export async function demoSmsPersonId(db: Db): Promise<string | null> {
  const [s] = await db.select({ id: demoSettings.smsDemoPersonId }).from(demoSettings).where(eq(demoSettings.id, SETTINGS_ID));
  return s?.id ?? null;
}

export async function deliverSms(
  db: Db,
  input: { personId: string; body: string; escalationId: string | null; at: Date },
  deps: SmsDeps = {},
) {
  const env = deps.env ?? smsEnv();
  const [person] = await db.select({ phone: people.phone }).from(people).where(eq(people.id, input.personId));
  const route = routeSms(env, input.personId, await demoSmsPersonId(db), person?.phone ?? null);

  let provider: SmsProvider | null = null;
  let result;
  if (route.via === "misconfigured") {
    result = { status: "failed" as const, providerId: null, sentBody: null, error: route.error };
  } else if (route.via === "mock") {
    provider = mockProvider;
    result = route.to
      ? await mockProvider.send({ to: route.to, body: input.body })
      : { status: "failed" as const, providerId: null, sentBody: null, error: "no phone number on file" };
  } else {
    provider = deps.twilio ?? twilioProvider(env.twilio!);
    result = await provider.send({ to: route.to, body: input.body });
  }

  const row = {
    id: uuidv4(),
    escalationId: input.escalationId,
    personId: input.personId,
    provider: route.via === "mock" ? ("mock" as const) : ("twilio" as const),
    toMasked: maskNumber(route.to),
    body: input.body,
    sentBody: result.sentBody,
    status: result.status,
    providerId: result.providerId,
    error: result.error,
    createdAt: input.at,
    updatedAt: input.at,
  };
  await db.insert(smsMessages).values(row);
  return { ...row, ok: result.status !== "failed" && result.status !== "undelivered" };
}

const FINAL = new Set(["delivered", "undelivered", "failed", "mocked"]);

/** Refresh delivery status of recent real messages that aren't final yet (SMS log page). */
export async function refreshSmsStatuses(db: Db, rows: { id: string; provider: string; providerId: string | null; status: string; createdAt: Date }[], deps: SmsDeps = {}) {
  const env = deps.env ?? smsEnv();
  if (!env.twilio && !deps.twilio) return 0;
  const provider = deps.twilio ?? twilioProvider(env.twilio!);
  const open = rows
    .filter((r) => r.provider === "twilio" && r.providerId && !FINAL.has(r.status) && Date.now() - r.createdAt.getTime() < 2 * 86_400_000)
    .slice(0, 10);
  let changed = 0;
  await Promise.all(
    open.map(async (r) => {
      const s = await provider.status?.(r.providerId!);
      if (s && s.status !== r.status) {
        changed++;
        await db.update(smsMessages).set({ status: s.status, error: s.error, updatedAt: new Date() }).where(inArray(smsMessages.id, [r.id]));
      }
    }),
  );
  return changed;
}
