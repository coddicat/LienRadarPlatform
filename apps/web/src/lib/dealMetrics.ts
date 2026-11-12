/** Partner-facing deal metrics from opening vs assessed/market. */
export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function dealValue(lot: {
  assessedValue?: unknown;
  marketValue?: unknown;
  property?: { assessedValue?: unknown; marketValue?: unknown } | null;
}): number | null {
  return (
    num(lot.marketValue) ??
    num(lot.property?.marketValue) ??
    num(lot.assessedValue) ??
    num(lot.property?.assessedValue)
  );
}

/** How far below value the opening bid sits (positive = discount). */
export function discountPct(opening: number | null, value: number | null): number | null {
  if (opening == null || value == null || value <= 0) return null;
  return (value - opening) / value;
}

export function spreadUsd(opening: number | null, value: number | null): number | null {
  if (opening == null || value == null) return null;
  return value - opening;
}
