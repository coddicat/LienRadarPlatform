import { Prisma, prisma } from "@lienradar/db";
import {
  computeBidCeiling,
  computeBidGate,
  DEFAULT_METHOD_SETTINGS,
  normalizeMethodSettings,
  type MethodSettings,
} from "@lienradar/method";
import { AmountKind } from "@lienradar/shared";
import { gateNeedsDd } from "@/components/GatePill";
import { dealValue, num } from "@/lib/dealMetrics";

export { DEFAULT_METHOD_SETTINGS, normalizeMethodSettings, type MethodSettings };

export async function getUserMethodSettings(userId: string | null | undefined): Promise<MethodSettings> {
  if (!userId) return structuredClone(DEFAULT_METHOD_SETTINGS);
  const row = await prisma.userMethodSettings.findUnique({ where: { userId } });
  if (!row) return structuredClone(DEFAULT_METHOD_SETTINGS);
  return normalizeMethodSettings({
    ceiling: row.ceiling,
    decisions: row.decisions,
    opportunity: row.opportunity,
  });
}

export async function saveUserMethodSettings(
  userId: string,
  settings: MethodSettings,
): Promise<MethodSettings> {
  const normalized = normalizeMethodSettings(settings);
  await prisma.userMethodSettings.upsert({
    where: { userId },
    create: {
      userId,
      ceiling: normalized.ceiling as Prisma.InputJsonValue,
      decisions: normalized.decisions as Prisma.InputJsonValue,
      opportunity: normalized.opportunity as Prisma.InputJsonValue,
    },
    update: {
      ceiling: normalized.ceiling as Prisma.InputJsonValue,
      decisions: normalized.decisions as Prisma.InputJsonValue,
      opportunity: normalized.opportunity as Prisma.InputJsonValue,
    },
  });
  return normalized;
}

export type LotMethodInputs = {
  channel: string;
  openingBid?: unknown;
  judgmentAmount?: unknown;
  assessedValue?: unknown;
  marketValue?: unknown;
  property?: { assessedValue?: unknown; marketValue?: unknown } | null;
  debts: Array<{
    category: string;
    amountKind: string;
    searchScoped: boolean;
    amount?: unknown;
  }>;
  mortgages: Array<{ rankLevel: string; satisfied?: boolean | null }>;
  risks: Array<{ code: string; result: string; blocksBid: boolean }>;
};

export type AppliedMethod = {
  bidAllowed: boolean;
  needsDd: boolean;
  fillScore: number;
  riskClosed: boolean;
  barriers: Array<{ code: string; message: string; severity: string }>;
  ceiling: number | null;
  ceilingParamsVersion: string;
  ceilingAssumptions: Record<string, unknown>;
  hotDiscountPct: number;
  methodVersion: string;
};

export function applyMethodToLot(lot: LotMethodInputs, settings: MethodSettings): AppliedMethod {
  const gate = computeBidGate(
    {
      channel: lot.channel,
      debts: lot.debts.map((d) => ({
        category: d.category,
        amountKind: d.amountKind,
        searchScoped: d.searchScoped,
        amount: d.amount != null ? Number(d.amount) : null,
      })),
      mortgages: lot.mortgages.map((m) => ({
        rankLevel: m.rankLevel,
        satisfied: m.satisfied,
      })),
      risks: lot.risks.map((r) => ({
        code: r.code,
        result: r.result,
        blocksBid: r.blocksBid,
      })),
    },
    settings.decisions,
  );

  const knownDebts = lot.debts
    .filter((d) => d.amountKind !== AmountKind.UNKNOWN && d.amount != null)
    .map((d) => Number(d.amount));

  const ceiling = computeBidCeiling(
    {
      assessedValue: dealValue(lot),
      openingBid: num(lot.openingBid),
      judgmentAmount: num(lot.judgmentAmount),
      knownDebts,
    },
    settings.ceiling,
  );

  return {
    bidAllowed: gate.bidAllowed,
    needsDd: !gate.bidAllowed && gateNeedsDd(gate.barriers),
    fillScore: gate.fillScore,
    riskClosed: gate.riskClosed,
    barriers: gate.barriers,
    ceiling: ceiling.ceilingAmount,
    ceilingParamsVersion: ceiling.paramsVersion,
    ceilingAssumptions: ceiling.assumptions,
    hotDiscountPct: settings.opportunity.hotDiscountPct,
    methodVersion: gate.methodVersion,
  };
}
