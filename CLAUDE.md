@AGENTS.md

# SiteSync

Offline-first field coordination app for an electrical contractor (commercial construction,
lighting retrofits, multi-site rollouts, service calls). **Interview demo prototype.**
Core promise: nothing a worker does is ever lost, and the office can always see whether an
instruction reached the worker (receipt chain: sent → delivered → seen → acknowledged).

- Company in the app: **"Demo Electrical Co."**. Fictional data only. Never use a real company's
  name, logo or branding.
- Demo mode has no real login: `/` picks a seeded person (actorId in Dexie + `sitesync_actor` cookie).

## Stack (versions verified 2026-11-15)

- Node 24 (`.nvmrc`). On this machine `~/.local/bin/node` is v20 and shadows nvm; use
  `export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH`.
- pnpm 12, **TypeScript 6.0.3** (strict). Not TS 7: TS 7 has no JS compiler API and
  typescript-eslint requires `<6.1`.
- Next.js 16.4 App Router, Turbopack. `cacheComponents` is **off** (Serwist route needs
  `dynamic`/`revalidate` segment config; field pages render from IndexedDB anyway).
  API routes use the Node.js runtime. Read `node_modules/next/dist/docs/` before using Next APIs.
- Tailwind 4 + shadcn/ui (base-nova style, `@base-ui/react`, `cn` package).
- Postgres on Neon + Drizzle ORM 0.45 + drizzle-kit 0.31. Server uses `drizzle-orm/neon-serverless`
  (WebSocket Pool) because sync needs an interactive transaction; the HTTP driver only does
  non-interactive batches. A Pool is opened and closed per request (`lib/db/server.ts`).
- Zod 4 for every external input. Dexie 4 + dexie-react-hooks on the client.
- Serwist 9.5 via **`@serwist/turbopack`** (the documented Turbopack setup): the worker is
  `app/sw.ts`, served by `app/serwist/[path]/route.ts` at `/serwist/sw.js`, registered by
  `SerwistProvider` in `app/layout.tsx` (disabled in `next dev`; test PWA with build + start).
- Vitest 5 + PGlite (in-memory Postgres, same migrations) + fake-indexeddb.

## Architecture rules (non-negotiable)

1. **Event-sourced writes.** Every client change is an event `{ id (client UUID v4), type, actorId,
   deviceId, clientTs, payload }`. Server stores it in `events` (`id` PK, `server_seq` bigserial).
   `INSERT … ON CONFLICT DO NOTHING`; reducers run only for newly inserted events → idempotent.
   Rule-rejected events are stored with `applied=false, reject_reason`; a resend gets the same
   rejection back. Shape-invalid events and unexpected errors are not stored.
2. **Projections are derived by pure reducers** in `lib/sync/reducers.ts` (deterministic, unit
   tested). `lib/sync/apply.ts` loads context from a `SyncStore`, runs the reducer, writes the
   result. The same code runs on the server (Drizzle store) and client (Dexie store, optimistic).
3. **Server is authoritative. Conflict rules:**
   - Task fields: last write wins **per field** by `clientTs`, ties broken by event id
     (`tasks.field_ts` jsonb holds the winning `{ts, ev}` per field).
   - Task status: an older event can never move a task out of `done`/`cancelled` (rejected as
     `stale_event`); older events against non-terminal states are accepted but lose. Transitions
     are validated (`STATUS_TRANSITIONS` in `lib/domain.ts`; terminal → `open` only).
   - Receipts are monotonic: keep the earliest timestamp, never clear one; later stages imply
     earlier ones.
   - Invalid events are rejected with a reason and never fail the batch (savepoint per event).
4. **Cursor pull.** Every projection row has `seq` from one shared sequence `sync_seq`, set on
   every write. Client sends its cursor, gets visible rows with `seq > cursor` + new cursor.
   Writers take `pg_advisory_xact_lock` so seq order = commit order (no skipped rows).
   When a site newly becomes relevant to someone, `touchSite` bumps its (and its rollout's) seq.
5. **Visibility by role.** technician/foreman: own tasks (assigned or created), receipts on them,
   own time entries/status/notes, sites they have tasks or time entries at, those sites' rollouts.
   coordinator/hr/manager: everything. People are a shared directory.
6. **The field app reads ONLY from Dexie** (`useLiveQuery`). Writes go to the Dexie outbox and are
   applied optimistically to the cache. After each sync, server rows overwrite the cache and
   pending outbox events are re-applied on top (reducers are idempotent).
7. **No Background Sync API** (iOS). Triggers: app start, `online`, `visibilitychange`→visible,
   every 30 s while open, manual "Sync now". Exponential backoff (2 s … 5 min, ±20% jitter);
   per-item `attempts` and `lastError`. Single-flight in-tab + Web Locks across tabs.
8. **Events are one Zod discriminated union** in `lib/events.ts`, shared by client and server.

Location is captured only at clock-in and clock-out. No continuous tracking, ever.

## Folder structure

```
app/
  page.tsx               demo role picker
  field/page.tsx         Day 1 task list (Today / This Week / This Month / Follow-ups)
  debug/page.tsx         sync console (outbox, cursor, simulate offline, test actions, reset)
  ~offline/page.tsx      service-worker fallback page
  api/sync/route.ts      POST /api/sync (Zod → processSync)
  api/people/route.ts    GET directory for the role picker
  serwist/[path]/route.ts, sw.ts, manifest.ts, layout.tsx
components/              sync-manager (triggers), sync-status, use-local hooks, ui/ (shadcn)
lib/
  domain.ts              enums, roles, status transitions (no deps)
  events.ts              Zod event union (shared)
  geo.ts, time.ts, uuid.ts, config.ts
  db/schema.ts           Drizzle schema (all tables, incl. later-day ones)
  db/server.ts           Neon Pool + Drizzle per request
  db/local.ts            Dexie schema: outbox, cache tables, meta
  sync/reducers.ts       pure reducers
  sync/apply.ts          SyncStore interface + applyEvent
  sync/store-drizzle.ts  server store;  sync/store-dexie.ts  client store
  sync/service.ts        processSync transaction
  sync/visibility.ts     role-scoped cursor pull
  sync/protocol.ts       request/response schema + types
  sync/client.ts         enqueue / sync / setActor / simulate offline / reset
  tasks/grouping.ts      Today / This Week / This Month / Follow-ups (rolling windows)
db/  migrations/ (drizzle-kit), migrate.ts, seed.ts, seed-data.ts, connect.ts
tests/  Vitest: sync (PGlite), reducers, client (fake-indexeddb + PGlite), grouping, seed
scripts/gen-icons.ts     placeholder PWA icons (no deps)
```

## Commands

```
pnpm dev | build | start | lint | typecheck | test
pnpm db:generate   # after editing lib/db/schema.ts
pnpm db:migrate    # applies db/migrations to DATABASE_URL (.env.local)
pnpm db:seed       # wipes + reseeds demo data (clients: /debug → Reset local data)
pnpm db:studio
pnpm icons         # regenerate placeholder icons
```

Secrets only in `.env.local` (gitignored). `.env.example` lists every key.

## Conventions

- Add a new write = add a member to `EventSchema`, a pure reducer, a case in `applyEvent`,
  tests. Never write projections directly from an API route.
- New projection table = `seq` column defaulting to `nextval('sync_seq')`, a Dexie cache table,
  a visibility rule in `pullChanges`, date revival in `client.ts`.
- Seed operational data through `processSync`, never by inserting projection rows.
- Small, meaningful git commits. Do not deploy, sign up for services or add paid deps without asking.

## 6-day plan

1. **Day 1 (done): foundation.** Schema, events, reducers, sync API, Dexie outbox/cache, PWA
   shell, role picker, `/field` list, `/debug`, seed, tests.
2. **Day 2: field worker PWA.** Task groups UI, task detail (auto `task.seen`, Acknowledge button),
   status changes, clock in/out with geolocation + site check + safety check, optional worker
   status, text/voice notes (blob upload when online), offline indicators.
3. **Day 3: coordinator dashboard.** Live board (who is where, status), receipts view
   (sent/delivered/seen/acknowledged per task), rollout board (stores by stage), timesheets with
   flagged clock-ins, task create/assign.
4. **Day 4: escalation + push.** Web Push subscriptions, rule-based escalation ladder
   push → SMS (Twilio) → coordinator alert for unacknowledged urgent tasks (`escalations` table).
5. **Day 5: AI agents.** Dispatch agent (suggest assignee), field report agent (voice note →
   transcript → structured report/follow-ups), digest agent (`digests`), ops copilot.
6. **Day 6: polish + demo.** Deploy to Vercel, demo script, airplane-mode walkthrough, hardening.

## Known Day 1 limitations

- A task reassigned away from a technician stays in their local cache (no visibility
  revocation/tombstones yet). Plan: tombstone rows or a per-actor "removed" list in the pull.
- Pull is not paginated (fine for demo volumes).
- Reseeding deletes rows; already-synced clients should Reset local data.
