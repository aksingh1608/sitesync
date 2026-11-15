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

/** Last day (Sunday) of the Monday-start week containing `key`. */
export function endOfWeek(key: string): string {
  const dow = keyToUtc(key).getUTCDay(); // 0 = Sunday
  return addDays(key, dow === 0 ? 0 : 7 - dow);
}

export function endOfMonth(key: string): string {
  const d = keyToUtc(key);
  return utcToKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
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
