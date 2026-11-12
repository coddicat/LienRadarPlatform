import { LayerStatus } from "@lienradar/shared";
import type { PaParcelResult } from "./propertyAppraiser.js";

const MCPA = "https://www.mcpafl.org/";
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

/**
 * Monroe PA — FDOR statewide cadastral (same free path as Broward/Palm Beach values).
 * mcpafl.org has no proven free folio API; FDOR covers Monroe parcel IDs when auction folios match.
 */
export async function probeMonroePa(): Promise<{
  ok: boolean;
  configured: boolean;
  error?: string;
  detail?: string;
}> {
  try {
    const where = encodeURIComponent("CO_NO='44'");
    const url = `${FDOR}?where=${where}&returnCountOnly=true&f=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ok: false, configured: true, error: `FDOR Monroe HTTP ${res.status}` };
    const json = (await res.json()) as { count?: number; error?: unknown };
    if (json.error) return { ok: false, configured: true, error: JSON.stringify(json.error) };
    const count = json.count ?? 0;
    if (count <= 0) {
      return { ok: false, configured: false, error: "FDOR returned zero Monroe parcels (CO_NO=44)" };
    }
    // Homepage reachability is informational only.
    let siteNote = "mcpafl.org not checked";
    try {
      const site = await fetch(MCPA, {
        headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 (compatible; LienRadar/1.0)" },
        signal: AbortSignal.timeout(12_000),
        redirect: "follow",
      });
      siteNote = `mcpafl.org HTTP ${site.status}`;
    } catch {
      siteNote = "mcpafl.org unreachable";
    }
    return {
      ok: true,
      configured: true,
      detail: `FDOR Monroe parcels=${count}; values/geo via statewide cadastral (${siteNote})`,
    };
  } catch (e) {
    return {
      ok: false,
      configured: true,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function fetchFdorParcel(folio: string): Promise<{
  attrs: Record<string, unknown>;
  lat: number | null;
  lng: number | null;
} | null> {
  const raw = folio.trim().toUpperCase();
  const digits = folioDigits(folio);
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
    const lat =
      c?.lat ??
      (typeof feat.geometry?.y === "number" ? feat.geometry.y : null);
    const lng =
      c?.lng ??
      (typeof feat.geometry?.x === "number" ? feat.geometry.x : null);
    return { attrs: feat.attributes, lat, lng };
  }
  return null;
}

export async function enrichMonroePa(folio: string): Promise<PaParcelResult> {
  const clean = folioDigits(folio);
  if (!clean || /unknown/i.test(folio)) {
    return {
      status: LayerStatus.FAILED,
      payload: { folio, county: "monroe" },
      error: "empty or UNKNOWN folio",
    };
  }

  try {
    const hit = await fetchFdorParcel(folio);
    if (!hit) {
      return {
        status: LayerStatus.PARTIAL,
        payload: { folio, county: "monroe", found: false, reason: "fdor_miss" },
      };
    }

    const { attrs, lat, lng } = hit;
    const jv = typeof attrs.JV === "number" ? attrs.JV : Number(attrs.JV);
    const justValue = Number.isFinite(jv) && jv > 0 ? jv : null;
    const owner = attrs.OWN_NAME != null ? String(attrs.OWN_NAME) : null;
    const address = attrs.PHY_ADDR1 != null ? String(attrs.PHY_ADDR1) : null;
    const city = attrs.PHY_CITY != null ? String(attrs.PHY_CITY) : null;
    const zip = attrs.PHY_ZIPCD != null ? String(attrs.PHY_ZIPCD) : null;
    const dorCode = attrs.DOR_UC != null ? String(attrs.DOR_UC) : null;
    const living = typeof attrs.TOT_LVG_AR === "number" ? attrs.TOT_LVG_AR : null;
    const lotSize = typeof attrs.LND_SQFOOT === "number" ? attrs.LND_SQFOOT : null;
    const salePrice = typeof attrs.SALE_PRC1 === "number" ? attrs.SALE_PRC1 : null;
    const saleYr = attrs.SALE_YR1 != null ? String(attrs.SALE_YR1) : null;

    return {
      status: LayerStatus.OK,
      payload: scrubJson({
        folio,
        folioPadded: clean,
        county: "monroe",
        source: { values: "Florida_Statewide_Cadastral (FDOR)", geo: "FDOR geometry" },
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
          yearBuilt: null,
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
        propertyInfo: null,
        ownerInfos: owner ? [{ Name: owner }] : null,
        mailingAddress: null,
        siteAddress: address ? [{ Address: address, City: city, Zip: zip }] : null,
        legalDescription: null,
      }),
    };
  } catch (e) {
    return {
      status: LayerStatus.FAILED,
      payload: { folio, county: "monroe" },
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
