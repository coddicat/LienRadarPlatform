import { Prisma, prisma } from "@lienradar/db";
import {
  AuctionChannel,
  AuctionStatus,
  FLORIDA_COUNTY_SET,
  TimeBucket,
  deriveTimeBucket,
} from "@lienradar/shared";
import { getServerSession } from "next-auth";
import Link from "next/link";
import { LotsExplorer, type LotListItem } from "@/components/LotsExplorer";
import { LotsFilters } from "@/components/LotsFilters";
import { Shell } from "@/components/Shell";
import { authOptions } from "@/lib/auth";
import { dealValue, discountPct, num, spreadUsd } from "@/lib/dealMetrics";
import { floridaTodayUtcDate } from "@/lib/floridaDate";
import { getI18n } from "@/lib/i18n";
import { applyMethodToLot, getUserMethodSettings } from "@/lib/methodSettings";

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

  const [total, lots, countyRows] = await Promise.all([
    prisma.lot.count({ where }),
    prisma.lot.findMany({
      where,
      include: {
        property: {
          select: {
            addressLine: true,
            assessedValue: true,
            marketValue: true,
            lat: true,
            lng: true,
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
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.lot.findMany({
      distinct: ["county"],
      select: { county: true },
      orderBy: { county: "asc" },
    }),
  ]);
  const countiesPresent = countyRows.map((r) => r.county).filter(Boolean);

  const now = new Date();
  let items: LotListItem[] = lots.map((lot) => {
    const tb = deriveTimeBucket(lot.saleDate, lot.status as AuctionStatus, now);
    const opening = num(lot.openingBid);
    const value = dealValue(lot);
    const method = applyMethodToLot(lot, methodSettings);
    return {
      id: lot.id,
      caseNumber: lot.caseNumber,
      folio: lot.folio,
      county: lot.county,
      channel: lot.channel,
      status: lot.status,
      bucket: tb,
      saleDate: lot.saleDate.toISOString(),
      propertyAddress: lot.propertyAddress,
      propertyAddressLine: lot.property?.addressLine ?? null,
      plaintiff: lot.plaintiff,
      openingBid: opening,
      judgmentAmount: num(lot.judgmentAmount),
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
      return discountOk || readyOk;
    });
  }

  if (gate.length) {
    items = items.filter((i) => {
      const allowed = i.hasGate && i.bidAllowed;
      const blocked = i.hasGate && !i.bidAllowed && !i.needsDd;
      const pending = !i.hasGate || (!i.bidAllowed && i.needsDd);
      return (
        (gate.includes("allowed") && allowed) ||
        (gate.includes("blocked") && blocked) ||
        (gate.includes("pending") && pending)
      );
    });
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
      <div className="page-head">
        <h1>{t("lots.title")}</h1>
        <p className="sub">{t("lots.subtitle")}</p>
      </div>

      <div className="callout">{t("lots.partnerTip")}</div>

      <div className="panel">
        <LotsFilters
          initial={{ q, county, status, bucket, channel, gate, opportunity }}
          countyOptions={countiesPresent}
        />

        <LotsExplorer
          lots={items}
          hotDiscountPct={hotDiscountPct}
          resultLabel={`${items.length} / ${total} ${t("common.shown")} · ${t("lots.page")} ${page}/${totalPages}`}
        />

        {totalPages > 1 ? (
          <div className="pager">
            {page > 1 ? <Link className="btn secondary" href={pageHref(page - 1)}>{t("lots.prevPage")}</Link> : null}
            {page < totalPages ? <Link className="btn secondary" href={pageHref(page + 1)}>{t("lots.nextPage")}</Link> : null}
          </div>
        ) : null}
      </div>
    </Shell>
  );
}
