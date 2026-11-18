# SiteSync demo script (4 minutes)

Fictional company: **Demo Electrical Co.** All people, sites and customers are made up.

## Before the interview (10 minutes ahead)

| Device | Set up |
| --- | --- |
| Laptop | Production URL, access code entered. Open `/office`, act as **Marcus Bell (Manager)**. Open two tabs: **Demo control** and **Live board**. Turn on "Enable notifications" in the demo clock bar. |
| Phone | The installed SiteSync app (Home Screen), person **Sam Novak** (technician). Notifications enabled. Wi-Fi off, mobile data on (airplane mode must cut everything). |

1. **Demo control → Reset demo** (tap twice, about 10 s). On the phone: **Me → Reset this device** (tap twice) → pick **Sam Novak**.
2. Check the health strip: Database, AI key and Push are green. Transcription shows "off" on purpose: we dictate text notes instead.
3. Leave the dashboard open. The first request after a quiet period wakes the database, which takes about 1 s.

Timings below were measured with the dry run (`pnpm demo:dryrun`). AI steps take 5 to 12 s, so talk while they run.

---

## 1. The problem (0:00 to 0:30)

**Say:** "An electrical contractor runs crews on construction sites, store rollouts and service calls. Signal on site is bad: basements, steel, rural lots. Instructions go out by text or phone call and get lost, and the office can't prove anyone received them. SiteSync makes sure nothing a worker does is lost, and shows the office whether every instruction was delivered, seen and acknowledged."

**Show:** the Live board: who is clocked in where, open and overdue work, and "Last synced" per person. It is never a fake "online" dot.

## 2. Dispatch: AI drafts, a person decides (0:30 to 1:10)

**Click:** Demo control → step 1, pick the **walk-in cooler breaker** sample → **Inject** (about 8 s). Then **Open dispatch drafts**.

**Say while it runs:** "A customer email comes in. The dispatch agent turns it into a work order: site, trade, priority, who should go. It only sees our own lists, and anything it gets wrong (a person who doesn't exist, the wrong trade) is dropped by a validation step."

**Show:** the draft: Cobble Corner Home Goods, electrical, priority, **Why:** reasoning, missing info.
**Click:** set **Assignee → Sam Novak** (the agent often suggests Luis Ortega, the foreman who is on site; changing it shows that the human decides).

**Before approving:** put the phone in **airplane mode**. Then **Approve and send**.

## 3. Offline: the receipt chain (1:10 to 1:50)

**Click:** Tasks → the new task. The receipt chain shows **Sent**, not Delivered.

**Say:** "The phone has no signal. The office can see the instruction has NOT reached Sam. No guessing."

**Phone:** show that the app still works in airplane mode (task list, clock screen). Turn airplane mode **off**. The app syncs by itself within seconds (or Me → **Sync now**).

**Laptop (refreshes every 5 s):** **Delivered**. On the phone, open the task: **Seen**. Tap **Got it**: **Acknowledged**. Hover the chain for the exact times.

## 4. Field report from a dictated note (1:50 to 2:40)

**Phone:** airplane mode **on** again → **Notes** → Text → tap the **keyboard microphone** and say:

> "Finished the north lot fixtures, we need 40 more LED panels, and there's an exposed wire near the loading dock."

Pick the site **Northfield Medical Center** → **Save note**. It shows as waiting. Airplane mode **off**.

**Say:** "Everything a worker does is stored on the phone first, so a dead zone never loses work. When it syncs, the report agent reads the note on the server; the phone never calls the AI."

**After about 20 s:** the note card shows the structured log: work done, materials needed, safety issue. Below it: **Created by report agent**: *Material: 40 × LED panels* and an **urgent** *Safety: exposed wire…* for the coordinator. On the laptop, open the safety task: "From this field note" shows the original text.

## 5. Escalation by rules, not AI (2:40 to 3:20)

**Click:** Demo control → step 3 **+30 min** three times (explain each click):
1. Reminder push to Sam for his high-priority tasks he hasn't acknowledged (watch the phone).
2. **SMS** fallback: the SMS log shows it (mocked for most people; a real text for the one demo recipient).
3. **Coordinator alert**: the Live board's **Alerts** panel, with "Mark handled".

**Say:** "These are fixed rules with a clock, not AI, because they have to be reliable and explainable. Each step is recorded once, so retries never send a duplicate SMS. The demo clock only moves the rules' clock."

## 6. Rollouts, timesheets, daily digest (3:20 to 3:50)

- **Rollouts:** 12 fictional stores by stage; stores longer in a stage than planned are flagged behind schedule.
- **Timesheets:** flagged clock-ins (outside the site's geofence, no location, missing clock-out). **Say:** "Location is captured only at clock-in and clock-out. No tracking during the day."
- **Daily digest → Generate today's digest** (about 10 s). **Say:** "The numbers come from the same queries as the board. The AI only writes the text, and a check rejects any number that isn't in the data."

## 7. Close (3:50 to 4:00)

**Say:** "AI handles the messy input: emails, field notes, questions. Rules handle anything that must be reliable: receipts, escalation, SMS. And every action, human or agent, is an event in one log. **Agent activity** shows each AI run with its cost and latency."

---

## If you have an extra minute

- **Ask ops copilot** (top right): "Who is at the hospital job and what's blocked?" Answers link to the records it used.
- **Agent activity**: every run, AI or fallback, with tokens and an estimated cost.

## Reset between runs

Demo control → **Reset demo** → phone: Me → **Reset this device** → pick Sam Novak. About 30 s in total.
