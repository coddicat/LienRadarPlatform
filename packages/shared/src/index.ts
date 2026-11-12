export const COUNTY_MIAMI_DADE = "miami-dade" as const;

/** Canonical county slugs used in Lot/Property.county (Florida auction desk). */
export const FLORIDA_COUNTIES = [
  COUNTY_MIAMI_DADE,
  "broward",
  "palm-beach",
  "monroe",
  "orange",
  "hillsborough",
  "pinellas",
  "duval",
  "lee",
  "collier",
  "sarasota",
  "manatee",
  "polk",
  "volusia",
  "seminole",
  "brevard",
  "pasco",
  "osceola",
  "lake",
  "marion",
  "clay",
  "st-lucie",
  "martin",
  "indian-river",
  "charlotte",
  "alachua",
  "leon",
  "escambia",
  "okaloosa",
  "bay",
  "putnam",
  "nassau",
  "st-johns",
  "flagler",
  "citrus",
  "hernando",
  "sumter",
] as const;
export type FloridaCounty = (typeof FLORIDA_COUNTIES)[number];
export const FLORIDA_COUNTY_SET = new Set<string>(FLORIDA_COUNTIES);

export const AuctionChannel = {
  TAX_DEED: "TAX_DEED",
  FORECLOSURE: "FORECLOSURE",
  BANK_REO: "BANK_REO",
} as const;
export type AuctionChannel = (typeof AuctionChannel)[keyof typeof AuctionChannel];

export const AuctionStatus = {
  SCHEDULED: "SCHEDULED",
  LIVE: "LIVE",
  CLOSED: "CLOSED",
  CANCELED: "CANCELED",
  POSTPONED: "POSTPONED",
  /** Platform settled sale (incl. plaintiff / 3rd-party subtypes in raw). */
  SOLD: "SOLD",
  REDEEMED: "REDEEMED",
  /** Settled day, not sold — keep platform outcome_text separately. */
  NOT_SOLD: "NOT_SOLD",
} as const;
export type AuctionStatus = (typeof AuctionStatus)[keyof typeof AuctionStatus];

/** Terminal platform outcomes for a sale date (status-guard / final-bid rules). */
export const FINAL_AUCTION_OUTCOMES: AuctionStatus[] = [
  AuctionStatus.SOLD,
  AuctionStatus.CANCELED,
  AuctionStatus.REDEEMED,
  AuctionStatus.NOT_SOLD,
  AuctionStatus.CLOSED,
];

export function isSoldAuctionStatus(status: string | null | undefined): boolean {
  return (status ?? "").toUpperCase().startsWith("SOLD");
}

export const TimeBucket = {
  PAST: "PAST",
  CURRENT: "CURRENT",
  FUTURE: "FUTURE",
} as const;
export type TimeBucket = (typeof TimeBucket)[keyof typeof TimeBucket];

export const DebtCategory = {
  TAX: "TAX",
  MORTGAGE: "MORTGAGE",
  MUNI_CODE: "MUNI_CODE",
  UTILITY: "UTILITY",
  PERMIT: "PERMIT",
  HOA: "HOA",
  CDD: "CDD",
  PACE: "PACE",
  OTHER: "OTHER",
} as const;
export type DebtCategory = (typeof DebtCategory)[keyof typeof DebtCategory];

export const AmountKind = {
  EXACT_FROM_DOC: "EXACT_FROM_DOC",
  ESTIMATED_SCENARIO: "ESTIMATED_SCENARIO",
  UNKNOWN: "UNKNOWN",
} as const;
export type AmountKind = (typeof AmountKind)[keyof typeof AmountKind];

export const MortgageRankLevel = {
  L1_ESTIMATE: "L1_ESTIMATE",
  L2_PROVEN: "L2_PROVEN",
} as const;
export type MortgageRankLevel = (typeof MortgageRankLevel)[keyof typeof MortgageRankLevel];

export const RiskResult = {
  PASS: "PASS",
  FAIL: "FAIL",
  UNKNOWN: "UNKNOWN",
  NOT_APPLICABLE: "NOT_APPLICABLE",
} as const;
export type RiskResult = (typeof RiskResult)[keyof typeof RiskResult];

export const DealStatus = {
  WATCHING: "WATCHING",
  ANALYZING: "ANALYZING",
  BID_PLANNED: "BID_PLANNED",
  WON: "WON",
  LOST: "LOST",
  SKIPPED: "SKIPPED",
  HOLDING: "HOLDING",
  LISTED: "LISTED",
  SOLD: "SOLD",
} as const;
export type DealStatus = (typeof DealStatus)[keyof typeof DealStatus];

export const LayerStatus = {
  OK: "OK",
  PARTIAL: "PARTIAL",
  FAILED: "FAILED",
  STALE: "STALE",
} as const;
export type LayerStatus = (typeof LayerStatus)[keyof typeof LayerStatus];

export const REQUIRED_DEBT_CATEGORIES: DebtCategory[] = [
  DebtCategory.TAX,
  DebtCategory.MUNI_CODE,
  DebtCategory.UTILITY,
  DebtCategory.HOA,
  DebtCategory.MORTGAGE,
];

export const REQUIRED_RISK_CODES = [
  "bankruptcy",
  "redemption",
  "federal_lien",
  "title_insurability",
  "flood",
  "occupancy",
] as const;

export function normalizeFolio(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

export function lotNaturalKey(parts: {
  county: string;
  channel: string;
  caseNumber: string;
  folio: string;
  saleDate: string | Date;
}): string {
  const sale =
    typeof parts.saleDate === "string"
      ? parts.saleDate.slice(0, 10)
      : parts.saleDate.toISOString().slice(0, 10);
  return [
    parts.county,
    parts.channel,
    parts.caseNumber.trim().toUpperCase(),
    normalizeFolio(parts.folio),
    sale,
  ].join("|");
}

/** Florida civil date YYYY-MM-DD for auction calendars. */
export function floridaDateISO(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * Time bucket is primarily by Florida sale date.
 * Outcome status is shown separately — a SOLD/CANCELED lot on today's board stays CURRENT.
 */
export function deriveTimeBucket(
  saleDate: Date,
  status: AuctionStatus,
  now = new Date(),
): TimeBucket {
  if (status === AuctionStatus.LIVE) return TimeBucket.CURRENT;
  // Prisma @db.Date comes back as UTC midnight of the civil sale date.
  const sale = [
    saleDate.getUTCFullYear(),
    String(saleDate.getUTCMonth() + 1).padStart(2, "0"),
    String(saleDate.getUTCDate()).padStart(2, "0"),
  ].join("-");
  const today = floridaDateISO(now);
  if (sale === today) return TimeBucket.CURRENT;
  if (sale < today) return TimeBucket.PAST;
  return TimeBucket.FUTURE;
}

export function moneyLabel(
  field:
    | "openingBid"
    | "judgmentAmount"
    | "plaintiffMaxBid"
    | "highBid"
    | "winningBid"
    | "confirmedSalePrice",
): string {
  switch (field) {
    case "openingBid":
      return "Opening / base bid";
    case "judgmentAmount":
      return "Final judgment";
    case "plaintiffMaxBid":
      return "Plaintiff max bid";
    case "highBid":
      return "High bid (live)";
    case "winningBid":
      return "Winning bid (platform)";
    case "confirmedSalePrice":
      return "Confirmed purchase price";
  }
}

export type BidBarrier = {
  code: string;
  message: string;
  severity: "block" | "warn";
};

export type BidGateResult = {
  bidAllowed: boolean;
  fillScore: number;
  riskClosed: boolean;
  barriers: BidBarrier[];
  methodVersion: string;
};

export * from "./counties.js";
export * from "./jobs.js";
