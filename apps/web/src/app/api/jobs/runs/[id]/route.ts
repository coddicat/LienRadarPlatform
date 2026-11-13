import { prisma } from "@lienradar/db";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

const LAYER_BY_STAGE: Record<string, string[]> = {
  // Calendar also runs auction_card_links inline.
  CALENDAR: ["auction_card_links"],
  // Flood + folio currently reuse ENRICH_PA stage in pipeline.
  ENRICH_PA: ["pa_parcel", "occupancy_proxy", "folio_resolve", "flood"],
  ENRICH_MUNI: ["muni_flags"],
  ENRICH_CLERK: ["court_ocs", "clerk_api", "official_records"],
  ENRICH_TAX: ["tax_status"],
  METHOD: ["mortgage_judgment_l1"],
  HEALTH: [],
};

function windowEnd(startedAt: Date, finishedAt: Date | null, status: string): Date {
  if (finishedAt) return new Date(finishedAt.getTime() + 2_000);
  if (status === "RUNNING") return new Date();
  return new Date(startedAt.getTime() + 3 * 60 * 60 * 1000);
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const run = await prisma.ingestRun.findUnique({ where: { id } });
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const from = run.startedAt;
  const to = windowEnd(run.startedAt, run.finishedAt, run.status);
  const layerNames = LAYER_BY_STAGE[run.stage] ?? [];
  const includeObservations = run.stage === "CALENDAR" || run.stage === "LOTS";

  const [observations, layers, documents, lotEvents] = await Promise.all([
    includeObservations
      ? prisma.rawObservation.findMany({
      where: { fetchedAt: { gte: from, lte: to } },
      orderBy: { fetchedAt: "desc" },
      take: 150,
      select: {
        id: true,
        source: true,
        externalId: true,
        fetchedAt: true,
        contentHash: true,
        payload: true,
        lot: {
          select: {
            id: true,
            caseNumber: true,
            folio: true,
            county: true,
            channel: true,
            propertyAddress: true,
            saleDate: true,
          },
        },
      },
    })
      : Promise.resolve([]),
    layerNames.length
      ? prisma.enrichmentLayer.findMany({
          where: {
            name: { in: layerNames },
            fetchedAt: { gte: from, lte: to },
          },
          orderBy: { fetchedAt: "desc" },
          take: 150,
          select: {
            id: true,
            name: true,
            status: true,
            fetchedAt: true,
            error: true,
            payload: true,
            lot: {
              select: {
                id: true,
                caseNumber: true,
                folio: true,
                county: true,
                channel: true,
                propertyAddress: true,
              },
            },
          },
        })
      : Promise.resolve([]),
    prisma.document.findMany({
      where: {
        updatedAt: { gte: from, lte: to },
      },
      orderBy: { updatedAt: "desc" },
      take: 150,
      select: {
        id: true,
        docType: true,
        title: true,
        sourceUrl: true,
        searchScope: true,
        evidenceNote: true,
        updatedAt: true,
        meta: true,
        lot: {
          select: {
            id: true,
            caseNumber: true,
            folio: true,
            propertyAddress: true,
          },
        },
      },
    }),
    prisma.lotEvent.findMany({
      where: {
        createdAt: { gte: from, lte: to },
        kind: { in: ["ingest_create", "ingest_change"] },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        kind: true,
        message: true,
        createdAt: true,
        payload: true,
        lot: {
          select: {
            id: true,
            caseNumber: true,
            folio: true,
            propertyAddress: true,
          },
        },
      },
    }),
  ]);

  function summarizePayload(payload: unknown): string {
    if (payload == null) return "—";
    if (typeof payload !== "object") return String(payload);
    const o = payload as Record<string, unknown>;
    const bits: string[] = [];
    for (const key of [
      "address",
      "folio",
      "status",
      "guess",
      "mode",
      "hitCount",
      "mortgageHitCount",
      "dorDescription",
      "improvementModelDesc",
      "zone",
      "detail",
      "note",
    ]) {
      if (o[key] != null && o[key] !== "") bits.push(`${key}=${String(o[key])}`);
    }
    if (Array.isArray(o.salesInfos)) bits.push(`sales=${o.salesInfos.length}`);
    if (Array.isArray(o.buildingInfos)) bits.push(`buildings=${o.buildingInfos.length}`);
    if (o.land && typeof o.land === "object") {
      const land = o.land as Record<string, unknown>;
      if (land.address) bits.push(`land.addr=${String(land.address)}`);
      if (land.totalValue != null) bits.push(`totalValue=${String(land.totalValue)}`);
    }
    if (o.sale && typeof o.sale === "object") {
      const sale = o.sale as Record<string, unknown>;
      if (sale.orBook && sale.orPage) bits.push(`OR ${sale.orBook}/${sale.orPage}`);
      if (sale.salePrice != null) bits.push(`salePrice=${String(sale.salePrice)}`);
    }
    if (!bits.length) {
      const keys = Object.keys(o).slice(0, 8);
      return keys.length ? `keys: ${keys.join(", ")}` : "—";
    }
    return bits.slice(0, 8).join(" · ");
  }

  return NextResponse.json({
    run: {
      id: run.id,
      stage: run.stage,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      counts: run.counts,
      errorSummary: run.errorSummary,
      notes: run.notes,
    },
    window: { from: from.toISOString(), to: to.toISOString() },
    observations: observations.map((o) => {
      const p = o.payload && typeof o.payload === "object" ? (o.payload as Record<string, unknown>) : {};
      return {
        id: o.id,
        source: o.source,
        externalId: o.externalId,
        fetchedAt: o.fetchedAt.toISOString(),
        contentHash: o.contentHash,
        lotId: o.lot?.id ?? null,
        caseNumber: o.lot?.caseNumber ?? null,
        folio: o.lot?.folio ?? null,
        county: o.lot?.county ?? null,
        channel: o.lot?.channel ?? null,
        address: o.lot?.propertyAddress ?? null,
        saleDate: o.lot?.saleDate?.toISOString().slice(0, 10) ?? null,
        summary: summarizePayload(o.payload),
        openingBid: p.openingBid ?? p.OpeningBid ?? null,
        assessed: p.assessedValue ?? p.AssessedValue ?? null,
        payload: o.payload,
      };
    }),
    layers: layers.map((l) => ({
      id: l.id,
      name: l.name,
      status: l.status,
      fetchedAt: l.fetchedAt.toISOString(),
      error: l.error,
      lotId: l.lot?.id ?? null,
      caseNumber: l.lot?.caseNumber ?? null,
      folio: l.lot?.folio ?? null,
      county: l.lot?.county ?? null,
      channel: l.lot?.channel ?? null,
      address: l.lot?.propertyAddress ?? null,
      summary: summarizePayload(l.payload),
      payload: l.payload,
    })),
    documents: documents.map((d) => ({
      id: d.id,
      docType: d.docType,
      title: d.title,
      sourceUrl: d.sourceUrl,
      searchScope: d.searchScope,
      evidenceNote: d.evidenceNote,
      updatedAt: d.updatedAt.toISOString(),
      lotId: d.lot?.id ?? null,
      caseNumber: d.lot?.caseNumber ?? null,
      folio: d.lot?.folio ?? null,
      address: d.lot?.propertyAddress ?? null,
      meta: d.meta,
    })),
    lotEvents: lotEvents.map((e) => ({
      id: e.id,
      kind: e.kind,
      message: e.message,
      createdAt: e.createdAt.toISOString(),
      lotId: e.lot?.id ?? null,
      caseNumber: e.lot?.caseNumber ?? null,
      folio: e.lot?.folio ?? null,
      address: e.lot?.propertyAddress ?? null,
      payload: e.payload,
    })),
  });
}
