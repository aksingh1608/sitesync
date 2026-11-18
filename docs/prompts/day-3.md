# SiteSync Day 3: Office dashboard (coordinator, HR, manager)

Read CLAUDE.md and skim the current code first. Days 1 and 2 are done: sync engine, field app, receipts, clock in/out, notes with media, material requests. Today builds the office side that a coordinator, HR person or manager uses on a laptop.

Fictional data only. "Demo Electrical Co." No real company names, logos or branding.

## Core principles for today
- **One write path.** The dashboard writes through the same `/api/sync` endpoint and the same events as the phone, using a stable web device id per browser. No separate admin write routes.
- **Online-only reads are fine here.** The dashboard can read from the server. Refresh by polling every 5 seconds (simple and works on Vercel without websockets), pausing when the tab is hidden. Show "Updated 3s ago".
- **Honest freshness.** Never show a misleading green "online" dot. Show "Last synced X min ago" for each worker, computed from their device's last sync time. Store each device's last sync time on the server during `/api/sync` (add a `devices` table: id, person_id, last_sync_at, app_version).
- Desktop layout with a left sidebar: Board, Tasks, Rollouts, Timesheets, Team, plus a role switcher at the top. Clean, dense and readable.

## 1. Live board (/office)
- One column or card per site, plus an "Unassigned" lane.
- Each worker shows: name, trade, clock-in state (and since when), optional status, "last synced" time, and open, overdue and blocked counts.
- Top strip: clocked in now, tasks overdue, tasks not acknowledged, blocked tasks, open material requests. Each number is clickable and filters the task table.

## 2. Tasks (/office/tasks)
- Table with filters: site, assignee, status, priority, kind, and the receipt stage reached.
- The receipt column shows the chain Sent → Delivered → Seen → Acknowledged with timestamps on hover. Highlight in amber any task sent more than 30 minutes ago that isn't acknowledged. Day 4 adds automatic escalation; today is visual only.
- Create task: title, description, site, assignee, priority, due date, kind. Assignee suggestions show only active people whose trade fits, with the people at that site first.
- Edit and reassign. Reassign uses the Day 2 revocation mechanism.
- Task detail drawer: full event history (who did what, when, from which device), notes with playable audio and photo thumbnails, and linked follow-ups.
- Material requests view: a queue of open requests with Approve, Ordered and Delivered actions. Add the needed event types (for example `material.status_changed`) to the Zod union, reducers, authorization and tests.

## 3. Rollouts (/office/rollouts)
- For the fictional "LED Retrofit - RetailCo, 12 stores": a board of stores across stages Survey → Materials shipped → Install → Punch list → Closeout → Done.
- Moving a store to another stage is an event: `site.stage_changed` { siteId, from, to, note? }. Only coordinators and managers may do this. Add tests.
- Progress bar for the whole rollout, plus a list of stores "behind schedule". Give each stage an expected duration in config, and flag a store when it has been in its stage longer than expected. Rule-based only; AI comes later.
- Closeout requires at least one photo note on the site. Block the move to Closeout otherwise and show why.

## 4. Timesheets (/office/timesheets), HR view
- Weekly view per person: days, clock in/out, hours, site, the distance from site at clock-in, and the safety check.
- Flagged entries (too far from site, location unavailable, missing clock-out) appear in a "Needs review" list first.
- Approve or reject with a reason through new events `time.approved` and `time.rejected`. Only HR and managers may do this. Add tests.
- Export the selected week as CSV.
- Note in the UI: "Location is recorded only at clock-in and clock-out."

## 5. Team stats (/office/team)
- For a selected date range: tasks completed, median time from sent to acknowledged, overdue count and blocked count, per person, per site and for the branch.
- Use Recharts. Keep it to 3 or 4 clear charts plus one table. Compute everything on the server with SQL and test the aggregation functions.

## 6. Role-based views
- Coordinator: everything except timesheet approval.
- HR: timesheets and team; tasks read-only.
- Manager: everything, read and write.
- Technicians and foremen who open /office are redirected to /field.

## How to work
1. Give me a short plan first, then continue without waiting unless something is ambiguous or would change the architecture in CLAUDE.md.
2. All writes go through events and reducers with authorization rules. Add tests for every new event type and rule.
3. Check current docs for Next.js data fetching, Recharts and anything else before using them.
4. Don't deploy, sign up for services or add paid dependencies without asking me.
5. Keep all tests green. Make small commits. Update CLAUDE.md at the end.

## Definition of done
- typecheck, lint, test and build all pass.
- With two browser windows (one technician on /field, one coordinator on /office): the coordinator creates a task for the technician. The technician is offline (simulate toggle), so the dashboard shows Sent only. The technician goes online and the dashboard shows Delivered. The technician opens it (Seen) and taps Got it (Acknowledged), and each step shows up within about 5 seconds.
- Reassigning a task moves it between two technicians' devices.
- Moving a store to Closeout without a photo is blocked; with a photo it works.
- HR approves one timesheet and rejects a flagged one; the CSV export opens correctly.
- Finish with a report: what was built, how to test it, results, anything unverified, deviations and why, and what Day 4 should start with.
