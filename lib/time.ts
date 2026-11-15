// Timezone-aware date bucketing without a date library. A "day key" is
// "YYYY-MM-DD" in the branch timezone.

export function dayKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const keyToUtc = (key: string) => new Date(`${key}T00:00:00Z`);
const utcToKey = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(key: string, days: number): string {
  const d = keyToUtc(key);
  d.setUTCDate(d.getUTCDate() + days);
  return utcToKey(d);
}

/**
 * The instant at local wall-clock `hh:mm` on day `key` in `timeZone`.
 * Two passes handle DST transitions correctly for normal hours.
 */
export function zonedTime(key: string, hh: number, mm: number, timeZone: string): Date {
  const target = Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10), hh, mm);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    }).formatToParts(new Date(guess));
    const g = (t: string) => +p.find((x) => x.type === t)!.value;
    const seen = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
    guess += target - seen;
  }
  return new Date(guess);
}

/** ISO weekday of a day key: Monday = 1 ... Sunday = 7. */
export function isoWeekday(key: string): number {
  const d = keyToUtc(key).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The Sunday that ends the (Monday-first) week containing `key`. */
export const endOfWeekKey = (key: string) => addDays(key, 7 - isoWeekday(key));

/** The last day of the calendar month containing `key`. */
export function endOfMonthKey(key: string): string {
  const d = keyToUtc(key);
  return utcToKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

/** Format an instant as wall-clock time in the branch timezone. */
export function formatInZone(
  date: Date | string,
  timeZone: string,
  opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, ...opts }).format(new Date(date));
}
