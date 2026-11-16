// Demo access gate (brought forward from Day 6). One shared code in
// DEMO_ACCESS_CODE; a correct entry sets an httpOnly cookie holding a hash of
// the code (so rotating the code locks everyone out again).
//
// Locked page requests get a tiny self-contained code form with status 401,
// NOT a redirect: the service worker's precache install copies *redirected*
// responses into the cache and fails on non-OK ones, and runtime caching keeps
// only 200s. So the gate page can never become the cached app shell; offline
// pages keep working once the worker installed during an unlocked visit.

export const ACCESS_COOKIE = "sitesync_access";
/** Browsers cap cookie lifetime at ~400 days. */
export const ACCESS_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

/**
 * Paths that never need the code: install/offline plumbing, the unlock
 * endpoint, and the escalation runner (Vercel Cron has no cookie; the route
 * itself requires `Authorization: Bearer CRON_SECRET`).
 */
const PUBLIC_EXACT = new Set(["/manifest.webmanifest", "/~offline", "/favicon.ico", "/api/unlock", "/api/escalations/run"]);
const PUBLIC_PREFIX = ["/icons/", "/serwist/", "/_next/static/", "/_next/image"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIX.some((p) => pathname.startsWith(p));
}

export async function accessToken(code: string): Promise<string> {
  const data = new TextEncoder().encode(`sitesync-access:v1:${code}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export type GateDecision = "allow" | "locked-api" | "locked-page" | "misconfigured";

export async function decide(input: {
  pathname: string;
  cookie: string | undefined;
  code: string | undefined;
  production: boolean;
}): Promise<GateDecision> {
  if (isPublicPath(input.pathname)) return "allow";
  if (!input.code) return input.production ? "misconfigured" : "allow"; // dev without a code: open
  if (input.cookie && safeEqual(input.cookie, await accessToken(input.code))) return "allow";
  return input.pathname.startsWith("/api/") ? "locked-api" : "locked-page";
}

/** Only same-site relative paths; never "//host" or a scheme. */
export function safeNext(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next.startsWith("/api/")) return "/";
  return next.slice(0, 500);
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Self-contained code page (no app JS, no service worker registration). */
export function gatePage(next: string, error?: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>SiteSync · access code</title>
<style>
:root{color-scheme:light}
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#f1f5f9;font:18px/1.4 system-ui,sans-serif;color:#020617}
main{width:100%;max-width:24rem;margin:16px;padding:24px;background:#fff;border:2px solid #cbd5e1;border-radius:16px}
h1{margin:0 0 4px;font-size:26px}p{margin:0 0 16px;color:#334155}
label{display:block;font-weight:600;margin-bottom:6px}
input{box-sizing:border-box;width:100%;min-height:52px;font-size:20px;padding:8px 12px;border:2px solid #475569;border-radius:10px}
button{margin-top:16px;width:100%;min-height:56px;font-size:20px;font-weight:700;color:#fff;background:#1d4ed8;border:0;border-radius:12px}
.err{margin-top:12px;color:#b91c1c;font-weight:700}
</style></head>
<body><main>
<h1>SiteSync</h1><p>Demo Electrical Co. · demo access</p>
<form method="post" action="/api/unlock">
<label for="code">Access code</label>
<input id="code" name="code" type="password" autocomplete="current-password" required autofocus>
<input type="hidden" name="next" value="${esc(next)}">
<button type="submit">Enter</button>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
</form></main></body></html>`;
}

export const gateHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
} as const;
