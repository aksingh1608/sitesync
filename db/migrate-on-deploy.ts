// Runs as part of the Vercel build (vercel.json buildCommand): applies pending
// migrations to the PRODUCTION database before the new code is built, so the
// new version never runs against an old schema. Preview and local builds skip
// it. Migrations are additive and skip applied ones; if this fails, the build
// fails and the previous deployment stays live.
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { describeError, withTransientRetry } from "../lib/db/errors";
import { connect } from "./connect";

async function main() {
  if (process.env.VERCEL_ENV !== "production") {
    console.log(`[migrate-on-deploy] skipped (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"})`);
    return;
  }
  await withTransientRetry(
    async () => {
      const { db, close } = connect();
      try {
        await migrate(db, { migrationsFolder: "./db/migrations" });
      } finally {
        await close().catch(() => {});
      }
    },
    { delayMs: 1500, onRetry: (err) => console.error(`[migrate-on-deploy] transient error, retrying once:\n${describeError(err)}`) },
  );
  console.log("[migrate-on-deploy] production migrations applied.");
}

main().catch((err) => {
  console.error(`[migrate-on-deploy] failed, aborting the build:\n${describeError(err)}`);
  process.exit(1);
});
