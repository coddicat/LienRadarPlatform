/** Florida civil date as UTC midnight Date for Prisma @db.Date comparisons. */
export function floridaTodayUtcDate(now = new Date()): Date {
  const ymd = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return new Date(`${ymd}T00:00:00.000Z`);
}
