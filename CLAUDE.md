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
  `/icons/*`, `/serwist/*`, `/~offline`, `/_next/static|image`, `POST /api/unlock` and
  `/api/escalations/run` (which requires `Authorization: Bearer CRON_SECRET` itself)
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

- **Node 24** (`.nvmrc` = 24, `package.json` engines `24.x`, which Vercel also reads; `.npmrc`
  sets `engine-strict`). On this machine `~/.local/bin/node` is v20 and shadows nvm; use
  `export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH` (a Node 20 `next dev` was flaky).
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
never the device's. Task groups are **rolling windows** (Overdue / Today / Next 7 days / Later /
Follow-ups); calendar weeks were dropped after the phone test (Sunday evening: "This Week" empty).

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

Day 5: `note.processed { noteId, transcript, report }` (**server-only**, written by the field report
agent as the note's author; first one wins; sets `field_notes.transcript/report/processed_at`).

**Server-only events** (`SERVER_ONLY_EVENT_TYPES` in `lib/events.ts`): `/api/sync` rejects them
from devices with `forbidden` and does not store them. Server code creates them with
`processSync(db, req, { trusted: true, skipPull: true })`, deviceId `server:media`, and a
deterministic event id (`mediaEventId(mediaId)`), so retries are duplicates.

Day 3 (office) events: `material.status_changed { taskId, to: approved|ordered|delivered }`
(coordinator/manager, material requests only, forward only; `delivered` also closes the task),
`site.stage_changed { siteId, from, to }` (coordinator/manager, rollout stores; `from` must equal
the current stage or it is rejected `stage_conflict`; Closeout/Done need >= 1 **uploaded** photo
note on the site, else `photo_required`; sets `sites.stage_changed_at`), `time.approved` /
`time.rejected { reason }` (HR/manager only; the later decision by clientTs wins; an open entry
can be rejected but not approved). Columns: `tasks.material_status(_at)`, `sites.stage_changed_at`,
`time_entries.review_status/reviewed_by/reviewed_at/review_reason`.

## Transient database errors (Day 3)

`lib/db/errors.ts`: `isTransientDbError` (net codes, AggregateError of per-address connect errors,
ws `ErrorEvent`, Postgres 08xxx/57P0x; never constraint or syntax errors), `describeError` (full
cause chain for logs; a ws ErrorEvent otherwise logs as `{}`), `withTransientRetry` (one retry,
fresh Pool per attempt; only for work that is safe to repeat).
- `POST /api/sync` (`lib/sync/http.ts` `handleSync`): one server-side retry (the transaction
  rolled back; events are idempotent by id), then **503 `{ error: "db_unavailable", retryable:
  true }` + Retry-After**. The client treats it as a failed attempt: outbox items stay `pending`
  (attempts + lastError), exponential backoff, never `rejected`.
- Office reads, `/office` layout (readable "can't reach the database" page instead of a crash),
  `/api/people`, `GET /api/media/[noteId]`: one retry, then 503.
- `db:seed` / `db:migrate` (`reseedWithRetry` in `db/seed-fast.ts`, reused by the Day 6 reset
  button): one retry on a fresh connection, full error log on any failure. Reproduced locally:
  the Neon WebSocket sometimes fails to open (bare ErrorEvent); the retry recovered every time.

## Office dashboard (/office, Day 3)

Coordinator / HR / manager, desktop, **online only**. Reads: `GET /api/office/{snapshot,
tasks/[id], timesheets?week=[&format=csv], team?from&to}` (`lib/office/queries.ts`; team stats
aggregated in SQL), polled every 5 s (`OFFICE_POLL_MS`) and paused while the tab is hidden, with
"Updated Xs ago". **Writes go through `POST /api/sync`** as events from a per-browser device id
(`web-<uuid>` in localStorage) with `pull: false`; no admin write routes.
- Identity: own cookie `sitesync_office_actor` (falls back to `sitesync_actor`), so one browser
  can run /field as a technician and /office as a coordinator. `app/office/layout.tsx` redirects
  field roles to /field; office APIs return 401 (no person) / 403 (field role). The media route
  accepts either cookie.
- Roles (UI hides, reducers enforce): coordinator everything except timesheet approval; HR
  timesheets + team, tasks read-only (no Board/Rollouts); manager everything.
- Freshness: `devices(id, person_id, last_sync_at, app_version)` is upserted by `/api/sync`
  (`recordDevice`, not seed/server writes); the board shows "Last synced X ago", never an online dot.
- Rules in `lib/office/rules.ts` (pure, tested): receipt stage, amber when sent > 30 min
  (`ACK_WARN_MINUTES`) and not acknowledged, behind schedule = longer in stage than
  `ROLLOUT_STAGE_EXPECTED_DAYS`, timesheet flags (geofence / no location / open > 14 h = missing
  clock-out), CSV (formula-safe, BOM), assignee suggestions (active field people whose trade fits,
  people at the site first). Timesheets use calendar weeks (Monday); "Needs review" spans 30 days.

## Escalation, push and SMS (Day 4)

Fixed rules, not AI. **Side effects (push, SMS) happen only through the `escalations` table,
never in reducers.**
- **Demo clock** (`lib/clock.ts`): rule time = real time + `demo_settings.clock_offset_ms`.
  Rule code gets a `Clock`, never calls `Date.now()`. Office "Demo clock" bar (managers and
  coordinators): +15 min / +30 min / +1 hour / Reset (`POST /api/office/demo-clock`, then runs the
  rules). The office snapshot's `now` is demo time (amber/overdue match). Field devices keep
  their own clock. Reseeding resets the offset. Reset does NOT undo escalations already sent.
- **Policy** (`lib/escalation/policy.ts`) and pure `evaluateEscalations(state, clock)`
  (`lib/escalation/rules.ts`), tested with a fixed clock:
  - `ack` (sent, not acknowledged; current assignee only): level 0 push at first sight, then
    from that moment +30 min push again, +60 SMS, +90 coordinator alert. Urgent/high x1,
    normal x2, low: level 0 only. Office assignees (material requests) get level 0 only.
    Episode = assignee@sentAt, so a reassignment starts a new ladder.
  - `overdue` (due passed, not done/cancelled, field assignee, not follow-up/low): reminder push
    once (level 1), coordinator alert 2 h after the reminder (level 2). Episode = due date.
  - `blocked`: push coordinators at once (level 0), alert after 2 h (level 1). Episode = the
    status event id.
  - `changed`: push the assignee when due date or priority changed (level 0, fresh changes only).
  - The ladder is counted from the level-0 row's `scheduled_for` (when the engine first saw it,
    demo clock), so old seed data never floods and fast-forward works on new tasks.
  - Catch-up: several levels due at once -> only the highest is sent, lower ones `skipped`
    (`superseded`). First notifications older than 60 REAL min -> `skipped` (`stale`).
  - Stop: acknowledged / done / cancelled (or unblocked, new due date, reassigned) -> no new
    steps and open rows close themselves (`resolved_at`; alerts also `status=resolved`).
    "Mark handled" (`POST /api/office/escalations/handle`) closes all open rows of a task and
    stops those ladders (`handled_by`).
  - Coordinator alerts go to the task creator (if office, not HR) + every active coordinator.
- **Runner** (`lib/escalation/run.ts`): load state -> rules -> claim each step with
  `INSERT ... ON CONFLICT DO NOTHING` on unique `(task_id, rule, episode, level)` -> only the
  claimer sends -> update status (`sent|failed|skipped`, provider id, error). At-most-once: a
  crash after the claim leaves `pending`, never a duplicate SMS. Triggers: after every
  `/api/sync` (`after()`; throttled when nothing was accepted), every dashboard snapshot poll
  (throttled to 30 s across instances by a conditional UPDATE on `demo_settings`), demo clock
  moves, `GET|POST /api/escalations/run` (Bearer `CRON_SECRET`), daily Vercel cron
  (`vercel.json`, 13:00 UTC; Hobby allows once a day, +-59 min) as a safety net.
- **Web Push** (`web-push` 3.6.7, VAPID): `push_subscriptions` unique per (endpoint, person);
  `POST|DELETE /api/push/subscribe` (field scope = `sitesync_actor`, office scope = office
  cookie; subscribing removes the same endpoint's other person of that scope). 404/410 -> row
  deleted. `app/sw.ts` shows `{title, body, url, tag}` and opens `url` on tap (field:
  `/field/task?id=`, office: `/office/tasks?task=`). Field "Enable notifications" card (task
  list + Me); on iOS outside the Home Screen it shows Add-to-Home-Screen steps instead (iOS only
  pushes to installed web apps, and asks only from a tap). Existing subscriptions are
  re-registered silently on app start. Dev (`next dev`) has no service worker: no push.
- **SMS** (`lib/sms/`): `SmsProvider` with `mock` and `twilio` (REST, no SDK), `SMS_PROVIDER`
  default mock. Only the person picked on `/office/sms` ("Real SMS recipient", stored in
  `demo_settings.sms_demo_person_id`) is texted for real, at `SMS_DEMO_TO_NUMBER`; everyone
  else is mock. Every SMS is a `sms_messages` row (the SMS log) with the number masked, our
  `body`, what the provider really sent (`sent_body`) and status (mock: `mocked`; Twilio
  statuses are refreshed from the API when the log is opened). **Twilio trial** (detected via
  the Accounts API): custom bodies are not allowed, so the template `sms_internal_alerts` is
  sent instead; "Reply 1 to acknowledge" is left out (custom text impossible, shared trial
  number, inbound webhook only via the trial console). SMS links use `/t/<last 10 hex of task
  id>` -> `/field/task?id=` (host from `VERCEL_PROJECT_PRODUCTION_URL`).
- Office UI: Alerts panel on the board (open escalations, highest first, "Mark handled"),
  escalation timeline in the task drawer (next to receipts), `/office/sms` log, office
  "Enable notifications" button in the demo clock bar.

## AI agents (Day 5)

`lib/agents/`. **AI handles messy input; rules handle anything that must be reliable.** Agents never
send SMS, escalate or approve timesheets; they suggest, people decide (anything that assigns work to
a person needs a coordinator's approval). Agents run on the server only (`after()` or an office
action); the phone never calls an AI API and an agent can never block or fail a sync.
- **Models** (`ai.ts`): AI SDK 7 (`ai@7.0.162`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, pinned).
  `ANTHROPIC_MODEL` (default `claude-opus-5-5`), `ANTHROPIC_EFFORT` (default `low`; Opus 5.5 always
  thinks, effort is the latency/cost lever), `OPENAI_TRANSCRIPTION_MODEL` (default
  `gpt-4o-mini-transcribe`). `MAX_OUTPUT_TOKENS` 1200, `AGENT_TIMEOUT_MS` 20 s, `maxRetries` 1.
- **Fallback** (`withFallback`): no key, timeout, error, or output that fails the Zod schema / our
  validation -> a deterministic rule-based result, labelled **"Fallback (AI unavailable)"** in the UI.
  Never throws for model problems.
- **Logging**: every run is an `agent_runs` row (agent, trigger, actor, subject, input summary,
  output, status running|ok|fallback|error, model, tokens, latency, cost estimate from
  `pricing.ts`, error, validation notes), written before the call and finished after it.
  Unique `(agent, subject_id)` (partial index) = a note / draft is claimed by one run; a run stuck
  in `running` > 5 min or ended in `error` > 1 min may be retried (`startRun`). `/office/agents`.
- **Agent writes are events**: from device `agent:<agent>` with deterministic ids (`stableUuid`),
  so a repeated run is a duplicate, never a second task.

Agents:
1. **Dispatch** (`dispatch.ts`, `/office/dispatch`, coordinator/manager): free-text request (+
   optional site) -> draft in `dispatch_drafts` (office-only state, like escalations). The model
   sees short refs (S1, P2), never uuids; `validateDispatch` drops refs that don't exist, inactive
   or wrong-trade assignees (filled from `suggestAssignees`), bad due dates; the form's site wins.
   Approve (`/api/office/dispatch/decide`) claims the draft (pending -> approved) then creates the
   task through `processSync` **as the coordinator**, `source: dispatch_agent`, task id = draft id;
   a refused event reverts the claim. Reject needs a reason. "Inject sample request" (3 samples).
2. **Field report** (`report.ts`): voice notes after `note.media_uploaded`, text notes of >= 20
   words. Triggers: `after()` in `/api/sync` (pending notes, up to 3) and `/api/media` (that note),
   plus one per office snapshot poll as a safety net (`hooks.ts`). Transcribe (OpenAI) -> extract
   (Zod schema) -> tasks **as the note's author** via `processSync` (existing authz: follow-ups /
   material requests to a coordinator, own follow-ups): follow-ups (coordinator, or the author if
   it is their task), one `material_request` per material needed, one **urgent** follow-up
   "Safety: ..." per safety issue (the Day 4 `ack` rule then notifies the coordinator). Follow-ups
   that restate a material/safety item are dropped. Then `note.processed`. Ids from
   (note, kind, index). Fallback: keyword extraction (`fallbackExtract`). Without
   `OPENAI_API_KEY` a voice note gets no transcript (reason stored in `report.transcriptError`).
   Shown on the field Notes screen and in the task drawer (also "From this field note" on tasks
   the agent created, found via `field_notes.report->createdTasks`).
3. **Digest** (`digest.ts`, `/office/digest`): numbers first, from the dashboard's own code
   (`loadSnapshot` + `derive` for "now" counts, `teamStats` for completions, the event log for the
   day: material requests, safety tasks, hours, stage moves). The model writes only the narrative;
   `checkNarrative` rejects any number (digits or number words) not in the data -> template.
   Stored in `digests` (latest per day shown). Triggers: "Generate today's digest" (demo-clock
   today) and the daily cron (`/api/escalations/run` GET also writes **yesterday's** digest).
   "Send to manager" pushes to active managers (`pushToPeople` now also takes `{url, tag}`).
4. **Ops copilot** (`copilot.ts`, drawer on every office page): read-only tools `listSites,
   getSiteStatus, listTasks, getWorker, getRolloutStatus, getTimesheetFlags` over one snapshot per
   question (fixed, parameterized queries; no SQL from the model), chosen by role
   (`TOOLS_BY_ROLE`: HR has no rollout tool; field roles would see only their own work). Max 5
   steps (`isStepCount`). Answers cite records as links (`/office/tasks?task=|site=|assignee=`;
   the task table reads `site`/`assignee` params); every record a tool returned is also listed.
   Fallback: keyword routing to one tool (site synonyms: hospital -> Medical).

Measured locally (Opus 5.5, effort low; Neon is slow from this machine): dispatch 5-8 s,
~$0.016/run; report extraction ~4.7 s, ~$0.004 (end to end after a sync ~25 s locally); digest
~7 s, ~$0.017; copilot 8-16 s (2-3 tool steps), ~$0.04. Fallbacks: < 3 s, $0.

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
  field/page.tsx         task list: Overdue/Today/Next 7 days/Later/Follow-ups, filters, My requests
  field/task/page.tsx    task detail (?id=): auto seen, Got it, Start/Blocked/Done(+photo), receipts
  field/clock/page.tsx   clock in/out: site, safety checklist, one-shot location, distance, hours
  field/notes/page.tsx   text / voice / photo notes, upload state
  field/me/page.tsx      optional worker status, last sync, Sync now
  field/request/page.tsx material request (?taskId=) -> material_request task for the coordinator
  debug/page.tsx         sync console (outbox, cursor, simulate offline, test actions, reset)
  ~offline/page.tsx      service-worker fallback page
  api/sync/route.ts      POST /api/sync (Zod → processSync)
  api/people/route.ts    GET directory for the role picker
  office/                dashboard: board, tasks (+materials), rollouts, timesheets, team
  api/office/            GET snapshot, tasks/[taskId], timesheets (+csv), team
  api/media/route.ts     POST upload -> private Blob + server-recorded note.media_uploaded
  api/media/[noteId]/    GET: authorized streaming of a note's media (ETag, Range)
  api/escalations/run/   GET (Vercel cron) / POST: run the rules, Bearer CRON_SECRET
  api/push/subscribe/    POST / DELETE push subscriptions
  api/office/            + demo-clock, escalations/handle, sms (log, demo recipient, test SMS)
  api/office/            + dispatch (+decide), digest (+send), copilot, agents (Day 5)
  office/                + dispatch, digest, agents pages (Day 5)
  t/[code]/              short task link for SMS
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
  field/                 sites.ts (site preselection, Clock + Notes), notes.ts (why Save is disabled)
  sync/status.ts         describeSync: one sync view for top bar + Me (no signal is not an error)
  clock.ts               demo clock (offset in demo_settings), run throttle
  escalation/            policy (config), rules (pure), run (claim + send)
  push/                  send (web-push, server), client (support checks, subscribe)
  sms/                   provider (interface, mock, routing), twilio (REST), send (log rows)
  tasks/grouping.ts      Overdue / Today / Next 7 days / Later / Follow-ups (rolling, branch tz)
  agents/                ai (models, fallback), runs (agent_runs), pricing, ids, hooks (after-sync),
                         dispatch, report, digest, copilot
lib/office/              auth (office actor), queries (server reads + SQL stats), rules, derive,
                         timesheets (rows + CSV), route (GET wrapper)
components/office/       data (polling, writes via /api/sync), shell, ui, tasks, agents (copilot, badges)
components/agent-report.tsx  report agent output (field Notes + office drawer)
db/  migrations/ (drizzle-kit), migrate.ts, seed.ts, seed-data.ts, seed-fast.ts, connect.ts
tests/  Vitest: sync, day2 (authz, revocations, paging, media; PGlite), reducers, client,
        client-day2, media (fake-indexeddb + PGlite), grouping, seed, field, day3 (office events,
        devices), office (rules + queries on the seed), escalation-rules (pure, fixed clock),
        escalation-run (PGlite: demo flow, concurrency, push cleanup, SMS routing, throttle),
        agents-report, agents-dispatch, agents-digest-copilot (mocked models via ai/test;
        agent-mocks.ts). Tests never call a real AI API.
scripts/gen-icons.ts     placeholder PWA icons (no deps)
```

## Commands

```
pnpm dev | build | start | lint | typecheck | test
pnpm db:generate   # after editing lib/db/schema.ts
pnpm db:migrate    # applies db/migrations to DATABASE_URL (.env.local)
pnpm db:seed       # wipes + reseeds demo data in ~7 s (clients: /debug → Reset local data)
pnpm db:studio
pnpm icons         # regenerate placeholder icons
CODE=… BASE=http://localhost:3100 pnpm e2e:office   # headless Playwright: /office per role +
                   # two-context receipt test; screenshots in /tmp/sitesync-office (creates 1 task)
BASE=http://localhost:3100 pnpm e2e:agents [--fallback]   # Day 5 definition of done against a
                   # running server (REAL model calls, ~$0.25 a run; writes demo data). --fallback: start
                   # the server with ANTHROPIC_API_KEY= OPENAI_API_KEY= and assert every agent falls back
```

Secrets only in `.env.local` (gitignored). `.env.example` lists every key:
`DATABASE_URL`, `BLOB_READ_WRITE_TOKEN` or `BLOB_STORE_ID` + OIDC (Day 2, private store),
`DEMO_ACCESS_CODE` (access gate; required in production), `SITESYNC_LOCAL_MEDIA` (optional dev flag),
Day 4: `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (build-time, starts with "B", 87 chars), `VAPID_PRIVATE_KEY`,
`VAPID_SUBJECT`, `CRON_SECRET`, `SMS_PROVIDER` (mock|twilio), `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `SMS_DEMO_TO_NUMBER`; Day 5: `ANTHROPIC_API_KEY`,
`ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT`, `OPENAI_API_KEY`, `OPENAI_TRANSCRIPTION_MODEL` (all optional:
missing keys mean rule-based fallbacks).
On Vercel, `vercel env ls` shows a "Config" (non-sensitive) value as an encrypted `eyJ2…`
envelope (base64 of `{"v`), not the value itself.

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
3. **Day 3 (done): coordinator dashboard.** Fast seed, devices table, office events. Live board (who is where, status), receipts view
   (sent/delivered/seen/acknowledged per task), rollout board (stores by stage), timesheets with
   flagged clock-ins, task create/assign.
4. **Day 4 (done): escalation + push.** Demo clock, pure escalation rules, claim-once runner,
   Web Push (field + office), SMS fallback (mock / Twilio for one demo recipient), alerts panel,
   escalation timeline, SMS log, daily cron safety net.
5. **Day 5 (done): AI agents.** Dispatch agent (draft -> human approval), field report agent
   (voice/text note -> transcript -> structured log, follow-ups, material requests, urgent safety
   task), daily digest (checked numbers), ops copilot (read-only tools), agent activity page.
6. **Day 6: polish + demo.** Deploy to Vercel, demo script, airplane-mode walkthrough, hardening.

## Known gaps (after Day 5)

- Voice transcription needs `OPENAI_API_KEY`; without it voice notes are logged with no
  transcript and the report agent creates nothing from them (text notes still work by rules).
- The field report agent runs after the sync/upload response (`after()`), or on the next office
  poll; a crashed run is retried after 5 min. If no office tab is open and no one syncs, a waiting
  note waits too. Locally a note -> tasks takes ~20-25 s (slow Neon route); the model part ~5 s.
- The report agent dedupes by (note, kind, index): if a note were processed twice with different
  model output, index i maps to the first run's task (no second task, but not re-titled).
- The digest number check only sees numbers (digits and common number words); it cannot catch a
  wrong claim without a number ("most sites are on track"). The "now" counts in a digest for a
  past day are as of generation time, not that day's end.
- Copilot answers in one turn (no chat memory). Its links open the task table filtered by
  site/assignee (there is no site or person page).
- Costs are list-price estimates (`pricing.ts`), not the provider's bill.

- Escalations run only when something calls them (syncs, dashboard polls, clock moves, the
  daily cron). On Hobby there is no frequent cron, so with every app closed a step can be late
  by up to a day. Pro (per-minute cron) or an external pinger to `/api/escalations/run` fixes it.
- Sending is at-most-once: a crash between claim and send leaves a `pending` row (shown in the
  timeline), never retried. Failed pushes/SMS are recorded, not retried; the next level still fires.
- Twilio trial: the phone gets Twilio's template text, not ours; no two-way SMS.
- iOS push needs the app on the Home Screen; Android/desktop Chrome work from the browser.
- One browser = one push endpoint: in demo mode it can carry one field person + office people.


- Revocations cover tasks only. Sites/rollouts a worker no longer has work at stay cached
  (reference data, harmless). The old assignee keeps their own (frozen) receipt row on the server.
- Done (Day 3 hardening items 1 and 2, landed before Day 3): the server no longer trusts a
  device-reported media URL (it records the pathname itself), and media lives in a private store
  served only through the authenticated `/api/media/[noteId]` route. Also done on Day 3: fast seed.
- Media auth uses the demo actor cookie, so it is only as strong as demo mode (no real login);
  the access gate keeps outsiders out, but anyone with the code can act as any seeded person.
- Access gate: one shared code, no per-user accounts, only a small fixed delay against guessing
  (no rate limiting yet).
- Local media blobs are kept on the recording device indefinitely (no eviction yet).
- Other devices can't play media offline (the route is network-only in the service worker).
- Demo mode: no real auth. The API trusts `actorId`; authorization assumes the actor is honest.
- Media stuck if its `note.created` is rejected by the server (blob stays on the device).
- Reseeding deletes rows; already-synced clients should Reset local data (/debug).
- Seeding: `db:seed` builds the data in an in-memory PGlite through `processSync`, then copies it
  to the target in ONE transaction (`db/seed-fast.ts`, ~12 statements, ~7 s). seq/server_seq are
  reassigned by the target, so cursors only move forward. Devices rows are seeded directly
  (freshness only, not a projection).
- Office: online only, polling (push only for alerts); the snapshot loads all open tasks + 30 days of closed
  ones (fine for a branch, not for thousands of tasks). Stats are computed live, not cached.
- Office photo check counts only uploaded photos: a photo still on the phone does not unlock
  Closeout yet.
- This dev machine has a slow, flaky route to Neon (~200 ms RTT, TCP timeouts, no IPv6): a sync
  takes 3-5 s locally and some requests 503 even after the retry. Receipt latency on the
  dashboard measured locally at 10-14 s for that reason (5 s poll + slow syncs); on Vercel next
  to Neon it should be ~poll interval. Local timings are not representative.
- Missing clock-out (open > 14 h): hours are unknown (`entryHours` = null), shown as "?" and left
  out of totals and the CSV hours column.
