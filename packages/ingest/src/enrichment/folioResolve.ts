import { CacheKeys, CacheTtl, cacheGetJson, cacheSetJson } from "@lienradar/cache";
import { LayerStatus, normalizeFolio } from "@lienradar/shared";
import { Prisma, prisma } from "@lienradar/db";

/** County GIS address → folio (PA GetPropertySearchByAddress currently returns a bogus default parcel). */
const GIS_ADDRESS =
  "https://gisws.miamidade.gov/gisaddress/AddressWebService.asmx/Address?myAddress=";

const LAND_LAYER =
  "https://gisweb.miamidade.gov/arcgis/rest/services/MD_LandInformation/MapServer/24/query";

function scrubListingNoise(address: string): string {
  let scrubbed = address.trim();
  for (let i = 0; i < 6; i++) {
    const next = scrubbed
      .replace(/\b\d+\s*(?:bd|br|ba|bath|beds?|baths?)/gi, " ")
      .replace(/\b\d[\d,]*\s*sq\.?\s*ft\.?/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (next === scrubbed) break;
    scrubbed = next;
  }
  return scrubbed;
}

/**
 * Normalize listing address toward MD PA/GIS street form:
 * "501 NW 20th Ave, Miami, FL 33125" → "501 NW 20 AVE"
 */
export function normalizeMdStreetQuery(address: string): { street: string; house: string; unit: string | null } {
  let s = scrubListingNoise(address)
    .replace(/\b(Sw|Nw|Se|Ne)\b/gi, (m) => m.toUpperCase())
    .replace(/\bNorthwest\b/gi, "NW")
    .replace(/\bNortheast\b/gi, "NE")
    .replace(/\bSouthwest\b/gi, "SW")
    .replace(/\bSoutheast\b/gi, "SE")
    .replace(/\bNorth\b/gi, "N")
    .replace(/\bSouth\b/gi, "S")
    .replace(/\bEast\b/gi, "E")
    .replace(/\bWest\b/gi, "W");

  const unitMatch = s.match(/(?:\b(?:Unit|Apt)\b|#)\s*([A-Za-z0-9\-]+)/i);
  const unit = unitMatch?.[1] ?? null;

  // Drop city/state/ZIP and unit suffixes for the street key.
  s = (s.split(",")[0] ?? s)
    .replace(/\s+(?:Unit|Apt|#)\s*[A-Za-z0-9\-]+/gi, "")
    .replace(
      /\s+(?:Miami(?:\s+Beach)?|Homestead|Hialeah|Doral|Kendall|Coral Gables|Miami Gardens|Cutler Bay|Palmetto Bay)\b.*$/i,
      "",
    )
    .replace(/\s+FL(?:\s+\d{5})?$/i, "")
    .trim();

  s = s
    .replace(/\b(Street)\b/gi, "ST")
    .replace(/\b(Avenue)\b/gi, "AVE")
    .replace(/\b(Boulevard)\b/gi, "BLVD")
    .replace(/\b(Drive)\b/gi, "DR")
    .replace(/\b(Lane)\b/gi, "LN")
    .replace(/\b(Court)\b/gi, "CT")
    .replace(/\b(Place)\b/gi, "PL")
    .replace(/\b(Terrace)\b/gi, "TER")
    .replace(/\b(Parkway)\b/gi, "PKWY")
    .replace(/\b(Path)\b/gi, "PATH")
    .replace(/\b(Road)\b/gi, "RD")
    .replace(/\b(Ave)\b/gi, "AVE")
    .replace(/\b(Blvd)\b/gi, "BLVD")
    .replace(/\b(St)\b/gi, "ST")
    .replace(/\b(Dr)\b/gi, "DR")
    .replace(/\b(Ln)\b/gi, "LN")
    .replace(/\b(Ct)\b/gi, "CT")
    .replace(/\b(Pl)\b/gi, "PL")
    .replace(/\b(Rd)\b/gi, "RD")
    // Ordinals: 20th → 20, 105th → 105, 1st → 1, 2nd → 2, 3rd → 3
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  const house = (s.match(/^(\d{1,6})/) || [])[1] || "";
  return { street: s, house, unit };
}

type GisResolveResult = {
  folio: string | null;
  matches: number;
  detail: string;
  payload: Record<string, unknown>;
};

async function resolveViaGis(street: string, house: string): Promise<GisResolveResult> {
  const cacheKey = CacheKeys.gisAddr(`${street}|${house}`);
  const cached = await cacheGetJson<GisResolveResult>(cacheKey);
  if (cached) return cached;

  const res = await fetch(`${GIS_ADDRESS}${encodeURIComponent(street)}`, {
    signal: AbortSignal.timeout(25_000),
    headers: { "User-Agent": "LienRadarPlatform/0.1 (+folio resolve)" },
  });
  if (!res.ok) throw new Error(`GIS address HTTP ${res.status}`);
  const xml = await res.text();
  const folioRaw = (xml.match(/<Folio>([^<]*)<\/Folio>/i) || [])[1]?.trim() || "";
  const std = (xml.match(/<StdAddress>([^<]*)<\/StdAddress>/i) || [])[1]?.trim() || "";
  const valid = ((xml.match(/<Valid>([^<]*)<\/Valid>/i) || [])[1] || "").toUpperCase() === "Y";
  const houseNum = (xml.match(/<House_Num>([^<]*)<\/House_Num>/i) || [])[1]?.trim() || "";
  const zip = (xml.match(/<Zip_Code>([^<]*)<\/Zip_Code>/i) || [])[1]?.trim() || "";

  let result: GisResolveResult;
  if (!valid || !folioRaw) {
    result = {
      folio: null,
      matches: 0,
      detail: "GIS address not valid / no folio",
      payload: { street, std, valid, xmlSnippet: xml.slice(0, 400) },
    };
  } else if (house && houseNum && houseNum !== house) {
    result = {
      folio: null,
      matches: 1,
      detail: `GIS house# ${houseNum} != query ${house} — not applying folio`,
      payload: { street, std, house, houseNum, folioRaw },
    };
  } else {
    const folio = normalizeFolio(folioRaw);
    result = {
      folio,
      matches: 1,
      detail: `GIS address verified → ${folioRaw} (${std || street})`,
      payload: { street, std, zip, folioRaw, folio, house: houseNum || house },
    };
  }

  await cacheSetJson(
    cacheKey,
    result,
    result.folio ? CacheTtl.gisAddrSec : CacheTtl.gisAddrNegativeSec,
  );
  return result;
}

async function resolveViaLandInfo(street: string, house: string): Promise<{
  folio: string | null;
  matches: number;
  detail: string;
  payload: Record<string, unknown>;
}> {
  const fields = "FOLIO,TRUE_SITE_ADDR,TRUE_SITE_CITY,TRUE_SITE_ZIP_CODE,TRUE_OWNER1,CANCEL_FLAG";
  // Exact first, then prefix LIKE on house + first tokens.
  const wheres = [
    `CANCEL_FLAG='N' AND TRUE_SITE_ADDR='${street.replace(/'/g, "''")}'`,
    `CANCEL_FLAG='N' AND TRUE_SITE_ADDR LIKE '${house.replace(/'/g, "''")} %'`,
  ];

  let hits: Array<Record<string, string>> = [];
  for (const where of wheres) {
    const url =
      `${LAND_LAYER}?where=${encodeURIComponent(where)}&outFields=${encodeURIComponent(fields)}` +
      `&returnGeometry=false&f=json&resultRecordCount=25`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(25_000),
      headers: { "User-Agent": "LienRadarPlatform/0.1 (+folio resolve)" },
    });
    if (!res.ok) throw new Error(`Land Info HTTP ${res.status}`);
    const json = (await res.json()) as {
      features?: Array<{ attributes?: Record<string, string> }>;
      error?: unknown;
    };
    if (json.error) throw new Error(`Land Info error ${JSON.stringify(json.error)}`);
    hits = (json.features ?? [])
      .map((f) => f.attributes ?? {})
      .filter((a) => (a.TRUE_SITE_ADDR || "").toUpperCase().startsWith(house));
    if (where.includes("TRUE_SITE_ADDR=")) {
      // exact path — keep only exact
      hits = hits.filter((a) => (a.TRUE_SITE_ADDR || "").toUpperCase() === street);
    } else {
      // LIKE path — require street tokens after house# match query street closely
      const tokens = street.split(/\s+/).slice(1); // drop house
      hits = hits.filter((a) => {
        const site = (a.TRUE_SITE_ADDR || "").toUpperCase();
        return tokens.every((t) => site.includes(t));
      });
    }
    if (hits.length === 1) break;
    if (hits.length > 1 && where.includes("TRUE_SITE_ADDR=")) break;
  }

  if (hits.length !== 1 || !hits[0]?.FOLIO) {
    return {
      folio: null,
      matches: hits.length,
      detail:
        hits.length === 0
          ? "no Land Info address match"
          : `ambiguous Land Info matches=${hits.length} — not applying folio`,
      payload: { street, house, matches: hits.slice(0, 5) },
    };
  }
  const folio = normalizeFolio(hits[0].FOLIO);
  return {
    folio,
    matches: 1,
    detail: `Land Info verified → ${hits[0].FOLIO} (${hits[0].TRUE_SITE_ADDR})`,
    payload: {
      street,
      house,
      folio,
      siteAddress: hits[0].TRUE_SITE_ADDR ?? null,
      owner: hits[0].TRUE_OWNER1 ?? null,
    },
  };
}

/**
 * Recover UNKNOWN folio via GIS / Land Info address search when lot has a usable street address.
 * Only applies a folio when exactly one verified match is returned (no guessing).
 */
export async function resolveFolioByAddress(address: string): Promise<{
  folio: string | null;
  matches: number;
  detail: string;
  payload: Record<string, unknown>;
}> {
  const { street, house, unit } = normalizeMdStreetQuery(address);
  if (street.length < 8 || !house) {
    return {
      folio: null,
      matches: 0,
      detail: "address too short / no house#",
      payload: { address, street, house, unit },
    };
  }

  const gis = await resolveViaGis(street, house);
  if (gis.folio) return { ...gis, payload: { ...gis.payload, unit, source: "gis" } };

  const land = await resolveViaLandInfo(street, house);
  return { ...land, payload: { ...land.payload, unit, source: "land_info", gis: gis.payload } };
}

export async function attachResolvedFolio(lotId: string, folio: string, evidence: string) {
  const folioNormalized = normalizeFolio(folio);
  if (!folioNormalized || folioNormalized === "UNKNOWN") return;

  const lot = await prisma.lot.findUnique({
    where: { id: lotId },
    select: { county: true },
  });
  // Address→folio GIS is Miami-Dade Land Info only — never attach onto other counties.
  const county = lot?.county === "miami-dade" ? "miami-dade" : null;
  if (!county) return;

  const property = await prisma.property.upsert({
    where: { county_folioNormalized: { county, folioNormalized } },
    update: {},
    create: {
      county,
      folio,
      folioNormalized,
    },
  });

  await prisma.lot.update({
    where: { id: lotId },
    data: {
      folio,
      folioNormalized,
      propertyId: property.id,
    },
  });

  await prisma.lotEvent.create({
    data: {
      lotId,
      kind: "FOLIO_ATTACH",
      message: evidence,
    },
  });
}

export async function runFolioAttachPass(limit = 40): Promise<{
  scanned: number;
  attached: number;
  ambiguous: number;
  failed: number;
}> {
  // MD Land Info / GIS only — never run address resolve against Broward/PB/Monroe lots.
  const lots = await prisma.lot.findMany({
    where: {
      county: "miami-dade",
      folioNormalized: "UNKNOWN",
      NOT: { propertyAddress: null },
    },
    take: limit,
    orderBy: { updatedAt: "desc" },
  });

  let attached = 0;
  let ambiguous = 0;
  let failed = 0;
  for (const lot of lots) {
    const addr = lot.propertyAddress?.trim();
    if (!addr) continue;
    try {
      const result = await resolveFolioByAddress(addr);
      const status = result.folio
        ? LayerStatus.OK
        : result.matches > 1
          ? LayerStatus.PARTIAL
          : LayerStatus.FAILED;
      await prisma.enrichmentLayer.upsert({
        where: { lotId_name: { lotId: lot.id, name: "folio_resolve" } },
        update: {
          status,
          payload: result.payload as Prisma.InputJsonValue,
          error: result.folio ? null : result.detail,
          fetchedAt: new Date(),
        },
        create: {
          lotId: lot.id,
          name: "folio_resolve",
          status,
          payload: result.payload as Prisma.InputJsonValue,
          error: result.folio ? null : result.detail,
        },
      });
      if (result.folio) {
        await attachResolvedFolio(lot.id, result.folio, result.detail);
        attached += 1;
      } else if (result.matches > 1) {
        ambiguous += 1;
      } else {
        failed += 1;
      }
    } catch (e) {
      failed += 1;
      await prisma.enrichmentLayer.upsert({
        where: { lotId_name: { lotId: lot.id, name: "folio_resolve" } },
        update: {
          status: LayerStatus.FAILED,
          payload: {} as Prisma.InputJsonValue,
          error: e instanceof Error ? e.message : String(e),
          fetchedAt: new Date(),
        },
        create: {
          lotId: lot.id,
          name: "folio_resolve",
          status: LayerStatus.FAILED,
          payload: {} as Prisma.InputJsonValue,
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }
  return { scanned: lots.length, attached, ambiguous, failed };
}
