/** Business-facing helpers shared by server pages. */

export function formatWhen(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Compact human duration from start/end (or start→now when end omitted). */
export function formatDuration(
  startedAt: Date | string | null | undefined,
  finishedAt?: Date | string | null,
): string | null {
  if (!startedAt) return null;
  const start = typeof startedAt === "string" ? new Date(startedAt) : startedAt;
  if (Number.isNaN(start.getTime())) return null;
  const end = finishedAt
    ? typeof finishedAt === "string"
      ? new Date(finishedAt)
      : finishedAt
    : new Date();
  if (Number.isNaN(end.getTime())) return null;
  const ms = end.getTime() - start.getTime();
  if (ms < 0) return null;

  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return secs ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins ? `${hours}h ${remMins}m` : `${hours}h`;
}

export function formatDay(date: Date | null | undefined): string {
  if (!date) return "—";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function healthLabel(
  status: string,
  t: (path: string) => string,
): string {
  const key = `health.${status}`;
  const translated = t(key);
  return translated === key ? status : translated;
}
