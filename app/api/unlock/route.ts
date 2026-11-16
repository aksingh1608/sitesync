// POST /api/unlock: check the demo access code, set the httpOnly cookie, go back.
import { NextResponse } from "next/server";
import { ACCESS_COOKIE, ACCESS_COOKIE_MAX_AGE, accessToken, gateHeaders, gatePage, safeEqual, safeNext } from "@/lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const next = safeNext(form?.get("next"));
  const code = process.env.DEMO_ACCESS_CODE;
  const given = form?.get("code");
  if (!code) return new NextResponse("Access gate not configured.", { status: 503, headers: { "cache-control": "no-store" } });

  if (typeof given !== "string" || !safeEqual(given.trim(), code)) {
    await new Promise((r) => setTimeout(r, 400)); // slow down guessing a little
    return new NextResponse(gatePage(next, "That code is not right."), { status: 401, headers: gateHeaders });
  }
  // 303: the browser follows with a GET to the page it wanted.
  const res = NextResponse.redirect(new URL(next, request.url), 303);
  res.cookies.set(ACCESS_COOKIE, await accessToken(code), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_COOKIE_MAX_AGE,
  });
  res.headers.set("cache-control", "no-store");
  return res;
}
