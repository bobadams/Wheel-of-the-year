// Wheel center "ecology" image.
//
// The image is produced and cached by a small Node service on the Mac mini
// (server/image-server.mjs), reachable through nginx at `/wheel-images/`.
// The client sends a compact set of *facts* about the location's climate; the
// server uses the local Ollama LLM to expand those into a detailed Stable
// Diffusion prompt, runs Forge txt2img, caches the PNG to disk keyed by
// location, and returns it. Subsequent loads for the same location are served
// straight from the cache (no regeneration) unless `force` is set.
//
// In local dev, set VITE_IMAGE_URL=http://macmini.local:7871 in .env.local to
// hit the image service directly, bypassing the nginx proxy.
const IMAGE_BASE = import.meta.env.VITE_IMAGE_URL ?? '/wheel-images';

/**
 * Classify climate data into a biome string suitable for prompt use.
 * Uses annual mean temp and precipitation plus latitude cues.
 */
export function classifyBiome(data) {
  const { temp, rain, evi, lat } = data;
  if (!temp || !rain) return 'temperate landscape';

  const meanTemp = temp.reduce((a, b) => a + b, 0) / temp.length; // °F
  const meanRain = rain.reduce((a, b) => a + b, 0) / rain.length; // in/day
  const meanEvi  = evi  ? evi.reduce((a, b) => a + b, 0) / evi.length : 0.3;
  const absLat   = Math.abs(lat ?? 40);

  if (meanTemp < 23)                                   return 'arctic tundra';
  if (meanTemp < 37 && absLat > 55)                    return 'boreal taiga forest';
  if (meanTemp > 72 && meanRain > 0.16)                return 'tropical rainforest';
  if (meanTemp > 68 && meanRain < 0.04)                return 'hot desert';
  if (meanTemp > 61 && meanRain < 0.08 && meanEvi < 0.2) return 'semi-arid savanna';
  if (meanTemp > 61 && meanRain > 0.08)                return 'subtropical forest';
  if (meanRain < 0.04 && meanEvi < 0.15)               return 'arid shrubland';
  if (meanRain < 0.06)                                 return 'temperate grassland prairie';
  if (meanTemp < 50)                                   return 'cool temperate mixed forest';
  return 'temperate deciduous forest';
}

/** Mean of a numeric array, or null. */
function mean(arr) {
  return Array.isArray(arr) && arr.length
    ? arr.reduce((a, b) => a + b, 0) / arr.length
    : null;
}

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Mean of arr over the DOY half-open range [a, b), skipping non-numbers. */
function binMean(arr, a, b) {
  if (!Array.isArray(arr)) return null;
  let s = 0, n = 0;
  for (let i = a; i < b; i++) {
    const v = arr[i];
    if (typeof v === 'number' && !Number.isNaN(v)) { s += v; n++; }
  }
  return n ? s / n : null;
}

/**
 * Characterize the local year as 12 equal time-bands (one per ~month), each
 * described by *actual* normalized conditions from this location's data rather
 * than a generic season template. Band 0 starts at DOY 0 (winter solstice), the
 * same anchor the wheel and the center-image warp use, so the planet's seasonal
 * wedges line up with the rings. The image service turns these into the colors
 * of a synthetic panorama it then runs through img2img — so e.g. a place whose
 * grass is green in its wet winter and golden in its dry summer renders that
 * way, not the northern-hemisphere default.
 *
 * Each band: veg (greenness 0–1), warm (temp 0–1), wet (rain 0–1), snow (0–1),
 * cold (below-freezing whiteness 0–1). Values are null when data is missing.
 */
export function monthlyConditions(data) {
  const N = (data.temp?.length) || (data.evi?.length) || 365;
  const B = 12;
  const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
  const out = [];
  for (let m = 0; m < B; m++) {
    const a = Math.round((m * N) / B);
    const b = Math.round(((m + 1) * N) / B);
    const t    = binMean(data.temp, a, b);   // °F
    const veg  = binMean(data.evi,  a, b);    // EVI
    const rain = binMean(data.rain, a, b);    // in/day
    const snow = binMean(data.snow, a, b);    // in
    out.push({
      warm: t    == null ? null : r2(clamp01((t - 32) / (100 - 32))),
      veg:  veg  == null ? null : r2(clamp01((veg - 0.02) / (0.65 - 0.02))),
      wet:  rain == null ? null : r2(clamp01(rain / 0.3)),
      snow: snow == null ? null : r2(clamp01(snow / 12)),
      // Whiteness from cold even when there's no snow series: 1 at ≤10°F, 0 at ≥40°F.
      cold: t    == null ? null : r2(clamp01((40 - t) / 30)),
    });
  }
  return out;
}

/**
 * Build the compact "facts" payload the server uses to compose a prompt.
 * Keeping the climate logic here (where the data lives) lets the server stay a
 * thin LLM + Forge + cache layer.
 */
export function buildImageFacts(data) {
  const meanTemp = mean(data.temp);
  const meanRain = mean(data.rain);
  const meanEvi  = mean(data.evi);
  const lat = data.lat ?? 40;
  return {
    name:       data.name || 'an unnamed location',
    lat,
    hemisphere: lat < 0 ? 'southern' : 'northern',
    biome:      classifyBiome(data),
    meanTempF:  meanTemp == null ? null : Math.round(meanTemp),
    // tenths of an inch/day reads more naturally to the LLM as in/month
    meanRainInPerMonth: meanRain == null ? null : Math.round(meanRain * 30 * 10) / 10,
    vegetationIndex: meanEvi == null ? null : Math.round(meanEvi * 100) / 100,
    // 12 data-driven time-bands the service paints into the warp source.
    monthly: monthlyConditions(data),
  };
}

/**
 * Stable cache key for a location. Prefers the name; falls back to rounded
 * lat/lon so unnamed coordinates still cache consistently.
 */
export function locationKey(data) {
  const base = data.name
    ? data.name
    : `${(data.lat ?? 0).toFixed(2)}_${(data.lon ?? 0).toFixed(2)}`;
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
    || 'location';
}

/**
 * Fetch (or generate) the cached ecology image for the current location.
 * Returns a blob URL suitable for `new Image().src`.
 * Throws if the image service is unreachable or returns an error.
 *
 * @param {object} data    currentData (needs name/lat plus temp/rain/evi)
 * @param {object} opts
 * @param {boolean} opts.force  bypass the server cache and regenerate
 */
export async function fetchWheelImage(data, { force = false } = {}) {
  const key   = locationKey(data);
  const facts = buildImageFacts(data);

  const response = await fetch(`${IMAGE_BASE}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, facts, force }),
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try { detail = (await response.json()).error ?? detail; } catch { /* noop */ }
    throw new Error(`Image service error: ${detail}`);
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
}
