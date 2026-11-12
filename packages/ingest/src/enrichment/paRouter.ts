import { LayerStatus } from "@lienradar/shared";
import { enrichPropertyAppraiser, probePropertyAppraiser, type PaParcelResult } from "./propertyAppraiser.js";
import { enrichBrowardPa, probeBrowardPa } from "./propertyAppraiserBroward.js";
import { enrichMonroePa, probeMonroePa } from "./propertyAppraiserMonroe.js";
import { enrichPalmBeachPa, probePalmBeachPa } from "./propertyAppraiserPalmBeach.js";

/** Route PA enrich by lot county. Unknown counties fail closed (never default to Miami). */
export async function enrichPropertyAppraiserForCounty(
  county: string,
  folio: string,
): Promise<PaParcelResult> {
  switch (county) {
    case "broward":
      return enrichBrowardPa(folio);
    case "palm-beach":
      return enrichPalmBeachPa(folio);
    case "monroe":
      return enrichMonroePa(folio);
    case "miami-dade":
      return enrichPropertyAppraiser(folio);
    default:
      return {
        status: LayerStatus.FAILED,
        payload: { folio, county, reason: "unknown_county_pa" },
        error: `No PA adapter for county '${county}'`,
      };
  }
}

export async function probeCountyPa(county: string): Promise<{
  ok: boolean;
  configured?: boolean;
  error?: string;
  detail?: string;
  resourceKeys: string[];
}> {
  switch (county) {
    case "broward": {
      const p = await probeBrowardPa();
      return { ...p, configured: true, resourceKeys: ["broward_pa"] };
    }
    case "palm-beach": {
      const p = await probePalmBeachPa();
      return { ...p, configured: true, resourceKeys: ["palm_beach_pa"] };
    }
    case "monroe": {
      const p = await probeMonroePa();
      return {
        ok: p.ok,
        configured: p.configured,
        error: p.error,
        detail: p.detail,
        resourceKeys: ["monroe_pa"],
      };
    }
    case "miami-dade": {
      const p = await probePropertyAppraiser();
      return {
        ...p,
        configured: true,
        resourceKeys: ["miami_dade_pa_arcgis", "miami_dade_pa_json"],
      };
    }
    default:
      return {
        ok: false,
        configured: false,
        error: `No PA probe for county '${county}'`,
        resourceKeys: [],
      };
  }
}
