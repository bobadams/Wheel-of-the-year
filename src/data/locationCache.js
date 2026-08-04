// Server-side location cache — the client half.
//
// Every location the app downloads is recorded on the Mac mini (see
// server/climate-cache.mjs) so it is fetched from the upstream APIs once rather
// than once per visit. Revisiting a place reads the record back and renders it
// immediately, then tops up only what is actually missing:
//
//   normals — 365-point arrays from fixed historical windows (ERA5 1991–2020,
//             MODIS EVI 2013–2022, CAMS PM2.5, ERA5 visibility). These never go
//             stale, so a stored one is simply reused. They are tracked field by
//             field, which is what repairs an interrupted visit: whatever landed
//             last time is kept and only the gaps are refetched.
//
//   actuals — daily observations, held date-keyed ({ '2026-08-04': 72.1 }) so
//             visits accumulate. `newestDate` gives the client a `since` to hand
//             the fetchers, which then ask upstream only for the days after it.
//
// Reached through nginx at `/wheel-images/climate`. In local dev, set
// VITE_IMAGE_URL=http://macmini.local:7871 in .env.local to hit the service
// directly; without it every call here fails softly and the app just refetches
// as it did before the cache existed.

import { calendarDOY } from '../fetch/actuals.js';

const BASE = import.meta.env.VITE_IMAGE_URL ?? '/wheel-images';

// The year the wheel shows. Older observations stay on the server (they are the
// only record of a location visited long ago) but aren't drawn.
const DISPLAY_DAYS = 365;

// Series stored in each half of a record.
export const NORMAL_SERIES = ['temp', 'rain', 'daylight', 'wind', 'windDir', 'snow', 'cloud', 'evi', 'pm25', 'visibility'];
export const ACTUAL_SERIES = ['temp', 'rain', 'wind', 'snow', 'cloud', 'evi', 'pm25', 'visibility'];

const NORMAL_SCALARS = ['resolution', 'eviSource', 'eviSampLat', 'eviSampLon', 'eviSampMapUrl', 'eviPeakKey', 'eviTroughKey'];

/**
 * Stable cache key for a location — slugified name, else rounded lat/lon. Shared
 * with the ecology-image and phenology caches so all three key alike.
 */
export function locationKey(data) {
  const base = data.name
    ? data.name
    : `${(data.lat ?? 0).toFixed(2)}_${(data.lon ?? 0).toFixed(2)}`;
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
    || 'location';
}

// How far a cached record's coordinates may sit from the point we just geocoded
// before it is treated as a different place. Generous, because a legitimate match
// re-geocodes to essentially the same point and OSM centroids drift a little;
// tight enough that two same-named places in different states never match.
const MAX_DRIFT_KM = 25;

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371, rad = d => d * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Is this record actually for the place we geocoded?
 *
 * Keys come from the geocoder's label, and two genuinely different places can
 * slugify to the same one — "Main Street, Springfield" exists in more than one
 * state. Without this check the second one would silently be served the first
 * one's climate. A record with no stored coordinates predates the check and is
 * given the benefit of the doubt.
 */
export function isSamePlace(rec, lat, lon) {
  if (!Number.isFinite(rec?.lat) || !Number.isFinite(rec?.lon)) return true;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return true;
  return haversineKm(lat, lon, rec.lat, rec.lon) <= MAX_DRIFT_KM;
}

/** Suffix that gives a colliding location its own key, stable across visits. */
export function coordSuffix(lat, lon) {
  return `${Math.round((lat ?? 0) * 100)}_${Math.round((lon ?? 0) * 100)}`;
}

/** A usable normals series: 365 points with at least one real value. */
export function hasSeries(arr) {
  return Array.isArray(arr) && arr.length === 365 && arr.some(v => Number.isFinite(v));
}

/** Newest date held for one actuals series, or null if there is none. */
export function newestDate(dateMap) {
  if (!dateMap) return null;
  let newest = null;
  for (const d of Object.keys(dateMap)) if (!newest || d > newest) newest = d;
  return newest;
}

/** Entries (with `date`) → the { 'YYYY-MM-DD': value } map the server stores. */
export function entriesToDates(entries) {
  if (!entries?.length) return null;
  const out = {};
  for (const e of entries) if (e.date && Number.isFinite(e.value)) out[e.date] = e.value;
  return Object.keys(out).length ? out : null;
}

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whole days between `date` and today; Infinity when there is no date. */
export function daysSince(date) {
  if (!date) return Infinity;
  return Math.floor((Date.now() - new Date(`${date}T00:00:00`).getTime()) / 86400000);
}

/**
 * Date-keyed store → the `{ doy, value }` arrays the drawing code expects, one
 * per series. Only the trailing display year is included, and because the dates
 * are walked oldest-first the newest observation wins each day-of-year slot.
 */
export function actualsForDisplay(store) {
  const cutoff = isoDaysAgo(DISPLAY_DAYS);
  const out = {};
  for (const id of ACTUAL_SERIES) {
    const map = store?.[id];
    if (!map) { out[id] = null; continue; }
    const byDoy = new Map();
    Object.keys(map).sort().forEach(date => {
      if (date >= cutoff && Number.isFinite(map[date])) byDoy.set(calendarDOY(date), map[date]);
    });
    out[id] = byDoy.size
      ? [...byDoy].map(([doy, value]) => ({ doy, value })).sort((a, b) => a.doy - b.doy)
      : null;
  }
  return out;
}

/** Merge a freshly fetched series into the date-keyed store, in place. */
export function mergeActuals(store, id, entries) {
  const dates = entriesToDates(entries);
  if (!dates) return false;
  store[id] = { ...(store[id] ?? {}), ...dates };
  return true;
}

/**
 * Pull cacheable normals fields out of currentData. `keys` narrows it to the
 * fields one stage produced, so each patch carries only its own contribution
 * rather than resending every array on every stage. `meta` always rides along —
 * it is merged server-side, and it is what the source badges read back.
 */
export function normalsFromData(data, keys) {
  const want = keys ? new Set(keys) : null;
  const out = {};
  for (const k of NORMAL_SERIES)  if ((!want || want.has(k)) && hasSeries(data[k])) out[k] = data[k];
  for (const k of NORMAL_SCALARS) if ((!want || want.has(k)) && data[k] != null)    out[k] = data[k];
  if (data.meta) {
    // Skip the in-flight placeholders — persisting "fetching…" would have a later
    // cached load briefly show a badge for a fetch that is not happening.
    const meta = Object.fromEntries(
      Object.entries(data.meta).filter(([, m]) => m?.source !== 'fetching…'),
    );
    if (Object.keys(meta).length) out.meta = meta;
  }
  return out;
}

// ── Transport ────────────────────────────────────────────────────────────────

/**
 * Read the stored record for a location, or null on a miss (or if the service is
 * unreachable — a cache that is down must never block a load).
 */
export async function loadLocationCache(key) {
  try {
    const r = await fetch(`${BASE}/climate?key=${encodeURIComponent(key)}`);
    if (!r.ok) return null;
    const rec = await r.json();
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

/**
 * Record a patch against a location. Fire-and-forget: callers send one after each
 * stage of a load completes, so a visit abandoned midway still leaves everything
 * that had arrived by then on the server for the next visit to build on.
 */
export function saveLocationCache(key, patch) {
  try {
    fetch(`${BASE}/climate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, ...patch }),
    }).catch(() => {});
  } catch { /* cache is best-effort */ }
}
