# SiteSync Day 5: AI agents

Read CLAUDE.md and skim the current code first. Days 1 to 4 are done: sync engine, field app, office dashboard, push, SMS fallback and escalation rules. Today adds four AI agents. Every agent writes through the same events and reducers as people do, so the event log stays the single source of truth.

Fictional data only. "Demo Electrical Co." No real company names, logos or branding.

## Principles (state these in the UI where relevant; this is the AI coordinator pitch)
- **AI handles messy input. Rules handle anything that must be reliable.** Agents never send SMS, never escalate and never approve timesheets.
- **Agents suggest, people decide**, for anything that assigns work to a person. Only low-risk actions are automatic (creating a follow-up task from a field report, writing a summary).
- **Everything is logged.** Every agent run is stored in an `agent_runs` table: agent, trigger, input summary, structured output, model, tokens, latency, cost estimate, status, error. A run's actions are events with `source` set to the agent name.
- **The demo never breaks.** If the API key is missing, the call times out (about 20 seconds) or it errors, fall back to a deterministic rule-based output labelled "Fallback (AI unavailable)". Agent failures never block sync.
- Agents run on the server, triggered after sync or by an office action. The phone never calls an AI API.

## Tools
- Vercel AI SDK with the Anthropic provider. Use structured output with Zod schemas, and tool calling for the copilot. Check the AI SDK's current docs for the exact function names.
- Put the model ID in an env var (`ANTHROPIC_MODEL`). Look up current Claude model IDs in Anthropic's docs instead of guessing.
- Speech-to-text: check whether the AI SDK currently supports transcription with OpenAI. If it does, use it; if not, call OpenAI's transcription API directly. Put the model in an env var.
- Ask me for ANTHROPIC_API_KEY and OPENAI_API_KEY when needed.

## 1. Dispatch agent (request → draft work order → human approval)
- Input: a new "Service request" form on the office dashboard with free text (paste of a customer email) and an optional site. Also add a demo button "Inject sample request" with 3 realistic fictional examples, such as "Store 114 parking lot lights are out, customer says it's a safety issue."
- The agent gets read-only context: sites (with the rollout and stage), active people (trade, clocked in or not, current site, open task count) and recent tasks at that site.
- Output schema: { siteId | null, matchedSiteConfidence, kind, trade, priority, title, description, suggestedAssigneeId, alternativeAssigneeIds[2], dueAt, reasoning (max 3 short sentences), missingInfo[] }.
- The output is validated: the IDs must exist, the assignee must be active, and the trade must match. Anything invalid is dropped and noted.
- UI: a "Dispatch drafts" inbox. Each draft shows the fields, editable, plus the reasoning. Approve creates the task through normal events with `source: dispatch_agent`. Reject requires a short reason, which is stored.
- Tests: validation, the invalid-ID handling and the fallback path, with the model mocked.

## 2. Field report agent (voice note → structured daily log → follow-ups)
- Trigger: after `note.media_uploaded` for a voice note, and after any text note longer than about 20 words. Run it after the sync response, using the platform's documented way to run work after a response if available. Otherwise use a small queue table processed on the next sync or poll. Never make the phone's sync request wait for the AI.
- Steps: transcribe (voice) → extract.
- Output schema: { summary, workDone[], materialsUsed[{item, qty?}], materialsNeeded[{item, qty?}], blockers[], safetyIssues[], followUps[{title, assigneeRole, dueInDays}] }.
- Actions: save the transcript and structured log on the note (`note.processed` event). Automatically create follow-up tasks with `source: report_agent` (kind follow_up, assigned to the coordinator unless the note's own task assignee clearly fits). Each material needed becomes a material_request. A safety issue creates an urgent task for the coordinator, and the existing Day 4 rules handle notifying them.
- Dedupe: never create the same follow-up twice for the same note. Store the note id plus an index.
- UI: in the task drawer and on the field note screen, show the transcript, the structured log and "Created by report agent" links.
- Tests: the extraction schema with a mocked model, dedupe, and that a safety issue becomes an urgent task.

## 3. Daily digest agent
- One summary per site plus a branch summary for the selected day, built from the event log: completed, blocked, overdue, not acknowledged, material requests, safety issues, hours worked and rollout movement.
- Compute the numbers with SQL first. The model only writes the narrative from those numbers and must not invent figures. Add a check that every number in the output appears in the input data, and fall back to a template if the check fails.
- Triggers: the daily Vercel cron (the Hobby plan allows once a day) and a "Generate today's digest" button on the dashboard. Store the result in `digests`.
- UI: /office/digest shows today's digest and previous days. Add a "Send to manager" button that sends a push to the manager.

## 4. Ops copilot (ask questions in plain language)
- A chat panel on the office dashboard. Example questions: "Who is at the hospital job and what's blocked?", "Which rollout stores are behind?", "Who hasn't acknowledged urgent tasks today?"
- Read-only tools only: listSites, getSiteStatus, listTasks(filters), getWorker(personId), getRolloutStatus, getTimesheetFlags. Each tool runs a fixed, parameterized query scoped to the caller's role. No free-form SQL.
- Answers cite the records they used as links (task, site, person), so the coordinator can check them.
- Limit tool-call steps per question and log each run in agent_runs.
- Tests: role scoping for each tool, and that no write tool exists.

## 5. Agent activity page (/office/agents)
- A list of agent runs with status, latency, cost estimate and output, plus a filter by agent. This shows the interviewer that the AI is observable and controlled.

## How to work
1. Give me a short plan first, then continue without waiting unless something is ambiguous or would change the architecture in CLAUDE.md.
2. Agents act only through events and reducers, with authorization. Structured outputs are validated with Zod before use.
3. Check current docs for the AI SDK, the Anthropic provider, model IDs and transcription before writing code.
4. Ask me for API keys. Don't deploy or add paid services without asking. Keep token usage modest: short prompts, small context, about 1,000 max output tokens per call.
5. Mock the model in tests; tests must not call real APIs.
6. Keep all tests green. Make small commits. Update CLAUDE.md at the end with the agents, env vars and fallback behaviour.

## Definition of done
- typecheck, lint, test and build all pass.
- Inject a sample request: a draft appears within about 10 seconds with a sensible site, trade and assignee. Approve it and the task reaches the technician like any other.
- A technician records "Finished the north lot fixtures, we need 40 more LED panels, and there's an exposed wire near the loading dock" offline, then syncs: a transcript, a log, a material request and an urgent safety task all appear, and the Day 4 escalation applies to the safety task.
- Generate today's digest: its numbers match the dashboard.
- Ask the copilot 3 questions and get correct, linked answers.
- Remove the API key: every agent falls back cleanly and nothing crashes.
- Finish with a report: what was built, how to test it, results, measured latency and rough cost per run, anything unverified, deviations and why, and what Day 6 should start with.
