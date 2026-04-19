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
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}`
    + `&start_date=1991-01-01&end_date=2020-12-31&timezone=UTC`
    + `&daily=temperature_2m_mean,precipitation_sum,windspeed_10m_mean,winddirection_10m_dominant`;
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

// Returns 0-based DOY (0–364), skipping Feb 29. Returns null for Feb 29.
function dateToDoy(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  if (m === 2 && d === 29) return null;
  const dim = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let doy = d - 1;
  for (let i = 1; i < m; i++) doy += dim[i];
  return doy;
}

export function aggregateClimate(d, lat) {
  const {
    time,
    temperature_2m_mean: tempC,
    precipitation_sum: precMM,
    windspeed_10m_mean: windKmh,
    winddirection_10m_dominant: windDirDeg,
  } = d.daily;
  const ts = new Array(365).fill(0), tc = new Array(365).fill(0);
  const rs = new Array(365).fill(0);
  const ws = new Array(365).fill(0), wc = new Array(365).fill(0);
  // Circular components for direction averaging
  const dsx = new Array(365).fill(0), dsy = new Array(365).fill(0), dc = new Array(365).fill(0);
  time.forEach((t, i) => {
    const doy = dateToDoy(t);
    if (doy === null) return;
    if (tempC[i]      != null) { ts[doy] += tempC[i];   tc[doy]++; }
    if (precMM[i]     != null)   rs[doy] += precMM[i];
    if (windKmh[i]    != null) { ws[doy] += windKmh[i]; wc[doy]++; }
    if (windDirDeg?.[i] != null) {
      const r = windDirDeg[i] * Math.PI / 180;
      dsx[doy] += Math.cos(r); dsy[doy] += Math.sin(r); dc[doy]++;
    }
  });
  const cnt = n => Math.max(n, 1);
  const tempF   = ts.map((s, i) => Math.round((s / cnt(tc[i]) * 9 / 5 + 32) * 10) / 10);
  const rainIn  = rs.map((s, i) => Math.round(s / cnt(tc[i]) / 25.4 * 100) / 100);
  const windMph = ws.map((s, i) => Math.round(s / cnt(wc[i]) * 0.621371 * 10) / 10);
  const windDir = dc.map((n, i) => n > 0
    ? ((Math.atan2(dsy[i] / n, dsx[i] / n) * 180 / Math.PI) + 360) % 360
    : null);

  return {
    tempF,
    rainIn,
    windMph,
    windDir,
    daylight: daylightDaily(lat),
    resolution: 'daily (ERA5 1991–2020)',
  };
}
