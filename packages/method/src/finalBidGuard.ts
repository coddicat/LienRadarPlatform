import { FINAL_AUCTION_OUTCOMES, isSoldAuctionStatus } from "@lienradar/shared";
import { isExplicitFailedSaleReason } from "./outcomeReason.js";

/** Florida "today" as YYYY-MM-DD (America/New_York). */
export function floridaToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export type SourceAuthority = "platform" | "secondary";

export type FinalBidPrev = {
  winningBid?: string | number | null;
  saleDate?: string | Date | null;
} | null;

export type FinalBidReason =
  | "fresh_price"
  | "no_price"
  | "kept_same_sale"
  | "drop_not_sold"
  | "drop_future_sale";

export type FinalBidDecision = {
  value: number | null;
  dropped: number | null;
  reason: FinalBidReason;
  contradiction: boolean;
};

export type StatusGuardResult = {
  status: string;
  guarded: boolean;
  rule:
    | "no_prev"
    | "source"
    | "scheduled_never_overwrites_outcome"
    | "unparsed_never_overwrites_sold"
    | "secondary_never_downgrades_sold";
};

const toNum = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const toIso = (v: string | Date | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    return v.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  }
  return v.slice(0, 10);
};

/**
 * Status that will land on the row. Call BEFORE decideFinalBid so price uses the applied status.
 */
export function applyStatusGuard(args: {
  nextStatus: string;
  prevStatus: string | null | undefined;
  newSaleDate: string | Date | null;
  prevSaleDate?: string | Date | null;
  authority: SourceAuthority;
  outcomeText?: string | null;
  today?: string;
}): StatusGuardResult {
  const { nextStatus, prevStatus, authority } = args;
  const today = args.today ?? floridaToday();
  const newDate = toIso(args.newSaleDate);
  const prevDate = toIso(args.prevSaleDate);
  if (!prevStatus) return { status: nextStatus, guarded: false, rule: "no_prev" };

  const saleIsFuture = newDate !== null && newDate > today;
  const sameDate = newDate !== null && prevDate !== null && newDate === prevDate;
  const prevUpper = prevStatus.toUpperCase();
  const nextUpper = nextStatus.toUpperCase();

  if (authority === "secondary" && isSoldAuctionStatus(prevUpper) && !isSoldAuctionStatus(nextUpper)) {
    return { status: prevStatus, guarded: true, rule: "secondary_never_downgrades_sold" };
  }
  if (
    nextUpper === "SCHEDULED" &&
    FINAL_AUCTION_OUTCOMES.includes(prevUpper as (typeof FINAL_AUCTION_OUTCOMES)[number]) &&
    !saleIsFuture
  ) {
    return { status: prevStatus, guarded: true, rule: "scheduled_never_overwrites_outcome" };
  }
  if (
    nextUpper === "NOT_SOLD" &&
    isSoldAuctionStatus(prevUpper) &&
    sameDate &&
    !isExplicitFailedSaleReason(args.outcomeText)
  ) {
    return { status: prevStatus, guarded: true, rule: "unparsed_never_overwrites_sold" };
  }
  return { status: nextStatus, guarded: false, rule: "source" };
}

/**
 * Winning / final bid decision. Never invent price from opening/judgment/assessed.
 */
export function decideFinalBid(args: {
  newBid: number | null;
  appliedStatus: string;
  newSaleDate: string | Date | null;
  prev: FinalBidPrev;
  today?: string;
}): FinalBidDecision {
  const { newBid, appliedStatus, prev } = args;
  const today = args.today ?? floridaToday();
  const saleDate = toIso(args.newSaleDate);
  const prevBid = toNum(prev?.winningBid);

  if (newBid !== null && newBid !== undefined) {
    return {
      value: newBid,
      dropped: null,
      reason: "fresh_price",
      contradiction: !isSoldAuctionStatus(appliedStatus),
    };
  }
  if (prevBid === null) {
    return { value: null, dropped: null, reason: "no_price", contradiction: false };
  }
  if (!isSoldAuctionStatus(appliedStatus)) {
    return { value: null, dropped: prevBid, reason: "drop_not_sold", contradiction: false };
  }
  if (saleDate !== null && saleDate > today) {
    return { value: null, dropped: prevBid, reason: "drop_future_sale", contradiction: false };
  }
  return { value: prevBid, dropped: null, reason: "kept_same_sale", contradiction: false };
}

/** Detect opening bid that belongs to a different lot identity on the same day (heuristic). */
export function foreignOpeningSuspect(args: {
  openingBid: number | null | undefined;
  caseNumber: string;
  otherOpenings: Array<{ caseNumber: string; openingBid: number | null | undefined }>;
}): boolean {
  if (args.openingBid == null || !(args.openingBid > 0)) return false;
  return args.otherOpenings.some(
    (o) =>
      o.caseNumber !== args.caseNumber &&
      o.openingBid != null &&
      o.openingBid === args.openingBid &&
      o.openingBid > 50_000,
  );
}
