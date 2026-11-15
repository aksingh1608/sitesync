import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { connect } from "./connect";

async function main() {
  const { db, close } = connect();
  try {
    await migrate(db, { migrationsFolder: "./db/migrations" });
    console.log("Migrations applied.");
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
