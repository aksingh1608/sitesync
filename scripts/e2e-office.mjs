// Headless click-through of /office (coordinator, HR, manager) + the two-context receipt test.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

// Usage: CODE=<demo access code> BASE=http://localhost:3100 pnpm e2e:office  (needs Chromium: pnpm exec playwright-core install chromium)
// Creates one "Playwright check" task assigned to Sam in the target database.
const B = process.env.BASE ?? "http://localhost:3100";
const OUT = process.env.OUT ?? "/tmp/sitesync-office";
mkdirSync(OUT, { recursive: true });
const CODE = process.env.CODE;
const P = {
  dana: "00000002-0000-4000-8000-000000000001",
  priya: "00000002-0000-4000-8000-000000000002",
  marcus: "00000002-0000-4000-8000-000000000003",
  sam: "00000002-0000-4000-8000-000000000006",
};
const results = [];
const check = (ok, msg) => { results.push(`${ok ? "PASS" : "FAIL"}  ${msg}`); console.log(results.at(-1)); };

const browser = await chromium.launch();

async function newContext(viewport) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: "allow" });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/status of 401/.test(m.text()) && problems.push(`console: ${m.text().slice(0, 200)}`));
  await page.goto(B + "/");
  if (await page.locator("#code").count()) {
    await page.fill("#code", CODE);
    await Promise.all([page.waitForLoadState("load"), page.click("button[type=submit]")]);
  }
  return { ctx, page, problems };
}

async function shot(page, name, waitFor = '[data-testid="updated-ago"]') {
  try {
    await page.locator(waitFor).first().waitFor({ timeout: 20_000 });
  } catch {
    check(false, `${name}: '${waitFor}' never appeared`);
  }
  await page.waitForTimeout(600); // charts animate in
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  return `${OUT}/${name}.png`;
}

// ---------------------------------------------------------------------------
// 1. Click-through per role
// ---------------------------------------------------------------------------
const office = await newContext({ width: 1440, height: 900 });
const op = office.page;
await op.click(`[data-testid="pick-${P.dana}"]`);
await op.waitForURL("**/office");

const pages = [
  ["board", "/office", '[data-testid="kpi-overdue"]'],
  ["tasks", "/office/tasks", '[data-testid^="task-row-"]'],
  ["materials", "/office/tasks/materials", '[data-testid^="material-"]'],
  ["rollouts", "/office/rollouts", '[data-testid^="store-"]'],
  ["timesheets", "/office/timesheets", '[data-testid="needs-review"]'],
  ["team", "/office/team", '[data-testid="team-table"]'],
];

async function tour(role, actorId, allowed) {
  if (actorId !== P.dana) {
    await op.goto(B + "/office/team");
    await op.selectOption('[data-testid="office-actor"]', actorId);
    await op.waitForFunction((id) => document.querySelector('[data-testid="office-actor"]')?.value === id, actorId);
    await op.waitForTimeout(800);
  }
  for (const [name, path, ready] of pages) {
    if (!allowed.includes(name)) continue;
    await op.goto(B + path);
    await shot(op, `${role}-${name}`, ready);
  }
  // The task drawer (history, notes, status actions).
  await op.goto(B + "/office/tasks");
  await op.locator('[data-testid^="task-row-"]').first().waitFor();
  await op.getByText("LED retrofit install, aisles 1-6", { exact: false }).first().click();
  await op.locator('[data-testid="task-panel"]').waitFor();
  await op.getByText("History").waitFor();
  await op.waitForTimeout(500);
  await op.screenshot({ path: `${OUT}/${role}-task-drawer.png`, fullPage: false });
  const hasStatus = await op.locator('[data-testid="status-cancelled"]').count();
  const hasNew = await op.locator('[data-testid="new-task"]').count();
  await op.keyboard.press("Escape");
  return { hasStatus, hasNew };
}

let r = await tour("coordinator", P.dana, pages.map((p) => p[0]));
check(r.hasStatus > 0 && r.hasNew > 0, "coordinator: New task + status/cancel actions in the drawer");
check((await op.locator('[data-testid="approve"]').count()) === 0, "coordinator timesheets: no approve buttons (view only)");

r = await tour("hr", P.priya, ["tasks", "timesheets", "team"]);
check(r.hasStatus === 0 && r.hasNew === 0, "HR: tasks read-only (no New task, no status actions)");
await op.goto(B + "/office");
await op.waitForURL("**/office/timesheets", { timeout: 15_000 }).then(() => check(true, "HR opening the Board lands on Timesheets"), () => check(false, "HR board redirect"));
await shot(op, "hr-timesheets-approve", '[data-testid="approve"]');
check((await op.locator('[data-testid="approve"]').count()) > 0, "HR timesheets: approve/reject available");

r = await tour("manager", P.marcus, pages.map((p) => p[0]));
check(r.hasStatus > 0 && r.hasNew > 0, "manager: full write access in tasks");

check(office.problems.length === 0, `office: no page errors (${office.problems.slice(0, 3).join(" | ") || "none"})`);

// Back to the coordinator for the receipt test.
await op.selectOption('[data-testid="office-actor"]', P.dana);
await op.waitForTimeout(800);

// ---------------------------------------------------------------------------
// 2. Two contexts: technician phone (offline) + coordinator dashboard
// ---------------------------------------------------------------------------
const phone = await newContext({ width: 390, height: 844 });
const pp = phone.page;
await pp.click(`[data-testid="pick-${P.sam}"]`);
await pp.waitForURL("**/field");
await pp.locator('[data-testid="net-status"]', { hasText: "Synced" }).waitFor({ timeout: 30_000 });
await phone.ctx.setOffline(true);
await pp.waitForFunction(() => navigator.onLine === false);
await pp.locator('[data-testid="net-status"]', { hasText: "No signal" }).waitFor({ timeout: 10_000 });
await pp.screenshot({ path: `${OUT}/phone-offline.png` });
check(true, "phone: technician offline, bar says 'No signal'");

const title = `Playwright check ${Date.now()}`;
await op.goto(B + "/office/tasks");
await op.click('[data-testid="new-task"]');
await op.fill('[data-testid="task-title"]', title);
await op.selectOption('[data-testid="task-site"]', "00000004-0000-4000-8000-000000000001");
await op.selectOption('[data-testid="task-assignee"]', P.sam);
await op.click('[data-testid="task-save"]');
const row = op.locator('tr[data-testid^="task-row-"]', { hasText: title });
await row.waitFor({ timeout: 15_000 });
const taskId = (await row.getAttribute("data-testid")).replace("task-row-", "");
const stageNow = () => row.locator('[data-testid="receipt-chain"]').getAttribute("data-stage");
check((await stageNow()) === "sent", "dashboard: new task shows Sent while the phone is offline");
await op.waitForTimeout(6_000); // a poll cycle passes; still offline
check((await stageNow()) === "sent", "dashboard: still Sent after a 5 s poll (phone offline)");
await op.screenshot({ path: `${OUT}/receipt-1-sent.png` });

async function until(stage, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    if ((await stageNow()) === stage) {
      const s = (Date.now() - t0) / 1000;
      check(s <= 7, `${label}: dashboard shows ${stage} after ${s.toFixed(1)} s`);
      await op.screenshot({ path: `${OUT}/receipt-${stage}.png` });
      return s;
    }
    await op.waitForTimeout(200);
  }
  check(false, `${label}: ${stage} never appeared within 30 s`);
}

// Back online: the 'online' event is one of the app's sync triggers.
await phone.ctx.setOffline(false);
await pp.evaluate(() => window.dispatchEvent(new Event("online")));
await until("delivered", "phone back online");
await pp.goto(`${B}/field/task?id=${taskId}`);
await until("seen", "technician opens the task");
await pp.click('[data-testid="ack"]');
await until("acknowledged", "technician taps Got it");
await pp.screenshot({ path: `${OUT}/phone-acknowledged.png` });
check(phone.problems.filter((p) => !/Failed to fetch|ERR_INTERNET_DISCONNECTED|net::/.test(p)).length === 0, `phone: no page errors (${phone.problems.slice(0, 3).join(" | ") || "none"})`);

await browser.close();
console.log(`\nScreenshots in ${OUT}`);
console.log(`TASK_ID=${taskId}`);
process.exitCode = results.some((x) => x.startsWith("FAIL")) ? 1 : 0;
