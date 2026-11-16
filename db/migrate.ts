import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { describeError, withTransientRetry } from "../lib/db/errors";
import { connect } from "./connect";

async function main() {
  // Migrations run in a transaction and skip applied ones, so a retry (on a
  // fresh connection) after a dropped WebSocket is safe.
  await withTransientRetry(
    async () => {
      const { db, close } = connect();
      try {
        await migrate(db, { migrationsFolder: "./db/migrations" });
      } finally {
        await close().catch(() => {});
      }
    },
    { delayMs: 1500, onRetry: (err) => console.error(`[migrate] transient database error; retrying once:\n${describeError(err)}`) },
  );
  console.log("Migrations applied.");
}

main().catch((err) => {
  console.error(`[migrate] failed:\n${describeError(err)}`);
  process.exit(1);
});
