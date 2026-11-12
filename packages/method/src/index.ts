import {
  AmountKind,
  AuctionChannel,
  BidBarrier,
  BidGateResult,
  DebtCategory,
  MortgageRankLevel,
  REQUIRED_DEBT_CATEGORIES,
  REQUIRED_RISK_CODES,
  RiskResult,
} from "@lienradar/shared";
import {
  DEFAULT_METHOD_SETTINGS,
  type BarrierSeverity,
  type CeilingSettings,
  type DecisionSettings,
  type MethodSettings,
  normalizeMethodSettings,
} from "./settings.js";

export const METHOD_VERSION = "2026.11.11-southfl-v1";
export const CEILING_PARAMS_VERSION = "user-settings-v1";

export {
  DEFAULT_METHOD_SETTINGS,
  normalizeMethodSettings,
  type BarrierSeverity,
  type CeilingSettings,
  type DecisionSettings,
  type MethodSettings,
  type MortgageL2Policy,
  type OpportunitySettings,
} from "./settings.js";

export {
  applyStatusGuard,
  decideFinalBid,
  floridaToday,
  foreignOpeningSuspect,
  type FinalBidDecision,
  type FinalBidPrev,
  type FinalBidReason,
  type SourceAuthority,
  type StatusGuardResult,
} from "./finalBidGuard.js";

export {
  classifyOutcomeReason,
  isExplicitFailedSaleReason,
  KNOWN_OUTCOME_TEXTS,
  type OutcomeCategory,
  type OutcomeDisposition,
  type OutcomeReason,
} from "./outcomeReason.js";

export type DebtInput = {
  category: DebtCategory | string;
  amountKind: AmountKind | string;
  searchScoped: boolean;
  amount?: number | null;
};

export type MortgageInput = {
  rankLevel: MortgageRankLevel | string;
  satisfied?: boolean | null;
};

export type RiskInput = {
  code: string;
  result: RiskResult | string;
  blocksBid: boolean;
};

function pushBarrier(
  barriers: BidBarrier[],
  severity: BarrierSeverity,
  code: string,
  message: string,
) {
  if (severity === "ignore") return;
  barriers.push({ code, message, severity });
}

/**
 * Honest bid gate: UNKNOWN required inputs block bidding by default.
 * Never treat unscoped municipal/HOA absence as verified zero.
 * Decision severity can be overridden via MethodSettings.
 */
export function computeBidGate(
  input: {
    channel: AuctionChannel | string;
    debts: DebtInput[];
    mortgages: MortgageInput[];
    risks: RiskInput[];
  },
  decisionParams?: Partial<DecisionSettings> | DecisionSettings,
): BidGateResult {
  const decisions = normalizeMethodSettings({
    ...DEFAULT_METHOD_SETTINGS,
    decisions: { ...DEFAULT_METHOD_SETTINGS.decisions, ...decisionParams },
  }).decisions;

  const barriers: BidBarrier[] = [];
  const debtsByCat = new Map(input.debts.map((d) => [d.category, d]));

  let filled = 0;
  let fillTotal = REQUIRED_DEBT_CATEGORIES.length + REQUIRED_RISK_CODES.length + 1;

  for (const cat of REQUIRED_DEBT_CATEGORIES) {
    const row = debtsByCat.get(cat);
    const severity = decisions.debtUnknown[cat] ?? "block";
    if (!row) {
      pushBarrier(
        barriers,
        severity,
        `debt_missing_${cat}`,
        `Required debt category ${cat} has no row — UNKNOWN, not zero`,
      );
      continue;
    }
    if (row.amountKind === AmountKind.UNKNOWN || !row.searchScoped) {
      pushBarrier(
        barriers,
        severity,
        `debt_unknown_${cat}`,
        severity === "warn"
          ? `${cat} incomplete — Manual DD required (not treated as $0)`
          : `${cat} not search-scoped or amountKind=UNKNOWN (anti false-zero)`,
      );
      continue;
    }
    filled += 1;
  }

  const hasL2 = input.mortgages.some((m) => m.rankLevel === MortgageRankLevel.L2_PROVEN);
  const hasL1 = input.mortgages.length > 0;
  if (input.channel === AuctionChannel.FORECLOSURE || input.channel === AuctionChannel.BANK_REO) {
    if (hasL2) {
      filled += 1;
    } else if (decisions.mortgageL2 === "ignore") {
      filled += 1;
    } else if (hasL1 && decisions.mortgageL2 === "warn_if_l1") {
      pushBarrier(
        barriers,
        "warn",
        "mortgage_l2_missing",
        "First mortgage is L1 only — L2 needs Official Records instrument proof or Manual DD",
      );
      filled += 0.5;
    } else if (hasL1 && decisions.mortgageL2 === "block") {
      pushBarrier(
        barriers,
        "block",
        "mortgage_l2_missing",
        "First mortgage not L2-proven — L1 estimate is not sufficient to clear bid gate",
      );
    } else {
      pushBarrier(
        barriers,
        decisions.mortgageL2 === "warn_if_l1" ? "warn" : "block",
        "mortgage_l2_missing",
        "No mortgage assessment yet — L1/L2 not evaluated",
      );
    }
  } else if (input.channel === AuctionChannel.TAX_DEED) {
    if (!hasL1 && !hasL2) {
      pushBarrier(
        barriers,
        "block",
        "mortgage_unreviewed",
        "Tax deed lot has no mortgage assessment — surviving liens may remain",
      );
    } else {
      filled += 1;
    }
  } else {
    filled += 1;
  }

  const riskMap = new Map(input.risks.map((r) => [r.code, r]));
  let riskClosed = true;
  for (const code of REQUIRED_RISK_CODES) {
    const row = riskMap.get(code);
    if (!row) {
      riskClosed = false;
      pushBarrier(barriers, "block", `risk_missing_${code}`, `Required risk ${code} not evaluated`);
      continue;
    }
    if (row.result === RiskResult.UNKNOWN && row.blocksBid) {
      const severity = decisions.riskUnknown[code] ?? "block";
      if (severity === "block") riskClosed = false;
      pushBarrier(
        barriers,
        severity,
        `risk_unknown_${code}`,
        severity === "warn"
          ? `Risk ${code} incomplete — Manual DD required`
          : `Risk ${code} is UNKNOWN and blocks bidding`,
      );
      continue;
    }
    if (row.result === RiskResult.FAIL && row.blocksBid) {
      riskClosed = false;
      pushBarrier(barriers, "block", `risk_fail_${code}`, `Risk ${code} failed`);
      continue;
    }
    filled += 1;
  }

  if (input.channel === AuctionChannel.BANK_REO) {
    pushBarrier(
      barriers,
      "warn",
      "reo_source_review",
      "BANK_REO requires an enabled live marketplace feed; verify source provenance before bidding",
    );
  }

  const blockBarriers = barriers.filter((b) => b.severity === "block");
  const fillScore = Math.max(0, Math.min(1, filled / fillTotal));

  return {
    bidAllowed: blockBarriers.length === 0,
    fillScore: Number(fillScore.toFixed(3)),
    riskClosed,
    barriers,
    methodVersion: METHOD_VERSION,
  };
}

export function computeBidCeiling(
  input: {
    assessedValue?: number | null;
    openingBid?: number | null;
    judgmentAmount?: number | null;
    knownDebts?: number[];
  },
  ceilingParams?: Partial<CeilingSettings> | CeilingSettings,
): {
  ceilingAmount: number | null;
  paramsVersion: string;
  assumptions: Record<string, unknown>;
} {
  const ceiling = normalizeMethodSettings({
    ...DEFAULT_METHOD_SETTINGS,
    ceiling: { ...DEFAULT_METHOD_SETTINGS.ceiling, ...ceilingParams },
  }).ceiling;

  const assessed = input.assessedValue ?? null;
  const knownDebtSum = (input.knownDebts ?? []).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const { repairReservePct, profitPct, ownerHaircut } = ceiling;

  if (assessed == null || assessed <= 0) {
    return {
      ceilingAmount: null,
      paramsVersion: CEILING_PARAMS_VERSION,
      assumptions: {
        note: "No assessed value — ceiling not computed",
        repairReservePct,
        profitPct,
        ownerHaircut,
        marked: "ASSUMPTION",
      },
    };
  }

  const afterReserves = assessed * (1 - repairReservePct - profitPct);
  const amount = Math.max(0, afterReserves * ownerHaircut - knownDebtSum);

  return {
    ceilingAmount: Math.round(amount),
    paramsVersion: CEILING_PARAMS_VERSION,
    assumptions: {
      assessedValue: assessed,
      openingBid: input.openingBid,
      judgmentAmount: input.judgmentAmount,
      knownDebtSum,
      repairReservePct,
      profitPct,
      ownerHaircut,
      marked: "ASSUMPTION — not owner-confirmed underwriting params (O02)",
      formula: "assessed*(1-repair-profit)*ownerHaircut - knownDebts",
    },
  };
}

export function markLayersStaleReason(reason: string) {
  return { status: "STALE" as const, reason, at: new Date().toISOString() };
}
