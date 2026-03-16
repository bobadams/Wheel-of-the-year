import { DIM } from '../draw/decorations.js';

Math.radians = deg => deg * Math.PI / 180;

export async function geocode(q) {
  const r = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
    { headers: { 'Accept-Language': 'en' } }
  );
  const d = await r.json();
  if (!d.length) throw new Error('City not found — try a different spelling');
  return { lat: parseFloat(d[0].lat), lon: parseFloat(d[0].lon), name: d[0].display_name };
}

export async function fetchClimateAPI(lat, lon) {
  const url = `https://climate-api.open-meteo.com/v1/climate?latitude=${lat}&longitude=${lon}`
    + `&start_date=1991-01-01&end_date=2020-12-31&models=ERA5`
    + `&monthly=temperature_2m_mean,precipitation_sum,windspeed_10m_mean`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Climate API error');
  return r.json();
}

export function daylightDaily(lat) {
  return Array.from({ length: 365 }, (_, i) => {
    const d = i + 1;
    const decl = 23.45 * Math.sin(Math.radians((360 / 365) * (d - 81)));
    const cosH = -Math.tan(lat * Math.PI / 180) * Math.tan(decl * Math.PI / 180);
    if (cosH <= -1) return 24;
    if (cosH >= 1)  return 0;
    return Math.round((2 / 15) * Math.acos(cosH) * 180 / Math.PI * 100) / 100;
  });
}

export function aggregateClimate(d, lat) {
  const { time, temperature_2m_mean: tempC, precipitation_sum: precMM, windspeed_10m_mean: windKmh } = d.monthly;
  const ts = new Array(12).fill(0), tc = new Array(12).fill(0);
  const rs = new Array(12).fill(0), ws = new Array(12).fill(0), wc = new Array(12).fill(0);
  time.forEach((t, i) => {
    const m = parseInt(t.split('-')[1]) - 1;
    if (tempC[i]   != null) { ts[m] += tempC[i];   tc[m]++; }
    if (precMM[i]  != null)   rs[m] += precMM[i];
    if (windKmh[i] != null) { ws[m] += windKmh[i]; wc[m]++; }
  });
  const cnt = n => Math.max(n, 1);
  const tempFmon = ts.map((s, i) => Math.round((s / cnt(tc[i]) * 9 / 5 + 32) * 10) / 10);
  const rainMon  = rs.map((s, i) => Math.round(s / cnt(tc[i]) / 25.4 * 100) / 100);
  const windMon  = ws.map((s, i) => Math.round(s / cnt(wc[i]) * .621371 * 10) / 10);

  function monthlyToDaily(monthly) {
    const mids = []; let doy = 0;
    DIM.forEach(d => { mids.push(doy + d / 2); doy += d; });
    const ext  = [...mids.map(m => m - 365), ...mids, ...mids.map(m => m + 365)];
    const extV = [...monthly, ...monthly, ...monthly];
    return Array.from({ length: 365 }, (_, day) => {
      for (let i = 0; i < ext.length - 1; i++) {
        if (ext[i] <= day && day < ext[i + 1]) {
          const t = (day - ext[i]) / (ext[i + 1] - ext[i]);
          const ts = (1 - Math.cos(t * Math.PI)) / 2;
          return Math.round((extV[i] * (1 - ts) + extV[i + 1] * ts) * 100) / 100;
        }
      }
      return monthly[0];
    });
  }

  return {
    tempF:   monthlyToDaily(tempFmon),
    rainIn:  monthlyToDaily(rainMon),
    windMph: monthlyToDaily(windMon),
    daylight: daylightDaily(lat),
    resolution: 'daily (ERA5 1991–2020 normals)',
  };
}
