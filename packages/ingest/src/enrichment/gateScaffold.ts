import { prisma } from "@lienradar/db";
import {
  AmountKind,
  DebtCategory,
  REQUIRED_DEBT_CATEGORIES,
  REQUIRED_RISK_CODES,
  RiskResult,
} from "@lienradar/shared";

/**
 * Ensure every lot has required debt/risk rows as UNKNOWN / not search-scoped.
 * Never invents verified zeros — only scaffolds so BidGate can evaluate honestly.
 */
export async function ensureGateScaffold(lotId: string) {
  const existingDebts = await prisma.debtItem.findMany({
    where: { lotId },
    select: { category: true },
  });
  const haveDebt = new Set(existingDebts.map((d) => d.category));

  for (const category of REQUIRED_DEBT_CATEGORIES) {
    if (haveDebt.has(category)) continue;
    await prisma.debtItem.create({
      data: {
        lotId,
        category,
        amount: null,
        amountKind: AmountKind.UNKNOWN,
        searchScoped: false,
        evidenceNote: "Scaffold — not searched yet (unknown ≠ zero)",
      },
    });
  }

  const existingRisks = await prisma.riskCheck.findMany({
    where: { lotId },
    select: { code: true },
  });
  const haveRisk = new Set(existingRisks.map((r) => r.code));

  for (const code of REQUIRED_RISK_CODES) {
    if (haveRisk.has(code)) continue;
    await prisma.riskCheck.create({
      data: {
        lotId,
        code,
        result: RiskResult.UNKNOWN,
        blocksBid: true,
        evidence: "Scaffold — risk not evaluated yet",
      },
    });
  }
}

export async function ensureGateScaffoldMany(lotIds: string[]) {
  for (const id of lotIds) {
    await ensureGateScaffold(id);
  }
}
