import './styles.css';

import { RING_DEFS } from './data/ringDefs.js';
import { PRESETS } from './data/presets.js';
import {
  canvas, ringOrder, ringState, displayState,
  currentData, smoothedData, actuals,
  setCurrentData, setActivePreset, setActuals, setTodayDOY,
} from './state.js';
import { computeRingLayouts } from './draw/layout.js';
import { drawRing } from './draw/ring.js';
import { drawMoon, drawTicks, drawAxes, drawCenter } from './draw/decorations.js';
import { drawMinMaxMarkers } from './draw/labels.js';
import { drawActualsLine, drawTodayDot } from './draw/actuals.js';
import { geocode, fetchClimateAPI, aggregateClimate } from './fetch/climate.js';
import { fetchModisNDVI, ndviProxyFallback } from './fetch/ndvi.js';
import { fetchActuals, fetchRecentNDVI } from './fetch/actuals.js';
import { setStatus, setLoading, setNdviProgress } from './ui/status.js';
import { rebuildLegend } from './ui/legend.js';
import { buildRingControls, toggleDisplay, setDrawCallback, refreshSourceBadges } from './ui/controls.js';
import { setupTooltip } from './ui/tooltip.js';

// ─── Draw ────────────────────────────────────────────────────────────────────
function draw() {
  const { ctx, W, H, CX, CY } = canvas;
  const layouts = computeRingLayouts();
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#faf7f2'; ctx.fillRect(0, 0, W, H);

  ringOrder.forEach(id => {
    const r = RING_DEFS.find(r => r.id === id);
    const s = ringState[id];
    if (!s.visible || !layouts[id]) return;
    const { innerFrac, thickFrac } = layouts[id];
    const ringData = s.smooth && smoothedData[id] ? smoothedData[id] : currentData[id];
    drawRing(ringData, r.normLo, r.normHi, innerFrac * W, thickFrac * W, s.color, s.opacity);
  });

  // Outer decorative circles
  ctx.save();
  ctx.beginPath(); ctx.arc(CX, CY, W * .425, 0, Math.PI * 2);
  ctx.strokeStyle = '#b0a090'; ctx.lineWidth = 1; ctx.globalAlpha = .3; ctx.stroke();
  ctx.beginPath(); ctx.arc(CX, CY, W * .442, 0, Math.PI * 2);
  ctx.lineWidth = .5; ctx.globalAlpha = .18; ctx.stroke();
  ctx.restore();

  if (actuals && displayState.actuals) {
    ['temp', 'rain', 'ndvi'].forEach(id => {
      const r = RING_DEFS.find(r => r.id === id);
      if (r && actuals[id] && layouts[id]) drawActualsLine(r, actuals[id], layouts[id]);
    });
    drawTodayDot(layouts);
  }

  drawMinMaxMarkers(layouts);
  if (displayState.moon)  drawMoon();
  if (displayState.ticks) drawTicks();
  if (displayState.axis)  drawAxes();
  drawCenter();
}

// ─── Live fetch ──────────────────────────────────────────────────────────────
async function fetchCity() {
  const q = document.getElementById('cityInput').value.trim();
  if (!q) return;
  setStatus('loading', 'Geocoding…');
  setLoading(true);
  setActuals(null); setTodayDOY(null);
  setNdviProgress(false);

  try {
    const geo = await geocode(q);
    const shortName = geo.name.split(',').slice(0, 2).join(',').trim();

    setStatus('loading', `Found ${shortName} — fetching climate normals…`);
    const climate = aggregateClimate(await fetchClimateAPI(geo.lat, geo.lon), geo.lat);

    setStatus('loading', 'Normals loaded — fetching MODIS NDVI…');
    setNdviProgress(true, 0, 'Fetching MODIS satellite data…');
    let ndvi, ndviSampLat = geo.lat, ndviSampLon = geo.lon, ndviSampMapUrl = null;
    try {
      ({ ndvi, sampLat: ndviSampLat, sampLon: ndviSampLon, sampMapUrl: ndviSampMapUrl } = await fetchModisNDVI(geo.lat, geo.lon, pct => setNdviProgress(true, pct, `MODIS NDVI: ${pct}%…`)));
    } catch {
      ndvi = ndviProxyFallback(climate.tempF, climate.rainIn);
    }
    setNdviProgress(false);

    setCurrentData({
      name: shortName, lat: geo.lat, lon: geo.lon,
      temp: climate.tempF, rain: climate.rainIn, daylight: climate.daylight,
      ndvi, wind: climate.windMph,
      ndviSampLat, ndviSampLon, ndviSampMapUrl,
      resolution: climate.resolution,
      ndviSource: ndvi ? 'MODIS 2019–2022' : 'proxy',
      meta: {
        temp:     { sourceInterval: 'daily',       source: 'ERA5 1991–2020' },
        rain:     { sourceInterval: 'daily',       source: 'ERA5 1991–2020' },
        daylight: { sourceInterval: 'calculated',  source: `astronomical (lat ${geo.lat.toFixed(1)}°)` },
        ndvi:     { sourceInterval: ndvi ? '16-day' : 'proxy', source: ndvi ? 'MODIS MOD13Q1 2019–2022' : 'ERA5-derived proxy' },
        wind:     { sourceInterval: 'daily',       source: 'ERA5 1991–2020' },
      },
    });
    setActivePreset('');
    refreshPresets();
    refreshSourceBadges();
    draw();

    // Actuals overlay (non-blocking)
    setStatus('loading', 'Fetching actuals for past 6 months…');
    try {
      const w = await fetchActuals(geo.lat, geo.lon);
      setTodayDOY(w.todayDOY);
      setActuals({ temp: w.temp, rain: w.rain, ndvi: null });
      draw();
      setStatus('ok', `${shortName} — normals + actuals loaded. Today = DOY ${w.todayDOY}.`);

      try {
        const recentNdvi = await fetchRecentNDVI(geo.lat, geo.lon);
        if (recentNdvi?.length) { actuals.ndvi = recentNdvi; draw(); }
      } catch { /* NDVI actuals optional */ }
    } catch (e) {
      setStatus('error', `Normals loaded. Actuals failed: ${e.message}`);
    }
  } catch (e) {
    setStatus('error', e.message);
    setNdviProgress(false);
  } finally {
    setLoading(false);
  }
}

// ─── Presets ─────────────────────────────────────────────────────────────────
function loadPreset(p) {
  setCurrentData(p.data);
  setActuals(null); setTodayDOY(null);
  document.getElementById('cityInput').value = p.city;
  setActivePreset(p.label);
  refreshPresets(); refreshSourceBadges(); draw();
  setStatus('ok', `Loaded built-in data for ${p.data.name} — click Load Live Data for actuals overlay`);
}

function refreshPresets() {
  document.querySelectorAll('.preset-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.label === (PRESETS.find(p => p.label === b.dataset.label) ? b.dataset.label : ''));
  });
}

// ─── Export ──────────────────────────────────────────────────────────────────
function exportPNG() {
  const a = document.createElement('a');
  a.download = `wheel-${currentData.name.replace(/[^a-z0-9]/gi, '_')}.png`;
  a.href = canvas.el.toDataURL('image/png');
  a.click();
}

// ─── Init ────────────────────────────────────────────────────────────────────
function resizeCanvas() {
  const sz = Math.min(660, window.innerWidth * .92);
  canvas.el.width = sz; canvas.el.height = sz;
  canvas.W = sz; canvas.H = sz; canvas.CX = sz / 2; canvas.CY = sz / 2;
}

function init() {
  canvas.el  = document.getElementById('wheel');
  canvas.ctx = canvas.el.getContext('2d');
  resizeCanvas();

  setDrawCallback(draw);
  buildRingControls(); // also calls refreshSourceBadges internally
  rebuildLegend();
  draw();
  setupTooltip();

  // Wire up buttons/inputs that use onclick in HTML via module-scope exposure
  window.fetchCity   = fetchCity;
  window.loadPreset  = loadPreset;
  window.exportPNG   = exportPNG;
  window.toggleDisplay = toggleDisplay;

  document.getElementById('cityInput').addEventListener('keydown', e => { if (e.key === 'Enter') fetchCity(); });
  window.addEventListener('resize', () => { resizeCanvas(); draw(); });

  // Build preset buttons
  const presetsEl = document.getElementById('presetsEl');
  PRESETS.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'preset-btn active';
    btn.dataset.label = p.label;
    btn.textContent = p.label;
    btn.onclick = () => loadPreset(p);
    presetsEl.appendChild(btn);
  });
}

window.addEventListener('DOMContentLoaded', init);
