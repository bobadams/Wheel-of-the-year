import { fetchModisBatch } from './evi.js';

export function calendarDOY(dateStr) {
  const [, mo, dy] = dateStr.split('-').map(Number);
  const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let doy = 0;
  for (let m = 0; m < mo - 1; m++) doy += dim[m];
  return Math.min(doy + dy - 1, 364);
}

export async function fetchActuals(lat, lon) {
  const now = new Date();
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const todayStr = fmt(now);
  const startDate = new Date(now); startDate.setDate(startDate.getDate() - 350);

  const url = `https://archive-api.open-meteo.com/v1/archive?`
    + `latitude=${lat}&longitude=${lon}`
    + `&start_date=${fmt(startDate)}&end_date=${todayStr}`
    + `&daily=temperature_2m_max,precipitation_sum,windspeed_10m_mean,snow_depth_mean,cloudcover_mean&timezone=auto`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Actuals API error ${r.status}`);
  const d = await r.json();
  if (!d.daily?.time?.length) throw new Error('No actuals data returned');

  const tempEntries = [], rainEntries = [], windEntries = [], snowEntries = [], cloudEntries = [];
  d.daily.time.forEach((dateStr, i) => {
    const doy = calendarDOY(dateStr);
    const tc = d.daily.temperature_2m_max[i];
    const p  = d.daily.precipitation_sum[i];
    const w  = d.daily.windspeed_10m_mean[i];
    const sn = d.daily.snow_depth_mean?.[i];
    const cl = d.daily.cloudcover_mean?.[i];
    if (tc != null) tempEntries.push({ doy, value: Math.round((tc * 9 / 5 + 32) * 10) / 10 });
    if (p  != null) rainEntries.push({ doy, value: Math.round(p / 25.4 * 1000) / 1000 });
    if (w  != null) windEntries.push({ doy, value: Math.round(w * 0.621371 * 10) / 10 });
    if (sn != null) snowEntries.push({ doy, value: Math.round(sn * 39.3701 * 100) / 100 });
    if (cl != null) cloudEntries.push({ doy, value: Math.round(cl * 10) / 10 });
  });

  return { temp: tempEntries, rain: rainEntries, wind: windEntries, snow: snowEntries, cloud: cloudEntries, todayDOY: calendarDOY(todayStr) };
}

export async function fetchActualsPm25(lat, lon) {
  const now = new Date();
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const todayStr = fmt(now);
  const startDate = new Date(now); startDate.setDate(startDate.getDate() - 350);

  const url = `https://air-quality-api.open-meteo.com/v1/air-quality`
    + `?latitude=${lat}&longitude=${lon}`
    + `&start_date=${fmt(startDate)}&end_date=${todayStr}`
    + `&hourly=pm2_5&timezone=auto`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`PM2.5 actuals API error ${r.status}`);
  const data = await r.json();
  const { time, pm2_5 } = data.hourly;

  const daySums = {}, dayCnts = {};
  time.forEach((ts, i) => {
    const v = pm2_5[i];
    if (v == null) return;
    const dateStr = ts.slice(0, 10);
    if (!daySums[dateStr]) { daySums[dateStr] = 0; dayCnts[dateStr] = 0; }
    daySums[dateStr] += v;
    dayCnts[dateStr]++;
  });

  return Object.entries(daySums)
    .map(([dateStr, sum]) => ({ doy: calendarDOY(dateStr), value: Math.round(sum / dayCnts[dateStr] * 100) / 100 }))
    .sort((a, b) => a.doy - b.doy);
}

export async function fetchActualsVisibility(lat, lon) {
  const now = new Date();
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const todayStr = fmt(now);
  const startDate = new Date(now); startDate.setDate(startDate.getDate() - 350);

  const url = `https://archive-api.open-meteo.com/v1/archive?`
    + `latitude=${lat}&longitude=${lon}`
    + `&start_date=${fmt(startDate)}&end_date=${todayStr}`
    + `&hourly=visibility&timezone=auto`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Visibility actuals API error ${r.status}`);
  const data = await r.json();
  const { time, visibility } = data.hourly;

  const daySums = {}, dayCnts = {};
  time.forEach((ts, i) => {
    const v = visibility[i];
    if (v == null) return;
    const dateStr = ts.slice(0, 10);
    if (!daySums[dateStr]) { daySums[dateStr] = 0; dayCnts[dateStr] = 0; }
    daySums[dateStr] += v;
    dayCnts[dateStr]++;
  });

  return Object.entries(daySums)
    .map(([dateStr, sum]) => ({ doy: calendarDOY(dateStr), value: Math.round(sum / dayCnts[dateStr] / 1609.34 * 100) / 100 }))
    .sort((a, b) => a.doy - b.doy);
}

export async function fetchRecentEVI(lat, lon) {
  const now = new Date();
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  const allDates = [];
  for (let offset = 350; offset >= 0; offset -= 16) {
    const d = new Date(now); d.setDate(d.getDate() - offset);
    const doy16 = Math.floor(calendarDOY(fmt(d)) / 16) * 16 + 1;
    const key = `A${d.getFullYear()}${String(Math.min(doy16, 365)).padStart(3, '0')}`;
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

  // Deduplicate by DOY — sort oldest-first, then overwrite so the most recent
  // observation wins for each DOY slot.
  const byDoy = {};
  results
    .map(({ date, value }) => ({ doy: calendarDOY(date), value, date }))
    .sort((a, b) => a.date < b.date ? -1 : 1)
    .forEach(e => { byDoy[e.doy] = e.value; });

  return Object.entries(byDoy)
    .map(([doy, value]) => ({ doy: Number(doy), value }))
    .sort((a, b) => a.doy - b.doy);
}
