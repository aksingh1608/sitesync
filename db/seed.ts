// pnpm db:seed: wipes all data and reseeds the fictional demo dataset.
// Built in memory through processSync, then copied in one transaction (fast
// over Neon); one automatic retry on a transient connection error.
import { connect } from "./connect";
import { reseedWithRetry } from "./seed-fast";

async function main() {
  const started = Date.now();
  const summary = await reseedWithRetry(connect);
  console.log("Seeded:", summary, `in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log("Clients that synced before this reseed should use /debug -> Reset local data.");
}

main().catch(() => process.exit(1)); // already logged in full by reseedWithRetry
