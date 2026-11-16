// Timesheet rows shared by the HR table and the CSV export. Pure.
import { BRANCH_TIMEZONE } from "../config";
import { dayKey, formatInZone } from "../time";
import { entryFlags, entryHours, FLAG_LABEL, toCsv } from "./rules";

type Entry = {
  id: string;
  personId: string;
  siteId: string;
  clockInAt: Date | string;
  clockOutAt: Date | string | null;
  clockInDistanceM: number | null;
  safetyCheckDone: boolean;
  flagged: boolean;
  flagReason: string | null;
  reviewStatus: "approved" | "rejected" | null;
  reviewReason: string | null;
};

export type TimesheetRow = {
  id: string;
  person: string;
  day: string;
  site: string;
  clockIn: string;
  clockOut: string;
  hours: number;
  distanceM: number | null;
  safety: boolean;
  flags: string[];
  review: string;
  reason: string;
};

const clock = (d: Date | string) => formatInZone(d, BRANCH_TIMEZONE, { hour: "numeric", minute: "2-digit" });

export function timesheetRows(
  data: { week: Entry[]; people: { id: string; name: string }[]; sites: { id: string; name: string }[] },
  now: Date,
): TimesheetRow[] {
  const name = new Map(data.people.map((p) => [p.id, p.name]));
  const site = new Map(data.sites.map((s) => [s.id, s.name]));
  return data.week
    .map((e) => ({
      id: e.id,
      person: name.get(e.personId) ?? e.personId,
      day: dayKey(new Date(e.clockInAt), BRANCH_TIMEZONE),
      site: site.get(e.siteId) ?? e.siteId,
      clockIn: clock(e.clockInAt),
      clockOut: e.clockOutAt ? clock(e.clockOutAt) : "",
      hours: Math.round(entryHours(e, now) * 100) / 100,
      distanceM: e.clockInDistanceM === null ? null : Math.round(e.clockInDistanceM),
      safety: e.safetyCheckDone,
      flags: entryFlags(e, now).map((f) => FLAG_LABEL[f]),
      review: e.reviewStatus ?? "pending",
      reason: e.reviewReason ?? "",
    }))
    .sort((a, b) => a.person.localeCompare(b.person) || a.day.localeCompare(b.day) || a.clockIn.localeCompare(b.clockIn));
}

export function timesheetCsv(data: Parameters<typeof timesheetRows>[0] & { weekKey: string }, now: Date): string {
  const header = [
    "Person",
    "Date",
    "Site",
    "Clock in",
    "Clock out",
    "Hours",
    "Distance from site at clock-in (m)",
    "Safety check",
    "Flags",
    "Review",
    "Review reason",
  ];
  const rows = timesheetRows(data, now).map((r) => [
    r.person,
    r.day,
    r.site,
    r.clockIn,
    r.clockOut || "(open)",
    r.hours.toFixed(2),
    r.distanceM,
    r.safety ? "yes" : "no",
    r.flags.join("; "),
    r.review,
    r.reason,
  ]);
  // UTF-8 BOM so Excel opens accented names correctly.
  return "\uFEFF" + toCsv([header, ...rows]);
}
