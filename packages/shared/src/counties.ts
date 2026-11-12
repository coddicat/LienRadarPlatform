export type CountySlug = "miami-dade" | "broward" | "palm-beach" | "monroe";

export type CountyEnrichmentFlags = {
  /** Free public Property Appraiser values/sales */
  pa: "live" | "probe" | "none";
  /** Tax delinquent / bill path */
  tax: "live" | "probe" | "not_configured" | "none";
  /** Clerk docket / official records */
  clerk: "live" | "not_configured" | "none";
  /** Flood layer preference */
  flood: "md_layer" | "nfhl";
};

export type CountyConfig = {
  slug: CountySlug;
  name: string;
  taxDeedHost: string | null;
  foreclosureHost: string | null;
  enrichment: CountyEnrichmentFlags;
};

/** South Florida wave — only these appear in the county filter by default. */
export const ACTIVE_COUNTIES: readonly CountySlug[] = [
  "miami-dade",
  "broward",
  "palm-beach",
  "monroe",
] as const;

export const COUNTY_REGISTRY: Record<CountySlug, CountyConfig> = {
  "miami-dade": {
    slug: "miami-dade",
    name: "Miami-Dade",
    taxDeedHost: "miamidade.realtaxdeed.com",
    foreclosureHost: "miamidade.realforeclose.com",
    enrichment: { pa: "live", tax: "live", clerk: "live", flood: "md_layer" },
  },
  broward: {
    slug: "broward",
    name: "Broward",
    taxDeedHost: "broward.realtaxdeed.com",
    foreclosureHost: "broward.realforeclose.com",
    enrichment: { pa: "live", tax: "not_configured", clerk: "not_configured", flood: "nfhl" },
  },
  "palm-beach": {
    slug: "palm-beach",
    name: "Palm Beach",
    taxDeedHost: "palmbeach.realtaxdeed.com",
    foreclosureHost: "palmbeach.realforeclose.com",
    enrichment: { pa: "live", tax: "probe", clerk: "not_configured", flood: "nfhl" },
  },
  monroe: {
    slug: "monroe",
    name: "Monroe",
    taxDeedHost: "monroe.realtaxdeed.com",
    foreclosureHost: "monroe.realforeclose.com",
    enrichment: { pa: "live", tax: "not_configured", clerk: "not_configured", flood: "nfhl" },
  },
};

export const ACTIVE_COUNTY_SET = new Set<string>(ACTIVE_COUNTIES);

/** Resolve active counties from env override (pass process.env.LR_ACTIVE_COUNTIES from Node) or registry default. */
export function resolveActiveCounties(envValue?: string | null): CountySlug[] {
  const raw = (envValue ?? "").trim();
  if (!raw) return [...ACTIVE_COUNTIES];
  const out: CountySlug[] = [];
  for (const part of raw.split(",")) {
    const slug = part.trim().toLowerCase() as CountySlug;
    if (COUNTY_REGISTRY[slug] && !out.includes(slug)) out.push(slug);
  }
  return out.length ? out : [...ACTIVE_COUNTIES];
}

export function countyResourceKey(county: string, kind: string): string {
  const slug = county.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").toLowerCase();
  return `${slug}_${kind}`;
}

export function isActiveCounty(slug: string): boolean {
  return ACTIVE_COUNTY_SET.has(slug);
}

export const DEFAULT_COUNTY: CountySlug = "miami-dade";
