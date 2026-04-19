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
 *   evi               — MODIS MOD13Q1 16-day composites (2013-2022), via ORNL DAAC
 *                       Best-contrast pixel selected within 10 km of city center.
 *
 * Run:  node scripts/generate-preset-oakland.js
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchModisEVI } from '../src/fetch/evi.js';
import { fetchPm25 } from '../src/fetch/pm25.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Oakland city center — findSeasonalPixel in evi.js will search within 10 km
// for the pixel with the greatest EVI seasonal amplitude.
const LAT  = 37.8044;
const LON  = -122.2712;
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
    + '&daily=temperature_2m_max,precipitation_sum,windspeed_10m_mean,winddirection_10m_dominant'
    + '&timezone=America%2FLos_Angeles'
    + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch';

  process.stdout.write('Fetching ERA5 daily archive 1991–2020 (~11k rows)… ');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ERA5 HTTP ${r.status}: ${await r.text()}`);
  const d = await r.json();
  process.stdout.write('done.\n');
  return d;
}

function circMeanDir(sx, sy, n) {
  if (n === 0) return null;
  return ((Math.atan2(sy / n, sx / n) * 180 / Math.PI) + 360) % 360;
}

function computeWindDirNormals(dates, dirs) {
  const sxs = new Array(365).fill(0), sys = new Array(365).fill(0);
  const cnts = new Array(365).fill(0);
  dates.forEach((d, i) => {
    const v = dirs[i];
    if (v == null || isNaN(v)) return;
    const doy = dateToCalDOY(d);
    if (doy < 0) return;
    const r = v * Math.PI / 180;
    sxs[doy] += Math.cos(r); sys[doy] += Math.sin(r); cnts[doy]++;
  });
  const result = sxs.map((sx, i) => circMeanDir(sx, sys[i], cnts[i]));
  // Fill gaps by circular interpolation
  for (let i = 0; i < 365; i++) {
    if (result[i] !== null) continue;
    let pi = i - 1, ni = i + 1;
    while (pi >= 0  && result[pi] === null) pi--;
    while (ni < 365 && result[ni] === null) ni++;
    if (pi < 0)    { result[i] = result[ni]; continue; }
    if (ni >= 365) { result[i] = result[pi]; continue; }
    // Circular lerp
    let diff = ((result[ni] - result[pi] + 540) % 360) - 180;
    const t = (i - pi) / (ni - pi);
    result[i] = ((result[pi] + diff * t) + 360) % 360;
  }
  return result.map(v => v === null ? null : Math.round(v * 10) / 10);
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nGenerating Oakland preset  lat=${LAT}  lon=${LON}\n${'─'.repeat(50)}`);

  // ERA5
  const era5 = await fetchERA5();
  const { time, temperature_2m_max, precipitation_sum, windspeed_10m_mean, winddirection_10m_dominant } = era5.daily;
  const temp    = computeDOYNormals(time, temperature_2m_max);
  const rain    = computeDOYNormals(time, precipitation_sum);
  const wind    = computeDOYNormals(time, windspeed_10m_mean);
  const windDir = computeWindDirNormals(time, winddirection_10m_dominant);

  // Daylight (pure math, no network)
  const daylight = computeDaylight();

  // MODIS EVI — reuses production fetch logic from src/fetch/evi.js:
  // selects the highest-seasonality pixel within 10 km, averages 10 years (2013-2022)
  // with IQR trimming, and Gaussian-smooths to a 365-point daily curve.
  process.stdout.write('Fetching MODIS EVI (selecting best pixel within 10 km, 10-year baseline):\n');
  let lastPct = -1;
  const { evi, sampLat, sampLon, peakKey: eviPeakKey, troughKey: eviTroughKey } = await fetchModisEVI(LAT, LON, pct => {
    if (pct !== lastPct) { process.stdout.write(`\r  ${pct}%`); lastPct = pct; }
  });
  process.stdout.write(`\r  done. Sampled pixel: ${sampLat.toFixed(5)}, ${sampLon.toFixed(5)}\n`);

  // Diagnostic
  const qAvg = (a, b) => {
    const vals = evi.slice(a, b);
    return (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(3);
  };
  console.log(`  [diag] smoothed EVI by quarter: Jan-Mar=${qAvg(0,90)} Apr-Jun=${qAvg(90,181)} Jul-Sep=${qAvg(181,273)} Oct-Dec=${qAvg(273,365)}`);

  // PM2.5 air quality normals (CAMS 2014–2023, via Open-Meteo)
  process.stdout.write('Fetching CAMS PM2.5 air quality normals (2014–2023)… ');
  let pm25 = null;
  try {
    pm25 = await fetchPm25(LAT, LON);
    process.stdout.write('done.\n');
  } catch (e) {
    process.stdout.write(`failed (${e.message}) — preset will have no PM2.5 data.\n`);
  }

  // Spot checks
  const s = i => `temp=${temp[i]}°F  rain=${rain[i]}"  wind=${wind[i]}mph  daylight=${daylight[i]}h  evi=${evi[i]}  pm25=${pm25?.[i] ?? 'n/a'}`;
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
      evi,
      wind,
      windDir,
      pm25,
      eviPeakKey, eviTroughKey,
      eviSampLat: sampLat, eviSampLon: sampLon,
      eviSource: 'MODIS EVI 2013–2022',
      resolution: 'daily (ERA5 archive 1991–2020 normals)',
      meta: {
        temp:     { sourceInterval: 'daily',      source: 'ERA5 archive 1991–2020', years: '1991–2020' },
        rain:     { sourceInterval: 'daily',      source: 'ERA5 archive 1991–2020', years: '1991–2020' },
        daylight: { sourceInterval: 'calculated', source: 'astronomical (lat 37.8044°)', years: 'exact' },
        evi:      { sourceInterval: '16-day',     source: 'MODIS MOD13Q1 EVI 2013–2022', years: '2013–2022',
                    sampLat, sampLon },
        wind:     { sourceInterval: 'daily',      source: 'ERA5 archive 1991–2020', years: '1991–2020' },
        pm25:     { sourceInterval: 'hourly',     source: pm25 ? 'CAMS 2014–2023' : 'unavailable', years: '2014–2023' },
      },
    },
  };

  const header = `// Auto-generated by scripts/generate-preset-oakland.js — DO NOT EDIT BY HAND
// Sources:
//   ERA5: Open-Meteo archive API, daily, 1991-01-01 – 2020-12-31
//   EVI: MODIS MOD13Q1 (250m 16-day), ORNL DAAC, 2013-2022
//         Best-contrast pixel at ${sampLat.toFixed(5)}, ${sampLon.toFixed(5)} (selected within 10 km of city center)
//   PM2.5: CAMS reanalysis, hourly, 2014-01-01 – 2023-12-31, via Open-Meteo air quality API
//   Daylight: astronomical calculation for lat ${LAT}°
// Generated: ${new Date().toISOString()}\n\n`;

  const out = header
    + `const OAKLAND = ${JSON.stringify(preset, null, 2)};\n\n`
    + `export const PRESETS = [OAKLAND];\n`;

  const outPath = join(__dirname, '../src/data/presets.js');
  writeFileSync(outPath, out);
  console.log(`\nWrote ${outPath}`);
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
