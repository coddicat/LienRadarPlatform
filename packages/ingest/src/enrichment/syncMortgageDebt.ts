import { AmountKind, DebtCategory, MortgageRankLevel } from "@lienradar/shared";
import { prisma } from "@lienradar/db";

/** Keep DebtItem.MORTGAGE in sync with MortgageAssessment so BidGate can clear debt_unknown_MORTGAGE. */
export async function syncMortgageDebtRow(
  lotId: string,
  opts: {
    lender?: string | null;
    estimatedBalance?: string | null;
    evidenceNote: string;
    rankLevel?: string;
  },
) {
  const isL2 = opts.rankLevel === MortgageRankLevel.L2_PROVEN;
  const data = {
    amount: opts.estimatedBalance ?? null,
    amountKind: isL2 ? AmountKind.EXACT_FROM_DOC : AmountKind.ESTIMATED_SCENARIO,
    searchScoped: true,
    holder: opts.lender ?? null,
    evidenceNote: opts.evidenceNote,
  };
  const existing = await prisma.debtItem.findFirst({
    where: { lotId, category: DebtCategory.MORTGAGE },
  });
  if (existing) {
    await prisma.debtItem.update({ where: { id: existing.id }, data });
  } else {
    await prisma.debtItem.create({
      data: { lotId, category: DebtCategory.MORTGAGE, ...data },
    });
  }
}

export async function syncMortgageDebtFromAssessments(lotId: string) {
  const m = await prisma.mortgageAssessment.findFirst({
    where: { lotId },
    orderBy: { updatedAt: "desc" },
  });
  if (!m) return false;
  await syncMortgageDebtRow(lotId, {
    lender: m.lender,
    estimatedBalance: m.estimatedBalance != null ? String(m.estimatedBalance) : null,
    evidenceNote:
      m.evidenceNote ??
      (m.rankLevel === MortgageRankLevel.L2_PROVEN
        ? "L2 mortgage assessment"
        : "L1 mortgage estimate — not L2-proven"),
    rankLevel: m.rankLevel,
  });
  return true;
}
