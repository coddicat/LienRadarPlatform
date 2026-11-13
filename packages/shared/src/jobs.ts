import {
  ACTIVE_COUNTIES,
  COUNTY_REGISTRY,
  countyResourceKey,
  type CountySlug,
} from "./counties.js";

export type ResourceDef = {
  key: string;
  name: string;
  kind: string;
  endpoint?: string;
  /** Requires env var before live pull is possible */
  requiresEnv?: string;
  usedByJobs: string[];
};

export type ScheduledJobDef = {
  key: string;
  name: string;
  cronExpr: string;
  description: string;
  timezone: string;
  resourceKeys: string[];
};

function auctionResources(): ResourceDef[] {
  const out: ResourceDef[] = [];
  for (const slug of ACTIVE_COUNTIES) {
    const cfg = COUNTY_REGISTRY[slug];
    if (cfg.taxDeedHost) {
      out.push({
        key: countyResourceKey(slug, "taxdeed_realauction"),
        name: `${cfg.name} Tax Deed (RealTaxDeed)`,
        kind: "auction_calendar",
        endpoint: `https://${cfg.taxDeedHost}/index.cfm?zaction=USER&zmethod=CALENDAR`,
        usedByJobs: ["calendar_6h", "day_refresh_30m", "nightly"],
      });
    }
    if (cfg.foreclosureHost) {
      out.push({
        key: countyResourceKey(slug, "foreclose_realauction"),
        name: `${cfg.name} Foreclosure (RealForeclose)`,
        kind: "auction_calendar",
        endpoint: `https://${cfg.foreclosureHost}/index.cfm?zaction=USER&zmethod=CALENDAR`,
        usedByJobs: ["calendar_6h", "day_refresh_30m", "nightly"],
      });
    }
  }
  return out;
}

function countyEnrichmentResources(): ResourceDef[] {
  const out: ResourceDef[] = [];

  // Miami-Dade (existing live paths)
  out.push(
    {
      key: "miami_dade_pa_arcgis",
      name: "Miami-Dade Property Appraiser (Land Info + PA JSON)",
      kind: "enrichment",
      endpoint: "https://gisweb.miamidade.gov/arcgis/rest/services/MD_LandInformation/MapServer/24",
      usedByJobs: ["enrich_pa_6h", "nightly"],
    },
    {
      key: "miami_dade_pa_json",
      name: "Miami-Dade PA public JSON (folio values/sales)",
      kind: "enrichment",
      endpoint:
        "https://apps.miamidadepa.gov/PApublicServiceProxy/PaServicesProxy.ashx?Operation=GetPropertySearchByFolio",
      usedByJobs: ["enrich_pa_6h", "enrich_folio_6h", "nightly"],
    },
    {
      key: "miami_dade_ccviol",
      name: "Miami-Dade Code Compliance (CCVIOL)",
      kind: "enrichment",
      endpoint:
        "https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/CCVIOL_gdb/FeatureServer/0",
      usedByJobs: ["enrich_muni_6h", "nightly"],
    },
    {
      key: "miami_dade_clerk_ocs",
      name: "Miami-Dade Clerk OCS (free docket)",
      kind: "case_docs",
      endpoint: "https://www2.miamidadeclerk.gov/ocs/",
      usedByJobs: ["enrich_clerk_nightly", "nightly"],
    },
    {
      key: "miami_dade_clerk_api",
      name: "Miami-Dade Clerk Developers API (paid OR)",
      kind: "case_docs",
      endpoint: "https://www2.miamidadeclerk.gov/Developers/",
      requiresEnv: "MIAMI_DADE_CLERK_AUTH_KEY",
      usedByJobs: ["enrich_clerk_nightly", "enrich_or_nightly"],
    },
    {
      key: "miami_dade_fema_flood",
      name: "FEMA flood zones (Miami-Dade layer)",
      kind: "enrichment",
      endpoint:
        "https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/FEMAFloodZone_gdb/FeatureServer/0",
      usedByJobs: ["enrich_flood_6h", "nightly"],
    },
    {
      key: "miami_dade_tax_collector",
      name: "Miami-Dade Tax Collector (delinquent list + portal)",
      kind: "taxes",
      endpoint:
        "https://www.miamidade.gov/resources/legal-ads/county/tax-collector/2026/2026-05-13-public-notice-delinquent-property-taxes.pdf",
      usedByJobs: ["enrich_tax_nightly", "nightly"],
    },
    {
      key: "miami_dade_official_records",
      name: "Miami-Dade Official Records (mortgage / liens)",
      kind: "case_docs",
      endpoint: "https://onlineservices.miamidadeclerk.gov/officialrecords",
      requiresEnv: "MIAMI_DADE_CLERK_AUTH_KEY",
      usedByJobs: ["enrich_or_nightly"],
    },
  );

  // Broward
  out.push(
    {
      key: "broward_pa",
      name: "Broward Property Appraiser (BCPA GIS)",
      kind: "enrichment",
      endpoint: "https://gisweb.bcpa.net/arcgis/rest/services/BCPA_WEB_BASE_26/MapServer",
      usedByJobs: ["enrich_pa_6h", "nightly"],
    },
    {
      key: "broward_tax_collector",
      name: "Broward Tax Collector (GovHub — Turnstile gated)",
      kind: "taxes",
      endpoint: "https://broward.county-taxes.com/",
      usedByJobs: ["enrich_tax_nightly"],
    },
    {
      key: "broward_clerk",
      name: "Broward Clerk Official Records (not free / captcha)",
      kind: "case_docs",
      endpoint: "https://officialrecords.broward.org/",
      usedByJobs: ["enrich_clerk_nightly"],
    },
    {
      key: "broward_fema_flood",
      name: "FEMA flood zones (NFHL — Broward)",
      kind: "enrichment",
      endpoint:
        "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Flood_Hazard_Reduced_Set_gdb/FeatureServer/0",
      usedByJobs: ["enrich_flood_6h", "nightly"],
    },
  );

  // Palm Beach
  out.push(
    {
      key: "palm_beach_pa",
      name: "Palm Beach Property Appraiser (pbcpao.gov)",
      kind: "enrichment",
      endpoint: "https://www.pbcpao.gov/Property/Details",
      usedByJobs: ["enrich_pa_6h", "nightly"],
    },
    {
      key: "palm_beach_tax_collector",
      name: "Palm Beach Tax Collector (Aumentum public path)",
      kind: "taxes",
      endpoint: "https://pbctax.publicaccessnow.com/",
      usedByJobs: ["enrich_tax_nightly"],
    },
    {
      key: "palm_beach_clerk",
      name: "Palm Beach Clerk Official Records (reCAPTCHA gated)",
      kind: "case_docs",
      endpoint: "https://erec.mypalmbeachclerk.com/",
      usedByJobs: ["enrich_clerk_nightly"],
    },
    {
      key: "palm_beach_fema_flood",
      name: "FEMA flood zones (NFHL — Palm Beach)",
      kind: "enrichment",
      endpoint:
        "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Flood_Hazard_Reduced_Set_gdb/FeatureServer/0",
      usedByJobs: ["enrich_flood_6h", "nightly"],
    },
  );

  // Monroe
  out.push(
    {
      key: "monroe_pa",
      name: "Monroe Property Appraiser (FDOR cadastral)",
      kind: "enrichment",
      endpoint:
        "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0",
      usedByJobs: ["enrich_pa_6h", "nightly"],
    },
    {
      key: "monroe_tax_collector",
      name: "Monroe Tax Collector (GovHub — Turnstile gated)",
      kind: "taxes",
      endpoint: "https://monroe.county-taxes.com/",
      usedByJobs: ["enrich_tax_nightly"],
    },
    {
      key: "monroe_clerk",
      name: "Monroe Clerk Official Records (not free until proven)",
      kind: "case_docs",
      endpoint: "https://www.clerk-of-the-court.com/",
      usedByJobs: ["enrich_clerk_nightly"],
    },
    {
      key: "monroe_fema_flood",
      name: "FEMA flood zones (NFHL — Monroe)",
      kind: "enrichment",
      endpoint:
        "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Flood_Hazard_Reduced_Set_gdb/FeatureServer/0",
      usedByJobs: ["enrich_flood_6h", "nightly"],
    },
  );

  return out;
}

/** Old miami_* keys — kept for disable/hide during seed; not shown as primary resources. */
export const LEGACY_MIAMI_RESOURCE_KEYS = [
  "miami_taxdeed_realauction",
  "miami_foreclose_realauction",
  "miami_pa_arcgis",
  "miami_pa_json",
  "miami_ccviol",
  "miami_clerk_ocs",
  "miami_clerk_api",
  "miami_fema_flood",
  "miami_tax_collector",
  "miami_official_records",
] as const;

/** Removed marketplace sources — seed disables these if still present in DB. */
export const REMOVED_REO_RESOURCE_KEYS = ["auction_com_reo", "hubzu_reo"] as const;

export const DATA_RESOURCES: ResourceDef[] = [
  ...auctionResources(),
  ...countyEnrichmentResources(),
];

const SOUTH_FL_AUCTION_KEYS = ACTIVE_COUNTIES.flatMap((slug: CountySlug) => {
  const keys: string[] = [];
  const cfg = COUNTY_REGISTRY[slug];
  if (cfg.taxDeedHost) keys.push(countyResourceKey(slug, "taxdeed_realauction"));
  if (cfg.foreclosureHost) keys.push(countyResourceKey(slug, "foreclose_realauction"));
  return keys;
});

export const SCHEDULED_JOBS: ScheduledJobDef[] = [
  {
    key: "calendar_6h",
    name: "South Florida auction calendars",
    cronExpr: "15 */6 * * *",
    description:
      "Pull RealTaxDeed + RealForeclose calendars for Miami-Dade, Broward, Palm Beach, Monroe (next 8 weeks)",
    timezone: "America/New_York",
    resourceKeys: SOUTH_FL_AUCTION_KEYS,
  },
  {
    key: "day_refresh_30m",
    name: "Day-of auction refresh",
    cronExpr: "*/30 * * * *",
    description: "Refresh today's and near-term auction lot cards across active South Florida counties",
    timezone: "America/New_York",
    resourceKeys: SOUTH_FL_AUCTION_KEYS,
  },
  {
    key: "enrich_pa_6h",
    name: "Property Appraiser enrichment",
    cronExpr: "45 */6 * * *",
    description: "Enrich lots by folio via county Property Appraiser (MD / Broward / Palm Beach / Monroe)",
    timezone: "America/New_York",
    resourceKeys: [
      "miami_dade_pa_arcgis",
      "miami_dade_pa_json",
      "broward_pa",
      "palm_beach_pa",
      "monroe_pa",
    ],
  },
  {
    key: "enrich_folio_6h",
    name: "Attach missing folios from address",
    cronExpr: "40 */6 * * *",
    description: "Miami-Dade PA address search for UNKNOWN folio lots only; unique match required",
    timezone: "America/New_York",
    resourceKeys: ["miami_dade_pa_json"],
  },
  {
    key: "enrich_or_nightly",
    name: "Official Records mortgage scan",
    cronExpr: "40 3 * * *",
    description: "Miami-Dade public OR name search for MOR/LIE hits; AuthKey unlocks paid FTP index later",
    timezone: "America/New_York",
    resourceKeys: ["miami_dade_official_records", "miami_dade_clerk_api"],
  },
  {
    key: "enrich_muni_6h",
    name: "Municipal / code-enforcement (CCVIOL)",
    cronExpr: "55 */6 * * *",
    description: "County CCVIOL for unincorporated Miami-Dade; never treats city absence as clean",
    timezone: "America/New_York",
    resourceKeys: ["miami_dade_ccviol"],
  },
  {
    key: "enrich_flood_6h",
    name: "FEMA flood zone by parcel point",
    cronExpr: "5 */6 * * *",
    description: "MD FEMA layer or national NFHL → flood RiskCheck (needs PA lat/lng)",
    timezone: "America/New_York",
    resourceKeys: [
      "miami_dade_fema_flood",
      "broward_fema_flood",
      "palm_beach_fema_flood",
      "monroe_fema_flood",
    ],
  },
  {
    key: "enrich_clerk_nightly",
    name: "Clerk docket / OR notes",
    cronExpr: "30 3 * * *",
    description: "Miami-Dade free OCS; other counties stay NOT_CONFIGURED until a free path is proven",
    timezone: "America/New_York",
    resourceKeys: [
      "miami_dade_clerk_ocs",
      "miami_dade_clerk_api",
      "broward_clerk",
      "palm_beach_clerk",
      "monroe_clerk",
    ],
  },
  {
    key: "enrich_tax_nightly",
    name: "Tax delinquent / bill enrich",
    cronExpr: "50 3 * * *",
    description:
      "MD delinquent list + Palm Beach public tax probe; Broward/Monroe GovHub remain NOT_CONFIGURED (Turnstile)",
    timezone: "America/New_York",
    resourceKeys: [
      "miami_dade_tax_collector",
      "palm_beach_tax_collector",
      "broward_tax_collector",
      "monroe_tax_collector",
    ],
  },
  {
    key: "method_nightly",
    name: "Method / BidGate recompute",
    cronExpr: "20 4 * * *",
    description: "Scaffold missing UNKNOWN inputs and recompute BidGate/ceilings",
    timezone: "America/New_York",
    resourceKeys: [],
  },
  {
    key: "nightly",
    name: "Nightly full cycle",
    cronExpr: "20 2 * * *",
    description: "Health + South Florida calendars + PA + flood + muni + tax probe + method in one pass",
    timezone: "America/New_York",
    resourceKeys: [
      ...SOUTH_FL_AUCTION_KEYS,
      "miami_dade_pa_arcgis",
      "miami_dade_pa_json",
      "broward_pa",
      "palm_beach_pa",
      "monroe_pa",
      "miami_dade_ccviol",
      "miami_dade_fema_flood",
      "broward_fema_flood",
      "palm_beach_fema_flood",
      "monroe_fema_flood",
      "miami_dade_clerk_ocs",
      "miami_dade_tax_collector",
      "palm_beach_tax_collector",
      "broward_tax_collector",
      "monroe_tax_collector",
    ],
  },
];
