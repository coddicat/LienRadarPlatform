import type { AuctionChannel, AuctionStatus } from "@lienradar/shared";

export type CalendarDay = {
  saleDate: string;
  /** Calendar cell total when RealAuction exposes one — used for completeness. */
  countHint?: number;
};

export type NormalizedLotCard = {
  /** County slug (e.g. miami-dade, broward). */
  county: string;
  channel: AuctionChannel;
  source: string;
  /** Stable identity: Case # (FC) or Certificate # / Tax Deed # (tax deed). */
  caseNumber: string;
  platformCaseNumber?: string | null;
  certificateNumber?: string | null;
  taxDeedNumber?: string | null;
  folio: string;
  saleDate: string;
  status: AuctionStatus;
  propertyAddress?: string;
  /** City / ZIP parsed from RealAuction second address line when present. */
  propertyCity?: string | null;
  propertyZip?: string | null;
  plaintiff?: string;
  openingBid?: number | null;
  judgmentAmount?: number | null;
  plaintiffMaxBid?: number | null;
  highBid?: number | null;
  winningBid?: number | null;
  assessedValue?: number | null;
  marketValue?: number | null;
  outcomeText?: string | null;
  sourceUrl?: string;
  /** Expected inventory size from #ALB for this date (completeness). */
  expectedAidCount?: number;
  /**
   * Outbound links from the auction preview card (Case # → clerk/OR instrument,
   * Parcel ID → property appraiser). Stored as Document rows — not scraped body text.
   */
  linkedDocuments?: Array<{
    docType: string;
    title?: string;
    sourceUrl: string;
    evidenceNote?: string;
  }>;
  raw: Record<string, unknown>;
};

export interface AuctionSourceAdapter {
  id: string;
  channel: AuctionChannel;
  fetchCalendar(from: Date, to: Date): Promise<CalendarDay[]>;
  fetchLotsForDate(saleDate: string): Promise<NormalizedLotCard[]>;
}
