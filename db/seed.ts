// pnpm db:seed: wipes all data and reseeds the fictional demo dataset.
import { connect } from "./connect";
import { seedViaMemory } from "./seed-fast";

async function main() {
  const { db, close } = connect();
  try {
    const started = Date.now();
    // Built in memory through processSync, then copied in one transaction (fast over Neon).
    const summary = await seedViaMemory(db);
    console.log("Seeded:", summary, `in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    console.log("Clients that synced before this reseed should use /debug -> Reset local data.");
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
