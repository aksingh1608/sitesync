# How SiteSync works (plain language)

**One sentence:** every action anyone takes is written down as an entry in a log; phones keep their own copy and send their entries when they can; the server checks each entry against fixed rules and builds the current picture from the log; AI helpers read messy text and write entries too, but only through the same checks.

## The event log
Every change is an **event**: "Sam acknowledged task 12 at 10:41 on his phone", "Dana created a task for Aisha". Each event has a unique id made by the device. The server keeps all of them, in order. The screens (task lists, the board, timesheets) are **derived** from the log, like a bank balance is derived from transactions. Benefits: nothing is overwritten, every decision can be traced, and sending the same event twice changes nothing.

## The outbox (on the phone)
The phone has its own small database. When a worker does something, the app writes the event to an **outbox** and updates its own copy of the data at once, so the app feels instant and works with no signal. Nothing is lost if the battery dies or the signal drops: the outbox is on the phone's storage.

## Sync
When the app is open and has signal (at start, when signal returns, every 30 s, or on "Sync now"), it sends the outbox to the server and receives what changed since last time. The server:
1. stores each new event once (repeats are ignored),
2. checks it against the rules (is this person allowed? is the task still open? is this change older than one already applied?),
3. updates the derived data, or records why it rejected the event.

The phone then replaces its copy with the server's and re-applies anything still waiting. Workers only receive their own work.

## Receipts
For every task and person the system keeps four times: **sent, delivered, seen, acknowledged**. The phone reports delivered when it downloads the task, seen when it is opened, acknowledged on "Got it". The office board shows the chain live.

## The rules engine (escalation)
A fixed set of rules checks open work against a clock: a high-priority task not acknowledged gets a reminder push after 30 minutes, an SMS after 60, and the coordinator is alerted after 90; overdue and blocked work have their own steps. Each step is claimed once in the database before it is sent, so two servers running the rules at the same moment never send a duplicate SMS. A demo clock lets us fast-forward the rules' time.

## The agents (AI)
Four helpers run on the server, never on the phone:
- **Dispatch** turns a customer email into a draft work order. A person approves it.
- **Field report** turns a worker's note into a structured log and creates follow-up tasks, material requests and urgent safety tasks, acting with the same permissions as the worker who wrote the note.
- **Daily digest** writes the day's summary from numbers the system computed; a check rejects any number not in the data.
- **Ops copilot** answers questions using read-only lookups, and links to the records it used.

Rules for all of them: their output is checked before use; if the AI is unavailable they fall back to simple rules (labelled on screen); they never send messages, escalate or approve anything; every run is logged with its cost.

## Where things run
- **Phone / browser:** the installable web app (works offline), the local database and outbox.
- **Server (Vercel):** sync, rules, agents, the office dashboard's data.
- **Database (Neon Postgres):** the event log and derived data.
- **File storage (Vercel Blob, private):** photos and voice recordings, served only to people allowed to see them.
- **Notifications:** Web Push to phones and browsers; SMS through Twilio (mocked except for one demo number).
