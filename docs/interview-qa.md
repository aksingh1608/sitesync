# Likely interview questions, short honest answers

## How does offline work?
Every action on the phone (clock-in, Got it, a note, a status change) is written first to a local database on the phone (IndexedDB) as an event in an outbox, and the screen updates from that local copy immediately. The app syncs when it can: on start, when the signal returns, when the app comes back to the foreground, every 30 s, or on "Sync now". There is no Background Sync on iPhone, so it syncs whenever the app is open. A service worker caches the app itself, so it opens with no signal.

## What happens with conflicts?
The server is the referee. Every event has a unique id, so a resend is ignored rather than applied twice. Task fields are "last write wins" per field, by the time the change was made on the device. A task closed by someone cannot be reopened by an older change. Receipts only move forward (delivered, seen, acknowledged). Invalid changes are rejected with a reason the device shows, and they never block the rest of a sync.

## How do you know a worker actually received an instruction?
Four timestamps per task and person: sent (office), delivered (the phone downloaded it), seen (opened), acknowledged ("Got it"). They come from the device, are kept in the event log, and the board shows them live. Unacknowledged high-priority work escalates by fixed rules: push, then SMS, then a coordinator alert.

## Privacy and location?
Location is captured only at clock-in and clock-out, once, to check the person is at the site (a geofence) and to flag exceptions for HR. There is no continuous tracking. A worker sees only their own work. In this demo there is no real login (anyone with the access code can pick any person); a real rollout needs proper accounts, see below.

## Where does the AI come in, and what if it is wrong?
Four agents: dispatch (email to a draft work order), field report (note to a structured log and follow-up tasks), daily digest (text from computed numbers) and an ops copilot (read-only questions). Agents suggest and people decide: nothing is assigned to a person without a coordinator's approval. Model output is validated (ids must exist, trades must fit; digest numbers must appear in the data). If the AI is unavailable or wrong-shaped, a rule-based fallback runs and is labelled. Agents never send SMS, escalate or approve timesheets. Every run is logged with tokens, latency and cost.

## Why not just use existing field service tools?
Many do scheduling and forms well. This prototype focuses on two things that are often weak: work that never gets lost on bad signal (an offline-first event log), and proof that an instruction reached the person (the receipt chain with escalation). In a real engagement I would first check what the company already uses and integrate with it rather than replace it.

## What would a real rollout need?
- Real accounts and sign-in (SSO with the company's identity provider), roles managed by them.
- Integration with their systems: job/ERP, payroll for timesheets, purchasing for material requests.
- A security review: data retention, audit, device management, penetration test.
- A pilot with one branch and a few crews, measuring acknowledgement times and lost-work incidents.
- A paid hosting plan (the Vercel Hobby plan used here is for non-commercial use only), monitoring and on-call.

## What does it cost to run?
The demo runs on free tiers (Vercel Hobby, Neon free Postgres, Vercel Blob). AI is the main variable cost; measured per run: dispatch about $0.016, field report about $0.004, digest about $0.017, copilot about $0.04 (Claude Opus 5.5 at low effort). A daily cap switches agents to their fallback if exceeded. SMS is per message (Twilio). A real deployment adds a paid hosting plan.

## Why a PWA and not a native app?
One codebase, installable from the browser, updates without an app store, and works offline with a service worker. The trade-off: on iPhone, push notifications need the app added to the Home Screen and there is no background sync.

## What was built with AI assistance?
_(Adjust to your own account.)_ The code was written over six days with an AI coding assistant (Claude Code) working from day plans I wrote (`docs/prompts/`). I set the architecture rules, reviewed the output, ran the tests and did the real-device testing. The test suite (200+ tests) runs without any AI calls.

## What are the known weak spots?
- Demo-mode identity: no real login.
- Escalations run when something triggers them (syncs, dashboard polls, the daily cron); with everything closed a step can be late.
- Voice notes are not transcribed in this demo build; workers dictate into a text note instead.
- iPhone push only works for the installed app.
