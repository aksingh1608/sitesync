// Demo access gate on every page and API route (see lib/access.ts).
import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, decide, gateHeaders, gatePage, safeNext } from "@/lib/access";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const decision = await decide({
    pathname,
    cookie: request.cookies.get(ACCESS_COOKIE)?.value,
    code: process.env.DEMO_ACCESS_CODE,
    production: process.env.NODE_ENV === "production",
  });
  if (decision === "allow") return NextResponse.next();
  if (decision === "misconfigured") {
    return new NextResponse("Access gate not configured (DEMO_ACCESS_CODE is missing).", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
  if (decision === "locked-api") {
    return NextResponse.json({ error: "access_code_required" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  // 401 + inline form (not a redirect): a service worker can never cache this as the app shell.
  const back = request.nextUrl.clone();
  back.searchParams.delete("_rsc"); // internal router param: return to the real page
  return new NextResponse(gatePage(safeNext(back.pathname + back.search)), { status: 401, headers: gateHeaders });
}

export const config = {
  // Cheap pre-filter; proxy() re-checks with isPublicPath(), which is unit tested.
  matcher: ["/((?!_next/static|_next/image|icons/|serwist/|manifest\\.webmanifest|favicon\\.ico|~offline|api/unlock|api/escalations/run).*)"],
};
