import type { NextConfig } from "next";
import { execSync } from "node:child_process";
import { withSerwist } from "@serwist/turbopack";

/** Shown in the demo health strip: which build is running. */
function commit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "";
  }
}

// cacheComponents/partialPrefetching are deliberately OFF: the field app renders
// from IndexedDB on the client, and Serwist's route handler relies on the
// `dynamic`/`revalidate` segment config that Cache Components removes.
const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  serverExternalPackages: ["@electric-sql/pglite", "ws"],
  // Server-only build info (not NEXT_PUBLIC: never in client bundles).
  env: { SITESYNC_COMMIT: commit(), SITESYNC_BUILT_AT: new Date().toISOString() },
  // "Reset demo" builds the seed in an in-memory PGlite from the migration files.
  outputFileTracingIncludes: { "/api/office/demo/reset": ["./db/migrations/**/*"] },
};

export default withSerwist(nextConfig);
