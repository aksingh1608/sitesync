"use client";
// SMS log: every escalation SMS, mock or real, with its delivery status. Also
// picks the one seeded person whose SMS really goes to the verified demo phone.
import { useState } from "react";
import { UpdatedAgo, usePolling, useSnapshot } from "@/components/office/data";
import { ErrorLine, fmtDateTime, PageHeader, Pill, Select } from "@/components/office/ui";
import { canManageTasks, isFieldRole, type Role } from "@/lib/domain";

type SmsRow = {
  id: string;
  escalationId: string | null;
  personId: string;
  provider: "mock" | "twilio";
  toMasked: string;
  body: string;
  sentBody: string | null;
  status: string;
  providerId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
type SmsData = {
  rows: SmsRow[];
  mode: "mock" | "twilio";
  twilioConfigured: boolean;
  twilioAccount: string | null;
  demoNumber: string | null;
  demoPersonId: string | null;
  people: { id: string; name: string; role: Role; phone: string | null }[];
};

const TONE: Record<string, "slate" | "green" | "amber" | "red" | "blue"> = {
  mocked: "blue",
  queued: "amber",
  sent: "green",
  delivered: "green",
  undelivered: "red",
  failed: "red",
};

export default function SmsPage() {
  const snap = useSnapshot();
  const { data, error, updatedAt, refresh } = usePolling<SmsData>("/api/office/sms");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (snap.data && !canManageTasks(snap.data.actor.role)) return <p className="text-sm text-muted-foreground">Coordinators and managers only.</p>;

  async function act(body: unknown) {
    setBusy(true);
    setActionError(null);
    setNote(null);
    try {
      const res = await fetch("/api/office/sms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const out = (await res.json().catch(() => ({}))) as { error?: string; sms?: { provider: string; status: string; error: string | null } };
      if (!res.ok) setActionError(out.error ?? `HTTP ${res.status}`);
      else if (out.sms) setNote(`Test SMS: ${out.sms.provider}, ${out.sms.status}${out.sms.error ? ` (${out.sms.error})` : ""}`);
    } catch {
      setActionError("No connection.");
    }
    setBusy(false);
    await refresh();
  }

  const name = (id: string) => data?.people.find((p) => p.id === id)?.name ?? "?";
  const field = data?.people.filter((p) => isFieldRole(p.role)) ?? [];

  return (
    <>
      <PageHeader title="SMS log">
        <UpdatedAgo at={updatedAt} error={error} />
      </PageHeader>
      {!data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-4">
          <section className="space-y-2 rounded-lg border p-3 text-sm" data-testid="sms-settings">
            <p>
              Provider: <strong>{data.mode === "twilio" ? "Twilio" : "Mock"}</strong>
              {data.mode === "twilio" && (
                <>
                  {" "}
                  ({data.twilioConfigured ? `account: ${data.twilioAccount ?? "unknown"}` : "credentials missing"})
                </>
              )}
              . Mock messages are only written here. With Twilio, only the person below is texted for real
              {data.demoNumber ? `, at the verified demo number ${data.demoNumber}` : ""}; everyone else stays mock.
            </p>
            {data.twilioAccount === "Trial" && (
              <p className="text-xs text-amber-800 dark:text-amber-300">
                Twilio trial: custom text isn&apos;t allowed, so the phone receives Twilio&apos;s template message, not ours. Both are shown below.
              </p>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <Select
                label="Real SMS recipient (demo)"
                value={data.demoPersonId ?? ""}
                onChange={(e) => act({ action: "set_demo_person", personId: e.target.value || null })}
                disabled={busy}
                data-testid="sms-demo-person"
              >
                <option value="">Nobody (all mock)</option>
                {field.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <button
                disabled={busy || !data.demoPersonId}
                onClick={() => act({ action: "test" })}
                className="h-8 rounded-md border px-2 text-xs hover:bg-muted disabled:opacity-50"
                data-testid="sms-test"
              >
                Send test SMS to {data.demoPersonId ? name(data.demoPersonId) : "…"}
              </button>
            </div>
            {note && <p className="text-xs">{note}</p>}
            <ErrorLine error={actionError} />
          </section>

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm" data-testid="sms-table">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">When (demo clock)</th>
                  <th className="px-2 py-1.5 font-medium">To</th>
                  <th className="px-2 py-1.5 font-medium">Message</th>
                  <th className="px-2 py-1.5 font-medium">Via</th>
                  <th className="px-2 py-1.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-2 py-3 text-muted-foreground">
                      No SMS yet. An urgent task that stays unacknowledged for 60 min sends one (use the demo clock).
                    </td>
                  </tr>
                )}
                {data.rows.map((r) => (
                  <tr key={r.id} className="border-t align-top" data-testid="sms-row">
                    <td className="whitespace-nowrap px-2 py-1.5">{fmtDateTime(r.createdAt)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      {name(r.personId)}
                      <div className="text-xs text-muted-foreground">{r.toMasked}</div>
                    </td>
                    <td className="px-2 py-1.5">
                      {r.body}
                      {r.sentBody && r.sentBody !== r.body && (
                        <div className="mt-1 text-xs text-muted-foreground">Actually sent: “{r.sentBody}”</div>
                      )}
                      {!r.escalationId && <div className="text-xs text-muted-foreground">(test message)</div>}
                    </td>
                    <td className="px-2 py-1.5">{r.provider === "twilio" ? "Twilio" : "Mock"}</td>
                    <td className="px-2 py-1.5">
                      <Pill tone={TONE[r.status] ?? "slate"}>{r.status}</Pill>
                      {r.error && <div className="mt-1 max-w-56 text-xs text-red-700 dark:text-red-400">{r.error}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
