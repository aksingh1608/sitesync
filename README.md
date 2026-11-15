# SiteSync

Offline-first field coordination demo for **Demo Electrical Co.** (fictional company, fictional data).

Field crews often have no signal. SiteSync records every action on the device first, syncs it
when it can, and lets the office see whether each instruction was delivered, seen and
acknowledged.

**This is Day 1: the foundation.** It includes the data model, event-sourced sync API, offline
outbox, PWA shell, demo role picker, a basic task list and a sync debug console.

## Requirements

- Node.js 24 (`nvm use`)
- pnpm 12
- A Postgres database on [Neon](https://neon.tech) (free tier is fine)

## Setup

```bash
pnpm install
cp .env.example .env.local      # then set DATABASE_URL to your Neon *pooled* connection string
pnpm db:migrate                 # create tables
pnpm db:seed                    # load demo data (wipes existing data)
pnpm dev                        # http://localhost:3000
```

The service worker is disabled in `pnpm dev`. To test offline behaviour and installability, run
a production build:

```bash
pnpm build && pnpm start
```

## Trying it

1. Open `/` and pick a person. **Demo mode, no real login.** Sam Novak (technician) has the
   most varied tasks.
2. `/field` shows that person's tasks from the on-device database, grouped into Today,
   This Week, This Month and Follow-ups.
3. `/debug` shows the device id, cursor and outbox. It has buttons to sync, simulate offline,
   create a test task, acknowledge a task and reset local data.

To demo offline, turn on **Simulate offline** in `/debug`, or set DevTools → Network to
Offline. Create a task and acknowledge one, then reload. The app still loads and the pending
events are still there. Go back online and press **Sync now**. The outbox empties, and the
server stores each event exactly once.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` / `build` / `start` | Next.js |
| `pnpm lint` / `typecheck` / `test` | ESLint / `tsc` / Vitest (uses in-memory PGlite, no database needed) |
| `pnpm db:generate` | Generate a migration after editing `lib/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL` |
| `pnpm db:seed` | Wipe and reseed demo data |
| `pnpm db:studio` | Drizzle Studio |

See `CLAUDE.md` for the architecture rules and the 6-day plan.
