// Browser side of Web Push: support checks (iOS needs the app on the Home
// Screen), subscribe from a tap, and quietly re-register an existing
// subscription on app start (after a reseed or a demo actor switch).

export type PushScope = "field" | "office";
export type PushSupport =
  | { state: "unsupported"; reason: string }
  | { state: "ios-not-installed" }
  | { state: "denied" }
  | { state: "ready"; subscribed: boolean };

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch points give it away.
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

export const vapidPublicKey = () => process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

/** VAPID public key (base64url) -> bytes for pushManager.subscribe. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  // ready never resolves without a worker (e.g. `next dev`): give up after 4 s.
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
}

export async function pushSupport(): Promise<PushSupport> {
  if (typeof window === "undefined") return { state: "unsupported", reason: "Not in a browser." };
  if (isIos() && !isStandalone()) return { state: "ios-not-installed" };
  if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) {
    return { state: "unsupported", reason: "This browser can't receive notifications." };
  }
  if (!vapidPublicKey()) return { state: "unsupported", reason: "Notifications aren't set up on the server yet." };
  if (Notification.permission === "denied") return { state: "denied" };
  const reg = await registration();
  if (!reg) return { state: "unsupported", reason: "The offline app isn't installed yet (reload once online)." };
  const sub = await reg.pushManager.getSubscription();
  return { state: "ready", subscribed: !!sub && Notification.permission === "granted" };
}

async function register(scope: PushScope, deviceId: string | null, sub: PushSubscription): Promise<void> {
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope, deviceId, subscription: sub.toJSON() }),
  });
  if (!res.ok) throw new Error(res.status === 401 ? "Pick a person first (or reload for the access code)." : `Server said ${res.status}`);
}

/** Call straight from a tap handler: iOS only shows the permission prompt for a user gesture. */
export async function enablePush(scope: PushScope, deviceId: string | null): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications are blocked for this app." : "Not allowed.");
  const reg = await registration();
  if (!reg) throw new Error("The offline app isn't installed yet. Reload once while online, then try again.");
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey()) }));
  await register(scope, deviceId, sub);
}

export async function disablePush(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await fetch("/api/push/subscribe", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => undefined);
  await sub.unsubscribe();
}

/** App start: if this browser already has permission + a subscription, tell the server (idempotent). */
export async function refreshPush(scope: PushScope, deviceId: string | null): Promise<void> {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") return;
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await register(scope, deviceId, sub).catch(() => undefined);
}
