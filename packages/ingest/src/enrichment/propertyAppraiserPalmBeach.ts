import { LayerStatus } from "@lienradar/shared";
import type { PaParcelResult } from "./propertyAppraiser.js";

const PB_DETAILS = "https://www.pbcpao.gov/Property/Details";
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

function stripTags(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function clean(s: unknown): string | null {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t === "" ? null : t;
}

function paDateToIso(s: string | null | undefined): string | null {
  if (s == null) return null;
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(String(s));
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yyyy = Number(m[3]);
  const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (dt.getUTCFullYear() !== yyyy || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return null;
  return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

type PbSale = {
  DateOfSale: string | null;
  SalePrice: number | null;
  SaleInstrument: string | null;
  OfficialRecordBook: string | null;
  OfficialRecordPage: string | null;
  GranteeName1: string | null;
};

function parsePbDetails(html: string): { owner: string | null; sales: PbSale[] } {
  const sales: PbSale[] = [];
  const tbl = /<table[^>]*id="salesTable"[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (tbl) {
    const body = tbl[1];
    const headRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    const heads: string[] = [];
    let h: RegExpExecArray | null;
    while ((h = headRe.exec(body)) !== null) heads.push(stripTags(h[1]).toUpperCase());
    const findCol = (re: RegExp, dflt: number): number => {
      const i = heads.findIndex((t) => re.test(t));
      return i >= 0 ? i : dflt;
    };
    const cDate = findCol(/SALES?\s*DATE|^DATE$/, 0);
    const cPrice = findCol(/PRICE/, 1);
    const cBookPage = findCol(/BOOK\s*\/?\s*PAGE|OR\s*BOOK/, 2);
    const cType = findCol(/SALE\s*TYPE|INSTRUMENT|DEED\s*TYPE/, 3);
    const cOwner = findCol(/OWNER|GRANTEE|BUYER/, 4);
    const need = Math.max(cDate, cPrice, cBookPage, cType, cOwner) + 1;
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let r: RegExpExecArray | null;
    while ((r = rowRe.exec(body)) !== null) {
      const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      const cells: string[] = [];
      let c: RegExpExecArray | null;
      while ((c = cellRe.exec(r[1])) !== null) cells.push(stripTags(c[1]));
      if (cells.length < need) continue;
      const date = paDateToIso(cells[cDate]);
      if (!date) continue;
      const bp = /(\d{3,6})\s*\/\s*(\d{1,6})/.exec(cells[cBookPage] ?? "");
      sales.push({
        DateOfSale: date.includes("-")
          ? `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`
          : date,
        SalePrice: toNum(cells[cPrice]),
        SaleInstrument: clean(cells[cType]),
        OfficialRecordBook: bp ? bp[1] : null,
        OfficialRecordPage: bp ? bp[2] : null,
        GranteeName1: clean(cells[cOwner]),
      });
    }
  }

  let owner: string | null = null;
  const ow = /<th[^>]*>\s*Owner\(s\)\s*<\/th>([\s\S]*?)<\/table>/i.exec(html);
  if (ow) {
    const firstTd = /<td[^>]*>([\s\S]*?)<\/td>/i.exec(ow[1]);
    if (firstTd) owner = clean(stripTags(firstTd[1]).replace(/\s*\|\s*$/, ""));
  }
  return { owner, sales };
}

export async function probePalmBeachPa(): Promise<{ ok: boolean; error?: string; detail?: string }> {
  try {
    // Homepage probe — empty parcelId often 500s; host reachability is enough for health.
    const res = await fetch("https://www.pbcpao.gov/", {
      headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 (compatible; LienRadar/1.0)" },
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, error: `pbcpao.gov HTTP ${res.status}` };
    return { ok: true, detail: `pbcpao.gov reachable (HTTP ${res.status}); Details used per-folio` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchFdorAttrs(folio: string): Promise<Record<string, unknown> | null> {
  const raw = folio.trim().toUpperCase();
  const digits = folioDigits(folio);
  if (!raw && !digits) return null;
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
        geometry?: { x?: number; y?: number; rings?: number[][][] };
      }>;
      error?: unknown;
    };
    if (json.error) throw new Error(JSON.stringify(json.error));
    const feat = json.features?.[0];
    if (!feat?.attributes) continue;
    let lat: number | null = null;
    let lng: number | null = null;
    if (feat.geometry?.y != null && feat.geometry?.x != null) {
      lat = feat.geometry.y;
      lng = feat.geometry.x;
    } else if (feat.geometry?.rings?.[0]?.length) {
      const ring = feat.geometry.rings[0];
      let x = 0;
      let y = 0;
      for (const [px, py] of ring) {
        x += px;
        y += py;
      }
      lng = x / ring.length;
      lat = y / ring.length;
    }
    return { ...feat.attributes, _lat: lat, _lng: lng };
  }
  return null;
}

/** Palm Beach PA: pbcpao Details (owner/sales) + FDOR values/geo. */
export async function enrichPalmBeachPa(folio: string): Promise<PaParcelResult> {
  const clean = folioDigits(folio);
  if (!clean || /unknown/i.test(folio)) {
    return {
      status: LayerStatus.FAILED,
      payload: { folio, county: "palm-beach" },
      error: "empty or UNKNOWN folio",
    };
  }

  try {
    const detailsUrl = `${PB_DETAILS}?parcelId=${encodeURIComponent(folio.trim())}`;
    const [htmlRes, attrs] = await Promise.all([
      fetch(detailsUrl, {
        headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 (compatible; LienRadar/1.0)" },
        signal: AbortSignal.timeout(45_000),
      }),
      fetchFdorAttrs(folio).catch(() => null),
    ]);

    if (!htmlRes.ok) throw new Error(`pbcpao HTTP ${htmlRes.status}`);
    const html = await htmlRes.text();
    const hasSales = /id="salesTable"/i.test(html);
    const parsed = hasSales ? parsePbDetails(html) : { owner: null, sales: [] as PbSale[] };

    if (!hasSales && !attrs) {
      return {
        status: LayerStatus.PARTIAL,
        payload: { folio, county: "palm-beach", found: false },
      };
    }

    const jv = typeof attrs?.JV === "number" ? attrs.JV : Number(attrs?.JV);
    const justValue = Number.isFinite(jv) && jv > 0 ? jv : null;
    const owner =
      parsed.owner || (attrs?.OWN_NAME != null ? String(attrs.OWN_NAME) : null);
    const address = attrs?.PHY_ADDR1 != null ? String(attrs.PHY_ADDR1) : null;
    const city = attrs?.PHY_CITY != null ? String(attrs.PHY_CITY) : null;
    const zip = attrs?.PHY_ZIPCD != null ? String(attrs.PHY_ZIPCD) : null;
    const dorCode = attrs?.DOR_UC != null ? String(attrs.DOR_UC) : null;
    const living = typeof attrs?.TOT_LVG_AR === "number" ? attrs.TOT_LVG_AR : null;
    const lotSize = typeof attrs?.LND_SQFOOT === "number" ? attrs.LND_SQFOOT : null;
    const lat = typeof attrs?._lat === "number" ? attrs._lat : null;
    const lng = typeof attrs?._lng === "number" ? attrs._lng : null;

    return {
      status: LayerStatus.OK,
      payload: scrubJson({
        folio,
        folioPadded: clean,
        county: "palm-beach",
        source: {
          details: "pbcpao.gov/Property/Details",
          values: attrs ? "Florida_Statewide_Cadastral (FDOR)" : null,
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
          yearBuilt: null,
          condoFlag: null,
          cancelFlag: null,
          lat,
          lng,
        },
        justValue,
        assessedValue: justValue,
        salesInfos: parsed.sales.length ? parsed.sales : null,
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
      payload: { folio, county: "palm-beach" },
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
