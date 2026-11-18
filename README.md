# SiteSync

Offline-first field coordination for **Demo Electrical Co.** (a fictional electrical contractor;
all people, sites and customers are made up). Interview demo prototype.

Crews often have no signal. SiteSync records every action on the phone first and syncs it when
it can, and the office can see whether each instruction was **sent, delivered, seen and
acknowledged**. Fixed rules escalate unacknowledged work (push, SMS, coordinator alert). AI
agents handle messy input: they draft work orders from emails, turn field notes into daily logs,
write the daily digest and answer questions. A person approves anything that assigns work.

- How it works, in plain language: [`docs/architecture.md`](docs/architecture.md)
- Demo: [`docs/demo-script.md`](docs/demo-script.md), [`docs/backup-plan.md`](docs/backup-plan.md),
  [`docs/interview-qa.md`](docs/interview-qa.md), [`docs/device-test.md`](docs/device-test.md)
- Engineering rules and details: [`CLAUDE.md`](CLAUDE.md)

## What's in it

| Area | Where |
| --- | --- |
| Field app (installable PWA, works offline): tasks, task detail with Got it, clock in/out with one-shot location, notes (text, voice, photo), material requests | `/field` |
| Office dashboard: live board, tasks with receipt chains, material requests, rollouts, timesheets (+CSV), team stats, SMS log | `/office` |
| AI agents: dispatch drafts, field report agent, daily digest, ops copilot, agent activity log | `/office/dispatch`, `/office/digest`, copilot button, `/office/agents` |
| Demo control (managers): health strip, Reset demo, demo steps | `/office/demo` |
| Sync console (managers, or everyone in demo mode) | `/debug` |

## Requirements

- Node.js 24 (`nvm use`), pnpm 12
- Postgres on [Neon](https://neon.tech) (free tier is fine). Use a **separate database or branch
  for development**: `pnpm db:seed` and "Reset demo" wipe all data.
- Optional: Anthropic API key (agents; without it every agent uses its rule-based fallback),
  VAPID keys (push), Twilio (SMS; mock by default), Vercel Blob (media).

## Setup

```bash
pnpm install
cp .env.example .env.local      # fill in DATABASE_URL and DEMO_ACCESS_CODE at least
pnpm db:migrate
pnpm db:seed                    # fictional demo data, relative to now (wipes the database)
pnpm build && pnpm start        # the service worker (offline, push) only runs in a production build
```

`pnpm dev` works for UI work but has no service worker. Every page asks for `DEMO_ACCESS_CODE`
once (in development without a code the app is open).

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` / `build` / `start` | Next.js |
| `pnpm lint` / `typecheck` / `test` | ESLint / tsc / Vitest (in-memory PGlite and mocked AI; no database or API keys needed) |
| `pnpm db:generate` / `db:migrate` / `db:seed` / `db:studio` | Drizzle migrations, seed, studio |
| `pnpm icons` | Regenerate the PWA icons |
| `BASE=… pnpm demo:dryrun [--runs 2]` | Server-side dry run of the demo script (wipes the target database, makes AI calls) |
| `BASE=… pnpm e2e:agents [--fallback]` | Day 5 agent checks against a running server |
| `CODE=… BASE=… pnpm e2e:office` | Headless browser check of the office dashboard |

## Deploying

Vercel (Next.js 16, Node.js runtime, Fluid compute) + Neon Postgres + Vercel Blob (private store).
Set the env vars from `.env.example` in the Vercel project (production and preview separately;
point Preview at the development database), run `pnpm db:migrate` against the production
database, seed it, and deploy. The daily cron in `vercel.json` runs the escalation rules and
writes yesterday's digest.

> **Plan note:** this demo runs on the **Vercel Hobby plan, which is for non-commercial use
> only.** A real pilot at a company needs a **Pro** plan (commercial use, per-minute cron for
> timely escalations, longer function limits), plus real sign-in, a security review and a paid
> database tier.

## Status

Days 1 to 6 of the six-day plan are built (see `CLAUDE.md`). Known gaps and limits are listed
there under "Known gaps".
