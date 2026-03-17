function modisJulianKey(year, doy) {
  return `A${year}${String(doy).padStart(3, '0')}`;
}

export async function fetchModisBatch(lat, lon, dates) {
  const url = `https://modis.ornl.gov/rst/api/v1/MOD13Q1/subset?`
    + `latitude=${lat}&longitude=${lon}&startDate=${dates[0]}&endDate=${dates[dates.length - 1]}`
    + `&kmAboveBelow=0&kmLeftRight=0`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) { console.warn('MODIS batch failed', r.status); return []; }
  const d = await r.json();
  return (d.subset || [])
    .filter(s => s.band === '250m_16_days_NDVI')
    .map(row => {
      const vals = row.data.map(v => v * (row.scale ?? 0.0001)).filter(v => v > -0.2 && v <= 1.0);
      if (!vals.length) return null;
      return { date: row.calendar_date, value: vals.reduce((a, b) => a + b, 0) / vals.length };
    })
    .filter(Boolean);
}

// Fetch a single MODIS date over a km-radius window; returns the pixel grid.
async function fetchPixelGrid(lat, lon, dateKey, km) {
  const url = `https://modis.ornl.gov/rst/api/v1/MOD13Q1/subset?`
    + `latitude=${lat}&longitude=${lon}`
    + `&startDate=${dateKey}&endDate=${dateKey}`
    + `&kmAboveBelow=${km}&kmLeftRight=${km}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const d = await r.json();
    const row = (d.subset || []).find(s => s.band === '250m_16_days_NDVI');
    if (!row?.data?.length) return null;
    const scale = row.scale ?? 0.0001;
    const side = Math.round(Math.sqrt(row.data.length));
    return {
      nrows: row.nrows ?? side,
      ncols: row.ncols ?? side,
      pixels: row.data.map(v => { const s = v * scale; return s > -0.2 && s <= 1.0 ? s : null; }),
    };
  } catch {
    return null;
  }
}

// Find the nearby pixel (within ~3 km) with the greatest seasonal NDVI contrast.
// Fetches one peak-green date and one peak-brown date concurrently, compares all
// pixels in the window, and returns the coordinates of the most seasonal one.
// Using |contrast| works for both hemispheres (seasons are simply inverted).
// Falls back to original coords if the API is unreachable or data is missing.
async function findSeasonalPixel(lat, lon) {
  const SCREEN_KM = 3;
  const PIXEL_KM  = 0.25; // MOD13Q1 native resolution
  const KM_PER_DEG = 111.0;

  const [gridA, gridB] = await Promise.all([
    fetchPixelGrid(lat, lon, 'A2022065', SCREEN_KM), // ~Mar 6 — NH spring green / SH late summer
    fetchPixelGrid(lat, lon, 'A2022209', SCREEN_KM), // ~Jul 28 — NH summer dry  / SH winter green
  ]);
  if (!gridA || !gridB) return { lat, lon };

  const { nrows, ncols, pixels: pxA } = gridA;
  const { pixels: pxB } = gridB;
  const centerRow = Math.floor(nrows / 2), centerCol = Math.floor(ncols / 2);

  let bestContrast = -1, bestRow = centerRow, bestCol = centerCol;
  for (let i = 0; i < pxA.length && i < pxB.length; i++) {
    const a = pxA[i], b = pxB[i];
    if (a === null || b === null) continue;
    const contrast = Math.abs(a - b);
    if (contrast > bestContrast) {
      bestContrast = contrast;
      bestRow = Math.floor(i / ncols);
      bestCol = i % ncols;
    }
  }

  const latAdj = lat + (bestRow - centerRow) * PIXEL_KM / KM_PER_DEG;
  const lonAdj = lon + (bestCol - centerCol) * PIXEL_KM / (KM_PER_DEG * Math.cos(lat * Math.PI / 180));
  return { lat: latAdj, lon: lonAdj };
}

export async function fetchModisNDVI(lat, lon, onProgress) {
  // Find the nearby pixel with the strongest seasonal contrast before the main fetch.
  onProgress(0);
  const { lat: sampLat, lon: sampLon } = await findSeasonalPixel(lat, lon);

  const years = [2019, 2020, 2021, 2022];
  const MODIS_DOYS = Array.from({ length: 23 }, (_, i) => 1 + i * 16); // 1,17,33…353
  const BATCH = 10; // API max per request
  const CONCURRENCY = 5; // parallel requests

  // Build flat task list using the best-contrast sample coordinates
  const tasks = [];
  for (const y of years) {
    for (let i = 0; i < MODIS_DOYS.length; i += BATCH) {
      const batch = MODIS_DOYS.slice(i, i + BATCH);
      tasks.push([sampLat, sampLon, [modisJulianKey(y, batch[0]), modisJulianKey(y, batch[batch.length - 1])]]);
    }
  }
  const total = tasks.length;
  let done = 0;
  const results = [];
  const active = new Set();
  for (const [la, lo, dates] of tasks) {
    const p = fetchModisBatch(la, lo, dates).then(r => {
      active.delete(p);
      results.push(...r);
      onProgress(Math.round(++done / total * 100));
    });
    active.add(p);
    if (active.size >= CONCURRENCY) await Promise.race(active);
  }
  await Promise.all(active);

  // Accumulate NDVI per DOY across years
  const doySum = new Array(365).fill(0), doyCnt = new Array(365).fill(0);
  const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  results.forEach(({ date, value }) => {
    const [, mo, dy] = date.split('-').map(Number);
    let doy = 0;
    for (let m = 0; m < mo - 1; m++) doy += dim[m];
    doy = Math.min(doy + dy - 1, 364);
    for (let dd = 0; dd < 16; dd++) { const d2 = (doy + dd) % 365; doySum[d2] += value; doyCnt[d2]++; }
  });

  let raw = doySum.map((s, i) => doyCnt[i] > 0 ? s / doyCnt[i] : null);

  // Fill nulls by interpolation
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < 365; i++) {
      if (raw[i] === null) {
        const prev = raw[(i + 364) % 365], next = raw[(i + 1) % 365];
        raw[i] = prev !== null && next !== null ? (prev + next) / 2
               : prev !== null ? prev : next;
      }
    }
  }

  // Gaussian smoothing to remove 16-day staircase artifacts
  const sigma = 7, kernelR = 14;
  const gauss = x => Math.exp(-0.5 * (x / sigma) ** 2);
  return raw.map((_, i) => {
    let sum = 0, wt = 0;
    for (let k = -kernelR; k <= kernelR; k++) {
      const j = (i + k + 365) % 365;
      if (raw[j] !== null) { const w = gauss(k); sum += raw[j] * w; wt += w; }
    }
    return Math.round((wt > 0 ? sum / wt : 0) * 1000) / 1000;
  });
}

export function ndviProxyFallback(tempArr, rainArr) {
  return tempArr.map((t, i) => {
    const r = rainArr[i]; let v = .08;
    if (r > .05)        v += .32 * (Math.min(r * 30, 5) / 5);
    if (t > 40 && t < 90) v += .28 * ((t - 40) / 50);
    if (t > 80)         v *= .78;
    if (r < .003 && t > 65) v *= .55;
    return Math.round(Math.max(.05, Math.min(.80, v)) * 1000) / 1000;
  });
}
