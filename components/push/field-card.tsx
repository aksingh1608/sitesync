"use client";
// "Enable notifications" for the field app. On an iPhone that hasn't added the
// app to the Home Screen, explains how instead of asking (iOS only delivers
// Web Push to Home Screen web apps, and only asks after a tap).
import { useCallback, useEffect, useState } from "react";
import { BigButton, Panel } from "@/components/field/ui";
import { disablePush, enablePush, pushSupport, type PushSupport } from "@/lib/push/client";
import { ensureDeviceId } from "@/lib/sync/client";

export function NotificationsCard({ compact = false }: { compact?: boolean }) {
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useCallback(() => void pushSupport().then(setSupport), []);
  useEffect(check, [check]);

  if (!support) return null;
  // On the task list, only show the card while there is something to do.
  if (compact && (support.state === "unsupported" || (support.state === "ready" && support.subscribed))) return null;

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      await enablePush("field", await ensureDeviceId());
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
    check();
  };
  const turnOff = async () => {
    setBusy(true);
    await disablePush();
    setBusy(false);
    check();
  };

  return (
    <Panel data-testid="notifications-card">
      <h2 className="text-xl font-bold">Notifications</h2>
      {support.state === "ios-not-installed" && (
        <>
          <p className="text-base text-slate-800">
            To get alerts for new and urgent tasks on iPhone, add SiteSync to your Home Screen first:
          </p>
          <ol className="list-decimal space-y-1 pl-6 text-base text-slate-800">
            <li>Tap the <strong>Share</strong> button in Safari.</li>
            <li>Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
            <li>Open SiteSync from the Home Screen and come back here.</li>
          </ol>
        </>
      )}
      {support.state === "unsupported" && <p className="text-base text-slate-800">{support.reason}</p>}
      {support.state === "denied" && (
        <p className="text-base text-slate-800">
          Notifications are blocked. Allow them for SiteSync in your phone&apos;s settings, then reopen the app.
        </p>
      )}
      {support.state === "ready" && !support.subscribed && (
        <>
          <p className="text-base text-slate-800">
            Get a notification when the office sends you a task or changes one, and a reminder if an urgent task is
            still waiting for your &quot;Got it&quot;. Nothing else, and never your location.
          </p>
          <BigButton onClick={turnOn} disabled={busy} data-testid="enable-notifications">
            {busy ? "Asking…" : "Enable notifications"}
          </BigButton>
        </>
      )}
      {support.state === "ready" && support.subscribed && (
        <>
          <p className="text-base text-slate-800">On for this phone. You&apos;ll get alerts for new, changed and urgent tasks.</p>
          <BigButton tone="neutral" onClick={turnOff} disabled={busy}>
            Turn off on this phone
          </BigButton>
        </>
      )}
      {error && <p className="text-base font-bold text-red-700" role="alert">{error}</p>}
    </Panel>
  );
}
