import { LayerStatus } from "@lienradar/shared";
import { Prisma, prisma } from "@lienradar/db";

/**
 * Follow RealAuction preview outbound links (Case # / Parcel ID) and pull public metadata.
 * Fail closed on Cloudflare / captcha — store what we can, never invent.
 */

function money(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number(String(s).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchHtml(url: string): Promise<{ ok: boolean; status: number; html: string; blocked: boolean }> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (compatible; LienRadar/1.0; +auction-card-link-enrich)",
      },
      signal: AbortSignal.timeout(35_000),
      redirect: "follow",
    });
    const html = await res.text();
    const blocked =
      res.status === 403 ||
      /cloudflare|attention required|captcha|access denied/i.test(html.slice(0, 2000));
    return { ok: res.ok && !blocked, status: res.status, html, blocked };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      html: "",
      blocked: false,
    };
  }
}

export type LinkEnrichResult = {
  status: typeof LayerStatus.OK | typeof LayerStatus.PARTIAL | typeof LayerStatus.FAILED;
  payload: Record<string, unknown>;
  error?: string;
  propertyPatch?: {
    ownerName?: string;
    addressLine?: string;
    city?: string;
    zip?: string;
    beds?: number;
    baths?: number;
    yearBuilt?: number;
    assessedValue?: number;
    marketValue?: number;
    livingSqft?: number;
  };
  extraDocs?: Array<{
    docType: string;
    title?: string;
    sourceUrl: string;
    evidenceNote?: string;
    meta?: Record<string, unknown>;
  }>;
};

/** Broward BCPA RecInfo.asp — free HTML with owner, beds, values, TRIM PDF, sale instruments. */
export async function enrichBcpaRecInfo(url: string): Promise<LinkEnrichResult> {
  const fetched = await fetchHtml(url);
  if (!fetched.ok) {
    return {
      status: fetched.blocked ? LayerStatus.FAILED : LayerStatus.PARTIAL,
      payload: { url, http: fetched.status, blocked: fetched.blocked },
      error: fetched.blocked ? "bcpa_cloudflare_or_blocked" : `bcpa HTTP ${fetched.status}`,
    };
  }
  const html = fetched.html;
  const text = stripHtml(html);

  const owner =
    html.match(/Property Owner[\s\S]*?<SPAN[^>]*>\s*([^<]+)/i)?.[1]?.trim() ||
    text.match(/Property Owner\s+([A-Z0-9][^0-9]{2,80}?)\s+Mailing Address/i)?.[1]?.trim() ||
    null;

  const addressLine =
    text.match(/Property Address\s+(.+?)\s+Property Owner/i)?.[1]?.trim() || null;

  const bedsBaths = text.match(/Units\/Beds\/Baths\s+(\d+)\s*\/\s*(\d+)\s*\/\s*([\d.]+)/i);
  const beds = bedsBaths ? Number(bedsBaths[2]) : null;
  const baths = bedsBaths ? Number(bedsBaths[3]) : null;

  const yearBuiltRaw = text.match(/Eff\.\/Act\.\s*Year Built:\s*(\d{4})\s*\/\s*(\d{4})/i);
  const yearBuilt = yearBuiltRaw ? Number(yearBuiltRaw[2] || yearBuiltRaw[1]) : null;

  // Prefer latest assessment year row: Just / Market then Assessed
  const justVals = [...text.matchAll(/\$([\d,]+)\s+\$([\d,]+)\s+\$([\d,]+\.\d{2})/g)];
  // Fallback: pull Just / Market Value column loosely
  const marketMatch = text.match(/Just\s*\/\s*Market Value[\s\S]{0,200}?\$([\d,]+)/i);
  const assessedMatch = text.match(/Assessed\s*\/\s*SOH Value[\s\S]{0,200}?\$([\d,]+)/i);
  const marketValue = money(marketMatch?.[1] ?? null);
  const assessedValue = money(assessedMatch?.[1] ?? null) ?? marketValue;

  // City/zip from address line
  let city: string | undefined;
  let zip: string | undefined;
  if (addressLine) {
    const zm = addressLine.match(/\b(\d{5})(?:-\d{4})?\b/);
    zip = zm?.[1];
    city = addressLine
      .replace(/\bFL\b/gi, "")
      .replace(/\b\d{5}(?:-\d{4})?\b/, "")
      .replace(/,/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(/\s+/)
      .slice(-3)
      .join(" ");
    // Prefer city token before zip in "..., POMPANO BEACH FL 33064"
    const cityZip = addressLine.match(/,\s*([^,]+?)\s+FL\s+(\d{5})/i);
    if (cityZip) {
      city = cityZip[1].trim();
      zip = cityZip[2];
    }
  }

  const trimHref = html.match(/href\s*=\s*["']([^"']*trims?[^"']+\.pdf)["']/i)?.[1];
  const trimUrl = trimHref
    ? trimHref.startsWith("http")
      ? trimHref
      : `https://bcpa.net${trimHref.startsWith("/") ? "" : "/"}${trimHref}`
    : null;

  const instrumentUrls = [
    ...html.matchAll(
      /href\s*=\s*["'](https?:\/\/officialrecords\.broward\.org[^"']+)["']/gi,
    ),
  ].map((m) => m[1]);

  const extraDocs: LinkEnrichResult["extraDocs"] = [];
  if (trimUrl) {
    extraDocs.push({
      docType: "bcpa_trim_notice",
      title: "BCPA TRIM Notice",
      sourceUrl: trimUrl,
      evidenceNote: "Linked from BCPA RecInfo (parcel appraiser page)",
      meta: { source: "bcpa_recinfo" },
    });
  }
  for (const u of [...new Set(instrumentUrls)].slice(0, 8)) {
    const inst = u.match(/InstrumentNumber\/O\/(\d+)/i)?.[1] || u.match(/BookPage\/O\/(\d+)\/(\d+)/i)?.[0];
    extraDocs.push({
      docType: "bcpa_sale_instrument",
      title: inst ? `Instrument ${inst}` : "BCPA sale instrument",
      sourceUrl: u,
      evidenceNote: "Sale/transfer instrument linked from BCPA RecInfo",
      meta: { source: "bcpa_recinfo" },
    });
  }

  return {
    status: LayerStatus.OK,
    payload: {
      url,
      owner,
      addressLine,
      beds,
      baths,
      yearBuilt,
      assessedValue,
      marketValue,
      justSampleRows: justVals.slice(0, 3).map((m) => m[0]),
      trimUrl,
      instrumentCount: instrumentUrls.length,
      textHead: text.slice(0, 400),
    },
    propertyPatch: {
      ownerName: owner || undefined,
      addressLine: addressLine || undefined,
      city,
      zip,
      beds: beds != null && Number.isFinite(beds) ? beds : undefined,
      baths: baths != null && Number.isFinite(baths) ? baths : undefined,
      yearBuilt: yearBuilt != null && Number.isFinite(yearBuilt) ? yearBuilt : undefined,
      assessedValue: assessedValue ?? undefined,
      marketValue: marketValue ?? undefined,
    },
    extraDocs,
  };
}

/** Broward Official Records instrument page — metadata only (images often Cloudflare-gated). */
export async function enrichBrowardOrInstrument(url: string): Promise<LinkEnrichResult> {
  const fetched = await fetchHtml(url);
  if (!fetched.ok) {
    return {
      status: fetched.blocked ? LayerStatus.FAILED : LayerStatus.PARTIAL,
      payload: { url, http: fetched.status, blocked: fetched.blocked },
      error: fetched.blocked ? "broward_or_cloudflare" : `broward OR HTTP ${fetched.status}`,
    };
  }
  const text = stripHtml(fetched.html);
  const instrument = text.match(/Instrument Number:\s*(\d+)/i)?.[1] ?? null;
  const docType = text.match(/Doc Type:\s*([A-Z0-9][^\n]{0,80}?)(?:\s+From:|$)/i)?.[1]?.trim() ?? null;
  const pages = text.match(/Number Of Pages:\s*(\d+)/i)?.[1] ?? null;
  const recorded = text.match(/Record Date:\s*([0-9/:\sAPMapm]+)/i)?.[1]?.trim() ?? null;
  const fromParty = text.match(/From:\s*(.+?)\s+To:/i)?.[1]?.trim() ?? null;
  const toParty = text.match(/To:\s*(.+?)\s+Case Number:/i)?.[1]?.trim() ?? null;
  const caseNumber = text.match(/Case Number:\s*([A-Z0-9-]+)/i)?.[1]?.trim() ?? null;

  return {
    status: LayerStatus.OK,
    payload: {
      url,
      instrument,
      docType,
      pages: pages ? Number(pages) : null,
      recorded,
      fromParty,
      toParty,
      caseNumber,
      textHead: text.slice(0, 500),
    },
  };
}

/** Palm Beach PA details — owner/address confirmation + any document links. */
export async function enrichPalmBeachPaDetails(url: string): Promise<LinkEnrichResult> {
  const fetched = await fetchHtml(url);
  if (!fetched.ok) {
    return {
      status: LayerStatus.PARTIAL,
      payload: { url, http: fetched.status, blocked: fetched.blocked },
      error: `pbcpao HTTP ${fetched.status}`,
    };
  }
  const text = stripHtml(fetched.html);
  const address =
    text.match(/LOCATION ADDRESS\s+(.+?)\s+MUNICIPALITY/i)?.[1]?.trim() ||
    text.match(/PAPA\s*-\s*(.+)$/i)?.[1]?.trim() ||
    null;
  const owner =
    text.match(/OWNER NAME\s+(.+?)\s+(?:MAILING|EXEMPTION|SALES)/i)?.[1]?.trim() || null;
  const city =
    text.match(/MUNICIPALITY\s+(.+?)\s+PARCEL/i)?.[1]?.trim() || null;

  return {
    status: LayerStatus.OK,
    payload: { url, address, owner, city, textHead: text.slice(0, 400) },
    propertyPatch: {
      ownerName: owner || undefined,
      addressLine: address || undefined,
      city: city && city !== "UNINCORPORATED" ? city : undefined,
    },
  };
}

function moneyDec(n: number | null | undefined): string | null {
  if (n == null || Number.isNaN(n)) return null;
  return n.toFixed(2);
}

async function upsertExtraDocs(
  lotId: string,
  docs: NonNullable<LinkEnrichResult["extraDocs"]>,
) {
  for (const doc of docs) {
    const existing = await prisma.document.findFirst({
      where: { lotId, sourceUrl: doc.sourceUrl },
      select: { id: true },
    });
    if (existing) {
      await prisma.document.update({
        where: { id: existing.id },
        data: {
          docType: doc.docType,
          title: doc.title ?? undefined,
          evidenceNote: doc.evidenceNote ?? undefined,
          meta: (doc.meta ?? {}) as Prisma.InputJsonValue,
        },
      });
    } else {
      await prisma.document.create({
        data: {
          lotId,
          docType: doc.docType,
          title: doc.title ?? null,
          sourceUrl: doc.sourceUrl,
          evidenceNote: doc.evidenceNote ?? null,
          searchScope: "auction_link_enrich",
          meta: doc.meta ? (doc.meta as Prisma.InputJsonValue) : undefined,
        },
      });
    }
  }
}

async function applyPropertyPatch(
  lotId: string,
  county: string,
  folio: string,
  folioNormalized: string,
  patch: NonNullable<LinkEnrichResult["propertyPatch"]>,
) {
  if (!folioNormalized || folioNormalized === "UNKNOWN") return;
  const property = await prisma.property.upsert({
    where: { county_folioNormalized: { county, folioNormalized } },
    update: {
      ownerName: patch.ownerName || undefined,
      addressLine: patch.addressLine || undefined,
      city: patch.city || undefined,
      zip: patch.zip || undefined,
      beds: patch.beds ?? undefined,
      baths: patch.baths ?? undefined,
      yearBuilt: patch.yearBuilt ?? undefined,
      livingSqft: patch.livingSqft ?? undefined,
      assessedValue: moneyDec(patch.assessedValue ?? null) ?? undefined,
      marketValue: moneyDec(patch.marketValue ?? null) ?? undefined,
      justValue: moneyDec(patch.marketValue ?? null) ?? undefined,
    },
    create: {
      county,
      folio,
      folioNormalized,
      ownerName: patch.ownerName,
      addressLine: patch.addressLine,
      city: patch.city,
      zip: patch.zip,
      beds: patch.beds,
      baths: patch.baths,
      yearBuilt: patch.yearBuilt,
      livingSqft: patch.livingSqft,
      assessedValue: moneyDec(patch.assessedValue ?? null),
      marketValue: moneyDec(patch.marketValue ?? null),
      justValue: moneyDec(patch.marketValue ?? null),
    },
  });
  await prisma.lot.update({
    where: { id: lotId },
    data: {
      propertyId: property.id,
      propertyAddress: patch.addressLine || undefined,
      assessedValue: moneyDec(patch.assessedValue ?? null) ?? undefined,
      marketValue: moneyDec(patch.marketValue ?? null) ?? undefined,
    },
  });
}

/** Enrich one lot from its auction_preview_link documents. */
export async function enrichLotAuctionLinks(lotId: string): Promise<{
  ok: boolean;
  enriched: number;
  failed: number;
}> {
  const lot = await prisma.lot.findUnique({
    where: { id: lotId },
    select: {
      id: true,
      county: true,
      folio: true,
      folioNormalized: true,
      documents: {
        where: {
          OR: [
            { searchScope: "auction_preview_link" },
            { docType: { in: ["auction_case_instrument", "auction_parcel_appraiser", "auction_case_link"] } },
          ],
        },
        select: { id: true, docType: true, sourceUrl: true, meta: true },
      },
    },
  });
  if (!lot) return { ok: false, enriched: 0, failed: 0 };

  let enriched = 0;
  let failed = 0;
  const results: Record<string, unknown>[] = [];

  for (const doc of lot.documents) {
    if (!doc.sourceUrl) continue;
    const url = doc.sourceUrl;
    let result: LinkEnrichResult | null = null;

    if (/bcpa\.net\/RecInfo/i.test(url)) {
      result = await enrichBcpaRecInfo(url);
    } else if (/officialrecords\.broward\.org/i.test(url)) {
      result = await enrichBrowardOrInstrument(url);
    } else if (/pbcpao\.gov\/Property\/Details/i.test(url)) {
      result = await enrichPalmBeachPaDetails(url);
    } else if (/erec\.mypalmbeachclerk\.com/i.test(url)) {
      // Landmark SPA — store probe-only note; image viewer is session-bound.
      result = {
        status: LayerStatus.PARTIAL,
        payload: {
          url,
          note: "Palm Beach erec viewer is session/SPA — link retained; no free document body scrape",
        },
      };
    } else if (
      /miamidade\.gov\/Apps\/PA\/propertysearch/i.test(url) ||
      /apps\.miamidadepa\.gov\/PropertySearch/i.test(url) ||
      /apps\.miamidadepa\.gov\/PApublicServiceProxy/i.test(url)
    ) {
      const folioFromUrl =
        url.match(/[?&#]folio=([0-9-]+)/i)?.[1] ||
        url.match(/folioNumber=([0-9-]+)/i)?.[1] ||
        null;
      result = {
        status: LayerStatus.PARTIAL,
        payload: {
          url,
          folioFromUrl,
          note:
            "Miami-Dade PA SPA/link retained; folio enrichment uses free ArcGIS + GetPropertySearchByFolio JSON (Sales OR Book-Page → Documents)",
        },
      };
    }

    if (!result) continue;

    await prisma.document.update({
      where: { id: doc.id },
      data: {
        meta: {
          ...((doc.meta && typeof doc.meta === "object" ? doc.meta : {}) as object),
          linkEnrich: result.payload,
          linkEnrichStatus: result.status,
          linkEnrichError: result.error ?? null,
          linkEnrichedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
        evidenceNote:
          result.status === LayerStatus.OK
            ? `${doc.docType} — outbound link metadata pulled`
            : result.error
              ? `Link enrich: ${result.error}`
              : undefined,
      },
    });

    if (result.propertyPatch) {
      await applyPropertyPatch(
        lot.id,
        lot.county,
        lot.folio,
        lot.folioNormalized,
        result.propertyPatch,
      );
    }
    if (result.extraDocs?.length) {
      await upsertExtraDocs(lot.id, result.extraDocs);
    }

    if (result.status === LayerStatus.OK) enriched += 1;
    else if (result.status === LayerStatus.FAILED) failed += 1;
    else enriched += 1; // PARTIAL still useful
    results.push({ docType: doc.docType, status: result.status, url });
  }

  await prisma.enrichmentLayer.upsert({
    where: { lotId_name: { lotId: lot.id, name: "auction_card_links" } },
    update: {
      status: failed && !enriched ? LayerStatus.FAILED : enriched ? LayerStatus.OK : LayerStatus.PARTIAL,
      payload: { results, at: new Date().toISOString() } as Prisma.InputJsonValue,
      error: failed && !enriched ? "all link targets failed" : null,
      fetchedAt: new Date(),
    },
    create: {
      lotId: lot.id,
      name: "auction_card_links",
      status: failed && !enriched ? LayerStatus.FAILED : enriched ? LayerStatus.OK : LayerStatus.PARTIAL,
      payload: { results, at: new Date().toISOString() } as Prisma.InputJsonValue,
    },
  });

  return { ok: enriched > 0, enriched, failed };
}

/** Batch: lots that have auction preview links but no auction_card_links layer yet (or STALE). */
export async function runAuctionLinkEnrichment(limit = 60): Promise<{
  lots: number;
  enriched: number;
  failed: number;
}> {
  const lots = await prisma.lot.findMany({
    take: limit,
    orderBy: { updatedAt: "desc" },
    where: {
      documents: {
        some: {
          OR: [
            { searchScope: "auction_preview_link" },
            { docType: { startsWith: "auction_" } },
          ],
        },
      },
      OR: [
        { layers: { none: { name: "auction_card_links" } } },
        { layers: { some: { name: "auction_card_links", status: { in: ["STALE", "FAILED", "PARTIAL"] } } } },
      ],
    },
    select: { id: true, county: true },
  });

  let enriched = 0;
  let failed = 0;
  for (const lot of lots) {
    const r = await enrichLotAuctionLinks(lot.id);
    enriched += r.enriched;
    failed += r.failed;
    // Gentle pacing for clerk/OR hosts
    await new Promise((r) => setTimeout(r, 250));
  }
  return { lots: lots.length, enriched, failed };
}
