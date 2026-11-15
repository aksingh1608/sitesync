import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

// The WebSocket/Pool driver (not the HTTP driver) because the sync route needs
// an interactive transaction: it reads state, then writes based on it.
neonConfig.webSocketConstructor = ws;

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  return url;
}

/**
 * Runs `fn` with a Drizzle database on a fresh Pool and closes it afterwards.
 * Neon recommends not keeping a WebSocket Pool alive across serverless
 * invocations.
 */
export async function withDb<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  try {
    return await fn(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}
