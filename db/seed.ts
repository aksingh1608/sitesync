// pnpm db:seed: wipes all data and reseeds the fictional demo dataset.
import { connect } from "./connect";
import { seed } from "./seed-data";

async function main() {
  const { db, close } = connect();
  try {
    const summary = await seed(db);
    console.log("Seeded:", summary);
    console.log("Clients that synced before this reseed should use /debug -> Reset local data.");
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
