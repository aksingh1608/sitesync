@AGENTS.md

# SiteSync

Offline-first field coordination app for an electrical contractor (commercial construction,
lighting retrofits, multi-site rollouts, service calls). **Interview demo prototype.**
Core promise: nothing a worker does is ever lost, and the office can always see whether an
instruction reached the worker (receipt chain: sent → delivered → seen → acknowledged).

- Company in the app: **"Demo Electrical Co."**. Fictional data only. Never use a real company's
  name, logo or branding.
- Demo mode has no real login: `/` picks a seeded person (actorId in Dexie + `sitesync_actor` cookie).
- **Access gate** (brought forward from Day 6): `proxy.ts` (Next 16's renamed middleware) requires
  the shared `DEMO_ACCESS_CODE` on every page and API route except `/manifest.webmanifest`,
  `/icons/*`, `/serwist/*`, `/~offline`, `/_next/static|image` and `POST /api/unlock`
  (`isPublicPath` in `lib/access.ts`; the `matcher` is only a pre-filter and is tested against it).
  `/api/unlock` sets the httpOnly, Secure (prod), SameSite=Lax cookie `sitesync_access` = SHA-256 of
  the code (rotating the code relocks everyone). Locked pages get an inline code form with **401,
  never a redirect**: Serwist's precache copies redirected responses into the cache and fails on
  non-OK ones, and runtime caching keeps only 200s, so the gate page can never become the app shell;
  the worker installs (and precaches the real shells) only during an unlocked visit, and offline
  field pages keep working afterwards. Locked APIs get 401 JSON (the sync bar says to reload).
  Production without `DEMO_ACCESS_CODE` fails closed (503); dev without it is open.
- **Stable test URL:** production, https://sitesync-gamma.vercel.app (Vercel project
  `aksingh1608s-projects/sitesync`). Preview URLs change per deploy and an installed PWA is tied
  to its URL. Deploy with `pnpm dlx vercel@65.9.0 deploy --prod` only after the user says so.

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
   **Revocations:** when someone loses visibility of a row (a task reassigned away from a field
   worker who did not create it), the reducer path writes `revocations(actor_id, entity, entity_id,
   seq)`; the pull returns them (field roles only) and the client deletes the row + its receipts.
   **Pagination:** each pull returns at most `PULL_PAGE_SIZE` (500) rows across all tables
   (revocations included) plus `hasMore`; the client keeps pulling inside the same sync lock.
5. **Write authorization** is in the reducers (so the client refuses locally with the same rules);
   every refusal is reason `forbidden`. Coordinators/managers: anything on tasks. Everyone else:
   receipts, status changes and notes only on tasks assigned to them; may edit only `description`
   on their own tasks; may create tasks for themselves, or a `material_request`/`follow_up`
   assigned to a coordinator. Clock in/out and status are always the actor's own.
6. **Visibility by role.** technician/foreman: own tasks (assigned or created), receipts on them,
   own time entries/status/notes, sites they have tasks or time entries at, those sites' rollouts.
   coordinator/hr/manager: everything. People are a shared directory.
7. **The field app reads ONLY from Dexie** (`useLiveQuery`). Writes go to the Dexie outbox and are
   applied optimistically to the cache. After each sync, server rows overwrite the cache and
   pending outbox events are re-applied on top (reducers are idempotent).
8. **No Background Sync API** (iOS). Triggers: app start, `online`, `visibilitychange`→visible,
   every 30 s while open, manual "Sync now". Exponential backoff (2 s … 5 min, ±20% jitter);
   per-item `attempts` and `lastError`. Single-flight in-tab + Web Locks across tabs.
   After each successful sync the **media upload queue** runs (`lib/sync/media.ts`, own lock).
9. **Events are one Zod discriminated union** in `lib/events.ts`, shared by client and server.

Location is captured only at clock-in and clock-out. No continuous tracking, ever.
Dates for grouping and display use the **branch timezone** (`BRANCH_TIMEZONE`, America/New_York),
never the device's. Weeks start Monday (calendar weeks/months, not rolling windows).

## Events (lib/events.ts)

`task.created`, `task.updated`, `task.status_changed`, `task.delivered`, `task.seen`,
`task.acknowledged`, `time.clock_in`, `time.clock_out`, `status.set`, `note.created`,
`note.media_uploaded` (Day 2, **server-only**).
Day 2 payload changes: `note.created.mediaId` (local media id; blob uploaded later; devices can
no longer send any URL), `note.media_uploaded { noteId, blobPath, mimeType, sizeBytes,
durationSec? }`, written only by the server after it stored the blob (first upload wins),
`status.set.status` nullable (= clear status), `time.clock_in/out.locationError`
(`denied|unavailable|timeout|unsupported`, feeds the HR flag reason).

Receipts from the device: `task.delivered` once per device+person after a task first arrives from
the server; `task.seen` the first time the detail opens; `task.acknowledged` from "Got it".
"Once" is enforced by Dexie `receiptMarks` (survives cache rebuilds), not by the server.

**Server-only events** (`SERVER_ONLY_EVENT_TYPES` in `lib/events.ts`): `/api/sync` rejects them
from devices with `forbidden` and does not store them. Server code creates them with
`processSync(db, req, { trusted: true, skipPull: true })`, deviceId `server:media`, and a
deterministic event id (`mediaEventId(mediaId)`), so retries are duplicates.

## Media (private Vercel Blob store)

Voice (MediaRecorder; mime picked with `isTypeSupported`, iOS gives audio/mp4; 2 min cap) and
photos (file input `capture`, compressed to 1600 px JPEG) are stored as Blobs in Dexie `media`,
written in the same transaction as their `note.created`. After the note syncs, the queue
(`lib/sync/media.ts`) POSTs the blob to `/api/media` (Node runtime, server upload, 4 MB cap).
The route (`lib/media/record.ts`): checks the actor authored the note with that media id,
`put`s it to the **private** store at `notes/<noteId>/<mediaId>.<ext>` (no random suffix,
overwrite allowed), then records `note.media_uploaded { blobPath }` itself. The reducer only
accepts a path under `notes/<noteId>/<that mediaId>.`.

Reading: **no blob URL or pathname ever reaches a client.** The pull sends `blobPath: null` and
`mediaUrl: "/api/media/<noteId>"`. `GET /api/media/[noteId]` reads the demo actor cookie, allows
the note's author and office roles (`canViewNote`, mirrors pull visibility), 404s otherwise, and
streams the blob with `get(path, { access: "private" })`: `Cache-Control: private, no-cache`,
ETag/`If-None-Match` -> 304, and byte ranges (206) for iOS audio. The recording device keeps its
Blob in Dexie and always plays that copy (offline too); other devices use the route (online only).

Auth to Blob: on Vercel the SDK uses OIDC + `BLOB_STORE_ID` (set when the store is connected to
the project); elsewhere `BLOB_READ_WRITE_TOKEN`. Without either, dev (and `pnpm start` with
`SITESYNC_LOCAL_MEDIA=1`) stores files in `.data/media`; production refuses uploads (503).

## Dexie schema versioning

`lib/db/local.ts` declares `this.version(n).stores({...})` for every version ever shipped.
To change local tables:
1. **Never edit a released version.** Add `this.version(n+1).stores({ changedTable: "..." })`
   listing only tables that are new or whose indexes change (`null` deletes a table).
   Dexie diffs schemas and leaves untouched tables (the outbox) as they are.
2. If existing rows need reshaping, add `.upgrade(async (tx) => { ... })` and use
   `tx.table(...)` only (never `localDb`), awaiting every write (`toArray` then `bulkPut`).
   Never clear or rewrite `outbox` items' events: they are the user's unsynced work.
3. If you add a cache table, add it to `cacheTables` (cleared on actor switch and full pulls);
   queue-like tables (`outbox`, `media`, `receiptMarks`) must NOT be in `cacheTables`.
4. Add a test like `tests/client-day2.test.ts` "Dexie schema upgrade": open a DB at the old
   schema with plain `Dexie`, write outbox rows, open `new LocalDb(name)`, assert they survive.
Other open tabs get a `versionchange`; Dexie closes them and the app shows the update banner.
History: v1 (Day 1) outbox + caches + meta; v2 (Day 2) `media`, `receiptMarks` (backfilled from
queued receipts).

## Service worker updates

`app/sw.ts` uses `skipWaiting: false`: a new worker waits. `components/update-banner.tsx` listens
for Serwist's `waiting` event, shows "Update available, tap to reload", waits for any in-flight
sync (`whenIdle`), sends `SKIP_WAITING` (`messageSkipWaiting`) and reloads on `controlling`.
`reloadOnOnline` is off (it would cut voice recordings). Precache ignores `?id=`/`?taskId=`, so
`/field/task?id=…` works offline for any task (hence not `/field/tasks/[id]`).

## Folder structure

```
app/
  page.tsx               demo role picker
  field/layout.tsx       FieldChrome: sync bar (top) + bottom nav (Tasks, Clock, Notes, Me)
  field/page.tsx         task list: Overdue/Today/This Week/This Month/Follow-ups, filters, My requests
  field/task/page.tsx    task detail (?id=): auto seen, Got it, Start/Blocked/Done(+photo), receipts
  field/clock/page.tsx   clock in/out: site, safety checklist, one-shot location, distance, hours
  field/notes/page.tsx   text / voice / photo notes, upload state
  field/me/page.tsx      optional worker status, last sync, Sync now
  field/request/page.tsx material request (?taskId=) -> material_request task for the coordinator
  debug/page.tsx         sync console (outbox, cursor, simulate offline, test actions, reset)
  ~offline/page.tsx      service-worker fallback page
  api/sync/route.ts      POST /api/sync (Zod → processSync)
  api/people/route.ts    GET directory for the role picker
  api/media/route.ts     POST upload -> private Blob + server-recorded note.media_uploaded
  api/media/[noteId]/    GET: authorized streaming of a note's media (ETag, Range)
  serwist/[path]/route.ts, sw.ts, manifest.ts, layout.tsx
components/              sync-manager (triggers + upload hook), update-banner, sync-status, use-local,
                         field/ (chrome, ui primitives, task-card, photo-input, hooks), ui/ (shadcn)
lib/
  domain.ts              enums, roles, status transitions (no deps)
  events.ts              Zod event union (shared)
  geo.ts (haversine, shared), time.ts (branch-tz days/weeks), geolocate.ts, uuid.ts, config.ts
  media/                 recorder, compress (photos), store (private Blob / dev fallback),
                         record (upload checks + server event), types
  db/schema.ts           Drizzle schema (all tables, incl. later-day ones)
  db/server.ts           Neon Pool + Drizzle per request
  db/local.ts            Dexie schema: outbox, cache tables, meta
  sync/reducers.ts       pure reducers
  sync/apply.ts          SyncStore interface + applyEvent
  sync/store-drizzle.ts  server store;  sync/store-dexie.ts  client store
  sync/service.ts        processSync transaction
  sync/visibility.ts     role-scoped cursor pull
  sync/protocol.ts       request/response schema + types
  sync/client.ts         enqueue (once/media opts) / sync (paged) / markSeen / setActor / reset
  sync/media.ts          saveNote + media upload queue
  tasks/grouping.ts      Overdue / Today / This Week / This Month / Follow-ups (calendar, branch tz)
db/  migrations/ (drizzle-kit), migrate.ts, seed.ts, seed-data.ts, connect.ts
tests/  Vitest: sync, day2 (authz, revocations, paging, media; PGlite), reducers, client,
        client-day2, media (fake-indexeddb + PGlite), grouping, seed
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

Secrets only in `.env.local` (gitignored). `.env.example` lists every key:
`DATABASE_URL`, `BLOB_READ_WRITE_TOKEN` or `BLOB_STORE_ID` + OIDC (Day 2, private store),
`DEMO_ACCESS_CODE` (access gate; required in production), `SITESYNC_LOCAL_MEDIA` (optional dev flag), and
later-day keys.

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
2. **Day 2 (done): field worker PWA** + Day 1 fixes (revocations, paging, write authz, branch tz,
   SW update prompt, Dexie v2). Task groups UI, task detail (auto `task.seen`, Acknowledge button),
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

## Known gaps (after Day 2)

- Revocations cover tasks only. Sites/rollouts a worker no longer has work at stay cached
  (reference data, harmless). The old assignee keeps their own (frozen) receipt row on the server.
- Done (were the first two Day 3 hardening items): the server no longer trusts a device-reported
  media URL (it records the pathname itself), and media lives in a private store served only
  through the authenticated `/api/media/[noteId]` route.
- Media auth uses the demo actor cookie, so it is only as strong as demo mode (no real login);
  the access gate keeps outsiders out, but anyone with the code can act as any seeded person.
- Access gate: one shared code, no per-user accounts, only a small fixed delay against guessing
  (no rate limiting yet).
- Local media blobs are kept on the recording device indefinitely (no eviction yet).
- Other devices can't play media offline (the route is network-only in the service worker).
- Demo mode: no real auth. The API trusts `actorId`; authorization assumes the actor is honest.
- Media stuck if its `note.created` is rejected by the server (blob stays on the device).
- Reseeding deletes rows; already-synced clients should Reset local data (/debug).
- Seeding over Neon is slow (one WebSocket round trip per statement, several minutes).
