/**
 * "Open in Google Maps ↗" for a place (2026-10-13, the owner's call: "allow
 * Google Map tagging").
 *
 * G-CORE holds no Google credentials, so a place is tagged by a LINK: a
 * Google Maps link pasted beside the address (a place, a dropped pin, a
 * maps.app.goo.gl share link — the API keeps only http(s), `safeHttpUrl`),
 * and with none, a search for the address itself. The meeting's Where and
 * the sales activity's Address both draw it; nothing else builds a maps URL.
 */

/** Google Maps' own search link for a place typed as text. */
export function mapsSearchUrl(place: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.trim())}`;
}

/** Only an http(s) link becomes an href — the server's rule, again at the door. */
const isHttp = (url: string | null | undefined): url is string => !!url && /^https?:\/\//i.test(url.trim());

export function MapLink({ place, mapUrl }: { place?: string | null; mapUrl?: string | null }) {
  const tagged = isHttp(mapUrl);
  if (!tagged && !place?.trim()) return null;
  return (
    <a className="map-link" href={tagged ? mapUrl.trim() : mapsSearchUrl(place!)} target="_blank" rel="noopener noreferrer">
      {tagged ? 'Open in Google Maps ↗' : 'Find on Google Maps ↗'}
    </a>
  );
}
