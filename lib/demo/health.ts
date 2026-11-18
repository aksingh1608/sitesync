// Health strip for /office/demo: what the demo depends on, checked live.
// Key checks call the providers' free "list models" endpoints (no tokens
// spent) and are cached for a few minutes per server instance.
import { sql } from "drizzle-orm";
import { aiDailyCap, aiRunsLast24h } from "../agents/budget";
import { modelsFromEnv } from "../agents/ai";
import { APP_VERSION } from "../config";
import { demoSettings } from "../db/schema";
import { vapidKeys } from "../push/send";
import { smsEnv } from "../sms/provider";
import type { Db } from "../sync/store-drizzle";

export type Check = { ok: boolean | null; label: string; detail: string };
export type Health = {
  db: Check;
  ai: Check;
  transcription: Check;
  push: Check;
  sms: Check;
  budget: Check;
  version: { app: string; commit: string | null; builtAt: string | null; deployment: string | null; region: string | null };
};

const cache = new Map<string, { at: number; value: Check }>();
const TTL_MS = 5 * 60_000;

async function cached(key: string, fn: () => Promise<Check>): Promise<Check> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function probe(url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number | string }> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000), cache: "no-store" });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: (err as Error).name === "TimeoutError" ? "timeout" : "network error" };
  }
}

export async function loadHealth(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<Health> {
  const started = Date.now();
  let dbCheck: Check;
  try {
    await db.execute(sql`select 1`);
    const [settings] = await db.select({ offset: demoSettings.clockOffsetMs }).from(demoSettings).limit(1);
    dbCheck = { ok: true, label: "Database", detail: `reachable, ${Date.now() - started} ms${settings?.offset ? ` · demo clock +${Math.round(Number(settings.offset) / 60000)} min` : ""}` };
  } catch (err) {
    dbCheck = { ok: false, label: "Database", detail: (err as Error).message.slice(0, 120) };
  }

  const models = modelsFromEnv(env);
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  const ai = anthropicKey
    ? await cached(`ai:${anthropicKey.slice(-6)}`, async () => {
        const r = await probe("https://api.anthropic.com/v1/models?limit=1", { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" });
        return { ok: r.ok, label: "AI key", detail: r.ok ? `valid · ${models.languageId}` : `rejected (${r.status}): agents use their fallback` };
      })
    : { ok: false, label: "AI key", detail: "not set: every agent uses its rule-based fallback" };

  const openaiKey = env.OPENAI_API_KEY?.trim();
  const transcription = openaiKey
    ? await cached(`stt:${openaiKey.slice(-6)}`, async () => {
        const r = await probe("https://api.openai.com/v1/models", { authorization: `Bearer ${openaiKey}` });
        return { ok: r.ok, label: "Transcription", detail: r.ok ? `valid · ${models.transcriptionId}` : `rejected (${r.status})` };
      })
    : { ok: null, label: "Transcription", detail: "off: voice notes are not transcribed (dictate into a text note instead)" };

  const vapid = vapidKeys();
  const push: Check = vapid
    ? { ok: true, label: "Push", detail: "VAPID keys set" }
    : { ok: false, label: "Push", detail: "VAPID keys missing: no notifications" };

  const s = smsEnv(env);
  const sms: Check =
    s.provider === "twilio"
      ? { ok: !!s.twilio && !!s.demoTo, label: "SMS", detail: s.twilio && s.demoTo ? "Twilio for the demo recipient, mock for everyone else" : "SMS_PROVIDER=twilio but Twilio settings are incomplete" }
      : { ok: true, label: "SMS", detail: "mock (logged, not sent)" };

  let budget: Check;
  try {
    const used = await aiRunsLast24h(db);
    const cap = aiDailyCap(env);
    budget = { ok: used < cap, label: "AI budget", detail: `${used} / ${cap} model runs in 24 h${used >= cap ? ": fallbacks only until it drops" : ""}` };
  } catch {
    budget = { ok: null, label: "AI budget", detail: "unknown" };
  }

  return {
    db: dbCheck,
    ai,
    transcription,
    push,
    sms,
    budget,
    version: {
      app: APP_VERSION,
      // Literal process.env reads: next.config `env` inlines these at build time.
      commit: process.env.SITESYNC_COMMIT || env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null,
      builtAt: process.env.SITESYNC_BUILT_AT || null,
      deployment: env.VERCEL_URL ?? null,
      region: env.VERCEL_REGION ?? null,
    },
  };
}
