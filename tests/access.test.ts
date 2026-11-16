// Demo access gate: proxy + /api/unlock.
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_COOKIE, accessToken, decide, isPublicPath, safeEqual, safeNext } from "@/lib/access";
import { OFFLINE_ROUTES } from "@/lib/config";
import { POST as unlock } from "@/app/api/unlock/route";
import { proxy, config } from "@/proxy";

const CODE = "orange-ladder-42";
const BASE = "https://sitesync.test";

beforeEach(() => {
  vi.stubEnv("DEMO_ACCESS_CODE", CODE);
  vi.stubEnv("NODE_ENV", "production");
});
afterEach(() => vi.unstubAllEnvs());

const req = (path: string, cookie?: string) =>
  new NextRequest(`${BASE}${path}`, { headers: cookie ? { cookie: `${ACCESS_COOKIE}=${cookie}` } : {} });
const isPassThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

describe("access gate (proxy)", () => {
  it("shows the code page with 401 (never a redirect) for pages without the cookie", async () => {
    for (const path of ["/", "/field", "/field/task?id=abc", "/debug"]) {
      const res = await proxy(req(path));
      expect(res.status, path).toBe(401);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain('action="/api/unlock"');
      expect(html).not.toContain("serwist"); // no app JS, no service worker registration
    }
  });

  it("keeps the page to return to, without Next's internal _rsc param", async () => {
    const html = await (await proxy(req("/field/task?id=abc&_rsc=xyz"))).text();
    expect(html).toContain('name="next" value="/field/task?id=abc"');
  });

  it("returns 401 JSON for API routes without the cookie, and lets them through with it", async () => {
    for (const path of ["/api/people", "/api/sync", "/api/media", `/api/media/${crypto.randomUUID()}`]) {
      const res = await proxy(req(path));
      expect(res.status, path).toBe(401);
      expect(await res.json()).toEqual({ error: "access_code_required" });
    }
    const token = await accessToken(CODE);
    expect(isPassThrough(await proxy(req("/api/people", token)))).toBe(true);
    expect(isPassThrough(await proxy(req("/field", token)))).toBe(true);
  });

  it("rejects a wrong cookie and old cookies after the code is rotated", async () => {
    expect((await proxy(req("/field", "nope"))).status).toBe(401);
    const old = await accessToken(CODE);
    vi.stubEnv("DEMO_ACCESS_CODE", "new-code");
    expect((await proxy(req("/field", old))).status).toBe(401);
  });

  it("leaves the manifest, icons, service worker, offline page and unlock endpoint open", async () => {
    for (const path of [
      "/manifest.webmanifest",
      "/icons/icon-192.png",
      "/serwist/sw.js",
      "/serwist/sw.js.map",
      "/~offline",
      "/api/unlock",
      "/_next/static/chunks/app.js",
    ]) {
      expect(isPublicPath(path), path).toBe(true);
      expect(isPassThrough(await proxy(req(path))), path).toBe(true);
    }
    // ...and the matcher pre-filter skips them too (it must agree with isPublicPath).
    const re = new RegExp(`^${config.matcher[0]}$`);
    for (const path of ["/manifest.webmanifest", "/icons/a.png", "/serwist/sw.js", "/~offline", "/api/unlock", "/_next/static/x.js"]) {
      expect(re.test(path), path).toBe(false);
    }
    for (const path of ["/", "/field", "/api/sync", "/api/media/x", "/debug"]) expect(re.test(path), path).toBe(true);
  });

  it("gates every precached app-shell route except the offline page, so precache can't store the gate", async () => {
    for (const route of OFFLINE_ROUTES) {
      const res = await proxy(req(route));
      if (route === "/~offline") expect(isPassThrough(res)).toBe(true);
      else expect(res.status, route).toBe(401); // install fails instead of caching the code page
    }
  });

  it("fails closed in production without a code, stays open in development", async () => {
    vi.stubEnv("DEMO_ACCESS_CODE", "");
    expect((await proxy(req("/field"))).status).toBe(503);
    expect(await decide({ pathname: "/field", cookie: undefined, code: undefined, production: false })).toBe("allow");
  });
});

describe("POST /api/unlock", () => {
  const post = (fields: Record<string, string>) =>
    unlock(new Request(`${BASE}/api/unlock`, { method: "POST", body: new URLSearchParams(fields) }));

  it("sets an httpOnly, secure cookie with the code's hash and redirects back with 303", async () => {
    const res = await post({ code: CODE, next: "/field/task?id=abc" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/field/task?id=abc`);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`${ACCESS_COOKIE}=${await accessToken(CODE)}`);
    expect(cookie).not.toContain(CODE);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    // The cookie it sets unlocks the proxy.
    const value = cookie.split(";")[0].split("=")[1];
    expect(isPassThrough(await proxy(req("/api/people", value)))).toBe(true);
  });

  it("shows the page again with 401 and no cookie for a wrong code", async () => {
    const res = await post({ code: "guess", next: "/field" });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toContain("That code is not right.");
  });

  it("never redirects off-site or into the API", async () => {
    for (const next of ["//evil.example.com", "https://evil.example.com", "/\\evil.example.com", "/api/people", ""]) {
      const res = await post({ code: CODE, next });
      expect(res.headers.get("location"), next).toBe(`${BASE}/`);
    }
    expect(safeNext("/field?x=1")).toBe("/field?x=1");
  });

  it("compares in constant time", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
