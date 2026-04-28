// Returns 0-based DOY (0–364), skipping Feb 29. Returns null for Feb 29.
function dateToDoy(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  if (m === 2 && d === 29) return null;
  const dim = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let doy = d - 1;
  for (let i = 1; i < m; i++) doy += dim[i];
  return doy;
}

// Fetch hourly visibility (meters) from Open-Meteo archive, aggregate to
// daily-mean DOY normals, and return a 365-element array in miles.
export async function fetchVisibility(lat, lon) {
  const url = `https://archive-api.open-meteo.com/v1/archive`
    + `?latitude=${lat}&longitude=${lon}`
    + `&start_date=2010-01-01&end_date=2020-12-31`
    + `&hourly=visibility&timezone=UTC`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Visibility API error ${r.status}`);
  const data = await r.json();

  const { time, visibility } = data.hourly;

  // Aggregate hourly → daily mean
  const daySums = {}, dayCnts = {};
  time.forEach((ts, i) => {
    const v = visibility[i];
    if (v == null) return;
    const dateStr = ts.slice(0, 10);
    if (!daySums[dateStr]) { daySums[dateStr] = 0; dayCnts[dateStr] = 0; }
    daySums[dateStr] += v;
    dayCnts[dateStr]++;
  });

  // Average same-DOY across years
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

  // Convert meters → miles
  return result.map(v => Math.round(v / 1609.34 * 100) / 100);
}
