// SMS behind one interface. SMS_PROVIDER=twilio|mock (default mock). Even with
// twilio selected, only the demo recipient (one seeded person picked in the
// office SMS log) is texted for real, at SMS_DEMO_TO_NUMBER; everyone else is
// routed to mock automatically. Real numbers are never stored (masked).
import type { SmsStatus } from "../domain";

export type SmsSendResult = {
  status: SmsStatus;
  providerId: string | null;
  /** What the provider really sent (a Twilio trial swaps custom text for a template). */
  sentBody: string | null;
  error: string | null;
};

export interface SmsProvider {
  readonly name: "mock" | "twilio";
  send(msg: { to: string; body: string }): Promise<SmsSendResult>;
  /** Current delivery status of a sent message (twilio only). */
  status?(providerId: string): Promise<{ status: SmsStatus; error: string | null } | null>;
}

/** "+49 ••• ••• ••42": keeps the country code and the last 2 digits. */
export function maskNumber(n: string | null | undefined): string {
  if (!n) return "(none)";
  const digits = n.replace(/[^\d+]/g, "");
  const cc = digits.startsWith("+49") ? "+49" : digits.startsWith("+1") ? "+1" : digits.slice(0, 3);
  return `${cc} ••• ••• ••${digits.slice(-2)}`;
}

/** Writes nothing anywhere: the SMS log row (sms_messages) is the whole "delivery". */
export const mockProvider: SmsProvider = {
  name: "mock",
  async send(msg) {
    return { status: "mocked", providerId: null, sentBody: msg.body, error: null };
  },
};

export type SmsEnv = {
  provider: "mock" | "twilio";
  demoTo: string | null;
  twilio: { accountSid: string; authToken: string; from: string } | null;
};

export function smsEnv(env: NodeJS.ProcessEnv = process.env): SmsEnv {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM_NUMBER;
  return {
    provider: env.SMS_PROVIDER === "twilio" ? "twilio" : "mock",
    demoTo: env.SMS_DEMO_TO_NUMBER || null,
    twilio: sid && token && from ? { accountSid: sid, authToken: token, from } : null,
  };
}

/** Which way one message goes. Pure. */
export function routeSms(
  env: SmsEnv,
  personId: string,
  demoPersonId: string | null,
  personPhone: string | null,
): { via: "mock"; to: string | null } | { via: "twilio"; to: string } | { via: "misconfigured"; to: string; error: string } {
  const isDemo = demoPersonId !== null && personId === demoPersonId;
  if (env.provider !== "twilio" || !isDemo) return { via: "mock", to: personPhone };
  if (!env.demoTo) return { via: "misconfigured", to: "", error: "SMS_DEMO_TO_NUMBER is not set" };
  if (!env.twilio) return { via: "misconfigured", to: env.demoTo, error: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER missing" };
  return { via: "twilio", to: env.demoTo };
}
