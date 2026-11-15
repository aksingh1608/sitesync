// Serves the service worker (Serwist's documented Turbopack setup).
import { createSerwistRoute } from "@serwist/turbopack";
import { OFFLINE_ROUTES } from "@/lib/config";

// A fresh revision per build re-fetches the precached HTML shells after a deploy.
const revision = process.env.VERCEL_GIT_COMMIT_SHA ?? crypto.randomUUID();

export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } = createSerwistRoute({
  // The app-shell HTML for the field routes, so they load with no network.
  additionalPrecacheEntries: OFFLINE_ROUTES.map((url) => ({ url, revision })),
  swSrc: "app/sw.ts",
  useNativeEsbuild: true,
});
