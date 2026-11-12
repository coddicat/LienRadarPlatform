import { prisma } from "@lienradar/db";
import { RiskResult } from "@lienradar/shared";

export type PaSale = {
  dateOfSale: string | null;
  salePrice: number | null;
  instrument: string | null;
  orBook: string | null;
  orPage: string | null;
  grantee: string | null;
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

/** Latest qualified sale from PA SalesInfos (already fetched). */
export function pickLatestSale(salesInfos: unknown): PaSale | null {
  if (!Array.isArray(salesInfos) || salesInfos.length === 0) return null;
  const rows = salesInfos
    .map((row) => {
      const r = row as Record<string, unknown>;
      const dateOfSale = str(r.DateOfSale);
      const salePrice = num(r.SalePrice);
      return {
        dateOfSale,
        salePrice,
        instrument: str(r.SaleInstrument),
        orBook: str(r.OfficialRecordBook),
        orPage: str(r.OfficialRecordPage),
        grantee: str(r.GranteeName1),
        _ts: parseMdY(dateOfSale)?.getTime() ?? 0,
      };
    })
    .filter((r) => r.salePrice != null && r.salePrice > 0 && r._ts > 0)
    .sort((a, b) => b._ts - a._ts);
  const top = rows[0];
  if (!top) return null;
  return {
    dateOfSale: top.dateOfSale,
    salePrice: top.salePrice,
    instrument: top.instrument,
    orBook: top.orBook,
    orPage: top.orPage,
    grantee: top.grantee,
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

/** Apply sales + beds/baths + occupancy derived from an existing or fresh pa_parcel payload. */
export async function applyPaDerivedToLot(lotId: string, payload: Record<string, unknown>) {
  const propertyInfo = (payload.propertyInfo ?? null) as Record<string, unknown> | null;
  const land = (payload.land ?? null) as Record<string, unknown> | null;
  const owners = Array.isArray(payload.ownerInfos) ? payload.ownerInfos : [];
  const ownerFromPa = str((owners[0] as Record<string, unknown> | undefined)?.Name);
  const sale = pickLatestSale(payload.salesInfos);
  const saleDate = parseMdY(sale?.dateOfSale ?? null);
  const occupancy = classifyOccupancyFromPa(payload);
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
  if (!lot?.folioNormalized || lot.folioNormalized === "UNKNOWN") {
    return { sale: false, occupancy: occupancy.guess };
  }
  const paSource =
    lot.county === "broward"
      ? "broward_pa"
      : lot.county === "palm-beach"
        ? "palm_beach_pa"
        : lot.county === "monroe"
          ? "monroe_pa"
          : "miami_dade_pa";

  const beds = num(propertyInfo?.BedroomCount);
  const baths = num(propertyInfo?.BathroomCount);
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

  const property = await prisma.property.upsert({
    where: {
      county_folioNormalized: { county: lot.county, folioNormalized: lot.folioNormalized },
    },
    update: {
      ownerName: ownerFromPa || (land?.owner as string) || undefined,
      addressLine: typeof land?.address === "string" ? land.address || undefined : undefined,
      city: typeof land?.city === "string" ? land.city || undefined : undefined,
      zip: land?.zip != null ? String(land.zip) : undefined,
      dorUse: land?.dorCode != null ? String(land.dorCode) : undefined,
      beds: beds ?? undefined,
      baths: bathsTotal ?? undefined,
      yearBuilt: yearBuilt ?? undefined,
      livingSqft:
        num(propertyInfo?.BuildingHeatedArea) != null
          ? Math.round(num(propertyInfo?.BuildingHeatedArea)!)
          : typeof land?.buildingGrossArea === "number"
            ? Math.round(land.buildingGrossArea)
            : undefined,
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
      dorUse: land?.dorCode != null ? String(land.dorCode) : undefined,
      beds: beds ?? undefined,
      baths: bathsTotal ?? undefined,
      yearBuilt: yearBuilt ?? undefined,
      livingSqft:
        typeof land?.buildingGrossArea === "number" ? Math.round(land.buildingGrossArea) : undefined,
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

  if (occupancy.result === RiskResult.PASS) {
    await prisma.riskCheck.upsert({
      where: { lotId_code: { lotId, code: "occupancy" } },
      update: {
        result: RiskResult.PASS,
        blocksBid: false,
        evidence: occupancy.evidence,
        checkedAt: new Date(),
      },
      create: {
        lotId,
        code: "occupancy",
        result: RiskResult.PASS,
        blocksBid: false,
        evidence: occupancy.evidence,
      },
    });
  }

  await prisma.enrichmentLayer.upsert({
    where: { lotId_name: { lotId, name: "occupancy_proxy" } },
    update: {
      status: occupancy.result === RiskResult.PASS ? "OK" : "PARTIAL",
      payload: {
        guess: occupancy.guess,
        homesteadLikely: occupancy.homesteadLikely,
        mailingMatchesSitus: occupancy.mailingMatchesSitus,
        evidence: occupancy.evidence,
        sale,
        source: paSource,
        isGroundTruth: false,
      },
      fetchedAt: new Date(),
      error: null,
    },
    create: {
      lotId,
      name: "occupancy_proxy",
      status: occupancy.result === RiskResult.PASS ? "OK" : "PARTIAL",
      payload: {
        guess: occupancy.guess,
        homesteadLikely: occupancy.homesteadLikely,
        mailingMatchesSitus: occupancy.mailingMatchesSitus,
        evidence: occupancy.evidence,
        sale,
        source: paSource,
        isGroundTruth: false,
      },
    },
  });

  return { sale: Boolean(sale), occupancy: occupancy.guess };
}
