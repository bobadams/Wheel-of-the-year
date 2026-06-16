// Phenology band — "Wildlife & blooms".
//
// Fetches the characteristic seasonal ecological events for the current location
// (flower blooms, migrations, arrivals, breeding) from the phenology service on
// the Mac mini (server/phenology.mjs), reachable through nginx at
// `/wheel-images/phenology`. The service uses the local LLM to propose events and
// iNaturalist observation histograms to anchor their timing, caching the result
// per location. See src/fetch/image.js for the sibling ecology-image fetch.
//
// In local dev, set VITE_IMAGE_URL=http://macmini.local:7871 in .env.local to hit
// the service directly. Without it the path 404s and the band stays empty.

const IMAGE_BASE = import.meta.env.VITE_IMAGE_URL ?? '/wheel-images';

/**
 * Classify climate data into a biome string for the LLM prompt. Uses annual mean
 * temperature and precipitation plus latitude. (Inlined from the former ecology-
 * image module, which was removed.)
 */
function classifyBiome(data) {
  const { temp, rain, evi, lat } = data;
  if (!temp || !rain) return 'temperate landscape';
  const meanTemp = temp.reduce((a, b) => a + b, 0) / temp.length; // °F
  const meanRain = rain.reduce((a, b) => a + b, 0) / rain.length; // in/day
  const meanEvi  = evi ? evi.reduce((a, b) => a + b, 0) / evi.length : 0.3;
  const absLat   = Math.abs(lat ?? 40);
  if (meanTemp < 23)                                     return 'arctic tundra';
  if (meanTemp < 37 && absLat > 55)                      return 'boreal taiga forest';
  if (meanTemp > 72 && meanRain > 0.16)                  return 'tropical rainforest';
  if (meanTemp > 68 && meanRain < 0.04)                  return 'hot desert';
  if (meanTemp > 61 && meanRain < 0.08 && meanEvi < 0.2) return 'semi-arid savanna';
  if (meanTemp > 61 && meanRain > 0.08)                  return 'subtropical forest';
  if (meanRain < 0.04 && meanEvi < 0.15)                 return 'arid shrubland';
  if (meanRain < 0.06)                                   return 'temperate grassland prairie';
  if (meanTemp < 50)                                     return 'cool temperate mixed forest';
  return 'temperate deciduous forest';
}

/** Stable cache key for a location — slugified name, else rounded lat/lon. */
function locationKey(data) {
  const base = data.name
    ? data.name
    : `${(data.lat ?? 0).toFixed(2)}_${(data.lon ?? 0).toFixed(2)}`;
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
    || 'location';
}

/** Compact facts the phenology service needs to propose + anchor events. */
function buildPhenologyFacts(data) {
  const lat = data.lat ?? 40;
  return {
    name: data.name || 'an unnamed location',
    lat,
    lon: data.lon ?? 0,
    hemisphere: lat < 0 ? 'southern' : 'northern',
    biome: classifyBiome(data),
  };
}

/**
 * Fetch (or generate) the cached phenology events for the current location.
 * Returns an array of event records:
 *   { label, startDOY, peakDOY, endDOY, event_type, source, verified, obs_total }
 * Resolves to [] on any service error so callers can fail silently.
 *
 * @param {object}  data         currentData (needs name/lat/lon plus temp/rain/evi for the biome)
 * @param {object}  opts
 * @param {boolean} opts.force   bypass the server cache and regenerate
 */
export async function fetchPhenology(data, { force = false } = {}) {
  const key   = locationKey(data);
  const facts = buildPhenologyFacts(data);

  const response = await fetch(`${IMAGE_BASE}/phenology`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, facts, force }),
  });
  if (!response.ok) throw new Error(`Phenology service error: ${response.status}`);

  const result = await response.json();
  return Array.isArray(result.events) ? result.events : [];
}
