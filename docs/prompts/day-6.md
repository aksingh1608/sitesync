# SiteSync Day 6: Production deploy, demo polish and rehearsal kit

Read CLAUDE.md and skim the current code first. Days 1 to 5 are done. Today makes the demo safe to show to an interviewer: deployed, protected, fast, resettable, and impossible to get stuck in. No new major features.

Fictional data only. "Demo Electrical Co." No real company names, logos or branding.

## 1. Hardening
- **Access gate.** A simple demo access code (env `DEMO_ACCESS_CODE`) checked by middleware on every page and API route, except the manifest, icons and the service worker. Store it in a cookie after the first entry. The public URL must not let strangers write to the database or spend AI credits.
- **Rate limits** on /api/sync, the agent routes and uploads. Simple per-IP and per-device limits are enough.
- **Secrets audit.** No keys in client bundles. Check the build output for env leaks. Every key comes from Vercel env vars.
- **Error handling.** Add error boundaries on every route, friendly offline and error screens, and keep the sync indicator visible everywhere.
- Hide /debug unless the role is manager or the demo mode flag is on.
- Run the whole test suite and fix anything flaky.

## 2. Demo control panel (/office/demo), managers only
- **Reset demo:** reseed the database relative to now, reset the demo clock, clear the escalations, SMS log, agent runs and digests. Add a "Reset this device" instruction or button for the phones.
- Buttons in demo order: Inject sample service request → Open dispatch draft → Fast-forward 30 min → Fast-forward 1 hour → Generate digest.
- A health strip: database reachable, AI key valid, transcription key valid, push configured, SMS mode (mock or real), app version and deploy time.

## 3. Performance and polish
- The field app's first load must be fast on a slow 4G connection. Check bundle size and lazy-load the office-only code and the charts.
- Run Lighthouse in Chrome DevTools for performance and accessibility. Fix the major issues. (Recent Lighthouse versions no longer have a PWA category, so verify installability in the Application tab instead.)
- Make sure the colours, spacing and copy are consistent, there's no leftover lorem ipsum, and the empty states are useful.
- Make the app icon and splash look intentional, with a neutral SiteSync wordmark. Avoid anything resembling a real company's brand.

## 4. Production deploy (ask me before each command that changes Vercel)
- Set up a production deployment with all env vars, migrations run against the production Neon branch, and a production seed.
- Keep a separate Neon branch for development, so testing never breaks the demo data.
- Confirm the sync, upload and agent routes run on the Node.js runtime with enough max duration for agent calls. Check the current Vercel limits for my plan.
- Confirm the daily cron is registered.
- Note in the README: the Vercel Hobby plan is for non-commercial use. A real pilot at a company would need a Pro plan.

## 5. Real-device test pass (give me the checklist and record the results I report)
- Android Chrome: install, offline clock-in, voice note, acknowledge, push, tap the notification, update banner after a redeploy.
- iPhone Safari: Add to Home Screen, the same flow, push only when installed, and what happens after the app has been closed for a while.
- Laptop: the office dashboard updating in real time during the phone flow.

## 6. Rehearsal kit (write these as files in /docs)
- `docs/demo-script.md`: a 4-minute script with exact clicks and talking points:
  1. The problem: weak signal on sites, instructions get lost, no proof they were received.
  2. Dispatch: inject a request → the AI draft → a human approves.
  3. Offline: the technician's phone has no signal → the dashboard shows Sent, not Delivered → signal returns → Delivered, Seen, Acknowledged.
  4. Field report: an offline voice note → after sync, a structured log, a material request and a safety task appear.
  5. Escalation: fast-forward → push, SMS, coordinator alert, driven by rules.
  6. Rollout board, timesheet flags (location only at clock-in) and the daily digest.
  7. Close: AI handles messy input, rules handle reliability, every action is logged.
- `docs/interview-qa.md`: likely interviewer questions with short honest answers. For example: how does offline work, what happens with conflicts, privacy and location, why not just use existing field tools, what would a real rollout need (login/SSO, integration with their existing systems, security review, a pilot with one branch), what it costs to run, and what was built with AI assistance.
- `docs/backup-plan.md`: what to do if the venue Wi-Fi fails (use a phone hotspot, have a pre-recorded screen video of the full demo, use the offline simulate toggle), and how to reset quickly between runs.
- `docs/architecture.md`: one page explaining the event log, outbox, sync, the rules engine and the agents in plain language, so a non-engineer can explain it.

## How to work
1. Give me a short plan first, then continue without waiting unless something is ambiguous.
2. No new features beyond this list. If something seems missing, tell me instead of building it.
3. Check current Vercel and Neon docs for limits, cron, function duration and env handling.
4. Ask before every deploy and every command that changes Vercel or Neon. Ask me for any secret.
5. Keep all tests green. Make small commits. Update CLAUDE.md and the README at the end.

## Definition of done
- The production URL works behind the access code, and all tests, lint, typecheck and build pass.
- Reset demo, then run the full demo script start to finish twice in a row without touching the database by hand.
- The real-device checklist passes on Android and iPhone, or the failures are documented with workarounds.
- The four docs exist and are accurate to the build.
- Finish with a report: the production URL (without the access code), what changed, the device test results, known risks during a live demo, and the 3 things to rehearse most.
