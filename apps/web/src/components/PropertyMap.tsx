type Props = {
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  title?: string;
  className?: string;
};

/** Google Maps embed — lat/lng preferred, otherwise address query (no API key required). */
export function PropertyMap({ address, lat, lng, title, className }: Props) {
  const hasCoords = lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng);
  const q = hasCoords
    ? `${lat},${lng}`
    : (address || "").trim();
  if (!q) {
    return (
      <div className={`map-fallback ${className ?? ""}`}>
        <span className="muted">Map unavailable — no coordinates or address yet.</span>
      </div>
    );
  }
  const src = hasCoords
    ? `https://maps.google.com/maps?q=${encodeURIComponent(q)}&z=17&output=embed`
    : `https://maps.google.com/maps?q=${encodeURIComponent(q)}&z=16&output=embed`;

  return (
    <div className={`map-frame ${className ?? ""}`}>
      <iframe
        title={title ?? "Property map"}
        src={src}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        allowFullScreen
      />
      <a
        className="map-open"
        href={
          hasCoords
            ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
            : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
        }
        target="_blank"
        rel="noreferrer"
      >
        Open in Google Maps
      </a>
    </div>
  );
}
