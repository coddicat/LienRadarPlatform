/** Resolve county slug to display label via i18n, with title-case fallback. */
export function countyLabel(
  t: (path: string, vars?: Record<string, string | number>) => string,
  slug: string | null | undefined,
): string {
  if (!slug) return "—";
  const key = `counties.${slug}`;
  const translated = t(key);
  if (translated !== key) return translated;
  return slug
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

/** Map a DataResource key (or name) to an ACTIVE_COUNTIES slug, or "shared". */
export function resourceCountySlug(key: string | null | undefined, name?: string | null): string {
  const hay = `${key ?? ""} ${name ?? ""}`.toLowerCase();
  if (/miami[_-]?dade|miamidade/.test(hay) || hay.startsWith("miami_")) return "miami-dade";
  if (hay.startsWith("broward_") || /\bbroward\b/.test(hay)) return "broward";
  if (hay.startsWith("palm_beach_") || /palm[_\s-]?beach/.test(hay)) return "palm-beach";
  if (hay.startsWith("monroe_") || /\bmonroe\b/.test(hay)) return "monroe";
  // Miami-area REO marketplaces
  if (/auction_com|hubzu|_reo\b/.test(hay)) return "miami-dade";
  return "shared";
}

/**
 * Counties a scheduled job touches, derived from its DATA_RESOURCES keys.
 * Empty resourceKeys (e.g. method_nightly) → all active counties (applies everywhere).
 */
export function jobCountiesFromResourceKeys(
  resourceKeys: string[] | null | undefined,
  activeCounties: readonly string[],
): string[] {
  if (!resourceKeys?.length) return [...activeCounties];
  const out: string[] = [];
  for (const key of resourceKeys) {
    const slug = resourceCountySlug(key);
    if (slug !== "shared" && !out.includes(slug)) out.push(slug);
  }
  // Preserve ACTIVE_COUNTIES order
  return activeCounties.filter((c) => out.includes(c));
}
