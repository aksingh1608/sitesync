// Connection for CLI scripts (migrate, seed). Same Neon WebSocket Pool driver
// as the API route.
import { config } from "dotenv";
import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

config({ path: ".env.local", quiet: true });
neonConfig.webSocketConstructor = ws;

export function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  return { db: drizzle({ client: pool }), close: () => pool.end() };
}
