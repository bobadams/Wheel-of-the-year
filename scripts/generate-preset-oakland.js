#!/usr/bin/env node
/**
 * scripts/generate-preset-oakland.js
 *
 * Fetches the highest-resolution available data for Oakland, CA and writes
 * src/data/presets.js with 365-point daily normals.
 *
 * Sources & intervals:
 *   temp, rain, wind  — ERA5 archive daily (1991-2020), via Open-Meteo
 *   daylight          — astronomical calculation (exact daily)
 *   ndvi              — MODIS MOD13Q1 16-day composites (2010-2022), via ORNL DAAC
 *
 * Run:  node scripts/generate-preset-oakland.js
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Oakland hills (Redwood Regional Park / Joaquin Miller area).
// The original 37.8°N, -122.2°W pixel was dominated by evergreen tree canopy
// (live oaks, eucalyptus) — NDVI ~0.39 year-round with no seasonal signal.
// Moving ~3km east into the grass-covered hillsides captures Oakland's
// Mediterranean wet-season green / dry-season brown cycle.
const LAT  = 37.83;
const LON  = -122.17;
const NAME = 'Oakland, California';

const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// ─── Date helpers ─────────────────────────────────────────────────────────────

/** Map a YYYY-MM-DD string to 0-based 365-day DOY. Returns -1 for Feb 29. */
function dateToCalDOY(dateStr) {
  const [, mo, dy] = dateStr.split('-').map(Number);
  if (mo === 2 && dy === 29) return -1;
  let doy = 0;
  for (let m = 0; m < mo - 1; m++) doy += DIM[m];
  return Math.min(doy + dy - 1, 364);
}

/** Average same-DOY values across all years, fill any gaps by linear interp. */
function computeDOYNormals(dates, values) {
  const sums = new Array(365).fill(0);
  const cnts = new Array(365).fill(0);
  dates.forEach((d, i) => {
    const v = values[i];
    if (v == null || isNaN(v)) return;
    const doy = dateToCalDOY(d);
    if (doy < 0) return;
    sums[doy] += v;
    cnts[doy]++;
  });
  const result = sums.map((s, i) => cnts[i] > 0 ? s / cnts[i] : null);

  // Linear interpolation for any missing DOYs
  for (let i = 0; i < 365; i++) {
    if (result[i] !== null) continue;
    let pi = i - 1, ni = i + 1;
    while (pi >= 0   && result[pi] === null) pi--;
    while (ni < 365  && result[ni] === null) ni++;
    if      (pi < 0)    result[i] = result[ni];
    else if (ni >= 365) result[i] = result[pi];
    else {
      const t = (i - pi) / (ni - pi);
      result[i] = result[pi] * (1 - t) + result[ni] * t;
    }
  }
  return result.map(v => Math.round(v * 1000) / 1000);
}

// ─── ERA5 daily normals (Open-Meteo archive) ─────────────────────────────────

async function fetchERA5() {
  const url = 'https://archive-api.open-meteo.com/v1/archive'
    + `?latitude=${LAT}&longitude=${LON}`
    + '&start_date=1991-01-01&end_date=2020-12-31'
    + '&daily=temperature_2m_mean,precipitation_sum,windspeed_10m_mean'
    + '&timezone=America%2FLos_Angeles'
    + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch';

  process.stdout.write('Fetching ERA5 daily archive 1991–2020 (~11k rows)… ');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ERA5 HTTP ${r.status}: ${await r.text()}`);
  const d = await r.json();
  process.stdout.write('done.\n');
  return d;
}

// ─── Daylight (astronomical) ─────────────────────────────────────────────────

function computeDaylight() {
  return Array.from({ length: 365 }, (_, i) => {
    const d    = i + 1;
    const decl = 23.45 * Math.sin((360 / 365) * (d - 81) * Math.PI / 180);
    const cosH = -Math.tan(LAT * Math.PI / 180) * Math.tan(decl * Math.PI / 180);
    if (cosH <= -1) return 24;
    if (cosH >= 1)  return 0;
    return Math.round((2 / 15) * Math.acos(cosH) * 180 / Math.PI * 100) / 100;
  });
}

// ─── MODIS MOD13Q1 16-day NDVI (ORNL DAAC) ───────────────────────────────────

function julianKey(year, doy1based) {
  return `A${year}${String(Math.min(doy1based, 365)).padStart(3, '0')}`;
}

let _modisFirstRow = true; // print one raw-value diagnostic on first successful fetch

async function fetchModisBatch(startKey, endKey, attempt = 1) {
  const url = `https://modis.ornl.gov/rst/api/v1/MOD13Q1/subset?`
    + `latitude=${LAT}&longitude=${LON}`
    + `&startDate=${startKey}&endDate=${endKey}`
    + `&kmAboveBelow=2&kmLeftRight=2`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) { console.warn(`  MODIS ${startKey}–${endKey}: HTTP ${r.status}`); return []; }
    const d = await r.json();
    if (!d.subset?.length) { console.warn(`  no subset rows for ${startKey}–${endKey}`); return []; }
    const bands = [...new Set(d.subset.map(s => s.band))];
    if (!d.subset.some(s => s.band === '250m_16_days_NDVI')) console.warn(`  band not found. Available: ${bands.join(', ')}`);
    const results = (d.subset || [])
      .filter(s => s.band === '250m_16_days_NDVI')
      .map(row => {
        if (_modisFirstRow) {
          _modisFirstRow = false;
          const raw0 = row.data[0], scale = row.scale ?? 0.0001;
          console.log(`  [diag] date=${row.calendar_date} nPixels=${row.data.length} scale=${row.scale} raw[0]=${raw0} → scaled=${+(raw0 * scale).toFixed(4)}`);
        }
        const vals = row.data.map(v => v * (row.scale ?? 0.0001)).filter(v => v > -0.2 && v <= 1.0);
        if (!vals.length) return null;
        return { date: row.calendar_date, value: vals.reduce((a, b) => a + b, 0) / vals.length };
      })
      .filter(Boolean);
    return results;
  } catch (e) {
    if (attempt < 3) {
      await new Promise(res => setTimeout(res, attempt * 2000));
      return fetchModisBatch(startKey, endKey, attempt + 1);
    }
    console.warn(`  MODIS ${startKey}–${endKey}: ${e.message}`);
    return [];
  }
}

async function fetchModisNDVI(startYear, endYear) {
  const MODIS_DOYS = Array.from({ length: 23 }, (_, i) => 1 + i * 16); // 1,17,33…353
  const BATCH = 10; // API max per request
  const CONCURRENCY = 5; // parallel requests
  const doySum = new Array(365).fill(0);
  const doyCnt = new Array(365).fill(0);

  // Build flat list of all batch tasks
  const tasks = [];
  for (let year = startYear; year <= endYear; year++) {
    for (let i = 0; i < MODIS_DOYS.length; i += BATCH) {
      const batch = MODIS_DOYS.slice(i, i + BATCH);
      tasks.push([julianKey(year, batch[0]), julianKey(year, batch[batch.length - 1])]);
    }
  }
  process.stdout.write(`Fetching MODIS NDVI ${startYear}–${endYear} (${tasks.length} batches, concurrency ${CONCURRENCY}):\n`);

  let done = 0;
  const active = new Set();
  for (const [startKey, endKey] of tasks) {
    const p = fetchModisBatch(startKey, endKey).then(results => {
      active.delete(p);
      process.stdout.write(results.length ? '.' : 'x');
      if (++done % 13 === 0) process.stdout.write(` ${done}/${tasks.length}\n`);
      results.forEach(({ date, value }) => {
        const doy = dateToCalDOY(date);
        if (doy < 0) return;
        for (let dd = 0; dd < 16; dd++) {
          const d2 = (doy + dd) % 365;
          doySum[d2] += value;
          doyCnt[d2]++;
        }
      });
    });
    active.add(p);
    if (active.size >= CONCURRENCY) await Promise.race(active);
  }
  await Promise.all(active);
  process.stdout.write('\n');
async function fetchModisNDVI(startYear, endYear) {
  const startKey = `A${startYear}001`;
  const endKey   = `A${endYear}353`;
  process.stdout.write(`Fetching MODIS NDVI ${startYear}–${endYear} (single request, 4km box)… `);
  const url = `https://modis.ornl.gov/rst/api/v1/MOD13Q1/subset?`
    + `latitude=${LAT}&longitude=${LON}`
    + `&startDate=${startKey}&endDate=${endKey}`
    + `&kmAboveBelow=2&kmLeftRight=2`;
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`MODIS HTTP ${r.status}: ${await r.text()}`);
  const d = await r.json();
  process.stdout.write('done.\n');

  const doySum = new Array(365).fill(0);
  const doyCnt = new Array(365).fill(0);

  (d.subset || [])
    .filter(s => s.band === '250m_16_days_NDVI')
    .forEach(row => {
      const vals = row.data.map(v => v * row.scale).filter(v => v > -0.2 && v <= 1.0);
      if (!vals.length) return;
      const value = vals.reduce((a, b) => a + b, 0) / vals.length;
      const doy = dateToCalDOY(row.calendar_date);
      if (doy < 0) return;
      for (let dd = 0; dd < 16; dd++) {
        const d2 = (doy + dd) % 365;
        doySum[d2] += value;
        doyCnt[d2]++;
      }
    });

  // Build raw annual-average array
  let raw = doySum.map((s, i) => doyCnt[i] > 0 ? s / doyCnt[i] : null);

  // Diagnostic: show seasonal signal in raw data (before smoothing/fill)
  const seasonAvg = (a, b) => {
    const vals = raw.slice(a, b).filter(v => v !== null);
    return vals.length ? (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(3) : 'n/a';
  };
  const nullCount = raw.filter(v => v === null).length;
  console.log(`  [diag] raw NDVI by quarter (pre-smooth): Jan-Mar=${seasonAvg(0,90)} Apr-Jun=${seasonAvg(90,181)} Jul-Sep=${seasonAvg(181,273)} Oct-Dec=${seasonAvg(273,365)}  nullDOYs=${nullCount}/365`);

  // Fill nulls by wrapping interpolation
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < 365; i++) {
      if (raw[i] !== null) continue;
      const prev = raw[(i + 364) % 365], next = raw[(i + 1) % 365];
      raw[i] = prev !== null && next !== null ? (prev + next) / 2
             : prev !== null ? prev : next;
    }
  }

  // Gaussian smoothing to remove 16-day staircase artifact
  const sigma = 7, kernelR = 14;
  const gauss = x => Math.exp(-0.5 * (x / sigma) ** 2);
  const smoothed = raw.map((_, i) => {
    let sum = 0, wt = 0;
    for (let k = -kernelR; k <= kernelR; k++) {
      const j = (i + k + 365) % 365;
      if (raw[j] !== null) { const w = gauss(k); sum += raw[j] * w; wt += w; }
    }
    return Math.round((wt > 0 ? sum / wt : 0) * 1000) / 1000;
  });

  process.stdout.write('MODIS done.\n');
  return smoothed;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nGenerating Oakland preset  lat=${LAT}  lon=${LON}\n${'─'.repeat(50)}`);

  // ERA5
  const era5 = await fetchERA5();
  const { time, temperature_2m_mean, precipitation_sum, windspeed_10m_mean } = era5.daily;
  const temp = computeDOYNormals(time, temperature_2m_mean);
  const rain = computeDOYNormals(time, precipitation_sum);
  const wind = computeDOYNormals(time, windspeed_10m_mean);

  // Daylight (pure math, no network)
  const daylight = computeDaylight();

  // MODIS NDVI
  const ndvi = await fetchModisNDVI(2010, 2022);

  // Spot checks
  const s = i => `temp=${temp[i]}°F  rain=${rain[i]}"  wind=${wind[i]}mph  daylight=${daylight[i]}h  ndvi=${ndvi[i]}`;
  console.log(`\nSpot checks:\n  Jan 1:  ${s(0)}\n  Apr 1:  ${s(90)}\n  Jul 1:  ${s(181)}\n  Oct 1:  ${s(273)}`);

  const preset = {
    label: 'Oakland',
    city: 'Oakland, California',
    data: {
      name: NAME,
      lat: LAT,
      lon: LON,
      temp,
      rain,
      daylight,
      ndvi,
      wind,
      resolution: 'daily (ERA5 archive 1991–2020 normals)',
      meta: {
        temp:     { sourceInterval: 'daily',      source: 'ERA5 archive 1991–2020', years: '1991–2020' },
        rain:     { sourceInterval: 'daily',      source: 'ERA5 archive 1991–2020', years: '1991–2020' },
        daylight: { sourceInterval: 'calculated', source: 'astronomical (lat 37.83°)', years: 'exact' },
        ndvi:     { sourceInterval: '16-day',     source: 'MODIS MOD13Q1 2010–2022', years: '2010–2022' },
        wind:     { sourceInterval: 'daily',      source: 'ERA5 archive 1991–2020', years: '1991–2020' },
      },
    },
  };

  const header = `// Auto-generated by scripts/generate-preset-oakland.js — DO NOT EDIT BY HAND
// Sources:
//   ERA5: Open-Meteo archive API, daily, 1991-01-01 – 2020-12-31
//   NDVI: MODIS MOD13Q1 (250m 16-day), ORNL DAAC, 2010-2022
//   Daylight: astronomical calculation for lat ${LAT}°
// Coordinates: ${LAT}°N, ${LON}°W (Oakland hills — grass-covered for seasonal signal)
// Generated: ${new Date().toISOString()}\n\n`;

  const out = header
    + `const OAKLAND = ${JSON.stringify(preset, null, 2)};\n\n`
    + `export const PRESETS = [OAKLAND];\n`;

  const outPath = join(__dirname, '../src/data/presets.js');
  writeFileSync(outPath, out);
  console.log(`\nWrote ${outPath}`);
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
