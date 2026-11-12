/** Friendly schedule helpers for 5-field cron (m h dom mon dow). */

export type ScheduleKind =
  | "every_minutes"
  | "every_hours"
  | "daily"
  | "weekdays"
  | "custom";

export type FriendlySchedule = {
  kind: ScheduleKind;
  /** every_minutes step, or minute-of-hour for daily/hours/weekdays */
  minute: number;
  /** every_hours step, or hour-of-day for daily/weekdays */
  hour: number;
  cronExpr: string;
};

const PRESET_MINUTES = [5, 10, 15, 30, 60] as const;
const PRESET_HOURS = [1, 2, 3, 4, 6, 8, 12] as const;

export { PRESET_MINUTES, PRESET_HOURS };

export function parseCronToFriendly(cronExpr: string): FriendlySchedule {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { kind: "custom", minute: 0, hour: 0, cronExpr: cronExpr.trim() };
  }
  const [minF, hourF, domF, monF, dowF] = parts;

  // */N * * * *
  if (/^\*\/\d+$/.test(minF) && hourF === "*" && domF === "*" && monF === "*" && dowF === "*") {
    const step = Number(minF.slice(2));
    if (Number.isFinite(step) && step > 0) {
      return { kind: "every_minutes", minute: step, hour: 0, cronExpr: cronExpr.trim() };
    }
  }

  // M */H * * *
  if (/^\d+$/.test(minF) && /^\*\/\d+$/.test(hourF) && domF === "*" && monF === "*" && dowF === "*") {
    const minute = Number(minF);
    const step = Number(hourF.slice(2));
    if (Number.isFinite(minute) && Number.isFinite(step) && step > 0) {
      return { kind: "every_hours", minute, hour: step, cronExpr: cronExpr.trim() };
    }
  }

  // M H * * *
  if (/^\d+$/.test(minF) && /^\d+$/.test(hourF) && domF === "*" && monF === "*" && dowF === "*") {
    return {
      kind: "daily",
      minute: Number(minF),
      hour: Number(hourF),
      cronExpr: cronExpr.trim(),
    };
  }

  // M H * * 1-5
  if (/^\d+$/.test(minF) && /^\d+$/.test(hourF) && domF === "*" && monF === "*" && dowF === "1-5") {
    return {
      kind: "weekdays",
      minute: Number(minF),
      hour: Number(hourF),
      cronExpr: cronExpr.trim(),
    };
  }

  return { kind: "custom", minute: 0, hour: 0, cronExpr: cronExpr.trim() };
}

export function buildCronFromFriendly(s: Omit<FriendlySchedule, "cronExpr">): string {
  const minute = clampInt(s.minute, 0, 59);
  const hour = clampInt(s.hour, 0, 23);
  switch (s.kind) {
    case "every_minutes": {
      const step = Math.max(1, Math.min(60, s.minute || 30));
      return step === 60 ? "0 * * * *" : `*/${step} * * * *`;
    }
    case "every_hours": {
      const step = Math.max(1, Math.min(24, s.hour || 6));
      return `${minute} */${step} * * *`;
    }
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "custom":
    default:
      return "0 * * * *";
  }
}

function clampInt(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

export function formatClock(hour: number, minute: number) {
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** English fallback description (UI prefers i18n via describeScheduleKey). */
export function describeCron(cronExpr: string, timezone?: string): string {
  const f = parseCronToFriendly(cronExpr);
  const tz = timezone ? ` (${timezone.replace(/_/g, " ")})` : "";
  switch (f.kind) {
    case "every_minutes":
      return f.minute === 60 ? `Every hour${tz}` : `Every ${f.minute} minutes${tz}`;
    case "every_hours":
      return f.hour === 1
        ? `Every hour at :${pad2(f.minute)}${tz}`
        : `Every ${f.hour} hours at :${pad2(f.minute)}${tz}`;
    case "daily":
      return `Every day at ${formatClock(f.hour, f.minute)}${tz}`;
    case "weekdays":
      return `Weekdays at ${formatClock(f.hour, f.minute)}${tz}`;
    default:
      return cronExpr.trim() || "—";
  }
}
