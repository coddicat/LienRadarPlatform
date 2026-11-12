import { prisma } from "@lienradar/db";
import { computeBidCeiling, computeBidGate } from "@lienradar/method";
import {
  AmountKind,
  DebtCategory,
  MortgageRankLevel,
  RiskResult,
} from "@lienradar/shared";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";

const DEBT_CATS = new Set(Object.values(DebtCategory));
const RISK_RESULTS = new Set(Object.values(RiskResult));

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  const lotId = String(body.lotId || "");
  if (!lotId) return NextResponse.json({ error: "lotId required" }, { status: 400 });

  const lot = await prisma.lot.findUnique({ where: { id: lotId } });
  if (!lot) return NextResponse.json({ error: "lot not found" }, { status: 404 });

  const evidence = String(body.evidenceNote || "Manual DD entry").slice(0, 2000);

  if (body.debtCategory && DEBT_CATS.has(body.debtCategory)) {
    const amount =
      body.amount === "" || body.amount == null || body.amount === undefined
        ? null
        : Number(body.amount);
    const amountKind =
      body.amountKind === AmountKind.EXACT_FROM_DOC || body.amountKind === AmountKind.ESTIMATED_SCENARIO
        ? body.amountKind
        : AmountKind.UNKNOWN;
    const searchScoped = Boolean(body.searchScoped) && amountKind !== AmountKind.UNKNOWN;
    const existing = await prisma.debtItem.findFirst({
      where: { lotId, category: body.debtCategory },
    });
    const data = {
      amount: amount != null && Number.isFinite(amount) ? amount.toFixed(2) : null,
      amountKind,
      searchScoped,
      evidenceNote: evidence,
      holder: body.holder ? String(body.holder).slice(0, 200) : null,
      documentUrl: body.documentUrl ? String(body.documentUrl).slice(0, 500) : null,
    };
    if (existing) await prisma.debtItem.update({ where: { id: existing.id }, data });
    else await prisma.debtItem.create({ data: { lotId, category: body.debtCategory, ...data } });
  }

  if (body.mortgageL2 === true || body.mortgageL2 === "1") {
    const existing = await prisma.mortgageAssessment.findFirst({ where: { lotId } });
    const data = {
      rankLevel: MortgageRankLevel.L2_PROVEN,
      lender: body.lender ? String(body.lender).slice(0, 200) : null,
      estimatedBalance:
        body.mortgageBalance != null && body.mortgageBalance !== ""
          ? Number(body.mortgageBalance).toFixed(2)
          : null,
      evidenceNote: evidence,
      satisfied: body.satisfied === true || body.satisfied === "1" ? true : body.satisfied === false ? false : null,
    };
    if (existing) await prisma.mortgageAssessment.update({ where: { id: existing.id }, data });
    else await prisma.mortgageAssessment.create({ data: { lotId, ...data } });
  }

  if (body.riskCode && body.riskResult && RISK_RESULTS.has(body.riskResult)) {
    await prisma.riskCheck.upsert({
      where: { lotId_code: { lotId, code: String(body.riskCode) } },
      update: {
        result: body.riskResult,
        blocksBid: body.riskResult === RiskResult.FAIL || body.riskResult === RiskResult.UNKNOWN,
        evidence,
        checkedAt: new Date(),
      },
      create: {
        lotId,
        code: String(body.riskCode),
        result: body.riskResult,
        blocksBid: body.riskResult === RiskResult.FAIL || body.riskResult === RiskResult.UNKNOWN,
        evidence,
      },
    });
  }

  const fresh = await prisma.lot.findUniqueOrThrow({
    where: { id: lotId },
    include: { debts: true, mortgages: true, risks: true },
  });
  const gate = computeBidGate({
    channel: fresh.channel,
    debts: fresh.debts.map((d) => ({
      category: d.category,
      amountKind: d.amountKind,
      searchScoped: d.searchScoped,
      amount: d.amount ? Number(d.amount) : null,
    })),
    mortgages: fresh.mortgages.map((m) => ({ rankLevel: m.rankLevel, satisfied: m.satisfied })),
    risks: fresh.risks.map((r) => ({ code: r.code, result: r.result, blocksBid: r.blocksBid })),
  });
  await prisma.bidGate.upsert({
    where: { lotId },
    update: {
      bidAllowed: gate.bidAllowed,
      fillScore: gate.fillScore,
      riskClosed: gate.riskClosed,
      barriers: gate.barriers as object[],
      methodVersion: gate.methodVersion,
      computedAt: new Date(),
    },
    create: {
      lotId,
      bidAllowed: gate.bidAllowed,
      fillScore: gate.fillScore,
      riskClosed: gate.riskClosed,
      barriers: gate.barriers as object[],
      methodVersion: gate.methodVersion,
    },
  });

  const ceiling = computeBidCeiling({
    assessedValue: fresh.assessedValue ? Number(fresh.assessedValue) : null,
    openingBid: fresh.openingBid ? Number(fresh.openingBid) : null,
    judgmentAmount: fresh.judgmentAmount ? Number(fresh.judgmentAmount) : null,
    knownDebts: fresh.debts
      .filter((d) => d.amountKind !== AmountKind.UNKNOWN && d.amount != null)
      .map((d) => Number(d.amount)),
  });
  await prisma.bidCeiling.upsert({
    where: { lotId },
    update: {
      ceilingAmount: ceiling.ceilingAmount != null ? String(ceiling.ceilingAmount) : null,
      paramsVersion: ceiling.paramsVersion,
      assumptions: ceiling.assumptions as object,
      computedAt: new Date(),
    },
    create: {
      lotId,
      ceilingAmount: ceiling.ceilingAmount != null ? String(ceiling.ceilingAmount) : null,
      paramsVersion: ceiling.paramsVersion,
      assumptions: ceiling.assumptions as object,
    },
  });

  await prisma.lotEvent.create({
    data: {
      lotId,
      kind: "manual_dd",
      message: `Manual DD by ${session?.user?.email ?? userId}`,
      payload: { body: { ...body, evidenceNote: evidence } },
    },
  });

  return NextResponse.json({
    ok: true,
    bidAllowed: gate.bidAllowed,
    fillScore: gate.fillScore,
    barriers: gate.barriers,
  });
}
