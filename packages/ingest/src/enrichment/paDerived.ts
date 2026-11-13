import { Prisma, prisma } from "@lienradar/db";
import { RiskResult } from "@lienradar/shared";

export type PaSale = {
  dateOfSale: string | null;
  salePrice: number | null;
  instrument: string | null;
  orBook: string | null;
  orPage: string | null;
  grantee: string | null;
  grantor: string | null;
  qualifiedFlag: string | null;
  qualificationDescription: string | null;
};

export type OccupancyProxy = {
  result: typeof RiskResult.PASS | typeof RiskResult.UNKNOWN;
  guess: "owner_occupied_proxy" | "absentee_proxy" | "unknown";
  evidence: string;
  homesteadLikely: boolean;
  mailingMatchesSitus: boolean | null;
};

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[,$]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).replace(/\u0000/g, "").trim();
  return s || null;
}

function parseMdY(raw: string | null): Date | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normStreetToken(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[.,#]/g, " ")
    .replace(/\b(STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|BOULEVARD|BLVD|LANE|LN|COURT|CT|TERRACE|TER|PLACE|PL|CIRCLE|CIR)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mapSaleRow(row: Record<string, unknown>): PaSale & { _ts: number; _price: number } {
  const dateOfSale = str(row.DateOfSale);
  const salePrice = num(row.SalePrice);
  return {
    dateOfSale,
    salePrice,
    instrument: str(row.SaleInstrument),
    orBook: str(row.OfficialRecordBook),
    orPage: str(row.OfficialRecordPage),
    grantee: str(row.GranteeName1),
    grantor: str(row.GrantorName1),
    qualifiedFlag: str(row.QualifiedFlag),
    qualificationDescription: str(row.QualificationDescription),
    _ts: parseMdY(dateOfSale)?.getTime() ?? 0,
    _price: salePrice ?? 0,
  };
}

function hasUsefulOr(book: string | null, page: string | null): boolean {
  if (!book || !page) return false;
  const b = book.replace(/^0+/, "") || "0";
  const p = page.replace(/^0+/, "") || "0";
  return b !== "0" && p !== "0";
}

/** Public MD Clerk OR image URL for a book/page (official records deep link). */
export function miamiDadeOrImageUrl(book: string, page: string): string {
  const b = book.replace(/\D/g, "");
  const p = page.replace(/\D/g, "");
  return (
    "https://onlineservices.miamidadeclerk.gov/officialrecords/api/DocumentImage/getdocumentimage" +
    `?redact=false&sBook=${encodeURIComponent(b)}&sBookType=${encodeURIComponent("O ")}&sPage=${encodeURIComponent(p)}`
  );
}

/** Latest priced sale from PA SalesInfos (prefer qualified). */
export function pickLatestSale(salesInfos: unknown): PaSale | null {
  if (!Array.isArray(salesInfos) || salesInfos.length === 0) return null;
  const rows = salesInfos
    .map((row) => mapSaleRow(row as Record<string, unknown>))
    .filter((r) => r._price > 0 && r._ts > 0)
    .sort((a, b) => {
      const aq = a.qualifiedFlag === "Q" ? 1 : 0;
      const bq = b.qualifiedFlag === "Q" ? 1 : 0;
      if (bq !== aq) return bq - aq;
      return b._ts - a._ts;
    });
  const top = rows[0];
  if (!top) return null;
  const { _ts: _a, _price: _b, ...sale } = top;
  return sale;
}

/** Recent sales that have real OR book/page — used for Document deep links. */
export function listSalesWithOr(salesInfos: unknown, limit = 8): PaSale[] {
  if (!Array.isArray(salesInfos) || salesInfos.length === 0) return [];
  return salesInfos
    .map((row) => mapSaleRow(row as Record<string, unknown>))
    .filter((r) => r._ts > 0 && hasUsefulOr(r.orBook, r.orPage))
    .sort((a, b) => b._ts - a._ts)
    .slice(0, limit)
    .map(({ _ts: _a, _price: _b, ...sale }) => sale);
}

function buildingSummary(payload: Record<string, unknown>): Record<string, unknown> | null {
  const infos = Array.isArray(payload.buildingInfos) ? payload.buildingInfos : [];
  if (!infos.length) return null;
  const primary = infos[0] as Record<string, unknown>;
  return {
    rollYear: num(primary.RollYear),
    improvementModelDesc: str(primary.improvementModelDesc),
    percentageGood: num(primary.PercentageGood),
    replacementCostNew: num(primary.ReplacementCostNew),
    depreciatedValue: num(primary.DepreciatedValue),
    heatedArea: num(primary.HeatedArea),
    grossArea: num(primary.GrossArea),
    effectiveYear: num(primary.Effective) ?? num(primary.Actual),
    segments: infos.length,
  };
}

/**
 * Honest occupancy PROXY from free PA signals only.
 * Never claims ground truth; UNKNOWN when signals are insufficient.
 */
export function classifyOccupancyFromPa(payload: Record<string, unknown>): OccupancyProxy {
  const propertyInfo = (payload.propertyInfo ?? null) as Record<string, unknown> | null;
  const mailing = (payload.mailingAddress ?? null) as Record<string, unknown> | null;
  const siteRaw = payload.siteAddress;
  const site = Array.isArray(siteRaw)
    ? (siteRaw[0] as Record<string, unknown> | undefined)
    : siteRaw && typeof siteRaw === "object"
      ? (siteRaw as Record<string, unknown>)
      : null;
  const land = (payload.land ?? null) as Record<string, unknown> | null;

  const hxYear = num(propertyInfo?.HxBaseYear);
  const hxPct = num(propertyInfo?.PercentHomesteadCapped);
  const homesteadLikely = (hxYear != null && hxYear >= 1990) || (hxPct != null && hxPct > 0);

  const mailLine = str(mailing?.Address1);
  const siteLine =
    str(site?.Address) ||
    str(land?.address) ||
    [str(site?.StreetNumber), str(site?.StreetPrefix), str(site?.StreetName), str(site?.StreetSuffix)]
      .filter(Boolean)
      .join(" ");

  let mailingMatchesSitus: boolean | null = null;
  if (mailLine && siteLine) {
    const a = normStreetToken(mailLine);
    const b = normStreetToken(siteLine);
    const mailNum = mailLine.match(/\d+/)?.[0];
    const siteNum = siteLine.match(/\d+/)?.[0];
    mailingMatchesSitus =
      Boolean(mailNum && siteNum && mailNum === siteNum) &&
      (a.includes(b.slice(0, Math.min(12, b.length))) || b.includes(a.slice(0, Math.min(12, a.length))));
  }

  const mailState = str(mailing?.State)?.toUpperCase() ?? "";
  const mailCity = str(mailing?.City)?.toUpperCase() ?? "";
  const siteCity = (str(site?.City) || str(land?.city) || "").toUpperCase();
  const outOfState = Boolean(mailState && mailState !== "FL");
  const cityMismatch =
    Boolean(mailCity && siteCity) &&
    !siteCity.includes(mailCity.slice(0, 6)) &&
    !mailCity.includes(siteCity.slice(0, 6));

  if (homesteadLikely && mailingMatchesSitus === true) {
    return {
      result: RiskResult.PASS,
      guess: "owner_occupied_proxy",
      evidence:
        `PA proxy: homestead signals (HxBaseYear=${hxYear ?? "n/a"}, cap%=${hxPct ?? "n/a"})` +
        ` and mailing matches situs — not ground-truth occupancy`,
      homesteadLikely,
      mailingMatchesSitus,
    };
  }

  if (outOfState || (mailingMatchesSitus === false && (outOfState || cityMismatch))) {
    return {
      result: RiskResult.PASS,
      guess: "absentee_proxy",
      evidence:
        `PA proxy: mailing suggests absentee` +
        `${outOfState ? ` (state=${mailState})` : ""}` +
        `${mailingMatchesSitus === false ? "; mailing≠situs street" : ""}` +
        ` — not ground-truth occupancy`,
      homesteadLikely,
      mailingMatchesSitus,
    };
  }

  if (homesteadLikely && mailingMatchesSitus == null) {
    return {
      result: RiskResult.PASS,
      guess: "owner_occupied_proxy",
      evidence: `PA proxy: homestead signals present (HxBaseYear=${hxYear ?? "n/a"}) but mailing/situs compare incomplete — not ground truth`,
      homesteadLikely,
      mailingMatchesSitus,
    };
  }

  return {
    result: RiskResult.UNKNOWN,
    guess: "unknown",
    evidence: "PA occupancy signals insufficient (need clearer mailing vs situs / homestead)",
    homesteadLikely,
    mailingMatchesSitus,
  };
}

async function upsertSaleOrDocuments(lotId: string, county: string, sales: PaSale[]) {
  let written = 0;
  for (const sale of sales) {
    if (!sale.orBook || !sale.orPage || !hasUsefulOr(sale.orBook, sale.orPage)) continue;
    const sourceUrl =
      county === "miami-dade" ? miamiDadeOrImageUrl(sale.orBook, sale.orPage) : null;
    if (!sourceUrl) continue;

    const titleParts = [
      sale.instrument || "OR",
      `Book ${sale.orBook}`,
      `Page ${sale.orPage}`,
      sale.dateOfSale ? `· ${sale.dateOfSale}` : null,
      sale.salePrice != null && sale.salePrice > 0 ? `· $${sale.salePrice.toLocaleString("en-US")}` : null,
    ].filter(Boolean);

    const existing = await prisma.document.findFirst({
      where: { lotId, sourceUrl },
      select: { id: true },
    });
    const data = {
      docType: "pa_sale_or",
      title: titleParts.join(" "),
      sourceUrl,
      searchScope: "pa_sales_information",
      evidenceNote: [
        sale.qualificationDescription,
        sale.grantor ? `Grantor: ${sale.grantor}` : null,
        sale.grantee ? `Grantee: ${sale.grantee}` : null,
        sale.qualifiedFlag ? `Qualified=${sale.qualifiedFlag}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      meta: {
        source: "pa_salesInfos",
        dateOfSale: sale.dateOfSale,
        salePrice: sale.salePrice,
        instrument: sale.instrument,
        orBook: sale.orBook,
        orPage: sale.orPage,
        grantor: sale.grantor,
        grantee: sale.grantee,
        qualifiedFlag: sale.qualifiedFlag,
        qualificationDescription: sale.qualificationDescription,
      } as Prisma.InputJsonValue,
    };
    if (existing) {
      await prisma.document.update({ where: { id: existing.id }, data });
    } else {
      await prisma.document.create({ data: { lotId, ...data } });
    }
    written += 1;
  }
  return written;
}

/** Apply sales + beds/baths + occupancy + OR sale docs derived from pa_parcel payload. */
export async function applyPaDerivedToLot(lotId: string, payload: Record<string, unknown>) {
  const propertyInfo = (payload.propertyInfo ?? null) as Record<string, unknown> | null;
  const land = (payload.land ?? null) as Record<string, unknown> | null;
  const owners = Array.isArray(payload.ownerInfos) ? payload.ownerInfos : [];
  const ownerFromPa = str((owners[0] as Record<string, unknown> | undefined)?.Name);
  const sale = pickLatestSale(payload.salesInfos);
  const salesWithOr = listSalesWithOr(payload.salesInfos, 8);
  const saleDate = parseMdY(sale?.dateOfSale ?? null);
  const occupancy = classifyOccupancyFromPa(payload);
  const building = buildingSummary(payload);
  const legalRaw = payload.legalDescription as Record<string, unknown> | string | null | undefined;
  const legalDescription =
    typeof legalRaw === "string"
      ? str(legalRaw)
      : legalRaw && typeof legalRaw === "object"
        ? str(legalRaw.Description)
        : null;

  const lot = await prisma.lot.findUnique({
    where: { id: lotId },
    select: { folioNormalized: true, folio: true, propertyId: true, county: true },
  });

  async function writeOccupancy(orDocsWritten = 0) {
    // Always write-through so a later UNKNOWN refresh does not leave a sticky PASS.
    await prisma.riskCheck.upsert({
      where: { lotId_code: { lotId, code: "occupancy" } },
      update: {
        result: occupancy.result,
        blocksBid: occupancy.result !== RiskResult.PASS,
        evidence: occupancy.evidence,
        checkedAt: new Date(),
      },
      create: {
        lotId,
        code: "occupancy",
        result: occupancy.result,
        blocksBid: occupancy.result !== RiskResult.PASS,
        evidence: occupancy.evidence,
      },
    });

    const occupancyPayload = {
      guess: occupancy.guess,
      homesteadLikely: occupancy.homesteadLikely,
      mailingMatchesSitus: occupancy.mailingMatchesSitus,
      evidence: occupancy.evidence,
      sale,
      salesWithOr,
      building,
      dorDescription:
        str(propertyInfo?.DORDescription) ||
        str(propertyInfo?.DORDescriptionCurrent) ||
        str(land?.dorDesc),
      zoneDescription: str(propertyInfo?.PrimaryZoneDescription),
      municipality: str(propertyInfo?.Municipality) || str(land?.city),
      subdivision: str(propertyInfo?.SubdivisionDescription) || str(land?.subdivision),
      landValue: num(land?.landValue),
      buildingValue: num(land?.buildingValue),
      source: "pa_derived",
      isGroundTruth: false,
      orDocsWritten,
      folioKnown: Boolean(lot?.folioNormalized && lot.folioNormalized !== "UNKNOWN"),
    } as Prisma.InputJsonValue;

    await prisma.enrichmentLayer.upsert({
      where: { lotId_name: { lotId, name: "occupancy_proxy" } },
      update: {
        status: occupancy.result === RiskResult.PASS ? "OK" : "PARTIAL",
        payload: occupancyPayload,
        fetchedAt: new Date(),
        error: null,
      },
      create: {
        lotId,
        name: "occupancy_proxy",
        status: occupancy.result === RiskResult.PASS ? "OK" : "PARTIAL",
        payload: occupancyPayload,
      },
    });
  }

  if (!lot?.folioNormalized || lot.folioNormalized === "UNKNOWN") {
    await writeOccupancy(0);
    return { sale: false, occupancy: occupancy.guess, orDocs: 0 };
  }
  const paSource =
    lot.county === "broward"
      ? "broward_pa"
      : lot.county === "palm-beach"
        ? "palm_beach_pa"
        : lot.county === "monroe"
          ? "monroe_pa"
          : "miami_dade_pa";

  const beds = num(propertyInfo?.BedroomCount) ?? num(land?.beds);
  const baths = num(propertyInfo?.BathroomCount) ?? num(land?.baths);
  const halfBath = num(propertyInfo?.HalfBathroomCount) ?? 0;
  const bathsTotal = baths != null ? baths + halfBath * 0.5 : null;
  const yearBuiltRaw = propertyInfo?.YearBuilt;
  const yearBuilt =
    typeof yearBuiltRaw === "number"
      ? yearBuiltRaw
      : typeof yearBuiltRaw === "string" && /^\d{4}$/.test(yearBuiltRaw)
        ? Number(yearBuiltRaw)
        : typeof land?.yearBuilt === "number"
          ? land.yearBuilt
          : undefined;

  const assessedFromPa = num(payload.assessedValue) ?? num(payload.justValue);
  const marketFromPa = num(payload.justValue) ?? num(payload.assessedValue);
  const lat = typeof land?.lat === "number" ? land.lat : null;
  const lng = typeof land?.lng === "number" ? land.lng : null;
  const dorUse =
    land?.dorCode != null
      ? String(land.dorCode)
      : propertyInfo?.DORCode != null
        ? String(propertyInfo.DORCode)
        : undefined;
  const zoning =
    str(propertyInfo?.PrimaryZone) ||
    (land?.zoning != null ? String(land.zoning) : undefined) ||
    undefined;

  const livingSqft =
    num(propertyInfo?.BuildingHeatedArea) != null
      ? Math.round(num(propertyInfo?.BuildingHeatedArea)!)
      : num(land?.buildingHeatedArea) != null
        ? Math.round(num(land?.buildingHeatedArea)!)
        : typeof land?.buildingGrossArea === "number"
          ? Math.round(land.buildingGrossArea)
          : undefined;

  const property = await prisma.property.upsert({
    where: {
      county_folioNormalized: { county: lot.county, folioNormalized: lot.folioNormalized },
    },
    update: {
      ownerName: ownerFromPa || (land?.owner as string) || undefined,
      addressLine: typeof land?.address === "string" ? land.address || undefined : undefined,
      city: typeof land?.city === "string" ? land.city || undefined : undefined,
      zip: land?.zip != null ? String(land.zip) : undefined,
      dorUse,
      zoning,
      beds: beds ?? undefined,
      baths: bathsTotal ?? undefined,
      yearBuilt: yearBuilt ?? undefined,
      livingSqft,
      lotSqft: typeof land?.lotSize === "number" ? Math.round(land.lotSize) : undefined,
      assessedValue: assessedFromPa != null ? assessedFromPa : undefined,
      marketValue: marketFromPa != null ? marketFromPa : undefined,
      justValue: marketFromPa != null ? marketFromPa : undefined,
      lat: lat ?? undefined,
      lng: lng ?? undefined,
      lastSaleDate: saleDate ?? undefined,
      lastSalePrice: sale?.salePrice != null ? sale.salePrice : undefined,
      legalDescription: legalDescription ?? undefined,
    },
    create: {
      county: lot.county,
      folio: lot.folio,
      folioNormalized: lot.folioNormalized,
      ownerName: ownerFromPa || (land?.owner as string) || undefined,
      addressLine: typeof land?.address === "string" ? land.address || undefined : undefined,
      city: typeof land?.city === "string" ? land.city || undefined : undefined,
      zip: land?.zip != null ? String(land.zip) : undefined,
      dorUse,
      zoning,
      beds: beds ?? undefined,
      baths: bathsTotal ?? undefined,
      yearBuilt: yearBuilt ?? undefined,
      livingSqft,
      lotSqft: typeof land?.lotSize === "number" ? Math.round(land.lotSize) : undefined,
      assessedValue: assessedFromPa,
      marketValue: marketFromPa,
      justValue: marketFromPa,
      lat: lat ?? undefined,
      lng: lng ?? undefined,
      lastSaleDate: saleDate ?? undefined,
      lastSalePrice: sale?.salePrice != null ? sale.salePrice : undefined,
      legalDescription: legalDescription ?? undefined,
    },
  });

  await prisma.lot.update({
    where: { id: lotId },
    data: {
      propertyId: property.id,
      assessedValue: assessedFromPa != null ? assessedFromPa : undefined,
      marketValue: marketFromPa != null ? marketFromPa : undefined,
    },
  });

  const orDocs = await upsertSaleOrDocuments(lotId, lot.county, salesWithOr);
  await writeOccupancy(orDocs);

  // Enrich occupancy_proxy with county PA source once property path succeeded.
  await prisma.enrichmentLayer.update({
    where: { lotId_name: { lotId, name: "occupancy_proxy" } },
    data: {
      payload: {
        guess: occupancy.guess,
        homesteadLikely: occupancy.homesteadLikely,
        mailingMatchesSitus: occupancy.mailingMatchesSitus,
        evidence: occupancy.evidence,
        sale,
        salesWithOr,
        building,
        dorDescription:
          str(propertyInfo?.DORDescription) ||
          str(propertyInfo?.DORDescriptionCurrent) ||
          str(land?.dorDesc),
        zoneDescription: str(propertyInfo?.PrimaryZoneDescription),
        municipality: str(propertyInfo?.Municipality) || str(land?.city),
        subdivision: str(propertyInfo?.SubdivisionDescription) || str(land?.subdivision),
        landValue: num(land?.landValue),
        buildingValue: num(land?.buildingValue),
        source: paSource,
        isGroundTruth: false,
        orDocsWritten: orDocs,
        folioKnown: true,
      } as Prisma.InputJsonValue,
    },
  });

  return { sale: Boolean(sale), occupancy: occupancy.guess, orDocs };
}
