import { createHash } from "node:crypto";
import { Prisma, ResourceHealth, prisma } from "@lienradar/db";
import {
  applyStatusGuard,
  classifyOutcomeReason,
  computeBidCeiling,
  computeBidGate,
  decideFinalBid,
} from "@lienradar/method";
import {
  AmountKind,
  AuctionStatus,
  DebtCategory,
  LayerStatus,
  countyResourceKey,
  floridaDateISO,
  lotNaturalKey,
  normalizeFolio,
  resolveActiveCounties,
  toCivilDateISO,
} from "@lienradar/shared";
import { buildCountyAdapters, type CountyAuctionAdapter } from "./adapters/realauction.js";
import type { AuctionSourceAdapter, NormalizedLotCard } from "./adapters/types.js";
import { applyClerkAuthNote, probeClerkApi } from "./enrichment/clerkApi.js";
import { applyCourtOcs, fetchCourtOcs, probeCourtOcs } from "./enrichment/courtOcs.js";
import { enrichFlood, probeFlood, probeNfhl } from "./enrichment/flood.js";
import { runFolioAttachPass } from "./enrichment/folioResolve.js";
import { ensureGateScaffold } from "./enrichment/gateScaffold.js";
import { syncMortgageDebtFromAssessments } from "./enrichment/syncMortgageDebt.js";
import { applyMuniDebt, enrichMuniMd, probeCcviol } from "./enrichment/muniMd.js";
import { runAuctionLinkEnrichment } from "./enrichment/auctionCardLinks.js";
import { applyOfficialRecordsMortgage, probeOfficialRecords } from "./enrichment/officialRecords.js";
import { applyJudgmentMortgageEstimate } from "./enrichment/judgmentMortgage.js";
import { applyPaDerivedToLot } from "./enrichment/paDerived.js";
import { enrichPropertyAppraiserForCounty, probeCountyPa } from "./enrichment/paRouter.js";
import {
  applyTaxDebt,
  decideTaxFromDelinquent,
  loadDelinquentIndex,
  probeTaxDelinquent,
} from "./enrichment/taxDelinquent.js";
import { markJobFinish, markJobStart, setResourceStatus } from "./status.js";

function money(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return null;
  return n.toFixed(2);
}

async function startRun(
  stage:
    | "CALENDAR"
    | "LOTS"
    | "ENRICH_PA"
    | "ENRICH_MUNI"
    | "METHOD"
    | "HEALTH"
    | "ENRICH_CLERK"
    | "ENRICH_TAX",
) {
  // IDENTITY stage reused for free OCS / flood batch in ingest runs table via notes when needed.
  return prisma.ingestRun.create({
    data: { stage, status: "RUNNING" },
  });
}

async function finishRun(
  id: string,
  status: "SUCCESS" | "PARTIAL" | "FAILED",
  counts: Record<string, number>,
  errorSummary?: string,
) {
  await prisma.ingestRun.update({
    where: { id },
    data: { status, finishedAt: new Date(), counts, errorSummary },
  });
}

export async function upsertLotCard(card: NormalizedLotCard) {
  const county = (card.county || "").trim().toLowerCase();
  if (!county) {
    throw new Error(`upsertLotCard: missing county for ${card.source} ${card.caseNumber}`);
  }
  const folioNormalized = normalizeFolio(card.folio);
  const civilSale = toCivilDateISO(card.saleDate);
  if (!civilSale) {
    throw new Error(`upsertLotCard: bad saleDate ${String(card.saleDate)} for ${card.caseNumber}`);
  }
  let naturalKey = lotNaturalKey({
    county,
    channel: card.channel,
    caseNumber: card.caseNumber,
    folio: card.folio || "UNKNOWN",
    saleDate: civilSale,
  });
  // Prisma @db.Date: store UTC midnight of the civil sale day.
  const saleDate = new Date(`${civilSale}T00:00:00.000Z`);
  const outcome = classifyOutcomeReason(card.outcomeText);
  const caseNorm = card.caseNumber.trim().toUpperCase();

  const event = await prisma.auctionEvent.upsert({
    where: {
      county_channel_source_saleDate: {
        county,
        channel: card.channel,
        source: card.source,
        saleDate,
      },
    },
    update: { status: card.status, venueUrl: card.sourceUrl },
    create: {
      county,
      channel: card.channel,
      source: card.source,
      saleDate,
      status: card.status,
      venueUrl: card.sourceUrl,
    },
  });

  let propertyId: string | undefined;
  if (folioNormalized && folioNormalized !== "UNKNOWN") {
    const property = await prisma.property.upsert({
      where: { county_folioNormalized: { county, folioNormalized } },
      update: {
        // Only fill address/values from the auction card — never null out PA enrichment.
        addressLine: card.propertyAddress || undefined,
        city: card.propertyCity || undefined,
        zip: card.propertyZip || undefined,
        assessedValue: money(card.assessedValue) ?? undefined,
        marketValue: money(card.marketValue) ?? undefined,
        justValue: money(card.marketValue ?? card.assessedValue) ?? undefined,
      },
      create: {
        county,
        folio: card.folio,
        folioNormalized,
        addressLine: card.propertyAddress,
        city: card.propertyCity || undefined,
        zip: card.propertyZip || undefined,
        assessedValue: money(card.assessedValue),
        marketValue: money(card.marketValue),
        justValue: money(card.marketValue ?? card.assessedValue),
      },
    });
    propertyId = property.id;
  }

  // Identity is case+sale day first. Folio may arrive later — merge UNKNOWN → real folio
  // onto one row instead of creating a duplicate naturalKey.
  let existing = await prisma.lot.findUnique({ where: { naturalKey } });
  if (!existing) {
    const sameDay = await prisma.lot.findMany({
      where: { county, channel: card.channel, saleDate },
      take: 40,
    });
    const byCase = sameDay.find((l) => l.caseNumber.trim().toUpperCase() === caseNorm);
    const byCert =
      card.certificateNumber || card.taxDeedNumber
        ? sameDay.find(
            (l) =>
              (card.certificateNumber &&
                l.certificateNumber &&
                l.certificateNumber === card.certificateNumber) ||
              (card.taxDeedNumber && l.taxDeedNumber && l.taxDeedNumber === card.taxDeedNumber),
          )
        : undefined;
    const match = byCase ?? byCert;
    if (match) {
      const incomingKnown = Boolean(folioNormalized && folioNormalized !== "UNKNOWN");
      const existingUnknown = !match.folioNormalized || match.folioNormalized === "UNKNOWN";
      if (match.naturalKey !== naturalKey && (existingUnknown || !incomingKnown)) {
        const nextKey = incomingKnown && existingUnknown ? naturalKey : match.naturalKey;
        if (nextKey !== match.naturalKey) {
          await prisma.lot.update({
            where: { id: match.id },
            data: {
              naturalKey: nextKey,
              folio: card.folio || match.folio,
              folioNormalized: folioNormalized || match.folioNormalized,
            },
          });
          naturalKey = nextKey;
        } else {
          naturalKey = match.naturalKey;
        }
        existing = await prisma.lot.findUnique({ where: { naturalKey } });
      } else if (match.naturalKey === naturalKey) {
        existing = match;
      }
    }
  }

  const statusGuard = applyStatusGuard({
    nextStatus: card.status,
    prevStatus: existing?.status,
    newSaleDate: civilSale,
    prevSaleDate: existing?.saleDate,
    authority: "platform",
    outcomeText: card.outcomeText,
  });

  const bidDecision = decideFinalBid({
    newBid: card.winningBid ?? null,
    appliedStatus: statusGuard.status,
    newSaleDate: civilSale,
    prev: existing
      ? { winningBid: existing.winningBid ? Number(existing.winningBid) : null, saleDate: existing.saleDate }
      : null,
  });

  const appliedStatus = statusGuard.status as AuctionStatus;
  const purchaseConfirmed =
    appliedStatus === AuctionStatus.SOLD && bidDecision.value != null && !bidDecision.contradiction;
  const winningBidStored = bidDecision.contradiction ? null : money(bidDecision.value);

  const lot = await prisma.lot.upsert({
    where: { naturalKey },
    update: {
      status: appliedStatus,
      plaintiff: card.plaintiff,
      propertyAddress: card.propertyAddress,
      certificateNumber: card.certificateNumber ?? undefined,
      taxDeedNumber: card.taxDeedNumber ?? undefined,
      folio: card.folio || undefined,
      folioNormalized: folioNormalized && folioNormalized !== "UNKNOWN" ? folioNormalized : undefined,
      openingBid: money(card.openingBid),
      judgmentAmount: money(card.judgmentAmount),
      plaintiffMaxBid: money(card.plaintiffMaxBid),
      highBid: money(card.highBid),
      winningBid: winningBidStored,
      confirmedSalePrice: purchaseConfirmed ? money(bidDecision.value) : null,
      purchaseConfirmed,
      outcomeText: card.outcomeText ?? undefined,
      outcomeCategory: outcome.category,
      // Preserve PA-enriched values when the auction card omits assessed/market.
      assessedValue: money(card.assessedValue) ?? undefined,
      marketValue: money(card.marketValue) ?? undefined,
      sourceUrl: card.sourceUrl,
      auctionEventId: event.id,
      propertyId,
    },
    create: {
      naturalKey,
      county,
      channel: card.channel,
      caseNumber: card.caseNumber,
      certificateNumber: card.certificateNumber ?? null,
      taxDeedNumber: card.taxDeedNumber ?? null,
      folio: card.folio || "UNKNOWN",
      folioNormalized: folioNormalized || "UNKNOWN",
      saleDate,
      status: appliedStatus,
      plaintiff: card.plaintiff,
      propertyAddress: card.propertyAddress,
      openingBid: money(card.openingBid),
      judgmentAmount: money(card.judgmentAmount),
      plaintiffMaxBid: money(card.plaintiffMaxBid),
      highBid: money(card.highBid),
      winningBid: winningBidStored,
      confirmedSalePrice: purchaseConfirmed ? money(bidDecision.value) : null,
      purchaseConfirmed,
      outcomeText: card.outcomeText ?? null,
      outcomeCategory: outcome.category,
      assessedValue: money(card.assessedValue),
      marketValue: money(card.marketValue),
      sourceUrl: card.sourceUrl,
      auctionEventId: event.id,
      propertyId,
    },
  });

  if (bidDecision.dropped != null) {
    await prisma.finalBidDrop.create({
      data: {
        lotId: lot.id,
        droppedBid: money(bidDecision.dropped)!,
        reason: bidDecision.reason,
        oldStatus: existing?.status,
        newStatus: appliedStatus,
        oldSaleDate: existing?.saleDate,
        newSaleDate: saleDate,
      },
    });
  }

  await prisma.rawObservation.create({
    data: {
      lotId: lot.id,
      source: card.source,
      externalId: card.caseNumber,
      contentHash: createHash("sha256").update(JSON.stringify(card.raw)).digest("hex").slice(0, 24),
      payload: {
        ...card.raw,
        statusGuard,
        bidDecision,
        outcome,
      } as Prisma.InputJsonValue,
    },
  });

  // Persist Case # / Parcel ID outbound links from the auction card (Documents tab).
  if (card.linkedDocuments?.length) {
    for (const doc of card.linkedDocuments) {
      if (!doc.sourceUrl) continue;
      const existingDoc = await prisma.document.findFirst({
        where: { lotId: lot.id, sourceUrl: doc.sourceUrl },
        select: { id: true },
      });
      if (existingDoc) {
        await prisma.document.update({
          where: { id: existingDoc.id },
          data: {
            docType: doc.docType,
            title: doc.title ?? undefined,
            evidenceNote: doc.evidenceNote ?? undefined,
            searchScope: "auction_preview_link",
            meta: { source: card.source, saleDate: civilSale } as Prisma.InputJsonValue,
          },
        });
      } else {
        await prisma.document.create({
          data: {
            lotId: lot.id,
            docType: doc.docType,
            title: doc.title ?? null,
            sourceUrl: doc.sourceUrl,
            evidenceNote: doc.evidenceNote ?? null,
            searchScope: "auction_preview_link",
            meta: { source: card.source, saleDate: civilSale },
          },
        });
      }
    }
  }

  if (existing) {
    const changed =
      String(existing.openingBid) !== String(money(card.openingBid)) ||
      existing.status !== appliedStatus ||
      String(existing.winningBid) !== String(money(bidDecision.value)) ||
      String(existing.plaintiffMaxBid) !== String(money(card.plaintiffMaxBid));
    if (changed) {
      await prisma.lotEvent.create({
        data: {
          lotId: lot.id,
          kind: "ingest_change",
          message: "Lot fields updated from source",
          payload: {
            beforeStatus: existing.status,
            afterStatus: appliedStatus,
            statusGuarded: statusGuard.guarded,
            bidReason: bidDecision.reason,
          },
        },
      });
      await prisma.enrichmentLayer.updateMany({
        where: { lotId: lot.id },
        data: { status: LayerStatus.STALE },
      });
    }
  } else {
    await prisma.lotEvent.create({
      data: { lotId: lot.id, kind: "ingest_create", message: "Lot created from source" },
    });
  }

  return lot;
}

async function pullAdapter(
  resourceKey: string,
  adapter: AuctionSourceAdapter & { probe?: () => Promise<{ ok: boolean; error?: string; days?: number }> },
  from: Date,
  to: Date,
) {
  try {
    if (adapter.probe) {
      const probe = await adapter.probe();
      if (!probe.ok) {
        await setResourceStatus({
          key: resourceKey,
          status: ResourceHealth.DOWN,
          detail: "Probe failed",
          lastError: probe.error ?? "probe failed",
        });
        return {
          days: 0,
          lots: 0,
          expected: 0,
          mismatchDays: 0,
          taxIdentityLots: 0,
          retargetedLots: 0,
          error: probe.error ?? "probe failed",
        };
      }
    }

    const calendar = await adapter.fetchCalendar(from, to);
    let lots = 0;
    let expected = 0;
    let mismatchDays = 0;
    const dayErrors: string[] = [];

    let taxIdentityLots = 0;
    let retargetedLots = 0;
    for (const day of calendar) {
      try {
        const cards = await adapter.fetchLotsForDate(day.saleDate);
        for (const card of cards) {
          await upsertLotCard(card);
          lots += 1;
          if (card.channel === "TAX_DEED") taxIdentityLots += 1;
          if (card.raw && typeof card.raw === "object" && "retargetedChannel" in (card.raw as object)) {
            retargetedLots += 1;
          }
        }
        const dayExpected = cards[0]?.expectedAidCount ?? day.countHint ?? 0;
        expected += dayExpected;
        // Flag only true empty parses — retargeted FC cards on the tax host still count as inventory.
        if (day.countHint != null && day.countHint > 0 && cards.length === 0) {
          mismatchDays += 1;
          dayErrors.push(`${day.saleDate}: calendar hint ${day.countHint} but 0 lots parsed`);
        } else if (cards.length === 0 && dayExpected > 0) {
          mismatchDays += 1;
          dayErrors.push(`${day.saleDate}: inventory~${dayExpected} but 0 lots parsed`);
        }
      } catch (e) {
        mismatchDays += 1;
        dayErrors.push(`${day.saleDate}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const degraded =
      (calendar.length > 0 && lots === 0) || mismatchDays > 0 || dayErrors.length > 0;
    const status = degraded ? ResourceHealth.DEGRADED : ResourceHealth.OK;
    await setResourceStatus({
      key: resourceKey,
      status,
      detail: degraded
        ? `Pulled ${calendar.length} days / ${lots} lots; completeness issues on ${mismatchDays} day(s)` +
          (dayErrors[0] ? ` — ${dayErrors[0]}` : "")
        : `Pulled ${calendar.length} sale days, ${lots} lots`,
      lastError: dayErrors.length ? dayErrors.slice(0, 3).join(" | ") : null,
      success: lots > 0 || calendar.length === 0,
    });
    return {
      days: calendar.length,
      lots,
      expected,
      mismatchDays,
      dayErrors,
      taxIdentityLots,
      retargetedLots,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setResourceStatus({
      key: resourceKey,
      status: ResourceHealth.DOWN,
      detail: "Fetch failed",
      lastError: msg,
    });
    return {
      days: 0,
      lots: 0,
      expected: 0,
      mismatchDays: 0,
      taxIdentityLots: 0,
      retargetedLots: 0,
      error: msg,
    };
  }
}

/** Mirror new miami_dade_* resource status onto legacy miami_* Admin keys. */
async function mirrorLegacyMiamiResource(
  resourceKey: string,
  status: ResourceHealth,
  detail?: string | null,
  lastError?: string | null,
  success?: boolean,
) {
  const legacy =
    resourceKey === countyResourceKey("miami-dade", "taxdeed_realauction")
      ? "miami_taxdeed_realauction"
      : resourceKey === countyResourceKey("miami-dade", "foreclose_realauction")
        ? "miami_foreclose_realauction"
        : null;
  if (!legacy) return;
  await setResourceStatus({ key: legacy, status, detail: detail ?? undefined, lastError: lastError ?? null, success });
}

export async function runCalendarAndLots(jobKey = "calendar_6h") {
  const run = await startRun("CALENDAR");
  await markJobStart(jobKey);
  try {
    // Full calendar: past outcomes + upcoming window (Florida civil day, not UTC clock).
    // Day-of refresh: tight window around today (avoid replaying ± weeks every 30m).
    const pastDays = jobKey === "day_refresh_30m" ? 1 : 14;
    const futureDays = jobKey === "day_refresh_30m" ? 2 : 56;
    const todayCivil = floridaDateISO();
    const todayUtc = new Date(`${todayCivil}T00:00:00.000Z`);
    const from = new Date(todayUtc);
    from.setUTCDate(from.getUTCDate() - pastDays);
    const to = new Date(todayUtc);
    to.setUTCDate(to.getUTCDate() + futureDays);

    const adapters = buildCountyAdapters();
    const results: Array<{
      adapter: CountyAuctionAdapter;
      days: number;
      lots: number;
      expected: number;
      mismatchDays: number;
      taxIdentityLots: number;
      retargetedLots: number;
      dayErrors?: string[];
      error?: string;
    }> = [];

    for (const adapter of adapters) {
      const pulled = await pullAdapter(adapter.resourceKey, adapter, from, to);
      results.push({ adapter, ...pulled });
      // Keep legacy Miami Admin rows in sync during the key rename.
      if (adapter.county === "miami-dade") {
        const status = pulled.error
          ? ResourceHealth.DOWN
          : pulled.mismatchDays || pulled.dayErrors?.length
            ? ResourceHealth.DEGRADED
            : ResourceHealth.OK;
        await mirrorLegacyMiamiResource(
          adapter.resourceKey,
          status,
          pulled.error
            ? "Fetch failed"
            : `Pulled ${pulled.days} sale days, ${pulled.lots} lots`,
          pulled.error ?? (pulled.dayErrors?.length ? pulled.dayErrors.slice(0, 3).join(" | ") : null),
          pulled.lots > 0 || pulled.days === 0,
        );
      }
    }

    const taxResults = results.filter((r) => r.adapter.channel === "TAX_DEED");
    const fcResults = results.filter((r) => r.adapter.channel === "FORECLOSURE");
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const counts: Record<string, number> = {
      counties: new Set(adapters.map((a) => a.county)).size,
      adapters: adapters.length,
      taxDays: sum(taxResults.map((r) => r.days)),
      taxLots: sum(taxResults.map((r) => r.taxIdentityLots ?? 0)),
      taxHostCards: sum(taxResults.map((r) => r.lots)),
      taxRetargetedFc: sum(taxResults.map((r) => r.retargetedLots ?? 0)),
      taxMismatchDays: sum(taxResults.map((r) => r.mismatchDays)),
      fcDays: sum(fcResults.map((r) => r.days)),
      fcLots: sum(fcResults.map((r) => r.lots)),
      fcMismatchDays: sum(fcResults.map((r) => r.mismatchDays)),
      failedAdapters: results.filter((r) => r.error).length,
    };
    for (const r of results) {
      const prefix = `${r.adapter.county.replace(/-/g, "_")}_${r.adapter.channel === "TAX_DEED" ? "tax" : "fc"}`;
      counts[`${prefix}_days`] = r.days;
      counts[`${prefix}_lots`] = r.lots;
    }

    // Follow Case # / Parcel ID outbound links for public metadata (BCPA RecInfo, OR, PB PA).
    const linkLimit = jobKey === "day_refresh_30m" ? 25 : 80;
    const linkEnrich = await runAuctionLinkEnrichment(linkLimit);
    counts.linkLots = linkEnrich.lots;
    counts.linkEnriched = linkEnrich.enriched;
    counts.linkFailed = linkEnrich.failed;

    const errors = results.map((r) => r.error).filter(Boolean) as string[];
    const anyMismatch = results.some((r) => r.mismatchDays > 0);
    const allFailed = results.length > 0 && errors.length === results.length;
    const status = allFailed
      ? "FAILED"
      : errors.length > 0 || anyMismatch
        ? "PARTIAL"
        : "SUCCESS";
    await finishRun(run.id, status, counts, errors.join("; ") || undefined);
    await markJobFinish(jobKey, status, counts, errors.join("; ") || undefined);
    return counts;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishRun(run.id, "FAILED", {}, msg);
    await markJobFinish(jobKey, "FAILED", {}, msg);
    throw e;
  }
}

export async function runPaEnrichment(limit = 250, jobKey = "enrich_pa_6h") {
  const run = await startRun("ENRICH_PA");
  await markJobStart(jobKey);
  try {
    const counties = resolveActiveCounties(process.env.LR_ACTIVE_COUNTIES);
    let anyLiveOk = false;
    let probeErrors: string[] = [];
    const liveCounties: string[] = [];

    for (const county of counties) {
      const probe = await probeCountyPa(county);
      for (const key of probe.resourceKeys) {
        if (probe.configured === false) {
          await setResourceStatus({
            key,
            status: ResourceHealth.NOT_CONFIGURED,
            detail: probe.detail ?? "No free folio API proven",
            lastError: null,
          });
        } else if (!probe.ok) {
          await setResourceStatus({
            key,
            status: ResourceHealth.DOWN,
            detail: "Probe failed",
            lastError: probe.error ?? "down",
          });
          probeErrors.push(`${county}: ${probe.error ?? "down"}`);
        } else {
          await setResourceStatus({
            key,
            status: ResourceHealth.OK,
            detail: probe.detail ?? "PA reachable",
            lastError: null,
            success: true,
          });
          anyLiveOk = true;
          if (!liveCounties.includes(county)) liveCounties.push(county);
        }
      }
    }

    if (!anyLiveOk) {
      const err = probeErrors.join("; ") || "all county PA probes failed / not configured";
      await finishRun(run.id, "FAILED", {}, err);
      await markJobFinish(jobKey, "FAILED", {}, err);
      return { ok: 0, failed: 0, error: err };
    }

    // Fair per-county sampling; prioritize never-enriched before refresh so Broward/PB catch up.
    const freshAfter = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    const perCounty = Math.max(40, Math.ceil(limit / Math.max(liveCounties.length, 1)));
    const lots: Array<{
      id: string;
      county: string;
      folio: string;
      folioNormalized: string;
      propertyAddress: string | null;
      propertyId: string | null;
    }> = [];
    const selectLot = {
      id: true,
      county: true,
      folio: true,
      folioNormalized: true,
      propertyAddress: true,
      propertyId: true,
    } as const;
    for (const county of liveCounties) {
      const baseWhere = { county, NOT: { folioNormalized: "UNKNOWN" as const } };
      const missing = await prisma.lot.findMany({
        take: perCounty,
        orderBy: [{ updatedAt: "desc" }],
        where: {
          ...baseWhere,
          layers: { none: { name: "pa_parcel" } },
        },
        select: selectLot,
      });
      lots.push(...missing);
      const remain = perCounty - missing.length;
      if (remain <= 0) continue;
      const refresh = await prisma.lot.findMany({
        take: remain,
        orderBy: [{ updatedAt: "desc" }],
        where: {
          ...baseWhere,
          layers: { some: { name: "pa_parcel" } },
          OR: [
            { layers: { some: { name: "pa_parcel", status: "STALE" } } },
            { layers: { some: { name: "pa_parcel", status: "FAILED" } } },
            { layers: { some: { name: "pa_parcel", fetchedAt: { lt: freshAfter } } } },
            { property: { is: { lat: null } } },
            { assessedValue: null },
          ],
        },
        select: selectLot,
      });
      lots.push(...refresh);
    }
    // Cap total work for this run while keeping county mix.
    lots.sort((a, b) => a.county.localeCompare(b.county));
    const work = lots.slice(0, limit);

    let ok = 0;
    let failed = 0;
    const skippedNotConfigured = 0;
    for (const lot of work) {
      const result = await enrichPropertyAppraiserForCounty(lot.county, lot.folio);
      await prisma.enrichmentLayer.upsert({
        where: { lotId_name: { lotId: lot.id, name: "pa_parcel" } },
        update: {
          status: result.status,
          payload: result.payload as Prisma.InputJsonValue,
          error: result.error,
          fetchedAt: new Date(),
        },
        create: {
          lotId: lot.id,
          name: "pa_parcel",
          status: result.status,
          payload: result.payload as Prisma.InputJsonValue,
          error: result.error,
        },
      });

      if (result.status === LayerStatus.OK) {
        const land = result.payload.land as Record<string, unknown> | null | undefined;
        const justValue = result.payload.justValue as number | null | undefined;
        const assessedValue = result.payload.assessedValue as number | null | undefined;
        if (lot.folioNormalized && lot.folioNormalized !== "UNKNOWN") {
          const property = await prisma.property.upsert({
            where: {
              county_folioNormalized: { county: lot.county, folioNormalized: lot.folioNormalized },
            },
            update: {
              addressLine: (land?.address as string) || undefined,
              city: (land?.city as string) || undefined,
              zip: land?.zip != null ? String(land.zip) : undefined,
              ownerName: (land?.owner as string) || undefined,
              dorUse: land?.dorCode != null ? String(land.dorCode) : undefined,
              zoning: (land?.zoning as string) || undefined,
              yearBuilt: typeof land?.yearBuilt === "number" ? land.yearBuilt : undefined,
              livingSqft:
                typeof land?.buildingGrossArea === "number" ? Math.round(land.buildingGrossArea) : undefined,
              lotSqft: typeof land?.lotSize === "number" ? Math.round(land.lotSize) : undefined,
            assessedValue: money(assessedValue ?? null) ?? undefined,
            marketValue: money(justValue ?? null) ?? undefined,
            justValue: money(justValue ?? null) ?? undefined,
            lat: typeof land?.lat === "number" ? land.lat : undefined,
            lng: typeof land?.lng === "number" ? land.lng : undefined,
          },
          create: {
            county: lot.county,
            folio: lot.folio,
            folioNormalized: lot.folioNormalized,
            addressLine: (land?.address as string) || lot.propertyAddress,
            city: (land?.city as string) || undefined,
            zip: land?.zip != null ? String(land.zip) : undefined,
            ownerName: (land?.owner as string) || undefined,
            dorUse: land?.dorCode != null ? String(land.dorCode) : undefined,
            zoning: (land?.zoning as string) || undefined,
            yearBuilt: typeof land?.yearBuilt === "number" ? land.yearBuilt : undefined,
            livingSqft:
              typeof land?.buildingGrossArea === "number" ? Math.round(land.buildingGrossArea) : undefined,
            lotSqft: typeof land?.lotSize === "number" ? Math.round(land.lotSize) : undefined,
            assessedValue: money(assessedValue ?? null),
            marketValue: money(justValue ?? null),
            justValue: money(justValue ?? null),
            lat: typeof land?.lat === "number" ? land.lat : undefined,
            lng: typeof land?.lng === "number" ? land.lng : undefined,
          },
        });
        await prisma.lot.update({
          where: { id: lot.id },
          data: {
            propertyId: property.id,
            assessedValue: money(assessedValue ?? null) ?? undefined,
            marketValue: money(justValue ?? null) ?? undefined,
          },
        });
      } else if (assessedValue != null || justValue != null) {
        await prisma.lot.update({
          where: { id: lot.id },
          data: {
            assessedValue: money(assessedValue ?? null) ?? undefined,
            marketValue: money(justValue ?? null) ?? undefined,
          },
        });
      }
        await applyPaDerivedToLot(lot.id, result.payload as Record<string, unknown>);
        // Persist BCPA RecInfo TRIM / sale instrument links when Broward PA pulled them.
        const extras = (result.payload as { recInfoExtras?: Array<{
          docType: string;
          title?: string;
          sourceUrl: string;
          evidenceNote?: string;
          meta?: Record<string, unknown>;
        }> }).recInfoExtras;
        if (extras?.length) {
          for (const doc of extras) {
            if (!doc.sourceUrl) continue;
            const existingDoc = await prisma.document.findFirst({
              where: { lotId: lot.id, sourceUrl: doc.sourceUrl },
              select: { id: true },
            });
            if (existingDoc) {
              await prisma.document.update({
                where: { id: existingDoc.id },
                data: {
                  docType: doc.docType,
                  title: doc.title ?? undefined,
                  evidenceNote: doc.evidenceNote ?? undefined,
                  searchScope: "bcpa_recinfo",
                  meta: (doc.meta ?? {}) as Prisma.InputJsonValue,
                },
              });
            } else {
              await prisma.document.create({
                data: {
                  lotId: lot.id,
                  docType: doc.docType,
                  title: doc.title ?? null,
                  sourceUrl: doc.sourceUrl,
                  evidenceNote: doc.evidenceNote ?? null,
                  searchScope: "bcpa_recinfo",
                  meta: doc.meta ? (doc.meta as Prisma.InputJsonValue) : undefined,
                },
              });
            }
          }
        }
        ok += 1;
      } else if (result.status === LayerStatus.FAILED) {
        failed += 1;
      } else {
        ok += 1;
      }
    }
    // Follow auction Case#/Parcel links for lots still missing auction_card_links.
    const linkPass = await runAuctionLinkEnrichment(Math.min(limit, 80));
    // Backfill sales/occupancy for lots that already have PA but were stored before derived fields.
    const derived = await runPaDerivedBackfill(Math.max(limit * 3, 200));

    const status = failed && ok ? "PARTIAL" : failed && !ok ? "FAILED" : "SUCCESS";
    await finishRun(run.id, status, {
      ok,
      failed,
      lots: work.length,
      skippedNotConfigured,
      linkLots: linkPass.lots,
      linkEnriched: linkPass.enriched,
      ...derived,
    });
    await markJobFinish(jobKey, status, {
      ok,
      failed,
      lots: work.length,
      skippedNotConfigured,
      linkLots: linkPass.lots,
      linkEnriched: linkPass.enriched,
      ...derived,
    });
    return { ok, failed, skippedNotConfigured, linkPass, ...derived };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishRun(run.id, "FAILED", {}, msg);
    await markJobFinish(jobKey, "FAILED", {}, msg);
    throw e;
  }
}

/** Re-apply PA sales/occupancy; refresh PA JSON when mailing/sales were never stored. */
export async function runPaDerivedBackfill(limit = 250) {
  const layers = await prisma.enrichmentLayer.findMany({
    where: { name: "pa_parcel", status: LayerStatus.OK },
    take: limit,
    orderBy: { fetchedAt: "desc" },
    include: { lot: { select: { id: true, folio: true, folioNormalized: true, county: true } } },
  });
  let refreshed = 0;
  let sales = 0;
  let occupancyPass = 0;
  for (const layer of layers) {
    let payload = (layer.payload ?? {}) as Record<string, unknown>;
    const needsRefresh = payload.mailingAddress == null || payload.salesInfos == null;
    if (needsRefresh && layer.lot.folioNormalized !== "UNKNOWN") {
      const result = await enrichPropertyAppraiserForCounty(layer.lot.county, layer.lot.folio);
      if (result.status === LayerStatus.OK) {
        payload = result.payload as Record<string, unknown>;
        await prisma.enrichmentLayer.update({
          where: { id: layer.id },
          data: {
            payload: result.payload as Prisma.InputJsonValue,
            fetchedAt: new Date(),
            error: result.error ?? null,
          },
        });
        refreshed += 1;
      }
    }
    const applied = await applyPaDerivedToLot(layer.lot.id, payload);
    if (applied.sale) sales += 1;
    if (applied.occupancy !== "unknown") occupancyPass += 1;
  }
  return { derivedLots: layers.length, refreshed, sales, occupancyPass };
}

export async function runMuniEnrichment(limit = 80, jobKey = "enrich_muni_6h") {
  const run = await startRun("ENRICH_MUNI");
  await markJobStart(jobKey);
  try {
    const probe = await probeCcviol();
    if (!probe.ok) {
      for (const key of ["miami_dade_ccviol", "miami_ccviol"] as const) {
        await setResourceStatus({
          key,
          status: ResourceHealth.DOWN,
          detail: "Probe failed",
          lastError: probe.error ?? "down",
        });
      }
      await finishRun(run.id, "FAILED", {}, probe.error);
      await markJobFinish(jobKey, "FAILED", {}, probe.error);
      return { ok: 0, failed: 0, error: probe.error };
    }
    for (const key of ["miami_dade_ccviol", "miami_ccviol"] as const) {
      await setResourceStatus({
        key,
        status: ResourceHealth.OK,
        detail: probe.detail,
        lastError: null,
        success: true,
      });
    }

    const lots = await prisma.lot.findMany({
      take: limit,
      orderBy: { updatedAt: "desc" },
      where: { county: "miami-dade", NOT: { folioNormalized: "UNKNOWN" } },
      include: { property: true },
    });
    let ok = 0;
    let failed = 0;
    let cleared = 0;
    for (const lot of lots) {
      const result = await enrichMuniMd({
        folio: lot.folio,
        city: lot.property?.city,
        address: lot.propertyAddress ?? lot.property?.addressLine,
      });
      await applyMuniDebt(lot.id, result);
      if (result.status === LayerStatus.FAILED) failed += 1;
      else {
        ok += 1;
        if (result.debt.searchScoped && result.debt.amountKind === AmountKind.EXACT_FROM_DOC) cleared += 1;
      }
    }
    const status = failed && ok ? "PARTIAL" : failed ? "FAILED" : "SUCCESS";
    await finishRun(run.id, status, { ok, failed, cleared, lots: lots.length });
    await markJobFinish(jobKey, status, { ok, failed, cleared, lots: lots.length });
    return { ok, failed, cleared };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishRun(run.id, "FAILED", {}, msg);
    await markJobFinish(jobKey, "FAILED", {}, msg);
    throw e;
  }
}

/** Scaffold UNKNOWN inputs if needed, then recompute BidGate for every lot. */
export async function runMethod(limit = 1500, jobKey = "method_nightly") {
  const run = await startRun("METHOD");
  await markJobStart(jobKey);
  try {
    // Prefer upcoming / current sale dates so stale gates on live inventory refresh first.
    const todayCivil = floridaDateISO();
    const todayUtc = new Date(`${todayCivil}T00:00:00.000Z`);
    const upcoming = await prisma.lot.findMany({
      where: { saleDate: { gte: todayUtc } },
      take: limit,
      orderBy: [{ saleDate: "asc" }, { updatedAt: "desc" }],
      include: { debts: true, mortgages: true, risks: true },
    });
    const remaining = Math.max(0, limit - upcoming.length);
    const recentPast =
      remaining > 0
        ? await prisma.lot.findMany({
            where: {
              saleDate: { lt: todayUtc },
              id: { notIn: upcoming.map((l) => l.id) },
            },
            take: remaining,
            orderBy: { updatedAt: "desc" },
            include: { debts: true, mortgages: true, risks: true },
          })
        : [];
    const lots = [...upcoming, ...recentPast];
    let updated = 0;
    let scaffolded = 0;
    let judgmentMortgage = 0;
    for (const lot of lots) {
      await ensureGateScaffold(lot.id);
      scaffolded += 1;
      const jm = await applyJudgmentMortgageEstimate(lot.id);
      if (jm.wrote) judgmentMortgage += 1;
      await syncMortgageDebtFromAssessments(lot.id);
      // Repair older TAX rows: delinquent list was searched but left UNKNOWN/unscoped.
      const taxDebt = await prisma.debtItem.findFirst({
        where: { lotId: lot.id, category: DebtCategory.TAX },
      });
      if (
        taxDebt &&
        taxDebt.amountKind === AmountKind.UNKNOWN &&
        !taxDebt.searchScoped &&
        /not on .+ delinquent|delinquent certificate list/i.test(taxDebt.evidenceNote ?? "")
      ) {
        await prisma.debtItem.update({
          where: { id: taxDebt.id },
          data: {
            amountKind: AmountKind.ESTIMATED_SCENARIO,
            searchScoped: true,
            evidenceNote: `${taxDebt.evidenceNote} · repaired: list searched (live bill still unverified)`,
          },
        });
      }
      // Repair bankruptcy UNKNOWN when OCS already matched (OK) with no bankruptcy mention.
      const ocsLayer = await prisma.enrichmentLayer.findFirst({
        where: { lotId: lot.id, name: "court_ocs" },
        select: { status: true, payload: true },
      });
      const ocsPayload =
        ocsLayer?.payload && typeof ocsLayer.payload === "object"
          ? (ocsLayer.payload as Record<string, unknown>)
          : null;
      const ocsMatched =
        ocsLayer?.status === "OK" ||
        (typeof ocsPayload?.docketCount === "number" && ocsPayload.docketCount > 0);
      if (ocsMatched && ocsPayload?.bankruptcyMention !== true) {
        await prisma.riskCheck.updateMany({
          where: { lotId: lot.id, code: "bankruptcy", result: "UNKNOWN" },
          data: {
            result: "PASS",
            blocksBid: false,
            evidence:
              "OCS docket scanned — no bankruptcy mention (docket-only; repaired from prior enrich)",
            checkedAt: new Date(),
          },
        });
      }
      const working = await prisma.lot.findUniqueOrThrow({
        where: { id: lot.id },
        include: { debts: true, mortgages: true, risks: true },
      });

      const gate = computeBidGate({
        channel: working.channel,
        debts: working.debts.map((d) => ({
          category: d.category,
          amountKind: d.amountKind,
          searchScoped: d.searchScoped,
          amount: d.amount ? Number(d.amount) : null,
        })),
        mortgages: working.mortgages.map((m) => ({ rankLevel: m.rankLevel, satisfied: m.satisfied })),
        risks: working.risks.map((r) => ({ code: r.code, result: r.result, blocksBid: r.blocksBid })),
      });

      await prisma.bidGate.upsert({
        where: { lotId: working.id },
        update: {
          bidAllowed: gate.bidAllowed,
          fillScore: gate.fillScore,
          riskClosed: gate.riskClosed,
          barriers: gate.barriers as unknown as Prisma.InputJsonValue,
          methodVersion: gate.methodVersion,
          computedAt: new Date(),
        },
        create: {
          lotId: working.id,
          bidAllowed: gate.bidAllowed,
          fillScore: gate.fillScore,
          riskClosed: gate.riskClosed,
          barriers: gate.barriers as unknown as Prisma.InputJsonValue,
          methodVersion: gate.methodVersion,
        },
      });

      const ceiling = computeBidCeiling({
        assessedValue: working.assessedValue ? Number(working.assessedValue) : null,
        openingBid: working.openingBid ? Number(working.openingBid) : null,
        judgmentAmount: working.judgmentAmount ? Number(working.judgmentAmount) : null,
        knownDebts: working.debts
          .filter((d) => d.amountKind !== AmountKind.UNKNOWN && d.amount != null)
          .map((d) => Number(d.amount)),
      });

      await prisma.bidCeiling.upsert({
        where: { lotId: working.id },
        update: {
          ceilingAmount: money(ceiling.ceilingAmount),
          paramsVersion: ceiling.paramsVersion,
          assumptions: ceiling.assumptions as Prisma.InputJsonValue,
          computedAt: new Date(),
        },
        create: {
          lotId: working.id,
          ceilingAmount: money(ceiling.ceilingAmount),
          paramsVersion: ceiling.paramsVersion,
          assumptions: ceiling.assumptions as Prisma.InputJsonValue,
        },
      });
      updated += 1;
    }
    await finishRun(run.id, "SUCCESS", { updated, scaffolded, judgmentMortgage });
    await markJobFinish(jobKey, "SUCCESS", { updated, scaffolded, judgmentMortgage });
    return { updated, scaffolded, judgmentMortgage };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishRun(run.id, "FAILED", {}, msg);
    await markJobFinish(jobKey, "FAILED", {}, msg);
    throw e;
  }
}

/** Miami-Dade folio shape (not a court case #) — skip OCS. */
function looksLikeMdFolioCaseId(caseNumber: string): boolean {
  const s = caseNumber.trim();
  return /^\d{2}-\d{4}-\d{3}-\d{4}$/.test(s) || /^\d{13}$/.test(s.replace(/\D/g, ""));
}

/** Prefer court-style case ids (…-CA-… / year-docket) over parcel/folio leftovers. */
function isLikelyMdCourtCase(caseNumber: string): boolean {
  const s = caseNumber.trim().toUpperCase();
  if (!s || s.startsWith("AID")) return false;
  if (looksLikeMdFolioCaseId(s)) return false;
  if (/(?:CA|FC|CC|SC|MH|CP)\b/.test(s)) return true;
  // e.g. 2024-012345-CA-01 already covered; also accept year-leading dockets.
  return /^\d{4}-\d{5,}/.test(s);
}

/** Free OCS docket + optional AuthKey portal probe (Miami-Dade only). */
export async function runCourtOcsEnrichment(limit = 60, jobKey = "enrich_clerk_nightly") {
  const run = await startRun("ENRICH_CLERK");
  await markJobStart(jobKey);
  try {
    const probe = await probeCourtOcs();
    await setResourceStatus({
      key: "miami_dade_clerk_ocs",
      status: probe.ok ? ResourceHealth.OK : ResourceHealth.DOWN,
      detail: probe.detail ?? "OCS probe",
      lastError: probe.ok ? null : probe.error ?? "down",
      success: probe.ok,
    });
    await setResourceStatus({
      key: "miami_clerk_ocs",
      status: probe.ok ? ResourceHealth.OK : ResourceHealth.DOWN,
      detail: probe.detail ?? "OCS probe",
      lastError: probe.ok ? null : probe.error ?? "down",
      success: probe.ok,
    });

    // Honest NOT_CONFIGURED for captcha / unpaid clerk portals outside Miami-Dade.
    for (const key of ["broward_clerk", "palm_beach_clerk", "monroe_clerk"] as const) {
      await setResourceStatus({
        key,
        status: ResourceHealth.NOT_CONFIGURED,
        detail:
          key === "palm_beach_clerk"
            ? "Palm Beach OR (erec) reCAPTCHA on every search — no free path"
            : key === "broward_clerk"
              ? "Broward Official Records not free / captcha — no free path proven"
              : "Monroe Clerk OR not free until proven",
        lastError: null,
      });
    }

    const authKey = process.env.MIAMI_DADE_CLERK_AUTH_KEY;
    if (!authKey) {
      for (const key of ["miami_dade_clerk_api", "miami_clerk_api"] as const) {
        await setResourceStatus({
          key,
          status: ResourceHealth.NOT_CONFIGURED,
          detail: "Optional paid OR API — set MIAMI_DADE_CLERK_AUTH_KEY; free OCS still runs",
          lastError: null,
        });
      }
    } else {
      const apiProbe = await probeClerkApi(authKey);
      for (const key of ["miami_dade_clerk_api", "miami_clerk_api"] as const) {
        await setResourceStatus({
          key,
          status: apiProbe.ok ? ResourceHealth.OK : ResourceHealth.DEGRADED,
          detail: apiProbe.detail ?? "AuthKey configured",
          lastError: apiProbe.ok ? null : apiProbe.error ?? null,
          success: apiProbe.ok,
        });
      }
    }

    if (!probe.ok) {
      await finishRun(run.id, "FAILED", {}, probe.error);
      await markJobFinish(jobKey, "FAILED", {}, probe.error);
      return { ok: 0, failed: 0, error: probe.error };
    }

    const candidates = await prisma.lot.findMany({
      take: Math.max(limit * 4, 120),
      orderBy: { updatedAt: "desc" },
      where: {
        county: "miami-dade",
        channel: "FORECLOSURE",
        NOT: { caseNumber: { startsWith: "AID" } },
      },
    });
    const lots = candidates.filter((l) => isLikelyMdCourtCase(l.caseNumber)).slice(0, limit);
    const skippedBadId = candidates.length - lots.length;
    let ok = 0;
    let failed = 0;
    let unmatched = 0;
    for (const lot of lots) {
      const result = await fetchCourtOcs(lot.caseNumber);
      await applyCourtOcs(lot.id, lot.caseNumber, result);
      if (authKey) {
        await applyClerkAuthNote(
          lot.id,
          "AuthKey present — use Manual DD / paid OR for L2 mortgage proof; OCS used for parties",
        );
      }
      if (result.matched) ok += 1;
      else if (result.error && /HTTP|timeout|fetch/i.test(result.error)) failed += 1;
      else unmatched += 1;
      await new Promise((r) => setTimeout(r, 200));
    }
    const counts = {
      ok,
      failed,
      unmatched,
      skippedBadId,
      lots: lots.length,
      candidates: candidates.length,
    };
    // No court-case ids in the sample is PARTIAL (data shape), not a hard OCS outage.
    const status =
      failed && !ok
        ? "FAILED"
        : failed || unmatched || (lots.length === 0 && skippedBadId > 0)
          ? "PARTIAL"
          : "SUCCESS";
    const errSummary =
      lots.length === 0 && skippedBadId > 0
        ? "no court-style case numbers in sample (folio/parcel ids skipped)"
        : failed
          ? `${failed} OCS transport failures`
          : unmatched
            ? `${unmatched} cases not found in OCS`
            : undefined;
    await finishRun(run.id, status, counts, errSummary);
    await markJobFinish(jobKey, status, counts, errSummary);
    return counts;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishRun(run.id, "FAILED", {}, msg);
    await markJobFinish(jobKey, "FAILED", {}, msg);
    throw e;
  }
}

export async function runFloodEnrichment(limit = 250, jobKey = "enrich_flood_6h") {
  const run = await startRun("ENRICH_PA");
  await markJobStart(jobKey);
  try {
    const mdProbe = await probeFlood();
    await setResourceStatus({
      key: "miami_dade_fema_flood",
      status: mdProbe.ok ? ResourceHealth.OK : ResourceHealth.DOWN,
      detail: mdProbe.detail ?? "FEMA probe",
      lastError: mdProbe.ok ? null : mdProbe.error ?? "down",
      success: mdProbe.ok,
    });
    await setResourceStatus({
      key: "miami_fema_flood",
      status: mdProbe.ok ? ResourceHealth.OK : ResourceHealth.DOWN,
      detail: mdProbe.detail ?? "FEMA probe",
      lastError: mdProbe.ok ? null : mdProbe.error ?? "down",
      success: mdProbe.ok,
    });

    const nfhl = await probeNfhl();
    for (const key of ["broward_fema_flood", "palm_beach_fema_flood", "monroe_fema_flood"]) {
      await setResourceStatus({
        key,
        status: nfhl.ok ? ResourceHealth.OK : ResourceHealth.DOWN,
        detail: nfhl.detail ?? "NFHL probe",
        lastError: nfhl.ok ? null : nfhl.error ?? "down",
        success: nfhl.ok,
      });
    }

    if (!mdProbe.ok && !nfhl.ok) {
      const err = mdProbe.error || nfhl.error || "flood probes failed";
      await finishRun(run.id, "FAILED", {}, err);
      await markJobFinish(jobKey, "FAILED", {}, err);
      return { ok: 0, failed: 0, error: err };
    }
    const counties = resolveActiveCounties(process.env.LR_ACTIVE_COUNTIES);
    const perCounty = Math.max(40, Math.ceil(limit / Math.max(counties.length, 1)));
    const lots: Array<{
      id: string;
      county: string;
      property: { lat: number | null; lng: number | null } | null;
    }> = [];
    for (const county of counties) {
      const base = {
        county,
        property: { is: { lat: { not: null }, lng: { not: null } } },
      };
      const missing = await prisma.lot.findMany({
        take: perCounty,
        orderBy: { updatedAt: "desc" },
        where: { ...base, layers: { none: { name: "flood" } } },
        include: { property: { select: { lat: true, lng: true } } },
      });
      lots.push(...missing);
      const remain = perCounty - missing.length;
      if (remain <= 0) continue;
      const refresh = await prisma.lot.findMany({
        take: remain,
        orderBy: { updatedAt: "desc" },
        where: {
          ...base,
          layers: { some: { name: "flood", status: { in: ["STALE", "FAILED", "PARTIAL"] } } },
        },
        include: { property: { select: { lat: true, lng: true } } },
      });
      lots.push(...refresh);
    }
    const work = lots.slice(0, limit);
    let ok = 0;
    let failed = 0;
    for (const lot of work) {
      const r = await enrichFlood(lot.id, lot.property?.lat, lot.property?.lng, lot.county);
      if (r.ok) ok += 1;
      else failed += 1;
    }
    const status = failed && ok ? "PARTIAL" : failed && !ok ? "FAILED" : "SUCCESS";
    await finishRun(run.id, status, { ok, failed, lots: work.length });
    await markJobFinish(jobKey, status, { ok, failed, lots: work.length });
    return { ok, failed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishRun(run.id, "FAILED", {}, msg);
    await markJobFinish(jobKey, "FAILED", {}, msg);
    throw e;
  }
}

/** @deprecated name kept for job key — delegates to free OCS + AuthKey probe */
export async function runClerkEnrichment(jobKey = "enrich_clerk_nightly") {
  return runCourtOcsEnrichment(60, jobKey);
}

async function probePalmBeachTaxPublic(): Promise<{ ok: boolean; error?: string; detail?: string }> {
  try {
    const res = await fetch("https://pbctax.publicaccessnow.com/", {
      headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 (compatible; LienRadar/1.0)" },
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, error: `Palm Beach tax HTTP ${res.status}` };
    return { ok: true, detail: `pbctax.publicaccessnow.com reachable (HTTP ${res.status}) — bill-by-folio not wired yet` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runTaxCollectorEnrichment(jobKey = "enrich_tax_nightly", limit = 200) {
  const run = await startRun("ENRICH_TAX");
  await markJobStart(jobKey);
  try {
    // Broward / Monroe GovHub — honest NOT_CONFIGURED (Turnstile).
    for (const key of ["broward_tax_collector", "monroe_tax_collector"] as const) {
      await setResourceStatus({
        key,
        status: ResourceHealth.NOT_CONFIGURED,
        detail: "GovHub Turnstile-gated — no free delinquent path without unlock",
        lastError: null,
      });
    }

    const pbTax = await probePalmBeachTaxPublic();
    await setResourceStatus({
      key: "palm_beach_tax_collector",
      status: pbTax.ok ? ResourceHealth.DEGRADED : ResourceHealth.DOWN,
      detail: pbTax.detail ?? pbTax.error ?? "Palm Beach tax probe",
      lastError: pbTax.ok ? null : pbTax.error ?? "down",
      success: pbTax.ok,
    });

    const probe = await probeTaxDelinquent();
    if (!probe.ok) {
      for (const key of ["miami_dade_tax_collector", "miami_tax_collector"] as const) {
        await setResourceStatus({
          key,
          status: ResourceHealth.DOWN,
          detail: "Delinquent list PDF unreachable",
          lastError: probe.error ?? "down",
        });
      }
      await finishRun(run.id, "PARTIAL", {}, probe.error);
      await markJobFinish(jobKey, "PARTIAL", {}, probe.error);
      return { ok: false, error: probe.error, palmBeach: pbTax.ok };
    }

    const index = await loadDelinquentIndex(false);
    for (const key of ["miami_dade_tax_collector", "miami_tax_collector"] as const) {
      await setResourceStatus({
        key,
        status: ResourceHealth.DEGRADED,
        detail: `Delinquent list ${index.published}: ${index.rows} rows parsed; live bill still GovHub-login-gated`,
        lastError: null,
        success: true,
      });
    }

    const lots = await prisma.lot.findMany({
      where: { county: "miami-dade", NOT: { folioNormalized: "UNKNOWN" } },
      take: limit,
      orderBy: { saleDate: "asc" },
    });
    let listed = 0;
    let notListed = 0;
    for (const lot of lots) {
      const decision = decideTaxFromDelinquent(lot.folio, index);
      await applyTaxDebt(lot.id, decision);
      if (decision.listed) listed += 1;
      else notListed += 1;
    }

    const counts = {
      lots: lots.length,
      listed,
      notListed,
      indexRows: index.rows,
      unparsed: index.unparsed,
      palmBeachProbeOk: pbTax.ok ? 1 : 0,
    };
    await finishRun(run.id, "PARTIAL", counts, "live_bill_login_gated; delinquent_list_applied");
    await markJobFinish(jobKey, "PARTIAL", counts, "live_bill_login_gated; delinquent_list_applied");
    return { ok: true, ...counts };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const key of ["miami_dade_tax_collector", "miami_tax_collector"] as const) {
      await setResourceStatus({
        key,
        status: ResourceHealth.DOWN,
        detail: "Tax enrich failed",
        lastError: msg,
      });
    }
    await finishRun(run.id, "FAILED", {}, msg);
    await markJobFinish(jobKey, "FAILED", {}, msg);
    return { ok: false, error: msg };
  }
}

export async function runFolioAttach(jobKey = "enrich_folio_6h", limit = 40) {
  const run = await startRun("ENRICH_PA");
  await markJobStart(jobKey);
  try {
    const result = await runFolioAttachPass(limit);
    for (const key of ["miami_dade_pa_json", "miami_pa_json"] as const) {
      await setResourceStatus({
        key,
        status: ResourceHealth.OK,
        detail: `Folio attach pass: attached=${result.attached} ambiguous=${result.ambiguous} failed=${result.failed}`,
        lastError: null,
        success: true,
      });
    }
    await finishRun(run.id, result.attached || result.scanned === 0 ? "SUCCESS" : "PARTIAL", result);
    await markJobFinish(jobKey, result.attached || result.scanned === 0 ? "SUCCESS" : "PARTIAL", result);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishRun(run.id, "FAILED", {}, msg);
    await markJobFinish(jobKey, "FAILED", {}, msg);
    return { ok: false, error: msg };
  }
}

export async function runOfficialRecordsEnrichment(jobKey = "enrich_or_nightly", limit = 25) {
  const run = await startRun("ENRICH_CLERK");
  await markJobStart(jobKey);
  try {
    const probe = await probeOfficialRecords();
    for (const key of ["miami_dade_official_records", "miami_official_records"] as const) {
      await setResourceStatus({
        key,
        status: probe.ok
          ? probe.mode === "authkey"
            ? ResourceHealth.OK
            : ResourceHealth.DEGRADED
          : ResourceHealth.DOWN,
        detail: probe.detail ?? probe.error ?? undefined,
        lastError: probe.error ?? null,
        success: probe.ok,
      });
    }
    if (!probe.ok) {
      await finishRun(run.id, "FAILED", {}, probe.error);
      await markJobFinish(jobKey, "FAILED", {}, probe.error);
      return { ok: false, error: probe.error };
    }

    // Public OR SPA often needs registration/verification — sample a few, fail soft.
    // Never fall back to plaintiff (creditor/bank) — that searches the wrong party.
    // Miami-Dade only — other counties have captcha OR portals.
    const lots = await prisma.lot.findMany({
      where: {
        county: "miami-dade",
        channel: "FORECLOSURE",
        property: { ownerName: { not: null } },
      },
      include: { property: true },
      take: Math.min(limit, 8),
      orderBy: { saleDate: "asc" },
    });
    let ok = 0;
    let failed = 0;
    let mortgageHits = 0;
    let formMissing = 0;
    for (const lot of lots) {
      const owner = lot.property?.ownerName?.trim() || null;
      try {
        const r = await applyOfficialRecordsMortgage(lot.id, owner);
        if (r.ok) ok += 1;
        else failed += 1;
        mortgageHits += r.mortgageHits ?? 0;
        if (!r.ok && !r.skipped && (r.mortgageHits ?? 0) === 0) formMissing += 1;
        // If public form is unusable, stop burning browser sessions.
        if (formMissing >= 2 && mortgageHits === 0) break;
      } catch {
        failed += 1;
      }
    }
    const orStatus =
      mortgageHits > 0
        ? ResourceHealth.OK
        : process.env.MIAMI_DADE_CLERK_AUTH_KEY?.trim()
          ? ResourceHealth.DEGRADED
          : ResourceHealth.NOT_CONFIGURED;
    const orDetail =
      mortgageHits > 0
        ? `Public OR hits=${mortgageHits}`
        : "Public OR SPA needs registration/verification for useful MOR search; set MIAMI_DADE_CLERK_AUTH_KEY for FTP index (paid). OCS L1 + Manual DD remain available.";
    for (const key of ["miami_dade_official_records", "miami_official_records"] as const) {
      await setResourceStatus({
        key,
        status: orStatus,
        detail: orDetail,
        lastError: null,
        success: mortgageHits > 0,
      });
    }
    const counts = { lots: lots.length, ok, failed, mortgageHits };
    await finishRun(run.id, "PARTIAL", counts, `mode=${probe.mode}`);
    await markJobFinish(jobKey, "PARTIAL", counts, `mode=${probe.mode}`);
    return { ...counts, mode: probe.mode };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishRun(run.id, "FAILED", {}, msg);
    await markJobFinish(jobKey, "FAILED", {}, msg);
    return { ok: false, error: msg };
  }
}

export async function runHealth() {
  const run = await startRun("HEALTH");
  const lotCount = await prisma.lot.count();
  const resources = await prisma.dataResource.count();
  await finishRun(run.id, "SUCCESS", { lotCount, resources });
  return { lotCount, resources };
}

export async function runJob(jobKey: string) {
  switch (jobKey) {
    case "calendar_6h":
    case "day_refresh_30m":
      return runCalendarAndLots(jobKey);
    case "enrich_pa_6h":
      return runPaEnrichment(250, jobKey);
    case "enrich_folio_6h":
      return runFolioAttach(jobKey, 40);
    case "enrich_muni_6h":
      return runMuniEnrichment(80, jobKey);
    case "enrich_flood_6h":
      return runFloodEnrichment(250, jobKey);
    case "enrich_clerk_nightly":
      return runCourtOcsEnrichment(60, jobKey);
    case "enrich_or_nightly":
      return runOfficialRecordsEnrichment(jobKey, 40);
    case "enrich_tax_nightly":
      return runTaxCollectorEnrichment(jobKey, 250);
    case "method_nightly":
      return runMethod(500, jobKey);
    case "nightly": {
      await markJobStart("nightly");
      try {
        const health = await runHealth();
        const calendar = await runCalendarAndLots("calendar_6h");
        const folio = await runFolioAttach("enrich_folio_6h", 40);
        const enrich = await runPaEnrichment(250, "enrich_pa_6h");
        const links = await runAuctionLinkEnrichment(100);
        const muni = await runMuniEnrichment(80, "enrich_muni_6h");
        const flood = await runFloodEnrichment(250, "enrich_flood_6h");
        const clerk = await runCourtOcsEnrichment(80, "enrich_clerk_nightly");
        const tax = await runTaxCollectorEnrichment("enrich_tax_nightly", 250);
        const method = await runMethod(500, "method_nightly");
        const counts = {
          lotCount: health.lotCount,
          taxLots: calendar.taxLots,
          fcLots: calendar.fcLots,
          folioAttached: (folio as { attached?: number }).attached ?? 0,
          paOk: enrich.ok ?? 0,
          linkEnriched: links.enriched ?? 0,
          muniOk: muni.ok ?? 0,
          floodOk: flood.ok ?? 0,
          ocsOk: clerk.ok ?? 0,
          taxListed: (tax as { listed?: number }).listed ?? 0,
          methodUpdated: method.updated,
        };
        await markJobFinish("nightly", "SUCCESS", counts);
        return { health, calendar, folio, enrich, muni, flood, clerk, tax, method };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await markJobFinish("nightly", "FAILED", {}, msg);
        throw e;
      }
    }
    case "all": {
      const health = await runHealth();
      const calendar = await runCalendarAndLots("calendar_6h");
      const folio = await runFolioAttach("enrich_folio_6h", 40);
      const enrich = await runPaEnrichment(250, "enrich_pa_6h");
      const muni = await runMuniEnrichment(80, "enrich_muni_6h");
      const flood = await runFloodEnrichment(250, "enrich_flood_6h");
      const clerk = await runCourtOcsEnrichment(40, "enrich_clerk_nightly");
      const tax = await runTaxCollectorEnrichment("enrich_tax_nightly", 250);
      const or = await runOfficialRecordsEnrichment("enrich_or_nightly", 15);
      const method = await runMethod(500);
      return { health, calendar, folio, enrich, muni, flood, clerk, tax, or, method };
    }
    default:
      throw new Error(`Unknown job: ${jobKey}`);
  }
}
