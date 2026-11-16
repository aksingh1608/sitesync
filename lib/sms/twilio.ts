// Twilio Programmable Messaging over plain REST (no SDK). Only used for the
// one demo recipient (see routeSms in ./provider.ts).
//
// Trial accounts (Twilio docs, checked 2026-11-16): messages go only to
// verified numbers in the sign-up country, from a shared Twilio trial number,
// and the body must be one of Twilio's template names, not custom text. So on
// a trial account we send the template below and store both what we wanted to
// say (`body`) and what Twilio actually sent (`sentBody`, from its response).
import type { SmsStatus } from "../domain";
import type { SmsProvider, SmsSendResult } from "./provider";

const API = "https://api.twilio.com/2010-04-01";
/** The closest Twilio trial template for a staff escalation. */
export const TRIAL_TEMPLATE = "sms_internal_alerts";

type Creds = { accountSid: string; authToken: string; from: string };
type Fetch = typeof fetch;

const auth = (c: Creds) => "Basic " + Buffer.from(`${c.accountSid}:${c.authToken}`).toString("base64");

/** Twilio message status -> ours. */
export function mapTwilioStatus(s: string | undefined): SmsStatus {
  switch (s) {
    case "delivered":
    case "read":
      return "delivered";
    case "sent":
      return "sent";
    case "undelivered":
      return "undelivered";
    case "failed":
    case "canceled":
      return "failed";
    default:
      return "queued"; // queued, accepted, sending, scheduled
  }
}

let accountTypeCache: { sid: string; type: string; at: number } | null = null;

/** "Trial" or "Full" (cached 10 min per server instance). */
export async function twilioAccountType(c: Creds, f: Fetch = fetch): Promise<string | null> {
  if (accountTypeCache && accountTypeCache.sid === c.accountSid && Date.now() - accountTypeCache.at < 600_000) {
    return accountTypeCache.type;
  }
  try {
    const res = await f(`${API}/Accounts/${c.accountSid}.json`, { headers: { authorization: auth(c) } });
    if (!res.ok) return null;
    const body = (await res.json()) as { type?: string };
    accountTypeCache = { sid: c.accountSid, type: body.type ?? "unknown", at: Date.now() };
    return accountTypeCache.type;
  } catch {
    return null;
  }
}

export function twilioProvider(c: Creds, f: Fetch = fetch): SmsProvider {
  return {
    name: "twilio",
    async send(msg): Promise<SmsSendResult> {
      const trial = (await twilioAccountType(c, f)) === "Trial";
      const form = new URLSearchParams({ To: msg.to, From: c.from, Body: trial ? TRIAL_TEMPLATE : msg.body });
      try {
        const res = await f(`${API}/Accounts/${c.accountSid}/Messages.json`, {
          method: "POST",
          headers: { authorization: auth(c), "content-type": "application/x-www-form-urlencoded" },
          body: form,
        });
        const body = (await res.json().catch(() => ({}))) as {
          sid?: string;
          status?: string;
          body?: string;
          code?: number;
          message?: string;
          error_code?: number | null;
          error_message?: string | null;
        };
        if (!res.ok) {
          return { status: "failed", providerId: null, sentBody: null, error: `Twilio ${res.status}${body.code ? ` (${body.code})` : ""}: ${body.message ?? "error"}` };
        }
        return {
          status: mapTwilioStatus(body.status),
          providerId: body.sid ?? null,
          sentBody: body.body ?? (trial ? `[template ${TRIAL_TEMPLATE}]` : msg.body),
          error: body.error_code ? `${body.error_code}: ${body.error_message ?? ""}` : null,
        };
      } catch (err) {
        return { status: "failed", providerId: null, sentBody: null, error: `network: ${(err as Error).message}` };
      }
    },
    async status(providerId) {
      try {
        const res = await f(`${API}/Accounts/${c.accountSid}/Messages/${providerId}.json`, { headers: { authorization: auth(c) } });
        if (!res.ok) return null;
        const b = (await res.json()) as { status?: string; error_code?: number | null; error_message?: string | null };
        return { status: mapTwilioStatus(b.status), error: b.error_code ? `${b.error_code}: ${b.error_message ?? ""}` : null };
      } catch {
        return null;
      }
    },
  };
}
