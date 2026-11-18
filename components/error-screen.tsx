"use client";
// Friendly error screen for route error boundaries. Field work is never lost
// by a render error: everything a worker did is in the on-device outbox.
import Link from "next/link";
import { useEffect } from "react";

export function ErrorScreen({
  error,
  retry,
  home,
  homeLabel,
  large,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  home: string;
  homeLabel: string;
  large?: boolean;
}) {
  useEffect(() => {
    console.error("[ui] route error:", error);
  }, [error]);
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return (
    <div className={large ? "mx-auto max-w-md space-y-4 p-4 text-lg" : "mx-auto max-w-md space-y-3 p-6 text-sm"} role="alert">
      <h1 className={large ? "text-2xl font-bold" : "text-lg font-semibold"}>
        {offline ? "No connection right now" : "Something went wrong on this screen"}
      </h1>
      <p>
        {offline
          ? "This screen needs a connection. Anything you already saved is kept on this device and syncs when the signal returns."
          : "Nothing you saved is lost: your changes are kept on this device and sync as usual. Try again, or go back."}
      </p>
      {error.digest && <p className="text-xs text-slate-500">Error reference: {error.digest}</p>}
      <div className="flex flex-wrap gap-2">
        <button onClick={() => retry()} className="rounded-lg bg-slate-900 px-4 py-2 font-semibold text-white">
          Try again
        </button>
        <Link href={home} className="rounded-lg border px-4 py-2 font-semibold">
          {homeLabel}
        </Link>
      </div>
    </div>
  );
}
