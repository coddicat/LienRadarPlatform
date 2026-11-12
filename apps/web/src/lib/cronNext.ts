/** Next fire for 5-field cron (m h dom mon dow), evaluated in a named IANA timezone. */
export function getNextCronDate(
  cronExpr: string,
  timezone = "America/New_York",
  from = new Date(),
): Date | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = parts as [string, string, string, string, string];

  const cursor = new Date(from.getTime() + 60_000);
  cursor.setUTCSeconds(0, 0);

  for (let i = 0; i < 60 * 24 * 21; i++) {
    const partsTz = zonedParts(cursor, timezone);
    if (
      matchField(minF, partsTz.minute) &&
      matchField(hourF, partsTz.hour) &&
      matchField(monF, partsTz.month) &&
      matchDomDow(domF, dowF, partsTz.day, partsTz.dow)
    ) {
      return new Date(cursor);
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

function matchDomDow(domF: string, dowF: string, day: number, dow: number): boolean {
  const domStar = domF === "*";
  const dowStar = dowF === "*";
  if (domStar && dowStar) return true;
  const domOk = matchField(domF, day);
  const dowOk = matchField(dowF, dow);
  // Standard cron: if both restricted, either may match.
  if (!domStar && !dowStar) return domOk || dowOk;
  if (!domStar) return domOk;
  return dowOk;
}

function matchField(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.includes(",")) return field.split(",").some((f) => matchField(f.trim(), value));
  if (field.startsWith("*/")) {
    const step = Number(field.slice(2));
    return Number.isFinite(step) && step > 0 && value % step === 0;
  }
  if (field.includes("-")) {
    const [a, b] = field.split("-").map(Number);
    return Number.isFinite(a) && Number.isFinite(b) && value >= a! && value <= b!;
  }
  return Number(field) === value;
}

function zonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    weekday: "short",
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[map.weekday ?? ""] ?? 0;
  return {
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    dow: weekday,
  };
}
