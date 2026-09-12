// Dew point normals — the "mugginess" axis.
//
// The ring plots DEW POINT rather than relative humidity, for the same reason
// forecasters quote it: relative humidity is a ratio against a temperature that
// is itself moving, so 80% RH at dawn and 80% RH at noon describe completely
// different air. Dew point is an absolute measure of how much water the air is
// actually carrying, which is what "muggy" means and what the season namer in
// src/data/seasons.js needs to distinguish a humid season from a merely warm one.
//
// Fetched separately from the main ERA5 call (rather than folded into it)
// deliberately: Open-Meteo rejects an entire request when one daily aggregation
// name is wrong, so adding a variable to fetchClimateAPI risks taking every
// other ring down with it. As its own optional stage — the pattern pm25.js and
// visibility.js already follow — a failure here costs one ring and nothing else.

// Returns 0-based DOY (0–364), skipping Feb 29. Returns null for Feb 29.
function dateToDoy(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  if (m === 2 && d === 29) return null;
  const dim = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let doy = d - 1;
  for (let i = 1; i < m; i++) doy += dim[i];
  return doy;
}

/** °C → °F, rounded to a tenth. */
export const cToF = c => Math.round((c * 9 / 5 + 32) * 10) / 10;

// Fetch hourly 2 m dew point (°C) from the Open-Meteo ERA5 archive, aggregate to
// daily-mean DOY normals, and return a 365-element array in °F. The window
// matches the visibility ring's (2010–2020) — hourly over three decades is a
// much larger download than the daily ERA5 call, and a decade is ample for a
// normal.
export async function fetchDewpoint(lat, lon) {
  const url = `https://archive-api.open-meteo.com/v1/archive`
    + `?latitude=${lat}&longitude=${lon}`
    + `&start_date=2010-01-01&end_date=2020-12-31`
    + `&hourly=dewpoint_2m&timezone=UTC`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Dew point API error ${r.status}`);
  const data = await r.json();

  const time = data.hourly?.time;
  const dew  = data.hourly?.dewpoint_2m ?? data.hourly?.dew_point_2m;
  if (!time?.length || !dew) throw new Error('No dew point data returned');

  // Aggregate hourly → daily mean
  const daySums = {}, dayCnts = {};
  time.forEach((ts, i) => {
    const v = dew[i];
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

  return result.map(v => (v == null ? null : cToF(v)));
}
