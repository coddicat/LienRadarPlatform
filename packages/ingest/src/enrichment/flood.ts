import { LayerStatus, RiskResult } from "@lienradar/shared";
import { Prisma, prisma } from "@lienradar/db";

const MD_FLOOD =
  "https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/FEMAFloodZone_gdb/FeatureServer/0/query";

const NFHL =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Flood_Hazard_Reduced_Set_gdb/FeatureServer/0/query";

export async function probeFlood(): Promise<{ ok: boolean; error?: string; detail?: string }> {
  try {
    const url = `${MD_FLOOD}?where=1%3D1&returnCountOnly=true&f=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = (await res.json()) as { count?: number; error?: unknown };
    if (json.error) return { ok: false, error: JSON.stringify(json.error) };
    return { ok: true, detail: `MD FEMAFloodZone count=${json.count ?? "n/a"}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** National NFHL probe — used for Broward / Palm Beach / Monroe flood resources. */
export async function probeNfhl(): Promise<{ ok: boolean; error?: string; detail?: string }> {
  try {
    const url = `${NFHL}?where=1%3D1&returnCountOnly=true&f=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ok: false, error: `NFHL HTTP ${res.status}` };
    const json = (await res.json()) as { count?: number; error?: unknown };
    if (json.error) return { ok: false, error: JSON.stringify(json.error) };
    return { ok: true, detail: `NFHL USA_Flood_Hazard count=${json.count ?? "n/a"}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function queryPoint(
  url: string,
  lon: number,
  lat: number,
  outFields: string,
): Promise<Record<string, unknown> | null> {
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields,
    returnGeometry: "false",
    f: "json",
  });
  const res = await fetch(`${url}?${params}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    features?: Array<{ attributes?: Record<string, unknown> }>;
    error?: unknown;
  };
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.features?.[0]?.attributes ?? null;
}

function zoneRisk(zone: string | null, sfha: boolean | null): {
  result: string;
  blocksBid: boolean;
  evidence: string;
} {
  const z = (zone || "").toUpperCase();
  if (!z) {
    return {
      result: RiskResult.UNKNOWN,
      blocksBid: true,
      evidence: "No flood zone polygon at coordinates",
    };
  }
  const special = /^A|^V|AE|AO|AH|VE/.test(z) || sfha === true;
  if (special) {
    return {
      result: RiskResult.FAIL,
      blocksBid: true,
      evidence: `FEMA SFHA / high-risk zone ${z}`,
    };
  }
  if (z === "X" || z === "B" || z === "C") {
    return {
      result: RiskResult.PASS,
      blocksBid: false,
      evidence: `FEMA zone ${z} (not SFHA)`,
    };
  }
  return {
    result: RiskResult.UNKNOWN,
    blocksBid: true,
    evidence: `Unrecognized FEMA zone ${z}`,
  };
}

export async function enrichFlood(
  lotId: string,
  lat: number | null | undefined,
  lng: number | null | undefined,
  county?: string | null,
) {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    await prisma.enrichmentLayer.upsert({
      where: { lotId_name: { lotId, name: "flood" } },
      update: {
        status: LayerStatus.PARTIAL,
        payload: { reason: "missing_coords" },
        error: "Need PA lat/lng first",
        fetchedAt: new Date(),
      },
      create: {
        lotId,
        name: "flood",
        status: LayerStatus.PARTIAL,
        payload: { reason: "missing_coords" },
        error: "Need PA lat/lng first",
      },
    });
    return { ok: false, reason: "missing_coords" };
  }

  try {
    const preferNfhl = county != null && county !== "miami-dade";
    let source: "md_fema" | "nfhl" | "none" = "none";
    let attrs: Record<string, unknown> | null = null;
    if (preferNfhl) {
      attrs = await queryPoint(NFHL, lng, lat, "FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE");
      if (attrs) source = "nfhl";
    } else {
      attrs = await queryPoint(MD_FLOOD, lng, lat, "FZONE,ZONESUBTY,ELEV");
      if (attrs) source = "md_fema";
      if (!attrs) {
        attrs = await queryPoint(NFHL, lng, lat, "FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE");
        if (attrs) source = "nfhl";
      }
    }
    const zone = String(attrs?.FZONE ?? attrs?.FLD_ZONE ?? "").trim() || null;
    const subtype = String(attrs?.ZONESUBTY ?? attrs?.ZONE_SUBTY ?? "").trim() || null;
    const sfhaRaw = attrs?.SFHA_TF;
    const sfha =
      sfhaRaw == null ? null : String(sfhaRaw).toUpperCase() === "T" || sfhaRaw === true;
    const decision = zoneRisk(zone, sfha);

    await prisma.enrichmentLayer.upsert({
      where: { lotId_name: { lotId, name: "flood" } },
      update: {
        status: zone ? LayerStatus.OK : LayerStatus.PARTIAL,
        payload: { lat, lng, zone, subtype, sfha, source, county: county ?? null } as Prisma.InputJsonValue,
        error: null,
        fetchedAt: new Date(),
      },
      create: {
        lotId,
        name: "flood",
        status: zone ? LayerStatus.OK : LayerStatus.PARTIAL,
        payload: { lat, lng, zone, subtype, sfha, source, county: county ?? null },
      },
    });

    await prisma.riskCheck.upsert({
      where: { lotId_code: { lotId, code: "flood" } },
      update: {
        result: decision.result as "PASS" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE",
        blocksBid: decision.blocksBid,
        evidence: decision.evidence,
        checkedAt: new Date(),
      },
      create: {
        lotId,
        code: "flood",
        result: decision.result as "PASS" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE",
        blocksBid: decision.blocksBid,
        evidence: decision.evidence,
      },
    });

    return { ok: true, zone, result: decision.result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.enrichmentLayer.upsert({
      where: { lotId_name: { lotId, name: "flood" } },
      update: {
        status: LayerStatus.FAILED,
        payload: { lat, lng },
        error: msg,
        fetchedAt: new Date(),
      },
      create: {
        lotId,
        name: "flood",
        status: LayerStatus.FAILED,
        payload: { lat, lng },
        error: msg,
      },
    });
    return { ok: false, error: msg };
  }
}
