import { Prisma, prisma } from "@lienradar/db";
import { AuctionChannel, MortgageRankLevel } from "@lienradar/shared";
import { syncMortgageDebtRow } from "./syncMortgageDebt.js";

/**
 * Free L1 mortgage path for foreclosure/REO when Official Records L2 is unavailable:
 * use published judgment / opening bid + plaintiff already on the lot card.
 * NEVER claims payoff — ESTIMATED_SCENARIO only; does not overwrite L2_PROVEN.
 */
export async function applyJudgmentMortgageEstimate(lotId: string): Promise<{
  wrote: boolean;
  reason: string;
}> {
  const lot = await prisma.lot.findUnique({
    where: { id: lotId },
    include: { mortgages: true },
  });
  if (!lot) return { wrote: false, reason: "lot_missing" };

  if (lot.channel !== AuctionChannel.FORECLOSURE && lot.channel !== AuctionChannel.BANK_REO) {
    return { wrote: false, reason: "channel_not_fc" };
  }

  const hasL2 = lot.mortgages.some((m) => m.rankLevel === MortgageRankLevel.L2_PROVEN);
  if (hasL2) return { wrote: false, reason: "has_l2" };

  const existingL1 = lot.mortgages.find((m) => m.rankLevel === MortgageRankLevel.L1_ESTIMATE);
  if (existingL1?.estimatedBalance != null) {
    await syncMortgageDebtRow(lotId, {
      lender: existingL1.lender,
      estimatedBalance: String(existingL1.estimatedBalance),
      evidenceNote: existingL1.evidenceNote ?? "Existing L1 mortgage estimate",
      rankLevel: existingL1.rankLevel,
    });
    return { wrote: false, reason: "already_has_l1_balance" };
  }

  const judgment = lot.judgmentAmount != null ? Number(lot.judgmentAmount) : null;
  const opening = lot.openingBid != null ? Number(lot.openingBid) : null;
  const balance =
    judgment != null && judgment > 0 ? judgment : opening != null && opening > 0 ? opening : null;
  if (balance == null) return { wrote: false, reason: "no_judgment_or_opening" };

  const basis = judgment != null && judgment > 0 ? "judgmentAmount" : "openingBid";
  const lender = lot.plaintiff?.trim() || null;
  const evidenceNote =
    `L1 from published ${basis}=$${balance.toLocaleString("en-US")}` +
    `${lender ? ` · plaintiff ${lender}` : ""}` +
    ` — estimate as of auction card, NOT a payoff / L2 instrument proof`;

  if (existingL1) {
    await prisma.mortgageAssessment.update({
      where: { id: existingL1.id },
      data: {
        lender,
        estimatedBalance: balance,
        evidenceNote,
        rankLevel: MortgageRankLevel.L1_ESTIMATE,
      },
    });
  } else {
    await prisma.mortgageAssessment.create({
      data: {
        lotId,
        rankLevel: MortgageRankLevel.L1_ESTIMATE,
        lender,
        estimatedBalance: balance,
        evidenceNote,
      },
    });
  }

  await syncMortgageDebtRow(lotId, {
    lender,
    estimatedBalance: String(balance),
    evidenceNote,
    rankLevel: MortgageRankLevel.L1_ESTIMATE,
  });

  await prisma.enrichmentLayer.upsert({
    where: { lotId_name: { lotId, name: "mortgage_judgment_l1" } },
    update: {
      status: "OK",
      payload: {
        basis,
        balance,
        lender,
        isPayoff: false,
        rankLevel: MortgageRankLevel.L1_ESTIMATE,
        evidenceNote,
      } as Prisma.InputJsonValue,
      fetchedAt: new Date(),
      error: null,
    },
    create: {
      lotId,
      name: "mortgage_judgment_l1",
      status: "OK",
      payload: {
        basis,
        balance,
        lender,
        isPayoff: false,
        rankLevel: MortgageRankLevel.L1_ESTIMATE,
        evidenceNote,
      } as Prisma.InputJsonValue,
    },
  });

  return { wrote: true, reason: "wrote_l1" };
}

export async function runJudgmentMortgageEnrichment(limit = 200) {
  const lots = await prisma.lot.findMany({
    where: {
      channel: { in: [AuctionChannel.FORECLOSURE, AuctionChannel.BANK_REO] },
      OR: [{ judgmentAmount: { not: null } }, { openingBid: { not: null } }],
    },
    select: { id: true },
    take: limit,
    orderBy: { saleDate: "asc" },
  });
  let wrote = 0;
  let skipped = 0;
  for (const lot of lots) {
    const r = await applyJudgmentMortgageEstimate(lot.id);
    if (r.wrote) wrote += 1;
    else skipped += 1;
  }
  return { candidates: lots.length, wrote, skipped };
}
