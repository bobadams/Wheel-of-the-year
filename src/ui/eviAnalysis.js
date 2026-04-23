import { fetchPixelGrid, fetchAnnualSeries } from '../fetch/evi.js';
import { currentData } from '../state.js';

// ── Constants ──────────────────────────────────────────────────────────────────
const SCREEN_KM    = 10;
const PIXEL_KM     = 0.25;
const KM_PER_DEG   = 111.0;
const MIN_MEAN_EVI = 0.10;
const TILE_SIZE    = 256;
const ZOOM         = 13;
const PANEL_PX     = 280;   // display canvas size (square)
const TS_W         = 700;
const TS_H         = 200;

const tileUrl = (z, ty, tx) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`;

// Convert a MODIS Julian key like 'A2022097' → human label like 'Apr 7, 2022'
const _MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const _DIMS   = [31,28,31,30,31,30,31,31,30,31,30,31];
function modisKeyToLabel(key) {
  if (!key) return '—';
  const year = parseInt(key.slice(1, 5));
  let doy    = parseInt(key.slice(5));
  let m = 0;
  while (doy > _DIMS[m]) doy -= _DIMS[m++];
  return `${_MONTHS[m]} ${doy}, ${year}`;
}

// ── Tile / projection helpers ──────────────────────────────────────────────────
function latLonToWorldPx(lat, lon, zoom) {
  const n   = 2 ** zoom * TILE_SIZE;
  const x   = (lon + 180) / 360 * n;
  const rad = lat * Math.PI / 180;
  const y   = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n;
  return { x, y };
}

function fetchTileImage(z, ty, tx) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = tileUrl(z, ty, tx);
  });
}

async function drawSatelliteBg(ctx, canvasPx, lat, lon, nrows, ncols) {
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, canvasPx, canvasPx);

  const latSpan = nrows * PIXEL_KM / KM_PER_DEG;
  const lonSpan = ncols * PIXEL_KM / (KM_PER_DEG * Math.cos(lat * Math.PI / 180));

  // The MODIS grid rows increase going North; row 0 = southernmost
  // so bbox: maxLat = lat + latSpan/2, minLat = lat - latSpan/2
  const maxLat  = lat + latSpan / 2;
  const minLat  = lat - latSpan / 2;
  const minLon  = lon - lonSpan / 2;
  const maxLon  = lon + lonSpan / 2;

  const tl = latLonToWorldPx(maxLat, minLon, ZOOM);  // top-left  = northWest
  const br = latLonToWorldPx(minLat, maxLon, ZOOM);  // bot-right = southEast

  const pxW  = br.x - tl.x;
  const pxH  = br.y - tl.y;
  const scale = canvasPx / Math.max(pxW, pxH);

  const txMin = Math.floor(tl.x / TILE_SIZE);
  const txMax = Math.floor(br.x / TILE_SIZE);
  const tyMin = Math.floor(tl.y / TILE_SIZE);
  const tyMax = Math.floor(br.y / TILE_SIZE);

  const fetches = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      fetches.push(fetchTileImage(ZOOM, ty, tx).then(img => ({ img, tx, ty })));
    }
  }
  const tiles = await Promise.all(fetches);

  tiles.forEach(({ img, tx, ty }) => {
    if (!img) return;
    const ox = (tx * TILE_SIZE - tl.x) * scale;
    const oy = (ty * TILE_SIZE - tl.y) * scale;
    ctx.drawImage(img, ox, oy, TILE_SIZE * scale, TILE_SIZE * scale);
  });
}

// ── Color maps ─────────────────────────────────────────────────────────────────
// EVI thresholds are lower than NDVI — dense canopy tops out around 0.65
function eviRgb(v) {
  if (v === null) return null;
  if (v < 0.03) return [80,  60,  30];   // very dry / bare
  if (v < 0.10) return [170, 130, 50];   // sparse/dry
  if (v < 0.20) return [210, 200, 60];   // low vegetation
  if (v < 0.30) return [120, 190, 55];   // moderate
  if (v < 0.45) return [40,  160, 40];   // healthy
  return              [10,  100, 20];    // dense / vigorous
}

function diffRgb(v, maxAbs) {
  if (v === null) return null;
  const t = Math.max(0, Math.min(1, v / (maxAbs || 0.4)));
  const i = Math.round(t * 220);
  return [255, 255 - i, 255 - i];           // white → red
}

// ── EVI overlay ────────────────────────────────────────────────────────────────
// MODIS row 0 = south; for map display (north up) we flip vertically
function drawEviOverlay(ctx, canvasPx, pixels, nrows, ncols, colorFn, opacity, bestIdx) {
  const cellW = canvasPx / ncols;
  const cellH = canvasPx / nrows;

  ctx.save();
  ctx.globalAlpha = opacity;
  for (let i = 0; i < pixels.length; i++) {
    const c = colorFn(pixels[i]);
    if (!c) continue;
    const dataRow = Math.floor(i / ncols);
    const dataCol = i % ncols;
    const dispRow = nrows - 1 - dataRow;  // flip: row 0 → bottom, row nrows-1 → top
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.fillRect(dataCol * cellW, dispRow * cellH, cellW, cellH);
  }
  ctx.restore();

  // Highlight selected pixel
  if (bestIdx >= 0 && bestIdx < pixels.length) {
    const dataRow = Math.floor(bestIdx / ncols);
    const dataCol = bestIdx % ncols;
    const dispRow = nrows - 1 - dataRow;
    ctx.save();
    ctx.strokeStyle = '#ffff00';
    ctx.lineWidth   = 2;
    ctx.shadowColor = '#000';
    ctx.shadowBlur  = 3;
    ctx.strokeRect(dataCol * cellW + 1, dispRow * cellH + 1, cellW - 2, cellH - 2);
    ctx.restore();
  }
}

// ── Best-pixel algorithm (mirrors evi.js findSeasonalPixel) ───────────────────
function findBestIdx(pxA, pxB, nrows, ncols) {
  const centerRow = Math.floor(nrows / 2);
  const centerCol = Math.floor(ncols / 2);
  let bestScore = -1;
  let bestIdx   = centerRow * ncols + centerCol;

  for (let i = 0; i < pxA.length && i < pxB.length; i++) {
    const a = pxA[i], b = pxB[i];
    if (a === null || b === null) continue;
    const mean = (a + b) / 2;
    if (mean < MIN_MEAN_EVI) continue;
    const score = Math.abs(a - b) * mean;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}

// Draw the EVI seasonal profile using the same 365-day array shown on the wheel.
function drawTimeSeries(canvas, eviArray) {
  const ctx = canvas.getContext('2d');
  const W   = canvas.width, H = canvas.height;
  const PAD = { t: 22, r: 16, b: 28, l: 44 };
  const pw  = W - PAD.l - PAD.r;
  const ph  = H - PAD.t - PAD.b;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#faf7f2';
  ctx.fillRect(0, 0, W, H);

  if (!eviArray?.length) {
    ctx.fillStyle = '#888'; ctx.font = '13px Crimson Pro, serif'; ctx.textAlign = 'center';
    ctx.fillText('No EVI data available', W / 2, H / 2);
    return;
  }

  // x: 0-based DOY 0–364, y: EVI 0–1
  const toX = i => PAD.l + i / 364 * pw;
  const toY = v => PAD.t + (1 - Math.max(0, Math.min(1, v))) * ph;

  // ── Horizontal grid + Y labels ──
  ctx.font = '10px sans-serif'; ctx.fillStyle = '#999'; ctx.textAlign = 'right';
  [0, 0.2, 0.4, 0.6, 0.8].forEach(v => {
    const y = toY(v);
    ctx.strokeStyle = '#e8e2d8'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + pw, y); ctx.stroke();
    ctx.fillText(v.toFixed(1), PAD.l - 5, y + 3.5);
  });

  // ── Month dividers + labels (0-based DOY starts) ──
  const MONTH_STARTS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  ctx.font = '10px sans-serif'; ctx.fillStyle = '#aaa'; ctx.textAlign = 'center';
  MONTH_STARTS.forEach((doy, i) => {
    const x     = toX(doy);
    const nextX = toX(MONTH_STARTS[i + 1] ?? 365);
    ctx.strokeStyle = '#d8d0c4'; ctx.lineWidth = 0.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + ph); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText(MONTH_LABELS[i], (x + nextX) / 2, PAD.t + ph + 14);
  });

  // ── Area fill ──
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(0));
  eviArray.forEach((v, i) => ctx.lineTo(toX(i), toY(v)));
  ctx.lineTo(toX(364), toY(0));
  ctx.closePath();
  ctx.fillStyle = '#27ae60'; ctx.globalAlpha = 0.20;
  ctx.fill();
  ctx.restore();

  // ── Line ──
  ctx.save();
  ctx.strokeStyle = '#27ae60'; ctx.lineWidth = 1.8;
  ctx.beginPath();
  eviArray.forEach((v, i) => i === 0 ? ctx.moveTo(toX(i), toY(v)) : ctx.lineTo(toX(i), toY(v)));
  ctx.stroke();
  ctx.restore();

  // ── Y-axis label ──
  ctx.save();
  ctx.translate(12, PAD.t + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.font = '11px Crimson Pro, serif'; ctx.fillStyle = '#555';
  ctx.fillText('EVI', 0, 0);
  ctx.restore();

  // ── Axes ──
  ctx.strokeStyle = '#bbb'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD.l, PAD.t); ctx.lineTo(PAD.l, PAD.t + ph);
  ctx.lineTo(PAD.l + pw, PAD.t + ph);
  ctx.stroke();
}

// ── Modal styles ───────────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById('evi-modal-css')) return;
  const s = document.createElement('style');
  s.id = 'evi-modal-css';
  s.textContent = `
    .evi-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,.55);
      display: flex; align-items: center; justify-content: center;
      z-index: 9999;
      padding: 1rem;
      overflow-y: auto;
    }
    .evi-modal {
      background: #faf7f2;
      border-radius: 10px;
      padding: 1.4rem 1.6rem 1.6rem;
      max-width: 900px;
      width: 100%;
      position: relative;
      box-shadow: 0 8px 40px rgba(0,0,0,.4);
    }
    .evi-modal h2 {
      font-family: 'Cinzel', serif;
      font-size: 1.1rem;
      color: #3a3028;
      margin: 0 2rem .2rem 0;
    }
    .evi-modal-subtitle {
      font-family: 'Crimson Pro', serif;
      font-size: .9rem;
      color: #888;
      margin: 0 0 1rem;
    }
    .evi-modal-close {
      position: absolute; top: .8rem; right: .9rem;
      background: none; border: none;
      font-size: 1.5rem; cursor: pointer; color: #999;
      line-height: 1; padding: 0 .2rem;
    }
    .evi-modal-close:hover { color: #333; }
    .evi-panels {
      display: flex; gap: .9rem; margin-bottom: 1rem;
    }
    .evi-panel {
      flex: 1; display: flex; flex-direction: column; align-items: center;
    }
    .evi-panel-title {
      font-family: 'Crimson Pro', serif;
      font-size: .82rem; color: #666;
      margin-bottom: .3rem; text-align: center;
    }
    .evi-panel canvas {
      width: 100%; aspect-ratio: 1;
      border-radius: 4px;
      border: 1px solid #ddd;
      image-rendering: pixelated;
    }
    .evi-opacity-row {
      display: flex; align-items: center; gap: .7rem;
      margin-bottom: 1rem;
      font-family: 'Crimson Pro', serif;
      font-size: .85rem; color: #555;
    }
    .evi-opacity-row input[type=range] {
      flex: 1; max-width: 200px;
    }
    .evi-ts-title {
      font-family: 'Crimson Pro', serif;
      font-size: .82rem; color: #666; margin-bottom: .3rem;
    }
    .evi-ts-panel canvas {
      width: 100%; height: auto;
      border-radius: 4px; border: 1px solid #e8e2d8;
    }
    .evi-loading {
      font-family: 'Crimson Pro', serif;
      font-size: .9rem; color: #888;
      text-align: center; padding: .5rem 0;
    }
    .evi-legend {
      display: flex; gap: .5rem; flex-wrap: wrap;
      margin: .4rem 0 .7rem;
      font-family: 'Crimson Pro', serif;
      font-size: .78rem; color: #666;
    }
    .evi-legend-item {
      display: flex; align-items: center; gap: .25rem;
    }
    .evi-legend-swatch {
      width: 14px; height: 14px; border-radius: 2px; flex-shrink: 0;
    }
    @media (max-width: 640px) {
      .evi-panels { flex-direction: column; }
      .evi-panel canvas { max-width: 100%; }
    }
  `;
  document.head.appendChild(s);
}

// ── Render a single panel ──────────────────────────────────────────────────────
// bgCanvas is a pre-rendered offscreen canvas containing the satellite tiles.
// Calling this is synchronous after the bg is ready.
function renderPanel(canvasEl, bgCanvas, pixels, nrows, ncols, colorFn, bestIdx, overlayOpacity) {
  const ctx = canvasEl.getContext('2d');
  const px  = canvasEl.width;
  ctx.clearRect(0, 0, px, px);
  ctx.drawImage(bgCanvas, 0, 0, px, px);
  drawEviOverlay(ctx, px, pixels, nrows, ncols, colorFn, overlayOpacity, bestIdx);
}

// ── Public entry point ─────────────────────────────────────────────────────────
export async function showEviAnalysis() {
  const lat  = currentData.lat;
  const lon  = currentData.lon;
  const name = currentData.name ?? '';

  injectStyles();

  // Remove any existing modal
  document.getElementById('evi-modal-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id        = 'evi-modal-overlay';
  overlay.className = 'evi-overlay';
  overlay.innerHTML = `
    <div class="evi-modal">
      <button class="evi-modal-close" title="Close">×</button>
      <h2>Vegetation Analysis</h2>
      <p class="evi-modal-subtitle">${name} · ${lat.toFixed(4)}°, ${lon.toFixed(4)}°</p>

      <div class="evi-panels">
        <div class="evi-panel">
          <div class="evi-panel-title" id="evi-title-peak">Peak EVI · loading…</div>
          <canvas id="evi-panel-jan" width="${PANEL_PX}" height="${PANEL_PX}"></canvas>
        </div>
        <div class="evi-panel">
          <div class="evi-panel-title" id="evi-title-trough">Trough EVI · loading…</div>
          <canvas id="evi-panel-jul" width="${PANEL_PX}" height="${PANEL_PX}"></canvas>
        </div>
        <div class="evi-panel">
          <div class="evi-panel-title" id="evi-title-diff">Peak − Trough · Seasonal change</div>
          <canvas id="evi-panel-diff" width="${PANEL_PX}" height="${PANEL_PX}"></canvas>
        </div>
      </div>

      <div class="evi-opacity-row">
        <label for="evi-overlay-opacity">Overlay opacity</label>
        <input type="range" id="evi-overlay-opacity" min="0" max="1" step="0.05" value="0.65">
        <span id="evi-opacity-val">65%</span>
      </div>

      <div class="evi-legend" id="evi-legend-area"></div>

      <div id="evi-map-status" class="evi-loading">Loading satellite imagery and EVI grids…</div>

      <div class="evi-ts-panel" style="display:none" id="evi-ts-wrap">
        <div class="evi-ts-title">EVI seasonal profile · 10-year baseline (2013–2022)</div>
        <canvas id="evi-timeseries" width="${TS_W}" height="${TS_H}"></canvas>
      </div>
      <div id="evi-ts-status" class="evi-loading" style="display:none"></div>
    </div>`;
  document.body.appendChild(overlay);

  // Close handlers
  overlay.querySelector('.evi-modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  const opacityInput = overlay.querySelector('#evi-overlay-opacity');
  const opacityVal   = overlay.querySelector('#evi-opacity-val');
  const statusEl     = overlay.querySelector('#evi-map-status');

  // ── Step 1: derive data-driven peak/trough dates for this location ──────────
  // Use stored keys from the main fetch if available; otherwise fetch the
  // annual series ourselves so the modal works correctly for preset data too.
  statusEl.textContent = 'Finding peak & trough composite dates for this location…';

  let peakKey   = currentData.eviPeakKey   ?? null;
  let troughKey = currentData.eviTroughKey ?? null;

  if (!peakKey || !troughKey) {
    // Use city-centre coords with a 3 km spatial average so the API returns
    // ~576 blended pixels rather than a single urban 250m pixel.  This gives a
    // representative regional seasonal signal even for dense urban centres.
    const series = await fetchAnnualSeries(currentData.lat, currentData.lon, 2022, 3);
    if (series.length >= 4) {
      let maxVal = -Infinity, minVal = Infinity;
      let maxDate = null,     minDate = null;
      for (const { date, value } of series) {
        if (value > maxVal) { maxVal = value; maxDate = date; }
        if (value < minVal) { minVal = value; minDate = date; }
      }
      // dateToModisKey inline: YYYY-MM-DD → AYYYY DDD
      const toKey = calDate => {
        const [y, mo, dy] = calDate.split('-').map(Number);
        const dims = [0,31,28,31,30,31,30,31,31,30,31,30,31];
        let doy = dy;
        for (let m = 1; m < mo; m++) doy += dims[m];
        return `A${y}${String(doy).padStart(3, '0')}`;
      };
      if (maxDate) peakKey   = toKey(maxDate);
      if (minDate) troughKey = toKey(minDate);
    }
    // Last-resort fallbacks
    peakKey   = peakKey   ?? 'A2022193';
    troughKey = troughKey ?? 'A2022001';
  }

  // Update panel titles with real dates
  overlay.querySelector('#evi-title-peak'  ).textContent = `Peak EVI · ${modisKeyToLabel(peakKey)}`;
  overlay.querySelector('#evi-title-trough').textContent = `Trough EVI · ${modisKeyToLabel(troughKey)}`;
  overlay.querySelector('#evi-title-diff'  ).textContent = `Peak − Trough · seasonal change`;

  // ── Step 2: fetch 250m grids at peak and trough dates ────────────────────
  statusEl.textContent = 'Fetching 250m EVI grids…';
  let gridA, gridB;
  try {
    [gridA, gridB] = await Promise.all([
      fetchPixelGrid(lat, lon, peakKey,   SCREEN_KM),
      fetchPixelGrid(lat, lon, troughKey, SCREEN_KM),
    ]);
  } catch {
    statusEl.textContent = 'Failed to fetch MODIS grid data.';
    return;
  }

  if (!gridA || !gridB) {
    statusEl.textContent = 'MODIS grid data unavailable for this location.';
    return;
  }

  const { nrows, ncols, pixels: pxPeak }  = gridA;  // gridA = peak date
  const { pixels: pxTrough }              = gridB;  // gridB = trough date

  // Diff = peak − trough (always positive for vegetated pixels)
  const diffPixels = pxPeak.map((a, i) => {
    const b = pxTrough[i];
    return a !== null && b !== null ? a - b : null;
  });
  const validDiffs = diffPixels.filter(v => v !== null);
  const maxAbs = Math.max(0.01, ...validDiffs.map(Math.abs));

  // Find best pixel (max amplitude × mean, same algorithm as evi.js)
  const bestIdx = findBestIdx(pxPeak, pxTrough, nrows, ncols);
  const bestRow = Math.floor(bestIdx / ncols);
  const bestCol = bestIdx % ncols;

  // Compute best-pixel lat/lon for time series
  const centerRow = Math.floor(nrows / 2);
  const centerCol = Math.floor(ncols / 2);
  const pixLat = lat + (bestRow - centerRow) * PIXEL_KM / KM_PER_DEG;
  const pixLon = lon + (bestCol - centerCol) * PIXEL_KM / (KM_PER_DEG * Math.cos(lat * Math.PI / 180));

  statusEl.textContent = 'Rendering satellite tiles…';

  const janCanvas  = overlay.querySelector('#evi-panel-jan');
  const julCanvas  = overlay.querySelector('#evi-panel-jul');
  const diffCanvas = overlay.querySelector('#evi-panel-diff');

  // Fetch satellite tiles once into an offscreen canvas, reuse for all panels
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = PANEL_PX; bgCanvas.height = PANEL_PX;
  await drawSatelliteBg(bgCanvas.getContext('2d'), PANEL_PX, lat, lon, nrows, ncols);

  let currentOpacity = parseFloat(opacityInput.value);

  // ── Redraw all three panels (synchronous after bg is ready) ──
  function renderAllPanels(opacity) {
    renderPanel(janCanvas,  bgCanvas, pxPeak,     nrows, ncols, eviRgb,                   bestIdx, opacity);
    renderPanel(julCanvas,  bgCanvas, pxTrough,   nrows, ncols, eviRgb,                   bestIdx, opacity);
    renderPanel(diffCanvas, bgCanvas, diffPixels, nrows, ncols, v => diffRgb(v, maxAbs),  bestIdx, opacity);
  }

  renderAllPanels(currentOpacity);
  statusEl.style.display = 'none';

  // Build EVI color legend
  const legendEl = overlay.querySelector('#evi-legend-area');
  [
    { color: [80, 60, 30],   label: 'Bare/very dry (< 0.03)' },
    { color: [170, 130, 50], label: 'Sparse (0.03–0.10)' },
    { color: [210, 200, 60], label: 'Low (0.10–0.20)' },
    { color: [120, 190, 55], label: 'Moderate (0.20–0.30)' },
    { color: [40, 160, 40],  label: 'Healthy (0.30–0.45)' },
    { color: [10, 100, 20],  label: 'Dense (> 0.45)' },
    { color: [255, 255, 255], label: 'No change (diff panel)' },
    { color: [255, 35, 35],  label: 'High seasonal change (diff panel)' },
    { color: [255, 255, 0],  label: '★ Selected pixel', border: true },
  ].forEach(({ color, label, border }) => {
    const item = document.createElement('div');
    item.className = 'evi-legend-item';
    item.innerHTML = `
      <div class="evi-legend-swatch" style="background:rgb(${color[0]},${color[1]},${color[2]});${border ? 'border:2px solid #ffff00;' : ''}"></div>
      <span>${label}</span>`;
    legendEl.appendChild(item);
  });

  // Opacity slider (synchronous re-render)
  opacityInput.addEventListener('input', () => {
    currentOpacity = parseFloat(opacityInput.value);
    opacityVal.textContent = Math.round(currentOpacity * 100) + '%';
    renderAllPanels(currentOpacity);
  });

  // ── Step 3: draw time series from already-loaded wheel data ──
  const tsWrapEl = overlay.querySelector('#evi-ts-wrap');
  overlay.querySelector('#evi-ts-status').style.display = 'none';
  if (Array.isArray(currentData.evi)) {
    tsWrapEl.style.display = '';
    drawTimeSeries(overlay.querySelector('#evi-timeseries'), currentData.evi);
  }
}
