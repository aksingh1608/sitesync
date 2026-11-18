# SiteSync Day 4: Push notifications, SMS fallback and escalation rules

Read CLAUDE.md and skim the current code first. Days 1 to 3 are done: sync engine, field app, office dashboard, receipts, rollouts and timesheets. Today makes sure an instruction never silently fails: push notifications, an SMS fallback and an escalation chain. These are fixed rules, not AI, because they must be reliable and predictable.

Fictional data only. "Demo Electrical Co." No real company names, logos or branding.

## Facts that shape the design (verify against current docs)
- iOS only delivers Web Push to a PWA installed on the home screen, and permission must be requested from a user tap. iOS has no Background Sync, so the server can't wake the app to sync.
- The Vercel Hobby plan only allows scheduled (cron) jobs once a day. So escalation must not depend on a frequent cron.
- Twilio trial accounts can only text verified numbers and add a trial prefix to messages. US SMS may also need sender registration (10DLC or toll-free verification). Check Twilio's current rules and tell me what applies to a trial sending to my verified US number.

## 1. Demo clock
- Add a server-side `now()` helper used by every rule: real time plus a demo offset stored in a `demo_settings` table.
- Add a "Fast-forward" control in the office UI (+15 min, +30 min, +1 hour, Reset clock), visible only to managers and coordinators and labelled "Demo clock".
- Every time comparison in the rules uses `now()`. Never call `Date.now()` directly in rule code. Add tests that use a fixed clock.

## 2. Escalation rules engine
- A pure function `evaluateEscalations(state, now)` returns the actions due. The default policy lives in config:
  - High or urgent task sent and not acknowledged after 30 min: send a push again to the assignee.
  - After 60 min: send an SMS to the assignee.
  - After 90 min: alert the coordinator (dashboard alert plus push).
  - Normal priority: same chain with doubled times. Low priority: no escalation.
  - Overdue (past due date and not done): remind the assignee once, then alert the coordinator after 2 hours.
  - Blocked for more than 2 hours: alert the coordinator.
- Each action is recorded once in the existing `escalations` table: task, level, channel, status, sent_at, provider id, error. A unique key on (task, level) prevents duplicates, even when two evaluations run at the same time.
- Stop escalating as soon as the task is acknowledged, done or cancelled.
- **When the rules run:** at the end of every `/api/sync` call, on every dashboard poll (throttled to once per 30 seconds), through `POST /api/escalations/run` protected by a secret, and when the demo clock moves. Also add one daily Vercel cron entry as a safety net. Use advisory locks or the unique key so concurrent runs are safe.
- Tests: every threshold, the stop conditions, no duplicates under concurrent runs, and the fast-forward behaviour.

## 3. Web Push
- Generate VAPID keys (tell me the command; I'll put the keys in .env.local and Vercel). Use the `web-push` library on the server.
- The field app gets an "Enable notifications" card with clear wording. On iOS, if the app isn't installed to the home screen, show short "Add to Home Screen first" instructions instead of asking for permission.
- Save subscriptions in `push_subscriptions` (person, device, endpoint, keys). Remove subscriptions that return 404 or 410.
- The service worker shows the notification. Tapping it opens the task detail.
- Send a push when: a task is assigned to you, a task you own changes due date or priority, and on escalations. Coordinators get pushes for level-3 escalations, blocked tasks and new material requests.
- Notification text stays short and specific, for example "Urgent: Store 114 parking lot lights out. Due 2:00 PM."

## 4. SMS fallback
- Put a `SmsProvider` interface in front of two implementations: `twilio` and `mock`. Choose with an env var. Default to `mock`.
- `mock` writes the message to an `sms_outbox` view in the dashboard, so the demo works even if Twilio blocks sending.
- The SMS contains the task title, the site, a short link to the task, and "Reply 1 to acknowledge" if two-way SMS is feasible on the trial. If it isn't, leave out the reply option and tell me why.
- People have phone numbers in the seed. Only the verified demo number receives real texts; every other person is routed to mock automatically.

## 5. Office UI additions
- An alerts panel on the board: open escalations by level, with "Mark handled".
- The task drawer shows the escalation timeline next to the receipt timeline.
- An "SMS log" page that shows mock and real messages with their delivery status.

## How to work
1. Give me a short plan first, then continue without waiting unless something is ambiguous or would change the architecture in CLAUDE.md.
2. Rules are pure and tested. Side effects (push, SMS) happen only through the escalations table, never inline in reducers.
3. Check current docs for web-push, the Push API on iOS, Twilio and Vercel cron before writing code.
4. Ask me for secrets (VAPID keys, Twilio SID and token, verified number). Never invent them. Don't sign up for anything or deploy without asking.
5. Keep all tests green. Make small commits. Update CLAUDE.md at the end with new env vars and the escalation policy.

## Definition of done
- typecheck, lint, test and build all pass.
- Demo run: a coordinator creates an urgent task for an offline technician. Fast-forward 30 min: a second push is recorded. +30 min: an SMS appears (mock, or real to my verified number). +30 min: the coordinator gets an alert. Acknowledge the task: no more escalations, even after fast-forwarding further.
- Push works on Android Chrome and on an iPhone with the app installed to the home screen (test on the preview deploy). Tapping the notification opens the right task.
- Finish with a report: what was built, how to test it, results, anything unverified (especially Twilio and iOS push), deviations and why, and what Day 5 should start with.
