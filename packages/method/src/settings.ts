import { DebtCategory } from "@lienradar/shared";

export type BarrierSeverity = "block" | "warn" | "ignore";

export type MortgageL2Policy = "block" | "warn_if_l1" | "ignore";

export type CeilingSettings = {
  repairReservePct: number;
  profitPct: number;
  ownerHaircut: number;
};

export type DecisionSettings = {
  /** Severity when debt category is missing/unknown. */
  debtUnknown: Partial<Record<string, BarrierSeverity>>;
  /** Severity when risk is UNKNOWN (and would otherwise block). */
  riskUnknown: Partial<Record<string, BarrierSeverity>>;
  /** Foreclosure/REO policy when L2 mortgage proof is missing. */
  mortgageL2: MortgageL2Policy;
};

export type OpportunitySettings = {
  /** Discount fraction that counts as a “hot” opportunity (e.g. 0.2 = 20%). */
  hotDiscountPct: number;
};

export type MethodSettings = {
  ceiling: CeilingSettings;
  decisions: DecisionSettings;
  opportunity: OpportunitySettings;
};

export const DEFAULT_METHOD_SETTINGS: MethodSettings = {
  ceiling: {
    repairReservePct: 0.15,
    profitPct: 0.2,
    ownerHaircut: 0.7,
  },
  decisions: {
    debtUnknown: {
      [DebtCategory.HOA]: "warn",
      [DebtCategory.UTILITY]: "warn",
      [DebtCategory.TAX]: "block",
      [DebtCategory.MUNI_CODE]: "block",
      [DebtCategory.MORTGAGE]: "block",
    },
    riskUnknown: {
      federal_lien: "warn",
      title_insurability: "warn",
      occupancy: "warn",
      bankruptcy: "block",
      redemption: "block",
      flood: "block",
    },
    mortgageL2: "warn_if_l1",
  },
  opportunity: {
    hotDiscountPct: 0.2,
  },
};

function clampPct(n: unknown, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(0.95, v));
}

function asSeverity(v: unknown, fallback: BarrierSeverity): BarrierSeverity {
  if (v === "block" || v === "warn" || v === "ignore") return v;
  return fallback;
}

/** Merge partial/DB JSON into full MethodSettings with defaults. */
export function normalizeMethodSettings(raw: unknown): MethodSettings {
  const base = DEFAULT_METHOD_SETTINGS;
  if (!raw || typeof raw !== "object") return structuredClone(base);
  const obj = raw as Partial<MethodSettings> & Record<string, unknown>;

  const ceilingIn = (obj.ceiling ?? {}) as Partial<CeilingSettings>;
  const decisionsIn = (obj.decisions ?? {}) as Partial<DecisionSettings>;
  const opportunityIn = (obj.opportunity ?? {}) as Partial<OpportunitySettings>;

  const debtUnknown: DecisionSettings["debtUnknown"] = {
    ...base.decisions.debtUnknown,
  };
  if (decisionsIn.debtUnknown && typeof decisionsIn.debtUnknown === "object") {
    for (const [k, v] of Object.entries(decisionsIn.debtUnknown)) {
      debtUnknown[k] = asSeverity(v, debtUnknown[k] ?? "block");
    }
  }

  const riskUnknown: DecisionSettings["riskUnknown"] = {
    ...base.decisions.riskUnknown,
  };
  if (decisionsIn.riskUnknown && typeof decisionsIn.riskUnknown === "object") {
    for (const [k, v] of Object.entries(decisionsIn.riskUnknown)) {
      riskUnknown[k] = asSeverity(v, riskUnknown[k] ?? "block");
    }
  }

  const mortgageL2Raw = decisionsIn.mortgageL2;
  const mortgageL2: MortgageL2Policy =
    mortgageL2Raw === "block" || mortgageL2Raw === "warn_if_l1" || mortgageL2Raw === "ignore"
      ? mortgageL2Raw
      : base.decisions.mortgageL2;

  return {
    ceiling: {
      repairReservePct: clampPct(ceilingIn.repairReservePct, base.ceiling.repairReservePct),
      profitPct: clampPct(ceilingIn.profitPct, base.ceiling.profitPct),
      ownerHaircut: clampPct(ceilingIn.ownerHaircut, base.ceiling.ownerHaircut),
    },
    decisions: {
      debtUnknown,
      riskUnknown,
      mortgageL2,
    },
    opportunity: {
      hotDiscountPct: clampPct(opportunityIn.hotDiscountPct, base.opportunity.hotDiscountPct),
    },
  };
}
