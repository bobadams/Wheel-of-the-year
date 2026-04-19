function modisJulianKey(year, doy) {
  return `A${year}${String(doy).padStart(3, '0')}`;
}

export async function fetchModisBatch(lat, lon, startKey, endKey) {
  const url = `https://modis.ornl.gov/rst/api/v1/MOD13Q1/subset?`
    + `latitude=${lat}&longitude=${lon}&startDate=${startKey}&endDate=${endKey}`
    + `&kmAboveBelow=0&kmLeftRight=0`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) { console.warn('MODIS batch failed', r.status); return []; }
  const d = await r.json();
  return (d.subset || [])
    .filter(s => s.band === '250m_16_days_NDVI')
    .map(row => {
      const scale = row.scale ?? 0.0001;
      const vals = row.data.map(v => v * scale).filter(v => v > -0.2 && v <= 1.0);
      if (!vals.length) return null;
      return { date: row.calendar_date, value: vals.reduce((a, b) => a + b, 0) / vals.length };
    })
    .filter(Boolean);
}

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

// Find the pixel within 10 km with the greatest seasonal NDVI amplitude.
// Uses two dates 6 months apart; abs(difference) works for both hemispheres.
// Falls back to original coords if the API is unreachable or data is missing.
async function findSeasonalPixel(lat, lon) {
  const SCREEN_KM  = 10;
  const PIXEL_KM   = 0.25;
  const KM_PER_DEG = 111.0;

  const [gridA, gridB] = await Promise.all([
    fetchPixelGrid(lat, lon, 'A2022001', SCREEN_KM), // Jan 1  — NH winter trough / SH summer peak
    fetchPixelGrid(lat, lon, 'A2022193', SCREEN_KM), // Jul 12 — NH summer peak   / SH winter trough
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
  onProgress(0);
  const { lat: sampLat, lon: sampLon } = await findSeasonalPixel(lat, lon);

  // 10-year baseline (2013–2022) at full 16-day composite cadence.
  // Each year produces 3 API calls (batches of 10 DOYs); 10 years = 30 calls total.
  const years = [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022];
  const MODIS_DOYS = Array.from({ length: 23 }, (_, i) => 1 + i * 16); // 1,17,33…353
  const BATCH = 10;
  const CONCURRENCY = 5;

  const tasks = [];
  for (const y of years) {
    for (let i = 0; i < MODIS_DOYS.length; i += BATCH) {
      const batch = MODIS_DOYS.slice(i, i + BATCH);
      tasks.push([sampLat, sampLon, modisJulianKey(y, batch[0]), modisJulianKey(y, batch[batch.length - 1])]);
    }
  }
  const total = tasks.length;
  let done = 0;
  const results = [];
  const active = new Set();
  for (const [la, lo, startKey, endKey] of tasks) {
    const p = fetchModisBatch(la, lo, startKey, endKey).then(r => {
      active.delete(p);
      results.push(...r);
      onProgress(Math.round(++done / total * 100));
    });
    active.add(p);
    if (active.size >= CONCURRENCY) await Promise.race(active);
  }
  await Promise.all(active);

  // Group raw values by DOY across all years for IQR-trimmed averaging.
  // Each composite slot (e.g. Jan 1) gets up to 10 values, one per year.
  const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const doyBuckets = Array.from({ length: 365 }, () => []);
  results.forEach(({ date, value }) => {
    const [, mo, dy] = date.split('-').map(Number);
    let doy = 0;
    for (let m = 0; m < mo - 1; m++) doy += dim[m];
    doyBuckets[Math.min(doy + dy - 1, 364)].push(value);
  });

  // IQR-trimmed mean: drop the single min and max when ≥ 5 samples available.
  // This discards anomalous drought/fire years without needing extra API calls.
  let raw = doyBuckets.map(vals => {
    const n = vals.length;
    if (n === 0) return null;
    if (n < 5) return vals.reduce((a, b) => a + b, 0) / n;
    const sorted = [...vals].sort((a, b) => a - b);
    const trimmed = sorted.slice(1, -1);
    return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  });

  // Fill short gaps by linear interpolation (3 passes covers 16-day inter-composite gaps).
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < 365; i++) {
      if (raw[i] !== null) continue;
      const prev = raw[(i + 364) % 365], next = raw[(i + 1) % 365];
      raw[i] = prev !== null && next !== null ? (prev + next) / 2
             : prev !== null ? prev : next;
    }
  }

  // Fallback for any persistent nulls: use circular mean of non-null values within ±30 days.
  const anchors = raw.map((v, i) => v !== null ? { i, v } : null).filter(Boolean);
  if (anchors.length > 0) {
    for (let i = 0; i < 365; i++) {
      if (raw[i] !== null) continue;
      const nearby = anchors.filter(({ i: j }) => Math.min(Math.abs(j - i), 365 - Math.abs(j - i)) <= 30);
      if (nearby.length > 0) raw[i] = nearby.reduce((a, { v }) => a + v, 0) / nearby.length;
    }
  }

  // Gaussian smoothing to remove inter-composite staircase artifacts.
  const sigma = 5, kernelR = 12;
  const gauss = x => Math.exp(-0.5 * (x / sigma) ** 2);
  const ndvi = raw.map((_, i) => {
    let sum = 0, wt = 0;
    for (let k = -kernelR; k <= kernelR; k++) {
      const j = (i + k + 365) % 365;
      if (raw[j] !== null) { const w = gauss(k); sum += raw[j] * w; wt += w; }
    }
    return Math.round((wt > 0 ? sum / wt : 0) * 1000) / 1000;
  });

  const sampMapUrl = `https://www.google.com/maps?q=${sampLat.toFixed(5)},${sampLon.toFixed(5)}`;
  return { ndvi, sampLat, sampLon, sampMapUrl };
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
