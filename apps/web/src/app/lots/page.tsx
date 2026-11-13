import { Prisma, prisma } from "@lienradar/db";
import {
  AuctionChannel,
  AuctionStatus,
  FLORIDA_COUNTY_SET,
  TimeBucket,
  deriveTimeBucket,
  floridaDateISO,
} from "@lienradar/shared";
import { getServerSession } from "next-auth";
import Link from "next/link";
import { LotsExplorer, type LotListItem } from "@/components/LotsExplorer";
import { LotsFilters } from "@/components/LotsFilters";
import { Shell } from "@/components/Shell";
import { authOptions } from "@/lib/auth";
import { dealValue, discountPct, num, spreadUsd } from "@/lib/dealMetrics";
import { loadDashboardStats } from "@/lib/dashboardStats";
import { floridaTodayUtcDate } from "@/lib/floridaDate";
import { getI18n } from "@/lib/i18n";
import { applyMethodToLot, getUserMethodSettings } from "@/lib/methodSettings";

function daysUntilCivil(saleIso: string, todayCivil: string): number {
  const sale = saleIso.slice(0, 10);
  const a = Date.parse(`${sale}T12:00:00.000Z`);
  const b = Date.parse(`${todayCivil}T12:00:00.000Z`);
  return Math.round((a - b) / 86_400_000);
}

export const dynamic = "force-dynamic";

const PAGE_SIZE = 75;
const ALL_CHANNELS = new Set(Object.values(AuctionChannel));
const ALL_STATUSES = new Set(Object.values(AuctionStatus));
const ALL_BUCKETS = new Set(Object.values(TimeBucket));
const ALL_GATES = new Set(["allowed", "blocked", "pending"]);
const ALL_OPPS = new Set(["discount", "ready"]);

function parseList(
  sp: Record<string, string | string[] | undefined>,
  key: string,
  allowed: Set<string>,
): string[] {
  const raw = sp[key];
  const parts = Array.isArray(raw)
    ? raw.flatMap((v) => v.split(","))
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const out: string[] = [];
  for (const p of parts) {
    const v = p.trim();
    if (v && allowed.has(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** County slugs: known Florida list, or safe lowercase slug for future counties. */
function parseCountyList(sp: Record<string, string | string[] | undefined>): string[] {
  const raw = sp.county;
  const parts = Array.isArray(raw)
    ? raw.flatMap((v) => v.split(","))
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const out: string[] = [];
  for (const p of parts) {
    const v = p.trim().toLowerCase();
    if (!v || out.includes(v)) continue;
    if (FLORIDA_COUNTY_SET.has(v) || /^[a-z][a-z0-9-]{1,40}$/.test(v)) out.push(v);
  }
  return out;
}

function andPush(where: Prisma.LotWhereInput, clause: Prisma.LotWhereInput) {
  where.AND = [
    ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
    clause,
  ];
}

export default async function LotsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const methodSettings = await getUserMethodSettings(userId);
  const hotDiscountPct = methodSettings.opportunity.hotDiscountPct;
  const { t } = await getI18n();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const county = parseCountyList(sp);
  const channel = parseList(sp, "channel", ALL_CHANNELS);
  const bucket = parseList(sp, "bucket", ALL_BUCKETS);
  const gate = parseList(sp, "gate", ALL_GATES);
  const status = parseList(sp, "status", ALL_STATUSES);
  const opportunity = parseList(sp, "opportunity", ALL_OPPS);
  const page = Math.max(1, Number(typeof sp.page === "string" ? sp.page : "1") || 1);

  const today = floridaTodayUtcDate();
  const where: Prisma.LotWhereInput = {};

  if (county.length === 1) where.county = county[0];
  else if (county.length > 1) where.county = { in: county };

  if (status.length === 1) where.status = status[0] as AuctionStatus;
  else if (status.length > 1) where.status = { in: status as AuctionStatus[] };

  if (channel.length === 1) where.channel = channel[0] as AuctionChannel;
  else if (channel.length > 1) where.channel = { in: channel as AuctionChannel[] };

  if (bucket.length === 1) {
    if (bucket[0] === TimeBucket.FUTURE) where.saleDate = { gt: today };
    else if (bucket[0] === TimeBucket.CURRENT) where.saleDate = today;
    else if (bucket[0] === TimeBucket.PAST) where.saleDate = { lt: today };
  } else if (bucket.length > 1) {
    const ors: Prisma.LotWhereInput[] = [];
    if (bucket.includes(TimeBucket.FUTURE)) ors.push({ saleDate: { gt: today } });
    if (bucket.includes(TimeBucket.CURRENT)) ors.push({ saleDate: today });
    if (bucket.includes(TimeBucket.PAST)) ors.push({ saleDate: { lt: today } });
    if (ors.length) andPush(where, { OR: ors });
  }

  // Gate/ready filters are applied in-memory after per-user method recompute.

  if (q) {
    andPush(where, {
      OR: [
        { caseNumber: { contains: q, mode: "insensitive" } },
        { folio: { contains: q, mode: "insensitive" } },
        { propertyAddress: { contains: q, mode: "insensitive" } },
        { plaintiff: { contains: q, mode: "insensitive" } },
        { property: { is: { addressLine: { contains: q, mode: "insensitive" } } } },
      ],
    });
  }

  const wantReady = opportunity.includes("ready");
  const wantDiscount = opportunity.includes("discount");
  if (wantReady || wantDiscount) {
    if (!bucket.length) where.saleDate = { gte: today };
  }
  if (wantDiscount) {
    andPush(where, {
      openingBid: { not: null },
      OR: [
        { assessedValue: { not: null } },
        { marketValue: { not: null } },
        { property: { is: { OR: [{ assessedValue: { not: null } }, { marketValue: { not: null } }] } } },
      ],
    });
  }

  // Gate filters use stored BidGate so pagination stays correct; per-user method still
  // recomputed for display. "pending" ≈ no gate row or fill incomplete.
  const postFilterNeeded = gate.length > 0 || wantReady || wantDiscount;
  if (gate.length === 1 && gate[0] === "allowed") {
    andPush(where, { bidGate: { is: { bidAllowed: true } } });
  } else if (gate.length === 1 && gate[0] === "blocked") {
    andPush(where, { bidGate: { is: { bidAllowed: false, riskClosed: true } } });
  } else if (gate.length === 1 && gate[0] === "pending") {
    andPush(where, {
      OR: [{ bidGate: { is: null } }, { bidGate: { is: { bidAllowed: false, riskClosed: false } } }],
    });
  } else if (gate.length > 1) {
    const ors: Prisma.LotWhereInput[] = [];
    if (gate.includes("allowed")) ors.push({ bidGate: { is: { bidAllowed: true } } });
    if (gate.includes("blocked")) ors.push({ bidGate: { is: { bidAllowed: false, riskClosed: true } } });
    if (gate.includes("pending")) {
      ors.push({ bidGate: { is: null } });
      ors.push({ bidGate: { is: { bidAllowed: false, riskClosed: false } } });
    }
    if (ors.length) andPush(where, { OR: ors });
  }
  if (wantReady && !wantDiscount) {
    andPush(where, { bidGate: { is: { bidAllowed: true } } });
  }

  const fetchTake = postFilterNeeded && wantDiscount ? PAGE_SIZE * 4 : PAGE_SIZE;
  const fetchSkip = postFilterNeeded && wantDiscount ? 0 : (page - 1) * PAGE_SIZE;

  const todayCivil = floridaDateISO();
  const [total, lots, countyRows, board] = await Promise.all([
    prisma.lot.count({ where }),
    prisma.lot.findMany({
      where,
      include: {
        property: {
          select: {
            addressLine: true,
            city: true,
            zip: true,
            assessedValue: true,
            marketValue: true,
            lat: true,
            lng: true,
            beds: true,
            baths: true,
            livingSqft: true,
            yearBuilt: true,
          },
        },
        debts: {
          select: { category: true, amountKind: true, searchScoped: true, amount: true },
        },
        mortgages: { select: { rankLevel: true, satisfied: true } },
        risks: { select: { code: true, result: true, blocksBid: true } },
        _count: { select: { risks: true } },
      },
      orderBy: [{ saleDate: "asc" }, { caseNumber: "asc" }],
      skip: fetchSkip,
      take: fetchTake,
    }),
    prisma.lot.findMany({
      distinct: ["county"],
      select: { county: true },
      orderBy: { county: "asc" },
    }),
    loadDashboardStats(userId),
  ]);
  const countiesPresent = countyRows.map((r) => r.county).filter(Boolean);

  const now = new Date();
  let items: LotListItem[] = lots.map((lot) => {
    const tb = deriveTimeBucket(lot.saleDate, lot.status as AuctionStatus, now);
    const opening = num(lot.openingBid);
    const value = dealValue(lot);
    const method = applyMethodToLot(lot, methodSettings);
    const saleIso = lot.saleDate.toISOString();
    return {
      id: lot.id,
      caseNumber: lot.caseNumber,
      folio: lot.folio,
      county: lot.county,
      channel: lot.channel,
      status: lot.status,
      bucket: tb,
      saleDate: saleIso,
      propertyAddress: lot.propertyAddress,
      propertyAddressLine: lot.property?.addressLine ?? null,
      city: lot.property?.city ?? null,
      zip: lot.property?.zip ?? null,
      plaintiff: lot.plaintiff,
      openingBid: opening,
      judgmentAmount: num(lot.judgmentAmount),
      winningBid: num(lot.winningBid),
      purchaseConfirmed: lot.purchaseConfirmed,
      valueHint: value,
      spread: spreadUsd(opening, value),
      discountPct: discountPct(opening, value),
      ceiling: method.ceiling,
      hasGate: true,
      bidAllowed: method.bidAllowed,
      needsDd: method.needsDd,
      fillScore: method.fillScore,
      barriers: method.barriers,
      sourceUrl: lot.sourceUrl,
      lat: lot.property?.lat ?? null,
      lng: lot.property?.lng ?? null,
      riskCount: lot._count.risks,
      riskFailCount: lot.risks.filter((r) => r.result === "FAIL").length,
      riskUnknownCount: lot.risks.filter((r) => r.result === "UNKNOWN").length,
      beds: lot.property?.beds ?? null,
      baths: lot.property?.baths ?? null,
      livingSqft: lot.property?.livingSqft ?? null,
      yearBuilt: lot.property?.yearBuilt ?? null,
      daysUntilSale: daysUntilCivil(saleIso, todayCivil),
    };
  });

  if (wantDiscount || wantReady) {
    items = items.filter((i) => {
      const discountOk =
        wantDiscount &&
        i.discountPct != null &&
        i.discountPct >= hotDiscountPct &&
        i.bucket !== "PAST";
      const readyOk = wantReady && i.bidAllowed && i.bucket !== "PAST";
      if (wantDiscount && wantReady) return discountOk || readyOk;
      if (wantDiscount) return discountOk;
      return readyOk;
    });
  }

  // Discount still needs in-memory threshold — page within the over-fetched window.
  if (wantDiscount) {
    const start = (page - 1) * PAGE_SIZE;
    items = items.slice(start, start + PAGE_SIZE);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (county.length) qs.set("county", county.join(","));
  if (status.length) qs.set("status", status.join(","));
  if (bucket.length) qs.set("bucket", bucket.join(","));
  if (channel.length) qs.set("channel", channel.join(","));
  if (gate.length) qs.set("gate", gate.join(","));
  if (opportunity.length) qs.set("opportunity", opportunity.join(","));

  function pageHref(p: number) {
    const next = new URLSearchParams(qs);
    if (p > 1) next.set("page", String(p));
    const s = next.toString();
    return s ? `/lots?${s}` : "/lots";
  }

  return (
    <Shell active="lots" email={session?.user?.email}>
      <div className="page-head lots-page-head">
        <div>
          <h1>{t("lots.title")}</h1>
          <p className="sub">{t("lots.subtitle")}</p>
        </div>
        <p className="lots-page-tip muted">{t("lots.partnerTip")}</p>
      </div>

      <div className="panel lots-board">
        <LotsFilters
          initial={{ q, county, status, bucket, channel, gate, opportunity }}
          countyOptions={countiesPresent}
          boardStats={{
            today: board.buckets.CURRENT,
            upcoming: board.buckets.FUTURE,
            ready: board.readyToBid,
            review: board.needsReview,
            blocked: board.doNotBid,
            hot: board.discountOpps,
          }}
        />

        <LotsExplorer
          lots={items}
          hotDiscountPct={hotDiscountPct}
          resultLabel={`${items.length} / ${total} ${t("common.shown")} · ${t("lots.page")} ${page}/${totalPages}`}
        />

        {totalPages > 1 ? (
          <div className="pager">
            {page > 1 ? (
              <Link className="btn secondary" href={pageHref(page - 1)}>
                {t("lots.prevPage")}
              </Link>
            ) : (
              <span />
            )}
            <span className="pager-status muted">
              {t("lots.page")} {page} / {totalPages}
            </span>
            {page < totalPages ? (
              <Link className="btn secondary" href={pageHref(page + 1)}>
                {t("lots.nextPage")}
              </Link>
            ) : (
              <span />
            )}
          </div>
        ) : null}
      </div>
    </Shell>
  );
}
