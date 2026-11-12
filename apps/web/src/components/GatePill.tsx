type Props = {
  bidAllowed: boolean | null | undefined;
  hasGate: boolean;
  allowedLabel: string;
  blockedLabel: string;
  pendingLabel: string;
  needsDdLabel: string;
  /** True when barriers are only missing/unknown scaffolds (due diligence incomplete). */
  needsDd?: boolean;
};

export function GatePill({
  bidAllowed,
  hasGate,
  allowedLabel,
  blockedLabel,
  pendingLabel,
  needsDdLabel,
  needsDd = false,
}: Props) {
  if (!hasGate) {
    return <span className="pill warn">{pendingLabel}</span>;
  }
  if (bidAllowed) {
    return <span className="pill ok">{allowedLabel}</span>;
  }
  if (needsDd) {
    return <span className="pill warn">{needsDdLabel}</span>;
  }
  return <span className="pill bad">{blockedLabel}</span>;
}

export function gateNeedsDd(barriers: unknown): boolean {
  if (!Array.isArray(barriers) || barriers.length === 0) return true;
  return barriers.every((b) => {
    const code = typeof b === "object" && b && "code" in b ? String((b as { code: string }).code) : "";
    return (
      code.startsWith("debt_missing_") ||
      code.startsWith("debt_unknown_") ||
      code.startsWith("risk_missing_") ||
      code.startsWith("risk_unknown_") ||
      code === "mortgage_l2_missing" ||
      code === "mortgage_unreviewed"
    );
  });
}
