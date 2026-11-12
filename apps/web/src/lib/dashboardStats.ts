import { CacheKeys, CacheTtl, cacheGetJson, cacheSetJson } from "@lienradar/cache";
import { prisma } from "@lienradar/db";
import { AuctionChannel, AuctionStatus, deriveTimeBucket } from "@lienradar/shared";
import { dealValue, discountPct, num } from "@/lib/dealMetrics";
import { floridaTodayUtcDate } from "@/lib/floridaDate";
import { applyMethodToLot, getUserMethodSettings } from "@/lib/methodSettings";

export type DashboardStats = {
  buckets: { FUTURE: number; CURRENT: number; PAST: number };
  channels: { TAX_DEED: number; FORECLOSURE: number; BANK_REO: number };
  readyToBid: number;
  needsReview: number;
  doNotBid: number;
  discountOpps: number;
  deals: number;
  cache: "hit" | "miss" | "bypass";
};

export async function loadDashboardStats(userId?: string | null): Promise<DashboardStats> {
  const settings = await getUserMethodSettings(userId);
  const cacheKey = `${CacheKeys.dashStats}:${userId ?? "anon"}:${settings.opportunity.hotDiscountPct}:${JSON.stringify(settings.decisions)}`;
  const cached = await cacheGetJson<Omit<DashboardStats, "cache">>(cacheKey);
  if (cached) return { ...cached, cache: "hit" };

  const today = floridaTodayUtcDate();
  const [future, current, past, taxDeed, foreclosure, bankReo, deals, methodLots] = await Promise.all([
    prisma.lot.count({ where: { saleDate: { gt: today } } }),
    prisma.lot.count({ where: { saleDate: today } }),
    prisma.lot.count({ where: { saleDate: { lt: today } } }),
    prisma.lot.count({ where: { channel: AuctionChannel.TAX_DEED } }),
    prisma.lot.count({ where: { channel: AuctionChannel.FORECLOSURE } }),
    prisma.lot.count({ where: { channel: AuctionChannel.BANK_REO } }),
    prisma.deal.count(),
    prisma.lot.findMany({
      where: { saleDate: { gte: today } },
      select: {
        channel: true,
        status: true,
        saleDate: true,
        openingBid: true,
        judgmentAmount: true,
        assessedValue: true,
        marketValue: true,
        property: { select: { assessedValue: true, marketValue: true } },
        debts: {
          select: { category: true, amountKind: true, searchScoped: true, amount: true },
        },
        mortgages: { select: { rankLevel: true, satisfied: true } },
        risks: { select: { code: true, result: true, blocksBid: true } },
      },
      take: 5000,
    }),
  ]);

  const now = new Date();
  let readyToBid = 0;
  let needsReview = 0;
  let doNotBid = 0;
  let discountOpps = 0;
  const hot = settings.opportunity.hotDiscountPct;

  for (const lot of methodLots) {
    const tb = deriveTimeBucket(lot.saleDate, lot.status as AuctionStatus, now);
    if (tb === "PAST") continue;
    const method = applyMethodToLot(lot, settings);
    if (method.bidAllowed) readyToBid += 1;
    else if (method.needsDd) needsReview += 1;
    else doNotBid += 1;

    const d = discountPct(num(lot.openingBid), dealValue(lot));
    if (d != null && d >= hot) discountOpps += 1;
  }

  const stats: Omit<DashboardStats, "cache"> = {
    buckets: { FUTURE: future, CURRENT: current, PAST: past },
    channels: { TAX_DEED: taxDeed, FORECLOSURE: foreclosure, BANK_REO: bankReo },
    readyToBid,
    needsReview,
    doNotBid,
    discountOpps,
    deals,
  };
  await cacheSetJson(cacheKey, stats, CacheTtl.dashStatsSec);
  return { ...stats, cache: "miss" };
}
