import { fetchModisBatch } from './ndvi.js';

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
  const startDate = new Date(now); startDate.setDate(startDate.getDate() - 185);

  const url = `https://archive-api.open-meteo.com/v1/archive?`
    + `latitude=${lat}&longitude=${lon}`
    + `&start_date=${fmt(startDate)}&end_date=${todayStr}`
    + `&daily=temperature_2m_mean,precipitation_sum&timezone=auto`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Actuals API error ${r.status}`);
  const d = await r.json();
  if (!d.daily?.time?.length) throw new Error('No actuals data returned');

  const tempEntries = [], rainEntries = [];
  d.daily.time.forEach((dateStr, i) => {
    const doy = calendarDOY(dateStr);
    const tc = d.daily.temperature_2m_mean[i];
    const p  = d.daily.precipitation_sum[i];
    if (tc != null) tempEntries.push({ doy, value: Math.round((tc * 9 / 5 + 32) * 10) / 10 });
    if (p  != null) rainEntries.push({ doy, value: Math.round(p / 25.4 * 1000) / 1000 });
  });

  return { temp: tempEntries, rain: rainEntries, todayDOY: calendarDOY(todayStr) };
}

export async function fetchRecentNDVI(lat, lon) {
  const now = new Date();
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  const allDates = [];
  for (let offset = 185; offset >= 0; offset -= 16) {
    const d = new Date(now); d.setDate(d.getDate() - offset);
    const doy16 = Math.floor(calendarDOY(fmt(d)) / 16) * 16 + 1;
    const key = `A${d.getFullYear()}${String(Math.min(doy16, 365)).padStart(3, '0')}`;
    if (!allDates.includes(key)) allDates.push(key);
  }
  allDates.sort();
  if (!allDates.length) return null;

  const results = [];
  for (let i = 0; i < allDates.length; i += 10) {
    try { const b = allDates.slice(i, i + 10); results.push(...await fetchModisBatch(lat, lon, b[0], b[b.length - 1])); }
    catch (e) { console.warn('Recent NDVI batch failed', e); }
    if (i + 10 < allDates.length) await new Promise(res => setTimeout(res, 120));
  }
  if (!results.length) return null;

  // Deduplicate by doy (average duplicates)
  const byDoy = {};
  results
    .map(({ date, value }) => ({ doy: calendarDOY(date), value, date }))
    .sort((a, b) => a.date < b.date ? -1 : 1)
    .forEach(e => { byDoy[e.doy] = e.doy in byDoy ? (byDoy[e.doy] + e.value) / 2 : e.value; });

  return Object.entries(byDoy)
    .map(([doy, value]) => ({ doy: Number(doy), value }))
    .sort((a, b) => a.doy - b.doy);
}
