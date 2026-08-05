function modisJulianKey(year, doy) {
  return `A${year}${String(doy).padStart(3, '0')}`;
}

// Convert a calendar date string (YYYY-MM-DD) → MODIS Julian key
function dateToModisKey(calendarDate) {
  const [year, month, day] = calendarDate.split('-').map(Number);
  const dims = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let doy = day;
  for (let m = 1; m < month; m++) doy += dims[m];
  return modisJulianKey(year, doy);
}

/** The 23 sixteen-day composite start days of a MOD13Q1 year: 1, 17, 33 … 353. */
const MODIS_DOYS = Array.from({ length: 23 }, (_, i) => 1 + i * 16);

/**
 * Hard API limit — a subset request spanning more than 10 composites is
 * rejected outright with `exceeds maximum subset tiles support of 10`. It is a
 * count of dates, not of pixels: a 25×25 grid over 10 dates is fine, a single
 * pixel over 11 is not. Every multi-date request has to be chunked by this.
 *
 * Also the batch size of the 10-year baseline below. Keep it at 10: batch ids
 * are derived from the date range, and stored `eviDoneKeys` in the location
 * cache would stop matching if it changed.
 */
const MAX_COMPOSITES = 10;

// Fetch all 23 sixteen-day composites for a full year, spatially averaged over
// a km×km radius around the given point.  km=0 returns the single 250m pixel;
// km>0 averages over a (2km)×(2km) area of 250m pixels, which dilutes urban
// signal and exposes the underlying regional seasonal pattern.
//
// A whole year is 23 composites, so this MUST be split into chunks of
// MAX_COMPOSITES. It used to ask for the year in one request and get a 400
// every time, which silently emptied the series and sent findSeasonalPixel to
// its northern-hemisphere fallback dates for every location on earth.
export async function fetchAnnualSeries(lat, lon, year = 2022, km = 0) {
  const chunks = [];
  for (let i = 0; i < MODIS_DOYS.length; i += MAX_COMPOSITES) {
    chunks.push(MODIS_DOYS.slice(i, i + MAX_COMPOSITES));
  }
  try {
    const parts = await Promise.all(chunks.map(c => fetchModisBatch(
      lat, lon,
      modisJulianKey(year, c[0]),
      modisJulianKey(year, c[c.length - 1]),
      km,
    )));
    return parts.filter(Boolean).flat().sort((a, b) => a.date < b.date ? -1 : 1);
  } catch {
    return [];
  }
}

// km: spatial half-extent in km; 0 = single 250m pixel (default, preserves
// existing behaviour for the 10-year baseline fetch).
/**
 * One batch of composites. Returns an array on success — possibly EMPTY, which
 * is a real answer (cloud, water, masked pixels) — and `null` when the request
 * itself failed. The baseline fetch relies on that distinction: an empty batch
 * is banked as done, a failed one is left for the next visit to retry rather
 * than frozen into the record as a permanent gap.
 */
export async function fetchModisBatch(lat, lon, startKey, endKey, km = 0) {
  const url = `https://modis.ornl.gov/rst/api/v1/MOD13Q1/subset?`
    + `latitude=${lat}&longitude=${lon}&startDate=${startKey}&endDate=${endKey}`
    + `&kmAboveBelow=${km}&kmLeftRight=${km}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) { console.warn('MODIS batch failed', r.status); return null; }
    const d = await r.json();
    return (d.subset || [])
      .filter(s => s.band === '250m_16_days_EVI')
      .map(row => {
        const scale = row.scale ?? 0.0001;
        const vals = row.data.map(v => v * scale).filter(v => v > -0.2 && v <= 1.0);
        if (!vals.length) return null;
        return { date: row.calendar_date, value: vals.reduce((a, b) => a + b, 0) / vals.length };
      })
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * A MOD13Q1 subset is a window on the MODIS **sinusoidal** grid, and it is not
 * a north-up lat/lon raster. Two consequences, both of which used to be ignored:
 *
 * 1. "250 m" pixels step 231.656358264 m, reported as `cellsize`. Assuming
 *    250 m stretches an 81-pixel subset from its true 18.76 km to 20.25 km.
 *
 * 2. Far more importantly, the grid is SHEARED. Rows are true parallels, but a
 *    column holds x constant, and in sinusoidal x = R·λ·cos φ — so as latitude
 *    falls, cos φ rises and a constant-x column drifts east. The tilt is
 *    -λ·sin φ, which grows with distance from the central meridian (λ₀ = 0):
 *    ~33° east of north over Florida, ~42° over the Adirondacks, ~53° over
 *    California. Treating the grid as axis-aligned smears every feature along
 *    that diagonal.
 *
 * Row 0 is the NORTHERNMOST row and column 0 the westernmost — standard raster
 * order, despite the response naming its origin `xllcorner`/`yllcorner`
 * (lower-left). Verified against a subset centred on the north shore of Lake
 * Okeechobee, where open water is unambiguously south: the water pixels come
 * back in the LAST rows.
 *
 * `sinuToLatLon` is the only correct way to place a cell. It was checked by
 * mapping every low-EVI cell around Raquette Lake, NY through it and asking for
 * the terrain elevation there: mean 537.0 m, sd 3.6 m — the lake's surface,
 * flat to within the noise.
 */
const R_SINU = 6371007.181;   // sphere radius of the MODIS sinusoidal grid

/** Inverse MODIS sinusoidal (central meridian 0) → [lat, lon] in degrees. */
export function sinuToLatLon(x, y) {
  const phi = y / R_SINU;
  return [phi * 180 / Math.PI, (x / (R_SINU * Math.cos(phi))) * 180 / Math.PI];
}

/**
 * True geographic position of a grid cell centre. `row`/`col` may be
 * fractional — pass ±0.5 offsets to get cell corners.
 *
 * The half-cell term is not cosmetic: `xllcorner`/`yllcorner` are the OUTER
 * corner of the lower-left pixel, not its centre. Omitting it puts every point
 * on a cell boundary, and probing the API with such a point snaps it into the
 * neighbouring row — verified by requesting a 1-pixel subset at each computed
 * position and reading back which cell of the parent grid it landed in.
 */
export function cellLatLon(grid, row, col) {
  return sinuToLatLon(
    grid.xll + (col + 0.5) * grid.cellM,
    grid.yll + (grid.nrows - row - 0.5) * grid.cellM,
  );
}

export async function fetchPixelGrid(lat, lon, dateKey, km) {
  const url = `https://modis.ornl.gov/rst/api/v1/MOD13Q1/subset?`
    + `latitude=${lat}&longitude=${lon}`
    + `&startDate=${dateKey}&endDate=${dateKey}`
    + `&kmAboveBelow=${km}&kmLeftRight=${km}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const d = await r.json();
    const row = (d.subset || []).find(s => s.band === '250m_16_days_EVI');
    if (!row?.data?.length) return null;
    const scale = row.scale ?? 0.0001;
    // nrows/ncols/cellsize/xllcorner/yllcorner are top-level on the response,
    // not per-band; reading them off `row` always yielded undefined and fell
    // back to a square guess. The corner origin is what makes exact
    // georeferencing possible, so a grid without it is unusable.
    const side = Math.round(Math.sqrt(row.data.length));
    if (d.xllcorner == null || d.yllcorner == null) return null;
    return {
      nrows: d.nrows ?? side,
      ncols: d.ncols ?? side,
      cellM: d.cellsize ?? 231.656358264,
      xll:   parseFloat(d.xllcorner),
      yll:   parseFloat(d.yllcorner),
      pixels: row.data.map(v => { const s = v * scale; return s > -0.2 && s <= 1.0 ? s : null; }),
    };
  } catch {
    return null;
  }
}

// Find the pixel within 10 km with the greatest seasonal NDVI amplitude.
//
// Step 1 — fetch a full-year single-point time series at the city centre to
//           determine the actual NDVI peak and trough composite dates for this
//           location.  This works for any hemisphere or climate regime because
//           we let the data tell us when the extremes occur rather than
//           assuming NH summer/winter.
//
// Step 2 — fetch the 10 km × 10 km 250m pixel grid for those two dates and
//           score every pixel by amplitude × mean NDVI, which down-weights
//           water, pavement and seasonally-flooded pixels while rewarding
//           persistent, seasonally-cycling canopy.
//
// Falls back gracefully to fixed dates / centre coordinates if any API call
// fails.
async function findSeasonalPixel(lat, lon) {
  const SCREEN_KM  = 10;

  // ── 1. Determine data-driven peak / trough dates ──────────────────────────
  // Fallback: NH summer peak vs. NH winter trough (previous behaviour)
  let peakKey   = 'A2022193'; // Jul 12
  let troughKey = 'A2022001'; // Jan 1

  // km=3 → 6×6 km spatial average: blends urban core with surrounding
  // parks, suburbs and vegetation to get a representative seasonal signal.
  const series = await fetchAnnualSeries(lat, lon, 2022, 3);
  if (series.length >= 4) {
    let maxVal = -Infinity, minVal = Infinity;
    let maxDate = null,     minDate = null;
    for (const { date, value } of series) {
      if (value > maxVal) { maxVal = value; maxDate = date; }
      if (value < minVal) { minVal = value; minDate = date; }
    }
    if (maxDate) peakKey   = dateToModisKey(maxDate);
    if (minDate) troughKey = dateToModisKey(minDate);
  }

  // ── 2. Fetch 250m grids at those two dates ────────────────────────────────
  const [gridPeak, gridTrough] = await Promise.all([
    fetchPixelGrid(lat, lon, peakKey,   SCREEN_KM),
    fetchPixelGrid(lat, lon, troughKey, SCREEN_KM),
  ]);
  if (!gridPeak || !gridTrough) return { lat, lon, peakKey, troughKey };

  const { nrows, ncols, pixels: pxPeak } = gridPeak;
  const { pixels: pxTrough }             = gridTrough;
  const centerRow = Math.floor(nrows / 2), centerCol = Math.floor(ncols / 2);

  // Score = amplitude × mean EVI
  const MIN_MEAN_EVI = 0.10;
  let bestScore = -1, bestRow = centerRow, bestCol = centerCol;
  for (let i = 0; i < pxPeak.length && i < pxTrough.length; i++) {
    const a = pxPeak[i], b = pxTrough[i];
    if (a === null || b === null) continue;
    const mean = (a + b) / 2;
    if (mean < MIN_MEAN_EVI) continue;
    const score = Math.abs(a - b) * mean;
    if (score > bestScore) {
      bestScore = score;
      bestRow = Math.floor(i / ncols);
      bestCol = i % ncols;
    }
  }

  // Place the winning cell by inverting the sinusoidal projection. A row/column
  // offset scaled into degrees cannot work here: the grid is sheared (see
  // fetchPixelGrid), so the offset that lands on a cell depends on where in the
  // grid it sits. The old formula sampled a point up to ~10 km from the pixel
  // it had just scored, and the wheel's EVI ring was built from there.
  const [latAdj, lonAdj] = cellLatLon(gridPeak, bestRow, bestCol);
  return { lat: latAdj, lon: lonAdj, peakKey, troughKey };
}

/** Stable id for one batch of composites, so a finished batch is never refetched. */
const batchId = (startKey, endKey) => `${startKey}_${endKey}`;

/**
 * The 10-year EVI baseline for a location.
 *
 * This is the slowest fetch in the app — ~30 MODIS calls, a couple of minutes —
 * so it is built to be RESUMABLE. `opts` carries whatever a previous visit
 * managed to store:
 *
 *   sample    { lat, lon, peakKey, troughKey } — the pixel a previous visit
 *             chose. Reusing it skips the pixel-grid search AND is what makes
 *             resuming sound: samples from two different pixels must never be
 *             averaged together.
 *   have      { 'YYYY-MM-DD': value } composites already stored.
 *   doneKeys  ids of batches already completed, so they are skipped outright.
 *             Tracked separately from `have` because a batch can legitimately
 *             come back empty (cloud, bad pixels) — without this, such a batch
 *             would look unfetched forever.
 *   onSample  called as soon as the pixel is known, so it is recorded before
 *             the long fetch rather than after it.
 *   onBatch   called per completed batch with { id, samples } so the caller can
 *             persist progress mid-flight.
 *
 * `complete` in the return says whether every batch is now accounted for — the
 * caller uses it to decide whether the curve is worth storing as a normal.
 */
export async function fetchModisEVI(lat, lon, onProgress, opts = {}) {
  const { have = null, doneKeys = [], sample = null, onSample = null, onBatch = null } = opts;

  // 10-year baseline (2013–2022) at full 16-day composite cadence.
  // Each year produces 3 API calls (batches of 10 DOYs); 10 years = 30 calls total.
  // Batch ids depend only on the dates, so the work left can be counted before
  // the pixel is known — a resumed visit opens its bar at the banked percentage
  // instead of flashing 0%.
  const years = [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022];
  const CONCURRENCY = 5;

  const allTasks = [];
  for (const y of years) {
    for (let i = 0; i < MODIS_DOYS.length; i += MAX_COMPOSITES) {
      const batch = MODIS_DOYS.slice(i, i + MAX_COMPOSITES);
      const startKey = modisJulianKey(y, batch[0]);
      const endKey   = modisJulianKey(y, batch[batch.length - 1]);
      allTasks.push({ startKey, endKey, id: batchId(startKey, endKey) });
    }
  }

  // Start from what is already stored, and fetch only the gaps.
  const results = [];
  if (have) for (const [date, value] of Object.entries(have)) {
    if (Number.isFinite(value)) results.push({ date, value });
  }
  const already = new Set(doneKeys);
  const tasks = allTasks.filter(t => !already.has(t.id));

  const total = allTasks.length;
  let done = total - tasks.length;      // stored batches count toward the bar
  const fetched = new Set(already);
  onProgress(Math.round(done / total * 100));

  const reuse = Number.isFinite(sample?.lat) && Number.isFinite(sample?.lon);
  const { lat: sampLat, lon: sampLon, peakKey, troughKey } = reuse
    ? { lat: sample.lat, lon: sample.lon, peakKey: sample.peakKey ?? null, troughKey: sample.troughKey ?? null }
    : await findSeasonalPixel(lat, lon);
  if (!reuse) onSample?.({ sampLat, sampLon, peakKey, troughKey });

  const active = new Set();
  for (const { startKey, endKey, id } of tasks) {
    const p = fetchModisBatch(sampLat, sampLon, startKey, endKey).then(r => {
      active.delete(p);
      onProgress(Math.round(++done / total * 100));
      if (!r) return;                 // request failed — leave it to be retried
      results.push(...r);
      fetched.add(id);
      // Hand the caller this batch the moment it lands. A visit abandoned
      // mid-fetch then still leaves its progress behind for the next one.
      onBatch?.({ id, samples: r });
    });
    active.add(p);
    if (active.size >= CONCURRENCY) await Promise.race(active);
  }
  await Promise.all(active);

  const complete = fetched.size >= total;

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
  const evi = raw.map((_, i) => {
    let sum = 0, wt = 0;
    for (let k = -kernelR; k <= kernelR; k++) {
      const j = (i + k + 365) % 365;
      if (raw[j] !== null) { const w = gauss(k); sum += raw[j] * w; wt += w; }
    }
    return Math.round((wt > 0 ? sum / wt : 0) * 1000) / 1000;
  });

  const sampMapUrl = `https://www.google.com/maps?q=${sampLat.toFixed(5)},${sampLon.toFixed(5)}`;
  return { evi, sampLat, sampLon, sampMapUrl, peakKey, troughKey, complete };
}

export function eviProxyFallback(tempArr, rainArr) {
  return tempArr.map((t, i) => {
    const r = rainArr[i]; let v = .06;
    if (r > .05)        v += .24 * (Math.min(r * 30, 5) / 5);
    if (t > 40 && t < 90) v += .22 * ((t - 40) / 50);
    if (t > 80)         v *= .78;
    if (r < .003 && t > 65) v *= .55;
    return Math.round(Math.max(.03, Math.min(.65, v)) * 1000) / 1000;
  });
}
