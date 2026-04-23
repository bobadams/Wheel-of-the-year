// Returns 0-based DOY (0–364), skipping Feb 29. Returns null for Feb 29.
function dateToDoy(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  if (m === 2 && d === 29) return null;
  const dim = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let doy = d - 1;
  for (let i = 1; i < m; i++) doy += dim[i];
  return doy;
}

export async function fetchPm25(lat, lon) {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality`
    + `?latitude=${lat}&longitude=${lon}`
    + `&start_date=2014-01-01&end_date=2023-12-31`
    + `&hourly=pm2_5&timezone=UTC`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`PM2.5 API error ${r.status}`);
  const data = await r.json();

  const { time, pm2_5 } = data.hourly;

  // Average hourly → daily, then average same-DOY across years
  const daySums = {}, dayCnts = {};
  time.forEach((ts, i) => {
    const v = pm2_5[i];
    if (v == null) return;
    const dateStr = ts.slice(0, 10);
    if (!daySums[dateStr]) { daySums[dateStr] = 0; dayCnts[dateStr] = 0; }
    daySums[dateStr] += v;
    dayCnts[dateStr]++;
  });

  const doySums = new Array(365).fill(0);
  const doyCnts = new Array(365).fill(0);
  Object.keys(daySums).forEach(dateStr => {
    const doy = dateToDoy(dateStr);
    if (doy === null) return;
    doySums[doy] += daySums[dateStr] / dayCnts[dateStr];
    doyCnts[doy]++;
  });

  const result = doySums.map((s, i) => doyCnts[i] > 0 ? s / doyCnts[i] : null);

  // Linear interpolation for any missing DOYs
  for (let i = 0; i < 365; i++) {
    if (result[i] !== null) continue;
    let pi = i - 1, ni = i + 1;
    while (pi >= 0  && result[pi] === null) pi--;
    while (ni < 365 && result[ni] === null) ni++;
    if      (pi < 0)    result[i] = result[ni];
    else if (ni >= 365) result[i] = result[pi];
    else {
      const t = (i - pi) / (ni - pi);
      result[i] = result[pi] * (1 - t) + result[ni] * t;
    }
  }

  return result.map(v => Math.round(v * 100) / 100);
}
