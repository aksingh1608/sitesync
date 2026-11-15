// One-shot location for clock-in / clock-out. Never watches position.
import type { LocationError } from "./domain";

export type Fix = { ok: true; lat: number; lng: number; accuracyM: number };
export type NoFix = { ok: false; error: LocationError };

export const LOCATION_TIMEOUT_MS = 10_000;

export function getLocationOnce(timeoutMs = LOCATION_TIMEOUT_MS): Promise<Fix | NoFix> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve({ ok: false, error: "unsupported" });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: Fix | NoFix) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(guard);
      resolve(r);
    };
    // Some browsers don't start the timeout until the permission prompt is answered.
    const guard = window.setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs + 1000);
    navigator.geolocation.getCurrentPosition(
      (p) =>
        finish({
          ok: true,
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracyM: Math.min(100_000, Math.round(p.coords.accuracy)),
        }),
      (e) =>
        finish({
          ok: false,
          error: e.code === e.PERMISSION_DENIED ? "denied" : e.code === e.TIMEOUT ? "timeout" : "unavailable",
        }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}

export const LOCATION_ERROR_TEXT: Record<LocationError, string> = {
  denied: "Location permission denied",
  unavailable: "Location unavailable (indoors?)",
  timeout: "Location timed out",
  unsupported: "This device can't share location",
};
