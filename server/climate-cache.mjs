// Wheel-of-the-Year climate cache.
//
// A per-location JSON store on disk so a city's climate data is downloaded from
// the upstream APIs once rather than once per visit. Mounted on the image
// service (server/image-server.mjs), reachable through nginx at
// `/wheel-images/climate`:
//
//   GET  /climate?key=…           → the stored record, or 404 if none
//   POST /climate  { key, … }     → merge a patch into the record
//
// The browser owns all the fetching; this is a dumb store. It holds two halves:
//
//   normals — 365-point arrays (ERA5 1991–2020, MODIS EVI 2013–2022, CAMS
//             PM2.5, …). Each is derived from a fixed historical window, so once
//             stored it never needs refreshing. They are merged field by field,
//             which is what lets an interrupted visit be repaired by the next
//             one: whatever landed is kept, and only the gaps are refetched.
//
//   actuals — daily observations stored date-keyed ({ "2026-08-04": 72.1 }),
//             appended to on every visit. Storing dates rather than day-of-year
//             is what makes the top-up incremental — the client reads the newest
//             stored date and asks the upstream API only for the days after it.
//
//   baseline — raw MODIS EVI composites, date-keyed like actuals but HISTORICAL
//             (2013–2022) and therefore never pruned, alongside `eviDoneKeys`:
//             the ids of the batches already fetched. This is what makes the
//             app's slowest fetch resumable — a visit closed partway through
//             leaves its composites behind and the next one asks MODIS only for
//             the batches still missing.
//
// Records are written atomically (tmp file + rename) behind a per-key promise
// chain, so the several patches a single page load sends can't clobber each
// other.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const VERSION = 1;

// Keep a comfortable margin over the year the wheel displays, so a location
// revisited after a long gap still has a full trailing year on hand.
const RETAIN_DAYS = 420;

// 365-point normals arrays (index = day-of-year, 0-based, Feb 29 excluded).
const NORMAL_SERIES = [
  'temp', 'rain', 'daylight', 'wind', 'windDir', 'snow', 'cloud',
  'evi', 'pm25', 'visibility',
];

// Scalars carried alongside the normals (EVI sample point, provenance strings).
const NORMAL_SCALARS = [
  'resolution', 'eviSource', 'eviSampLat', 'eviSampLon', 'eviSampMapUrl',
  'eviPeakKey', 'eviTroughKey',
];

// Daily observation series, stored as { 'YYYY-MM-DD': number }.
const ACTUAL_SERIES = ['temp', 'rain', 'wind', 'snow', 'cloud', 'evi', 'pm25', 'visibility'];

// Raw historical samples behind a normals series, date-keyed and never pruned.
const BASELINE_SERIES = ['evi'];

// Per-baseline lists of completed fetch batches. Bounded well above the 30
// batches an EVI baseline needs, so a malformed client can't grow one forever.
const BASELINE_KEYLISTS = ['eviDoneKeys'];
const MAX_KEYLIST = 200;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isNum = v => typeof v === 'number' && Number.isFinite(v);

/** A valid normals series: 365 entries, each a finite number or null. */
function cleanSeries(arr) {
  if (!Array.isArray(arr) || arr.length !== 365) return null;
  const out = arr.map(v => (isNum(v) ? v : null));
  return out.some(isNum) ? out : null;
}

/**
 * A valid date map: { 'YYYY-MM-DD': finite number }. `cutoff` drops anything
 * older than the retention window; baseline series pass none, since their whole
 * point is to hold decade-old composites.
 */
function cleanDateMap(map, cutoff) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const out = {};
  for (const [date, value] of Object.entries(map)) {
    if (DATE_RE.test(date) && (!cutoff || date >= cutoff) && isNum(value)) out[date] = value;
  }
  return Object.keys(out).length ? out : null;
}

/** A batch-id list: short plain strings, deduped and bounded. */
function cleanKeyList(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const v of list) {
    if (typeof v === 'string' && v.length <= 40 && !out.includes(v)) out.push(v);
    if (out.length >= MAX_KEYLIST) break;
  }
  return out.length ? out : null;
}

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

const recordPath = (cacheDir, key) => path.join(cacheDir, `${key}.climate.json`);

// ── Per-key write serialization ──────────────────────────────────────────────
const chains = new Map();

function withLock(key, fn) {
  const prev = chains.get(key) ?? Promise.resolve();
  const run  = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read the stored record for `key`. Returns null when nothing is cached (or the
 * file is unreadable/corrupt — a bad record should look like a cache miss, not
 * an error, so the client just refetches).
 */
export async function readClimateRecord(key, { cacheDir }) {
  try {
    const rec = JSON.parse(await fs.readFile(recordPath(cacheDir, key), 'utf8'));
    if (!rec || rec.v !== VERSION) return null;
    return rec;
  } catch {
    return null;
  }
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Merge `patch` into the record for `key` and persist it.
 *
 * `patch` may carry `{ name, lat, lon, normals, actuals }`. Normals fields
 * replace their stored counterparts; actuals date-maps are unioned with the
 * stored ones (the incoming value wins on a shared date, since a re-fetch of a
 * recent day supersedes the provisional value it had before).
 *
 * Anything unrecognized or malformed is dropped silently rather than rejected,
 * so one bad field can't cost the client the rest of the patch.
 *
 * Returns a summary of what is now stored.
 */
export async function writeClimateRecord(key, patch, { cacheDir }) {
  return withLock(key, async () => {
    const cutoff = isoDaysAgo(RETAIN_DAYS);
    const prev = (await readClimateRecord(key, { cacheDir })) ?? {};

    const rec = {
      v: VERSION,
      key,
      name: typeof patch?.name === 'string' ? patch.name : prev.name ?? '',
      lat: isNum(patch?.lat) ? patch.lat : prev.lat ?? null,
      lon: isNum(patch?.lon) ? patch.lon : prev.lon ?? null,
      normals: { ...(prev.normals ?? {}) },
      actuals: { ...(prev.actuals ?? {}) },
      baseline: { ...(prev.baseline ?? {}) },
      updated: new Date().toISOString(),
    };

    // Normals — field-by-field replace.
    const pn = patch?.normals ?? {};
    for (const k of NORMAL_SERIES) {
      const series = cleanSeries(pn[k]);
      if (series) rec.normals[k] = series;
    }
    for (const k of NORMAL_SCALARS) {
      if (typeof pn[k] === 'string' || isNum(pn[k])) rec.normals[k] = pn[k];
    }
    if (pn.meta && typeof pn.meta === 'object' && !Array.isArray(pn.meta)) {
      rec.normals.meta = { ...(rec.normals.meta ?? {}), ...pn.meta };
    }

    // Actuals — union of date maps, then prune anything past the retention window.
    const pa = patch?.actuals ?? {};
    for (const k of ACTUAL_SERIES) {
      const incoming = cleanDateMap(pa[k], cutoff);
      const existing = cleanDateMap(rec.actuals[k], cutoff);
      if (!incoming && !existing) { delete rec.actuals[k]; continue; }
      rec.actuals[k] = { ...(existing ?? {}), ...(incoming ?? {}) };
    }

    // Baseline — union of raw historical samples, and of the batch ids already
    // fetched. No cutoff: these are decade-old composites by design.
    const pb = patch?.baseline ?? {};
    for (const k of BASELINE_SERIES) {
      const incoming = cleanDateMap(pb[k], null);
      const existing = cleanDateMap(rec.baseline[k], null);
      if (!incoming && !existing) { delete rec.baseline[k]; continue; }
      rec.baseline[k] = { ...(existing ?? {}), ...(incoming ?? {}) };
    }
    for (const k of BASELINE_KEYLISTS) {
      const incoming = cleanKeyList(pb[k]);
      const existing = cleanKeyList(rec.baseline[k]);
      if (!incoming && !existing) { delete rec.baseline[k]; continue; }
      rec.baseline[k] = cleanKeyList([...(existing ?? []), ...(incoming ?? [])]) ?? [];
    }

    await fs.mkdir(cacheDir, { recursive: true });
    const file = recordPath(cacheDir, key);
    const tmp  = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(rec));
    await fs.rename(tmp, file);

    return {
      ok: true,
      key,
      normals: Object.keys(rec.normals),
      actuals: Object.fromEntries(
        Object.entries(rec.actuals).map(([k, m]) => [k, Object.keys(m).length]),
      ),
      baseline: Object.fromEntries(
        Object.entries(rec.baseline).map(([k, v]) => [k, Array.isArray(v) ? v.length : Object.keys(v).length]),
      ),
    };
  });
}
