import { fetchModisBatch } from './evi.js';

// Longest window we ever ask an upstream API for — a little under a full year,
// which is all the wheel can display at once.
const WINDOW_DAYS = 350;

// How far back to re-fetch past the newest date already stored. The last few
// days of a reanalysis archive are provisional and get revised, so a small
// overlap keeps the tail honest instead of freezing the first value seen.
const OVERLAP_DAYS = 3;

export function calendarDOY(dateStr) {
  const [, mo, dy] = dateStr.split('-').map(Number);
  const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let doy = 0;
  for (let m = 0; m < mo - 1; m++) doy += dim[m];
  return Math.min(doy + dy - 1, 364);
}

const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function todayDate() { return fmt(new Date()); }

/**
 * The date range to request, given the newest date already held for this series.
 * With no `since` it is the full trailing window; with one it is just the days
 * after it (less OVERLAP_DAYS), which is what makes a revisit cheap. A `since`
 * older than the window falls back to the full window.
 */
function requestRange(since) {
  const now = new Date();
  const floor = new Date(now); floor.setDate(floor.getDate() - WINDOW_DAYS);
  let start = floor;
  if (since) {
    const s = new Date(`${since}T00:00:00`);
    s.setDate(s.getDate() - OVERLAP_DAYS);
    if (s > floor) start = s;
  }
  return { start: fmt(start), end: fmt(now) };
}

/**
 * Recent daily weather observations. Each entry carries its calendar `date`
 * alongside the day-of-year, so results can be merged across visits and stored
 * date-keyed (see src/data/locationCache.js) rather than collapsed onto DOY.
 *
 * @param {string} [since] newest date already held ('YYYY-MM-DD') — fetch only past it
 */
export async function fetchActuals(lat, lon, since) {
  const { start, end } = requestRange(since);

  const url = `https://archive-api.open-meteo.com/v1/archive?`
    + `latitude=${lat}&longitude=${lon}`
    + `&start_date=${start}&end_date=${end}`
    + `&daily=temperature_2m_max,precipitation_sum,windspeed_10m_mean,snow_depth_mean,cloudcover_mean&timezone=auto`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Actuals API error ${r.status}`);
  const d = await r.json();
  if (!d.daily?.time?.length) throw new Error('No actuals data returned');

  const temp = [], rain = [], wind = [], snow = [], cloud = [];
  d.daily.time.forEach((date, i) => {
    const doy = calendarDOY(date);
    const tc = d.daily.temperature_2m_max[i];
    const p  = d.daily.precipitation_sum[i];
    const w  = d.daily.windspeed_10m_mean[i];
    const sn = d.daily.snow_depth_mean?.[i];
    const cl = d.daily.cloudcover_mean?.[i];
    if (tc != null) temp.push({ date, doy, value: Math.round((tc * 9 / 5 + 32) * 10) / 10 });
    if (p  != null) rain.push({ date, doy, value: Math.round(p / 25.4 * 1000) / 1000 });
    if (w  != null) wind.push({ date, doy, value: Math.round(w * 0.621371 * 10) / 10 });
    if (sn != null) snow.push({ date, doy, value: Math.round(sn * 39.3701 * 100) / 100 });
    if (cl != null) cloud.push({ date, doy, value: Math.round(cl * 10) / 10 });
  });

  return { temp, rain, wind, snow, cloud, todayDOY: calendarDOY(todayDate()) };
}

/** Average an hourly series (timestamps 'YYYY-MM-DDTHH:MM') into daily entries. */
function hourlyToDaily(time, values, transform) {
  const sums = {}, counts = {};
  time.forEach((ts, i) => {
    const v = values[i];
    if (v == null) return;
    const date = ts.slice(0, 10);
    sums[date] = (sums[date] ?? 0) + v;
    counts[date] = (counts[date] ?? 0) + 1;
  });
  return Object.entries(sums)
    .map(([date, sum]) => ({ date, doy: calendarDOY(date), value: transform(sum / counts[date]) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

export async function fetchActualsPm25(lat, lon, since) {
  const { start, end } = requestRange(since);

  const url = `https://air-quality-api.open-meteo.com/v1/air-quality`
    + `?latitude=${lat}&longitude=${lon}`
    + `&start_date=${start}&end_date=${end}`
    + `&hourly=pm2_5&timezone=auto`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`PM2.5 actuals API error ${r.status}`);
  const data = await r.json();
  return hourlyToDaily(data.hourly.time, data.hourly.pm2_5, v => Math.round(v * 100) / 100);
}

export async function fetchActualsVisibility(lat, lon, since) {
  const { start, end } = requestRange(since);

  const url = `https://archive-api.open-meteo.com/v1/archive?`
    + `latitude=${lat}&longitude=${lon}`
    + `&start_date=${start}&end_date=${end}`
    + `&hourly=visibility&timezone=auto`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Visibility actuals API error ${r.status}`);
  const data = await r.json();
  return hourlyToDaily(data.hourly.time, data.hourly.visibility, v => Math.round(v / 1609.34 * 100) / 100);
}

export async function fetchRecentEVI(lat, lon, since) {
  const { start, end } = requestRange(since);
  const endTime = new Date(`${end}T00:00:00`);

  // MODIS composites land every 16 days on fixed DOYs; walk the window and snap
  // each date back to the composite it falls in.
  const allDates = [];
  for (let t = new Date(`${start}T00:00:00`); t <= endTime; t.setDate(t.getDate() + 16)) {
    const doy16 = Math.floor(calendarDOY(fmt(t)) / 16) * 16 + 1;
    const key = `A${t.getFullYear()}${String(Math.min(doy16, 365)).padStart(3, '0')}`;
    if (!allDates.includes(key)) allDates.push(key);
  }
  allDates.sort();
  if (!allDates.length) return null;

  // Group by year — the ORNL DAAC API only returns results within a single
  // calendar year per request, so batches must not cross year boundaries.
  const byYear = {};
  allDates.forEach(key => {
    const yr = key.slice(1, 5);
    (byYear[yr] ??= []).push(key);
  });

  const results = [];
  const yearGroups = Object.values(byYear);
  for (let g = 0; g < yearGroups.length; g++) {
    const yearDates = yearGroups[g];
    for (let i = 0; i < yearDates.length; i += 10) {
      const b = yearDates.slice(i, i + 10);
      try { results.push(...await fetchModisBatch(lat, lon, b[0], b[b.length - 1])); }
      catch (e) { console.warn('Recent EVI batch failed', e); }
      if (i + 10 < yearDates.length) await new Promise(res => setTimeout(res, 120));
    }
    if (g + 1 < yearGroups.length) await new Promise(res => setTimeout(res, 120));
  }
  if (!results.length) return null;

  // Keep the calendar date; deduplication onto DOY happens once the series has
  // been merged with whatever was already cached (locationCache.actualsForDisplay).
  return results
    .map(({ date, value }) => ({ date, doy: calendarDOY(date), value }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}
