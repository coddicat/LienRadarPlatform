const STATUS_TONE: Record<string, "ok" | "bad" | "warn" | "info" | "neutral"> = {
  SCHEDULED: "info",
  LIVE: "ok",
  POSTPONED: "warn",
  CANCELED: "bad",
  SOLD: "ok",
  REDEEMED: "warn",
  NOT_SOLD: "neutral",
  CLOSED: "neutral",
};

export function StatusPill({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  const tone = STATUS_TONE[status] ?? "neutral";
  return <span className={`pill ${tone}`}>{label}</span>;
}

export function statusToneClass(status: string): string {
  return STATUS_TONE[status] ?? "neutral";
}
