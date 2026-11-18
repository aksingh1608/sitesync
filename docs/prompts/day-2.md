# SiteSync Day 2: Fix Day 1 gaps, then build the field worker app

Read CLAUDE.md and skim the current code before you start. Day 1 (foundation, sync engine, PWA shell, seed, 39 passing tests) is done. Today has three parts: A fixes Day 1 gaps, B builds the real field app, C prepares the first HTTPS preview deploy so I can test on a real phone.

Fictional data only. The company is "Demo Electrical Co." No real company names, logos or branding.

---

## Part A: Day 1 fixes (do these first, with tests)

1. **Reassignment and lost visibility.** When a task is reassigned or a person loses access to a row, the old assignee's device must remove it. Add a `revocations` table (id, actor_id, entity, entity_id, seq). The reducer that changes `assignee_id` writes a revocation for the previous assignee. The pull returns `revocations` with seq > cursor for this actor, and the client deletes those rows from Dexie. Test: reassign a task from technician A to B; A's next pull removes it and B's next pull adds it.
2. **Pull pagination.** Cap each pull at about 500 rows in total. Return `hasMore: true` plus the cursor reached. The client keeps pulling until `hasMore` is false, within the same single-flight lock. Test with a seed larger than one page.
3. **Write authorization per event type.** Reads are already scoped by role. Writes must be too:
   - Technicians and foremen can acknowledge, mark seen or delivered, change status and add notes only on tasks assigned to them. They can clock in and out and set status only for themselves.
   - Only coordinators and managers can create tasks for other people, reassign, or edit title, due date or priority.
   - Anyone can create a `material_request` or `follow_up` task assigned to the coordinator.
   - Unauthorized events are rejected with reason `forbidden` without failing the batch. Add tests.
4. **Timezone.** "Today / This Week / This Month" must use the branch timezone (America/New_York), not the device timezone. I test from Berlin, so this matters. Weeks start Monday. Add tests at the midnight boundary.
5. **Seed relative to now.** All seeded due dates, receipts and time entries must be computed relative to the moment `pnpm db:seed` runs, so the demo looks right on any day. Keep the UUIDs fixed.
6. **Service worker updates.** After a new deploy, an old service worker must not keep serving a stale app. Use the documented Serwist approach (skipWaiting/clientsClaim or a prompt). Show a small "Update available, tap to reload" banner. Never drop pending outbox items during an update.
7. **Dexie schema versioning.** Document in CLAUDE.md how to bump the Dexie version when local tables change, and add an upgrade path that preserves the outbox.

## Part B: Field worker app (mobile-first)

Design rules: field workers use this outdoors, sometimes in gloves. Tap targets at least 48px, high contrast that's readable in sunlight, large text, one main action per screen, and a bottom navigation bar (Tasks, Clock, Notes, Me). Every item that hasn't synced shows a small "waiting to sync" marker. The global sync indicator stays visible.

1. **Task list (/field)**
   - Groups: Overdue (red), Today, This Week, This Month, Follow-ups. Show counts.
   - Each card: title, site name, priority, due time, receipt state, sync marker.
   - Filter chips: All / Open / Blocked / Done.
2. **Receipts that fire automatically**
   - `task.delivered` fires once, the first time a task lands in the device cache after a sync. This is per device and per person; don't send it twice.
   - `task.seen` fires once, the first time the task detail opens.
   - `task.acknowledged` comes from a big "Got it" button on the detail screen.
3. **Task detail (/field/tasks/[id])**
   - Title, description, site with address and a "Directions" link (opens the maps app), due date, priority, who assigned it, and the receipt timeline.
   - Status buttons limited to allowed transitions: Start, Blocked (asks for a reason), Done. Done asks for an optional photo.
   - "Add note" and "Request material" actions.
4. **Clock in and out (/field/clock)**
   - Pick a site. The site the worker has tasks at today is preselected.
   - Safety checklist before clock-in: 3 short checkboxes (PPE on, hazards reviewed, lockout/tagout understood). All three are required. Record `safety_check_done`.
   - Get location with a timeout of about 10 seconds. If location is unavailable (indoors, permission denied), allow clock-in anyway, record "location unavailable", and let the server flag it for HR review.
   - Show the distance to the site on the device right away, computed with the same haversine function the server uses. Put that function in shared code. The server stays authoritative.
   - Clock out the same way. Show today's hours.
5. **Worker status (/field/me)**
   - Optional status: On site, Lunch, Traveling, Off, plus "Clear status". Make it clear this is optional.
   - Show the person's name, role, the last sync time and a "Sync now" button.
6. **Notes, voice and photos (/field/notes)**
   - Text note, voice note (MediaRecorder; detect a supported mime type, because iOS uses audio/mp4) and photo (file input with `capture`).
   - Store media as Blobs in a new Dexie `media` table while offline. `note.created` references a local media id.
   - Add an upload queue. When online, upload each blob to Vercel Blob through a server route (client uploads with a token route are fine if the current docs recommend them), then emit a new event `note.media_uploaded` { noteId, blobUrl, mimeType, sizeBytes, durationSec? }. Retries use the same backoff as the outbox. Add this event to the Zod union, the reducers and the tests.
   - Limit voice notes to 2 minutes and compress photos client-side to about 1600px on the long edge.
   - No transcription today. It comes on Day 5.
7. **Material request**
   - A form with item, quantity, needed-by date and an optional note. It creates a `material_request` task assigned to the branch coordinator and linked to the site and current task.

## Part C: First preview deploy (ask me before running anything that deploys)

- A service worker on a phone needs HTTPS, so localhost on my laptop isn't enough for phone testing.
- Walk me through `vercel link`, setting env vars (DATABASE_URL and BLOB_READ_WRITE_TOKEN), and a preview deploy. Wait for my go-ahead before each command that changes anything on Vercel.
- The sync and upload routes must use the Node.js runtime.
- After the deploy, give me a short phone test checklist: install to the home screen, go into airplane mode, clock in, add a voice note, acknowledge a task, turn signal back on, confirm everything syncs once.

---

## How to work
1. Give me a short plan first, then continue without waiting unless something is ambiguous or would change the architecture in CLAUDE.md.
2. All writes go through events and the existing reducers. No direct table writes from routes or UI, except in seed and migrations.
3. Check current docs before using any library API (Serwist, Dexie, Vercel Blob, MediaRecorder). Don't rely on memory.
4. Don't deploy, sign up for services or add paid dependencies without asking me. Ask me for any secret; never invent one.
5. Keep all existing tests green and add tests for every new rule.
6. Make small commits. At the end, update CLAUDE.md with what exists now, new event types, new env vars and known gaps.

## Definition of done
- typecheck, lint, test and build all pass.
- In the browser (pnpm build && pnpm start): as a technician, go offline with the simulate toggle, clock in with the checklist, acknowledge a task, mark one blocked, record a voice note, take a photo, create a material request. Reload while offline and confirm everything is still there with "waiting to sync" markers. Go online and confirm the outbox and upload queue empty, media URLs appear and every event is stored exactly once.
- Reassign a task in a test and confirm it disappears from the old assignee.
- Finish with a report: what was built, how to test it, test results, anything you couldn't verify, deviations and why, and what Day 3 should start with.
