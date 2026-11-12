import { CacheKeys, CacheTtl, cacheGetJson, cacheSetJson } from "@lienradar/cache";
import { LayerStatus } from "@lienradar/shared";

export type PaParcelResult = {
  status: typeof LayerStatus.OK | typeof LayerStatus.PARTIAL | typeof LayerStatus.FAILED;
  payload: Record<string, unknown>;
  error?: string;
};

/** County land information parcels (owner, DOR, values, condo flag). */
const LAND_LAYER =
  "https://gisweb.miamidade.gov/arcgis/rest/services/MD_LandInformation/MapServer/24/query";

/** Public PA JSON — works for condo units where GIS TOTAL_VAL_CUR is often null. */
const PA_JSON =
  "https://apps.miamidadepa.gov/PApublicServiceProxy/PaServicesProxy.ashx" +
  "?Operation=GetPropertySearchByFolio&clientAppName=PropertySearch&folioNumber=";

const LAND_FIELDS = [
  "FOLIO",
  "TRUE_SITE_ADDR",
  "TRUE_SITE_CITY",
  "TRUE_SITE_ZIP_CODE",
  "DOR_CODE_CUR",
  "DOR_DESC",
  "PRIMARY_ZONE",
  "LOT_SIZE",
  "BUILDING_GROSS_AREA",
  "LAND_VAL_CUR",
  "BUILDING_VAL_CUR",
  "TOTAL_VAL_CUR",
  "TRUE_OWNER1",
  "YEAR_BUILT",
  "CANCEL_FLAG",
  "CONDO_FLAG",
].join(",");

function folioDigits(folio: string): string {
  return folio.replace(/[^0-9]/g, "");
}

function folioPadded(folio: string): string {
  return folioDigits(folio).padStart(13, "0");
}

/** Health probe — Land Info layer + PA JSON host. */
export async function probePropertyAppraiser(): Promise<{
  ok: boolean;
  error?: string;
  detail?: string;
}> {
  try {
    const landUrl = `${LAND_LAYER}?where=1%3D1&returnCountOnly=true&f=json`;
    const landRes = await fetch(landUrl, { signal: AbortSignal.timeout(20_000) });
    if (!landRes.ok) return { ok: false, error: `Land Info HTTP ${landRes.status}` };
    const landJson = (await landRes.json()) as { count?: number; error?: unknown };
    if (landJson.error) return { ok: false, error: JSON.stringify(landJson.error) };

    // Probe JSON API with a known-shape empty folio path (should return JSON, not HTML block).
    const jsonRes = await fetch(`${PA_JSON}0000000000000`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!jsonRes.ok) return { ok: false, error: `PA JSON HTTP ${jsonRes.status}` };

    return {
      ok: true,
      detail: `MD_LandInformation/24 count=${landJson.count ?? "n/a"}; PA JSON reachable`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchLandParcel(clean: string): Promise<Record<string, unknown> | null> {
  const padded = clean.padStart(13, "0");
  const cacheKey = CacheKeys.paLand(padded);
  const cached = await cacheGetJson<Record<string, unknown> | { __empty: true }>(cacheKey);
  if (cached) {
    if ("__empty" in cached) return null;
    return cached;
  }

  const where = encodeURIComponent(`FOLIO='${padded}' OR FOLIO='${clean}'`);
  const url =
    `${LAND_LAYER}?where=${where}&outFields=${encodeURIComponent(LAND_FIELDS)}` +
    `&returnGeometry=true&outSR=4326&f=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Land Info HTTP ${res.status}`);
  const json = (await res.json()) as {
    features?: Array<{ attributes?: Record<string, unknown>; geometry?: { x?: number; y?: number } }>;
    error?: unknown;
  };
  if (json.error) throw new Error(JSON.stringify(json.error));
  const feat = json.features?.[0];
  if (!feat?.attributes) {
    await cacheSetJson(cacheKey, { __empty: true }, CacheTtl.gisAddrNegativeSec);
    return null;
  }
  const value = {
    ...feat.attributes,
    _geometry: feat.geometry ?? null,
  };
  await cacheSetJson(cacheKey, value, CacheTtl.paLandSec);
  return value;
}

async function fetchPaJson(clean: string): Promise<Record<string, unknown> | null> {
  const folio = clean.length >= 10 ? clean : clean.padStart(13, "0");
  const cacheKey = CacheKeys.paJson(folio.padStart(13, "0"));
  const cached = await cacheGetJson<Record<string, unknown> | { __empty: true }>(cacheKey);
  if (cached) {
    if ("__empty" in cached) return null;
    return cached;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${PA_JSON}${encodeURIComponent(folio)}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Record<string, unknown> & {
        Assessment?: { AssessmentInfos?: Array<{ TotalValue?: number; AssessedValue?: number; Year?: number }> };
        PropertyInfo?: Record<string, unknown>;
        SalesInfos?: unknown;
        OwnerInfos?: unknown;
        MailingAddress?: unknown;
        SiteAddress?: unknown;
        LegalDescription?: unknown;
      };
      if (!data || (data as { Message?: string }).Message === "Folio not found") {
        await cacheSetJson(cacheKey, { __empty: true }, CacheTtl.gisAddrNegativeSec);
        return null;
      }
      await cacheSetJson(cacheKey, data, CacheTtl.paJsonSec);
      return data;
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      else throw new Error(`PA JSON failed after retries for folio ${folio}`);
    }
  }
  return null;
}

/** Postgres rejects \\u0000 inside jsonb/text — strip before persistence. */
function scrubJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "string" ? v.replace(/\u0000/g, "") : v))) as T;
}

export async function enrichPropertyAppraiser(folio: string): Promise<PaParcelResult> {
  const clean = folioDigits(folio);
  if (!clean || clean === "0" || /unknown/i.test(folio)) {
    return { status: LayerStatus.FAILED, payload: { folio }, error: "empty or UNKNOWN folio" };
  }

  try {
    const [land, paJson] = await Promise.all([
      fetchLandParcel(clean).catch((e) => {
        throw e;
      }),
      fetchPaJson(clean).catch((e) => {
        throw e;
      }),
    ]);

    if (!land && !paJson) {
      return {
        status: LayerStatus.PARTIAL,
        payload: { folio, folioPadded: folioPadded(folio), found: false },
      };
    }

    const assessments = paJson?.Assessment as
      | { AssessmentInfos?: Array<{ TotalValue?: number; AssessedValue?: number; Year?: number }> }
      | undefined;
    const infos = assessments?.AssessmentInfos ?? [];
    const latest = [...infos].sort((a, b) => (b.Year ?? 0) - (a.Year ?? 0));
    const justValue =
      latest.find((i) => (i.TotalValue ?? 0) > 0)?.TotalValue ??
      (typeof land?.TOTAL_VAL_CUR === "number" ? land.TOTAL_VAL_CUR : null);
    const assessedValue =
      latest.find((i) => (i.AssessedValue ?? 0) > 0)?.AssessedValue ??
      (typeof land?.TOTAL_VAL_CUR === "number" ? land.TOTAL_VAL_CUR : null);

    const geom = land?._geometry as { x?: number; y?: number } | null | undefined;
    const sales = paJson?.SalesInfos;

    return {
      status: LayerStatus.OK,
      payload: scrubJson({
        folio,
        folioPadded: folioPadded(folio),
        source: {
          land: "MD_LandInformation/MapServer/24",
          values: "PApublicServiceProxy GetPropertySearchByFolio",
        },
        land: land
          ? {
              address: land.TRUE_SITE_ADDR,
              city: land.TRUE_SITE_CITY,
              zip: land.TRUE_SITE_ZIP_CODE,
              owner: land.TRUE_OWNER1,
              dorCode: land.DOR_CODE_CUR,
              dorDesc: land.DOR_DESC,
              zoning: land.PRIMARY_ZONE,
              lotSize: land.LOT_SIZE,
              buildingGrossArea: land.BUILDING_GROSS_AREA,
              landValue: land.LAND_VAL_CUR,
              buildingValue: land.BUILDING_VAL_CUR,
              totalValue: land.TOTAL_VAL_CUR,
              yearBuilt: land.YEAR_BUILT,
              condoFlag: land.CONDO_FLAG,
              cancelFlag: land.CANCEL_FLAG,
              lat: geom?.y ?? null,
              lng: geom?.x ?? null,
            }
          : null,
        justValue,
        assessedValue,
        salesInfos: sales ?? null,
        propertyInfo: paJson?.PropertyInfo ?? null,
        ownerInfos: paJson?.OwnerInfos ?? null,
        mailingAddress: paJson?.MailingAddress ?? null,
        siteAddress: paJson?.SiteAddress ?? null,
        legalDescription: paJson?.LegalDescription ?? null,
      }),
    };
  } catch (e) {
    return {
      status: LayerStatus.FAILED,
      payload: { folio, folioPadded: folioPadded(folio) },
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
