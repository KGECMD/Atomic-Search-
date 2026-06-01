// OpenMaps integration — geocoding via the Nominatim API (OpenStreetMap).
// Privacy-first: no API key required, no user data sent beyond the query
// string. Nominatim's usage policy requires a descriptive User-Agent and
// asks that requests be throttled to ≤1 req/s; we cache results for 1 hour
// so repeated searches for the same location never hit the upstream API.
//
// Frontend rendering uses Leaflet.js with OpenStreetMap tiles — both are
// open-source and require no account or tracking pixel.

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const NOMINATIM_UA = "AtomicSearch/3.0 (privacy-first; https://github.com/kay816577-hue/Atomic-Search-)";

// In-memory result cache keyed by normalised query. Entries expire after
// CACHE_TTL_MS so stale geocoding data doesn't persist across restarts.
const _cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cacheKey(q) {
  return (q || "").toLowerCase().trim();
}

function cacheGet(q) {
  const k = cacheKey(q);
  const entry = _cache.get(k);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(k); return null; }
  return entry.value;
}

function cacheSet(q, value) {
  const k = cacheKey(q);
  _cache.set(k, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Geocode a query string and return structured map results.
 *
 * Each result has the shape:
 *   { displayName, lat, lon, type, importance, boundingBox, osmId, osmType }
 *
 * Returns an empty array on error or when no results are found.
 * Never throws — callers can safely fire-and-forget.
 *
 * @param {string} query  - Free-text location query (e.g. "Paris, France")
 * @param {number} limit  - Maximum number of results to return (default 5)
 * @returns {Promise<Array>}
 */
export async function searchMaps(query, limit = 5) {
  const q = (query || "").trim();
  if (!q) return [];

  const cached = cacheGet(q);
  if (cached) return cached;

  try {
    const url = new URL(`${NOMINATIM_BASE}/search`);
    url.searchParams.set("q", q);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(Math.min(10, Math.max(1, limit))));
    url.searchParams.set("addressdetails", "1");

    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": NOMINATIM_UA,
        "Accept-Language": "en",
        "Referer": "https://atomic-search.onrender.com/",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return [];

    const data = await res.json();
    if (!Array.isArray(data)) return [];

    const results = data.slice(0, limit).map((item) => ({
      displayName: item.display_name || "",
      lat: parseFloat(item.lat) || 0,
      lon: parseFloat(item.lon) || 0,
      type: item.type || item.class || "place",
      importance: parseFloat(item.importance) || 0,
      boundingBox: Array.isArray(item.boundingbox)
        ? item.boundingbox.map(Number)
        : null,
      osmId: item.osm_id || null,
      osmType: item.osm_type || null,
      // Structured address fields for richer display.
      address: item.addressdetails || item.address || null,
    }));

    cacheSet(q, results);
    return results;
  } catch {
    return [];
  }
}

/**
 * Build a Leaflet.js map embed URL for a given lat/lon and zoom level.
 * Returns a URL string pointing to the OpenStreetMap tile server that can
 * be used as the `src` of an iframe or as the tile layer in a Leaflet map.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} zoom  - Zoom level 1–19 (default 13)
 * @returns {string}
 */
export function buildMapEmbedUrl(lat, lon, zoom = 13) {
  const z = Math.max(1, Math.min(19, zoom));
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${z}/${lat}/${lon}`;
}
