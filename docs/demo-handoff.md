# SiteSync demo handoff

For whoever presents the live demo. Everything in the app is fictional (**Demo Electrical Co.**).
The full talk track is in [`demo-script.md`](demo-script.md); fallbacks are in [`backup-plan.md`](backup-plan.md).

## Live URL

**https://sitesync-gamma.vercel.app**

The first page asks for the **access code**. It is not written in this repo or the app: get it from
Aryan directly. After entering it once, the browser remembers it.

## Who to pick for each view

The start page (`/`) is a people picker (demo mode, no real login). The office header also has an
"Acting as" switcher.

| View | Person | Role | Use it for |
| --- | --- | --- | --- |
| Phone (`/field`) | **Sam Novak** | Technician | The worker app: tasks, Got it, clock in/out, notes |
| Laptop (`/office`) | **Marcus Bell** | Manager | Everything, including **Demo control** (`/office/demo`) |
| Laptop (alternative) | Dana Whitfield | Coordinator | Board, tasks, dispatch, rollouts (no timesheet approval) |
| Laptop (alternative) | Priya Raman | HR | Timesheets and team; tasks read-only |

One browser can be Sam in `/field` and Marcus in `/office` at the same time.

## Before you start (10 minutes ahead)

1. Laptop: open the URL, enter the code, pick **Marcus Bell**, open **Demo control**.
2. **Reset demo** (tap twice, about 10 s). The health strip should show Database, AI key and Push green.
   Transcription shows "off" on purpose: voice notes are not transcribed, so dictate into a text note
   with the keyboard microphone instead.
3. Phone: open the URL (or the installed Home Screen app), enter the code, pick **Sam Novak**.
   **If this phone was used before**, first go to **Me → Reset this device** (tap twice), then pick Sam.

## 4-minute click path

| Time | Where | Click | Point to make |
| --- | --- | --- | --- |
| 0:00 | Laptop: Live board | Nothing; point at the board | Who is where, open/overdue work, "Last synced" per person (never a fake online dot) |
| 0:30 | Demo control → step 1 | Pick the walk-in cooler sample → **Inject** (~8 s) → **Open dispatch drafts** | AI drafts the work order; validation drops anything invalid |
| 0:50 | Dispatch draft | Set **Assignee → Sam Novak**. Phone to **airplane mode**. **Approve and send** | A person decides, not the AI |
| 1:10 | Tasks → the new task | Receipt chain shows **Sent** only | The office can see it has NOT reached Sam |
| 1:30 | Phone | Airplane mode **off** (or Me → Sync now). Open the task, tap **Got it** | Laptop goes Delivered → Seen → Acknowledged (5 s refresh) |
| 1:50 | Phone: Notes → Text | Dictate: "Finished the north lot fixtures, we need 40 more LED panels, and there's an exposed wire near the loading dock." Site **Northfield Medical Center** → Save | Saved on the phone first; works with no signal |
| 2:20 | Phone: Notes (after ~20 s) | Show the structured report and the tasks it created | Material request + urgent safety task for the coordinator |
| 2:40 | Demo control → step 3 | **+30 min** three times | 1: push reminder, 2: SMS (SMS log), 3: coordinator alert (Alerts panel). Fixed rules, not AI |
| 3:20 | Rollouts, then Timesheets | Show stores behind schedule, flagged clock-ins | Location only at clock-in/out, no tracking |
| 3:40 | **Ask ops copilot** (header) | Ask "Which rollout stores are behind?" (~10 s) | Read-only, role-scoped, cites the records it used |
| 3:55 | Agent activity | Show the runs list | Every AI run is logged with cost and latency |

## If something fails

| Symptom | Do this |
| --- | --- |
| Page shows the access code form | Enter the code again (it was rotated or cookies were cleared) |
| First load is slow | The database wakes after idling (~1 s). Open the dashboard 5 minutes early |
| AI step says "Fallback (AI unavailable)" | Keep going: the fallback result is real and labelled. That is the design: the demo never breaks |
| Phone task did not arrive | Phone: Me → **Sync now**; check the sync bar at the top |
| Push did not arrive | Show the SMS log and the Alerts panel instead. iPhone push only works from the Home Screen app |
| "Database briefly unavailable" | Wait 5 s; it retries. The phone keeps its work in the outbox |
| Data looks messy mid-demo | Demo control → **Reset demo**, phone → Me → **Reset this device** → Sam Novak (~30 s) |
| Airplane mode is awkward on stage | Phone: Me → Debug console → **Simulate offline** |
| Nothing loads at all | Use the recorded video (see `backup-plan.md`) |

## Reset the demo data later

Easiest: in the app, **Marcus Bell → Demo control → Reset demo** (tap twice).

From a terminal in the repo (with `.env.local`, which points at the production database):

```
export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH   # Node 24 (this machine)
pnpm db:seed
```

After any reset, phones that were used before must do **Me → Reset this device** (or `/debug` →
Reset local data), then pick Sam Novak again.
