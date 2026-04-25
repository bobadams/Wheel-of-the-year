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
import { computeNormBounds } from './draw/normalize.js';
import { drawMoon, drawTicks, drawAxes, drawCenter } from './draw/decorations.js';
import { drawHolidays } from './draw/holidays.js';
import { drawMinMaxMarkers } from './draw/labels.js';
import { drawWindBarbs } from './draw/windBarbs.js';
import { drawActualsLine, drawTodayDot } from './draw/actuals.js';
import { geocode, fetchClimateAPI, aggregateClimate } from './fetch/climate.js';
import { fetchModisEVI, eviProxyFallback } from './fetch/evi.js';
import { fetchPm25 } from './fetch/pm25.js';
import { fetchVisibility } from './fetch/visibility.js';
import { fetchActuals, fetchRecentEVI, fetchActualsPm25, fetchActualsVisibility } from './fetch/actuals.js';
import { setStatus, setLoading, setEviProgress } from './ui/status.js';
import { rebuildLegend } from './ui/legend.js';
import { buildRingControls, toggleDisplay, setDrawCallback, refreshSourceBadges } from './ui/controls.js';
import { setupTooltip } from './ui/tooltip.js';
import { showRingChart } from './ui/ringChart.js';

// ─── Draw ────────────────────────────────────────────────────────────────────
function draw() {
  const { ctx, W, H, CX, CY } = canvas;
  const layouts = computeRingLayouts();
  const normBounds = computeNormBounds(currentData);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#faf7f2'; ctx.fillRect(0, 0, W, H);

  ringOrder.forEach(id => {
    const s = ringState[id];
    if (!s.visible || !layouts[id]) return;
    const r = RING_DEFS.find(r => r.id === id);
    const { innerFrac, thickFrac } = layouts[id];
    const ringData = s.smooth && smoothedData[id] ? smoothedData[id] : currentData[id];
    const { lo, hi } = normBounds[id];
    drawRing(ringData, lo, hi, innerFrac * W, thickFrac * W, s.color, s.opacity, r.blankZero, currentData[id]);
  });

  // Outer decorative circles
  ctx.save();
  ctx.beginPath(); ctx.arc(CX, CY, W * .425, 0, Math.PI * 2);
  ctx.strokeStyle = '#b0a090'; ctx.lineWidth = 1; ctx.globalAlpha = .3; ctx.stroke();
  ctx.beginPath(); ctx.arc(CX, CY, W * .442, 0, Math.PI * 2);
  ctx.lineWidth = .5; ctx.globalAlpha = .18; ctx.stroke();
  ctx.restore();

  if (actuals && displayState.actuals) {
    ['temp', 'rain', 'evi', 'wind', 'pm25', 'visibility', 'snow', 'cloud'].forEach(id => {
      const r = RING_DEFS.find(r => r.id === id);
      if (r && actuals[id] && layouts[id]) drawActualsLine(r, actuals[id], layouts[id], normBounds);
    });
    drawTodayDot(layouts, normBounds);
  }

  drawMinMaxMarkers(layouts, normBounds);
  if (displayState.windBarbs)  drawWindBarbs(layouts);
  if (displayState.moon)       drawMoon();
  if (displayState.ticks)      drawTicks();
  if (displayState.axis)       drawAxes();
  if (displayState.holidays)   drawHolidays();
  drawCenter();
}

// ─── Live fetch ──────────────────────────────────────────────────────────────
async function fetchCity() {
  const q = document.getElementById('cityInput').value.trim();
  if (!q) return;
  setStatus('loading', 'Geocoding…');
  setLoading(true);
  setActuals(null); setTodayDOY(null);
  setEviProgress(false);

  try {
    const geo = await geocode(q);
    const shortName = geo.name.split(',').slice(0, 2).join(',').trim();

    setStatus('loading', `Found ${shortName} — fetching climate normals…`);
    const climate = aggregateClimate(await fetchClimateAPI(geo.lat, geo.lon), geo.lat);
    const { snowIn, cloudMean } = climate;

    setStatus('loading', 'Normals loaded — fetching MODIS EVI…');
    setEviProgress(true, 0, 'Fetching MODIS satellite data…');
    let evi, eviSampLat = geo.lat, eviSampLon = geo.lon, eviSampMapUrl = null;
    let eviPeakKey = null, eviTroughKey = null;
    try {
      ({ evi, sampLat: eviSampLat, sampLon: eviSampLon, sampMapUrl: eviSampMapUrl,
         peakKey: eviPeakKey, troughKey: eviTroughKey,
       } = await fetchModisEVI(geo.lat, geo.lon, pct => setEviProgress(true, pct, `MODIS EVI: ${pct}%…`)));
    } catch {
      evi = eviProxyFallback(climate.tempF, climate.rainIn);
    }
    setEviProgress(false);

    setStatus('loading', 'Fetching PM2.5 air quality normals…');
    let pm25 = null;
    try {
      pm25 = await fetchPm25(geo.lat, geo.lon);
    } catch { /* PM2.5 is optional; ring will be blank if unavailable */ }

    setStatus('loading', 'Fetching visibility normals…');
    let visibility = null;
    try {
      visibility = await fetchVisibility(geo.lat, geo.lon);
    } catch { /* visibility is optional; ring will be blank if unavailable */ }

    setCurrentData({
      name: shortName, lat: geo.lat, lon: geo.lon,
      temp: climate.tempF, rain: climate.rainIn, daylight: climate.daylight,
      evi, wind: climate.windMph, windDir: climate.windDir,
      pm25,
      visibility,
      snow: snowIn,
      cloud: cloudMean,
      eviSampLat, eviSampLon, eviSampMapUrl,
      eviPeakKey, eviTroughKey,
      resolution: climate.resolution,
      eviSource: evi ? 'MODIS EVI 2013–2022' : 'proxy',
      meta: {
        temp:     { sourceInterval: 'daily',       source: 'ERA5 1991–2020' },
        rain:     { sourceInterval: 'daily',       source: 'ERA5 1991–2020' },
        daylight: { sourceInterval: 'calculated',  source: `astronomical (lat ${geo.lat.toFixed(1)}°)` },
        evi:      { sourceInterval: evi ? '16-day' : 'proxy', source: evi ? 'MODIS MOD13Q1 EVI 2013–2022' : 'ERA5-derived proxy' },
        wind:     { sourceInterval: 'daily',       source: 'ERA5 1991–2020' },
        pm25:       { sourceInterval: 'hourly',      source: pm25 ? 'CAMS 2014–2023' : 'unavailable' },
        visibility: { sourceInterval: 'hourly',      source: visibility ? 'ERA5 2010–2020' : 'unavailable' },
        snow:       { sourceInterval: 'daily',       source: 'ERA5 1991–2020' },
        cloud:      { sourceInterval: 'daily',       source: 'ERA5 1991–2020' },
      },
    });
    setActivePreset('');
    refreshPresets();
    refreshSourceBadges();
    draw();

    // Actuals overlay (non-blocking)
    setStatus('loading', 'Fetching actuals for past year…');
    try {
      const w = await fetchActuals(geo.lat, geo.lon);
      setTodayDOY(w.todayDOY);
      setActuals({ temp: w.temp, rain: w.rain, wind: w.wind, evi: null, pm25: null, visibility: null, snow: w.snow, cloud: w.cloud });
      draw();
      setStatus('ok', `${shortName} — normals + actuals loaded. Today = DOY ${w.todayDOY}.`);

      try {
        const recentEvi = await fetchRecentEVI(
          currentData.eviSampLat ?? geo.lat,
          currentData.eviSampLon ?? geo.lon,
        );
        if (recentEvi?.length) { actuals.evi = recentEvi; draw(); }
      } catch { /* EVI actuals optional */ }

      try {
        const recentPm25 = await fetchActualsPm25(geo.lat, geo.lon);
        if (recentPm25?.length) { actuals.pm25 = recentPm25; draw(); }
      } catch { /* PM2.5 actuals optional */ }

      try {
        const recentVis = await fetchActualsVisibility(geo.lat, geo.lon);
        if (recentVis?.length) { actuals.visibility = recentVis; draw(); }
      } catch { /* visibility actuals optional */ }
    } catch (e) {
      setStatus('error', `Normals loaded. Actuals failed: ${e.message}`);
    }
  } catch (e) {
    setStatus('error', e.message);
    setEviProgress(false);
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

  canvas.el.addEventListener('mousemove', e => {
    const rect = canvas.el.getBoundingClientRect();
    const sx = canvas.W / rect.width, sy = canvas.H / rect.height;
    const dx = (e.clientX - rect.left) * sx - canvas.CX;
    const dy = (e.clientY - rect.top)  * sy - canvas.CY;
    const rFrac = Math.sqrt(dx * dx + dy * dy) / canvas.W;
    const layouts = computeRingLayouts();
    const hit = ringOrder.some(id => {
      if (!ringState[id].visible || !layouts[id]) return false;
      const { innerFrac, thickFrac } = layouts[id];
      return rFrac >= innerFrac && rFrac <= innerFrac + thickFrac;
    });
    canvas.el.style.cursor = hit ? 'pointer' : 'default';
  });

  canvas.el.addEventListener('click', e => {
    const rect = canvas.el.getBoundingClientRect();
    const sx = canvas.W / rect.width, sy = canvas.H / rect.height;
    const dx = (e.clientX - rect.left) * sx - canvas.CX;
    const dy = (e.clientY - rect.top)  * sy - canvas.CY;
    const rFrac = Math.sqrt(dx * dx + dy * dy) / canvas.W;
    const layouts = computeRingLayouts();
    for (const id of ringOrder) {
      if (!ringState[id].visible || !layouts[id]) continue;
      const { innerFrac, thickFrac } = layouts[id];
      if (rFrac >= innerFrac && rFrac <= innerFrac + thickFrac) {
        showRingChart(id);
        return;
      }
    }
  });

  // Wire up buttons/inputs that use onclick in HTML via module-scope exposure
  window.fetchCity   = fetchCity;
  window.loadPreset  = loadPreset;
  window.exportPNG   = exportPNG;
  window.toggleDisplay = toggleDisplay;

  document.getElementById('cityInput').addEventListener('keydown', e => { if (e.key === 'Enter') fetchCity(); });
  window.addEventListener('resize', () => { resizeCanvas(); draw(); });

  // Fetch actuals for the default preset on load
  (async () => {
    const { lat, lon } = PRESETS[0].data;
    setStatus('loading', 'Fetching actuals for past year…');
    try {
      const w = await fetchActuals(lat, lon);
      setTodayDOY(w.todayDOY);
      setActuals({ temp: w.temp, rain: w.rain, wind: w.wind, evi: null, pm25: null, visibility: null, snow: w.snow, cloud: w.cloud });
      draw();
      setStatus('ok', `${currentData.name} — preset + actuals loaded. Today = DOY ${w.todayDOY}.`);
      try {
        const { eviSampLat, eviSampLon } = PRESETS[0].data;
        const recentEvi = await fetchRecentEVI(eviSampLat ?? lat, eviSampLon ?? lon);
        if (recentEvi?.length) { actuals.evi = recentEvi; draw(); }
      } catch { /* EVI actuals optional */ }
      try {
        const recentPm25 = await fetchActualsPm25(lat, lon);
        if (recentPm25?.length) { actuals.pm25 = recentPm25; draw(); }
      } catch { /* PM2.5 actuals optional */ }
    } catch (e) {
      setStatus('error', `Preset loaded. Actuals failed: ${e.message}`);
    }
  })();

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
