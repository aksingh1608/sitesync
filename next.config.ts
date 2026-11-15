import type { NextConfig } from "next";
import { withSerwist } from "@serwist/turbopack";

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
};

export default withSerwist(nextConfig);
