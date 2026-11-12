import { LayerStatus } from "@lienradar/shared";
import { enrichBcpaRecInfo } from "./auctionCardLinks.js";
import type { PaParcelResult } from "./propertyAppraiser.js";

const BCPA_GIS =
  "https://gisweb.bcpa.net/arcgis/rest/services/BCPA_PARCELS_PROPID_CAMA/MapServer/0/query";
const FDOR =
  "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query";
const FDOR_FIELDS =
  "PARCEL_ID,DOR_UC,JV,LND_SQFOOT,TOT_LVG_AR,OWN_NAME,PHY_ADDR1,PHY_CITY,PHY_ZIPCD,SALE_PRC1,SALE_YR1";

function folioDigits(folio: string): string {
  return folio.replace(/[^0-9]/g, "");
}

function scrubJson<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "string" ? v.replace(/\u0000/g, "") : v)),
  ) as T;
}

function ringCentroid(rings: number[][][] | undefined): { lng: number; lat: number } | null {
  const ring = rings?.[0];
  if (!ring?.length) return null;
  let x = 0;
  let y = 0;
  for (const [px, py] of ring) {
    x += px;
    y += py;
  }
  return { lng: x / ring.length, lat: y / ring.length };
}

export async function probeBrowardPa(): Promise<{ ok: boolean; error?: string; detail?: string }> {
  try {
    const url = `${BCPA_GIS}?where=1%3D1&returnCountOnly=true&f=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ok: false, error: `BCPA GIS HTTP ${res.status}` };
    const json = (await res.json()) as { count?: number; error?: unknown };
    if (json.error) return { ok: false, error: JSON.stringify(json.error) };
    return { ok: true, detail: `BCPA_PARCELS_PROPID_CAMA count=${json.count ?? "n/a"}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchBcpaGeo(folio: string): Promise<{
  folio: string;
  lat: number | null;
  lng: number | null;
} | null> {
  const digits = folioDigits(folio);
  const candidates = [folio.trim().toUpperCase(), digits].filter(Boolean);
  const where = encodeURIComponent(
    candidates.map((c) => `FOLIO='${c.replace(/'/g, "''")}'`).join(" OR "),
  );
  const url = `${BCPA_GIS}?where=${where}&outFields=FOLIO&returnGeometry=true&outSR=4326&f=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`BCPA GIS HTTP ${res.status}`);
  const json = (await res.json()) as {
    features?: Array<{ attributes?: { FOLIO?: string }; geometry?: { rings?: number[][][] } }>;
    error?: unknown;
  };
  if (json.error) throw new Error(JSON.stringify(json.error));
  const feat = json.features?.[0];
  if (!feat) return null;
  const c = ringCentroid(feat.geometry?.rings);
  return {
    folio: String(feat.attributes?.FOLIO ?? folio),
    lat: c?.lat ?? null,
    lng: c?.lng ?? null,
  };
}

async function fetchFdorAttrs(folio: string): Promise<Record<string, unknown> | null> {
  const raw = folio.trim().toUpperCase();
  const digits = folioDigits(folio);
  if (!raw && !digits) return null;
  // Try published folio first (may include letters), then digits-only auction form.
  const candidates = [...new Set([raw, digits].filter(Boolean))];
  for (const id of candidates) {
    const where = encodeURIComponent(`PARCEL_ID='${id.replace(/'/g, "''")}'`);
    const url =
      `${FDOR}?where=${where}&outFields=${encodeURIComponent(FDOR_FIELDS)}` +
      `&returnGeometry=true&outSR=4326&f=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`FDOR HTTP ${res.status}`);
    const json = (await res.json()) as {
      features?: Array<{
        attributes?: Record<string, unknown>;
        geometry?: { rings?: number[][][]; x?: number; y?: number };
      }>;
      error?: unknown;
    };
    if (json.error) throw new Error(JSON.stringify(json.error));
    const feat = json.features?.[0];
    if (!feat?.attributes) continue;
    const c = ringCentroid(feat.geometry?.rings);
    const lat = c?.lat ?? (typeof feat.geometry?.y === "number" ? feat.geometry.y : null);
    const lng = c?.lng ?? (typeof feat.geometry?.x === "number" ? feat.geometry.x : null);
    return { ...feat.attributes, _lat: lat, _lng: lng };
  }
  return null;
}

/** Broward PA: BCPA GIS geo + FDOR owner/values (free public paths). */
export async function enrichBrowardPa(folio: string): Promise<PaParcelResult> {
  const clean = folioDigits(folio);
  if (!clean || /unknown/i.test(folio)) {
    return { status: LayerStatus.FAILED, payload: { folio, county: "broward" }, error: "empty or UNKNOWN folio" };
  }

  try {
    const [geo, attrs] = await Promise.all([
      fetchBcpaGeo(folio).catch((e) => {
        throw e;
      }),
      fetchFdorAttrs(folio).catch((e) => {
        throw e;
      }),
    ]);

    // RecInfo adds beds/baths/yearBuilt + TRIM PDF when FDOR/GIS are thin.
    const recUrl = `http://www.bcpa.net/RecInfo.asp?URL_Folio=${encodeURIComponent(folio.trim())}`;
    const rec = await enrichBcpaRecInfo(recUrl).catch(() => null);
    const recOk = rec?.status === LayerStatus.OK ? rec : null;

    if (!geo && !attrs && !recOk) {
      return {
        status: LayerStatus.PARTIAL,
        payload: { folio, county: "broward", found: false },
      };
    }

    const jv = typeof attrs?.JV === "number" ? attrs.JV : Number(attrs?.JV);
    const justValue =
      (Number.isFinite(jv) && jv > 0 ? jv : null) ??
      recOk?.propertyPatch?.marketValue ??
      recOk?.propertyPatch?.assessedValue ??
      null;
    const owner =
      (attrs?.OWN_NAME != null ? String(attrs.OWN_NAME) : null) ||
      recOk?.propertyPatch?.ownerName ||
      null;
    const address =
      (attrs?.PHY_ADDR1 != null ? String(attrs.PHY_ADDR1) : null) ||
      recOk?.propertyPatch?.addressLine ||
      null;
    const city =
      (attrs?.PHY_CITY != null ? String(attrs.PHY_CITY) : null) ||
      recOk?.propertyPatch?.city ||
      null;
    const zip =
      (attrs?.PHY_ZIPCD != null ? String(attrs.PHY_ZIPCD) : null) ||
      recOk?.propertyPatch?.zip ||
      null;
    const dorCode = attrs?.DOR_UC != null ? String(attrs.DOR_UC) : null;
    const living = typeof attrs?.TOT_LVG_AR === "number" ? attrs.TOT_LVG_AR : null;
    const lotSize = typeof attrs?.LND_SQFOOT === "number" ? attrs.LND_SQFOOT : null;
    const salePrice = typeof attrs?.SALE_PRC1 === "number" ? attrs.SALE_PRC1 : null;
    const saleYr = attrs?.SALE_YR1 != null ? String(attrs.SALE_YR1) : null;
    const fdorLat = typeof attrs?._lat === "number" ? attrs._lat : null;
    const fdorLng = typeof attrs?._lng === "number" ? attrs._lng : null;
    const lat = geo?.lat ?? fdorLat;
    const lng = geo?.lng ?? fdorLng;
    const beds = recOk?.propertyPatch?.beds ?? null;
    const baths = recOk?.propertyPatch?.baths ?? null;
    const yearBuilt = recOk?.propertyPatch?.yearBuilt ?? null;

    return {
      status: LayerStatus.OK,
      payload: scrubJson({
        folio,
        folioPadded: clean,
        county: "broward",
        source: {
          geo: geo?.lat != null ? "BCPA_PARCELS_PROPID_CAMA" : fdorLat != null ? "FDOR geometry" : null,
          values: attrs ? "Florida_Statewide_Cadastral (FDOR)" : recOk ? "BCPA RecInfo" : null,
          recInfo: recOk ? recUrl : null,
        },
        land: {
          address,
          city,
          zip,
          owner,
          dorCode,
          dorDesc: null,
          zoning: null,
          lotSize,
          buildingGrossArea: living,
          landValue: null,
          buildingValue: null,
          totalValue: justValue,
          yearBuilt,
          condoFlag: null,
          cancelFlag: null,
          lat,
          lng,
        },
        justValue,
        assessedValue: justValue,
        salesInfos:
          salePrice != null
            ? [{ SalePrice: salePrice, DateOfSale: saleYr ? `01/01/${saleYr}` : null, SaleInstrument: "FDOR" }]
            : null,
        propertyInfo:
          beds != null || baths != null
            ? { BedroomCount: beds, BathroomCount: baths, YearBuilt: yearBuilt }
            : yearBuilt != null
              ? { YearBuilt: yearBuilt }
              : null,
        ownerInfos: owner ? [{ Name: owner }] : null,
        mailingAddress: null,
        siteAddress: address ? [{ Address: address, City: city, Zip: zip }] : null,
        legalDescription: null,
        recInfoExtras: recOk?.extraDocs ?? null,
      }),
    };
  } catch (e) {
    return {
      status: LayerStatus.FAILED,
      payload: { folio, county: "broward" },
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
