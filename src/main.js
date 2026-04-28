import './styles.css';
import C2S from 'canvas2svg';

import { RING_DEFS } from './data/ringDefs.js';
import { PRESETS } from './data/presets.js';
import {
  canvas, ringOrder, ringState, displayState,
  currentData, smoothedData, actuals,
  setCurrentData, mergeCurrentData, setActivePreset, setActuals, setTodayDOY,
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
  ctx.beginPath(); ctx.arc(CX, CY, W * .420, 0, Math.PI * 2);
  ctx.strokeStyle = '#b0a090'; ctx.lineWidth = 1; ctx.globalAlpha = .3; ctx.stroke();
  ctx.beginPath(); ctx.arc(CX, CY, W * .437, 0, Math.PI * 2);
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

    // Draw immediately with just location so decorations/labels appear right away
    setCurrentData({ name: shortName, lat: geo.lat, lon: geo.lon });
    setActivePreset('');
    refreshPresets();
    refreshSourceBadges();
    draw();

    setStatus('loading', `Found ${shortName} — fetching climate normals…`);
    const climate = aggregateClimate(await fetchClimateAPI(geo.lat, geo.lon), geo.lat);

    // Draw climate rings as soon as normals arrive
    mergeCurrentData({
      temp: climate.tempF, rain: climate.rainIn, daylight: climate.daylight,
      wind: climate.windMph, windDir: climate.windDir,
      snow: climate.snowIn, cloud: climate.cloudMean,
      resolution: climate.resolution,
      meta: {
        temp:     { sourceInterval: 'daily',      source: 'ERA5 1991–2020' },
        rain:     { sourceInterval: 'daily',      source: 'ERA5 1991–2020' },
        daylight: { sourceInterval: 'calculated', source: `astronomical (lat ${geo.lat.toFixed(1)}°)` },
        evi:      { sourceInterval: 'pending',    source: 'fetching…' },
        wind:     { sourceInterval: 'daily',      source: 'ERA5 1991–2020' },
        pm25:       { sourceInterval: 'hourly',   source: 'fetching…' },
        visibility: { sourceInterval: 'hourly',   source: 'fetching…' },
        snow:       { sourceInterval: 'daily',    source: 'ERA5 1991–2020' },
        cloud:      { sourceInterval: 'daily',    source: 'ERA5 1991–2020' },
      },
    });
    refreshSourceBadges();
    draw();

    // Actuals overlay — kick off in parallel with the slow fetches below
    setStatus('loading', 'Normals loaded — fetching actuals + EVI…');
    const actualsPromise = fetchActuals(geo.lat, geo.lon).then(w => {
      setTodayDOY(w.todayDOY);
      setActuals({ temp: w.temp, rain: w.rain, wind: w.wind, evi: null, pm25: null, visibility: null, snow: w.snow, cloud: w.cloud });
      draw();
    }).catch(() => {});

    // EVI (slowest — draw as soon as it lands)
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
    mergeCurrentData({
      evi, eviSampLat, eviSampLon, eviSampMapUrl, eviPeakKey, eviTroughKey,
      eviSource: evi ? 'MODIS EVI 2013–2022' : 'proxy',
      meta: {
        ...currentData.meta,
        evi: { sourceInterval: evi ? '16-day' : 'proxy', source: evi ? 'MODIS MOD13Q1 EVI 2013–2022' : 'ERA5-derived proxy' },
      },
    });
    refreshSourceBadges();
    draw();

    // PM2.5
    setStatus('loading', 'Fetching PM2.5 air quality normals…');
    let pm25 = null;
    try {
      pm25 = await fetchPm25(geo.lat, geo.lon);
    } catch { /* optional */ }
    mergeCurrentData({
      pm25,
      meta: { ...currentData.meta, pm25: { sourceInterval: 'hourly', source: pm25 ? 'CAMS 2014–2023' : 'unavailable' } },
    });
    refreshSourceBadges();
    draw();

    // Visibility
    setStatus('loading', 'Fetching visibility normals…');
    let visibility = null;
    try {
      visibility = await fetchVisibility(geo.lat, geo.lon);
    } catch { /* optional */ }
    mergeCurrentData({
      visibility,
      meta: { ...currentData.meta, visibility: { sourceInterval: 'hourly', source: visibility ? 'ERA5 2010–2020' : 'unavailable' } },
    });
    refreshSourceBadges();
    draw();

    // Wait for actuals to finish before declaring done
    await actualsPromise;
    setStatus('ok', `${shortName} — loaded.`);

    // EVI / PM2.5 / visibility actuals (non-blocking)
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

    setStatus('ok', `${shortName} — all data loaded.`);
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

// ─── Copy link ───────────────────────────────────────────────────────────────
function copyLink() {
  const state = {
    city: currentData.name || document.getElementById('cityInput').value.trim(),
    order: [...ringOrder],
    rings: Object.fromEntries(ringOrder.map(id => {
      const s = ringState[id];
      return [id, { v: s.visible ? 1 : 0, c: s.color, t: s.thickness, s: s.smooth ? 1 : 0, n: s.normMode }];
    })),
    disp: {
      moon:          displayState.moon          ? 1 : 0,
      axis:          displayState.axis          ? 1 : 0,
      ticks:         displayState.ticks         ? 1 : 0,
      actuals:       displayState.actuals       ? 1 : 0,
      actualsSmooth: displayState.actualsSmooth ? 1 : 0,
      windBarbs:     displayState.windBarbs     ? 1 : 0,
      gap:           displayState.ringGap,
      hol:  displayState.holidays          ? 1 : 0,
      holC: displayState.holidayChristian  ? 1 : 0,
      holJ: displayState.holidayJewish     ? 1 : 0,
      holW: displayState.holidayWicca      ? 1 : 0,
      holI: displayState.holidayIslamic    ? 1 : 0,
    },
  };
  const url = `${location.origin}${location.pathname}?s=${encodeURIComponent(JSON.stringify(state))}`;
  const btn = document.getElementById('copyLinkBtn');
  navigator.clipboard.writeText(url).then(() => {
    if (btn) { const orig = btn.textContent; btn.textContent = '✓ Copied!'; setTimeout(() => { btn.textContent = orig; }, 2000); }
  }).catch(() => { prompt('Copy this link:', url); });
}

function applyUrlParams() {
  const raw = new URLSearchParams(location.search).get('s');
  if (!raw) return false;
  let p;
  try { p = JSON.parse(decodeURIComponent(raw)); } catch { return false; }

  if (Array.isArray(p.order)) {
    ringOrder.length = 0;
    p.order.forEach(id => { if (ringState[id]) ringOrder.push(id); });
  }

  if (p.rings) {
    Object.entries(p.rings).forEach(([id, r]) => {
      if (!ringState[id]) return;
      if (r.v !== undefined) ringState[id].visible    = !!r.v;
      if (r.c !== undefined) ringState[id].color      = r.c;
      if (r.t !== undefined) ringState[id].thickness  = r.t;
      if (r.s !== undefined) ringState[id].smooth     = !!r.s;
      if (r.n !== undefined) ringState[id].normMode   = r.n;
    });
  }

  if (p.disp) {
    const d = p.disp;
    const map = {
      moon: 'moon', axis: 'axis', ticks: 'ticks',
      actuals: 'actuals', actualsSmooth: 'actualsSmooth', windBarbs: 'windBarbs',
      hol: 'holidays', holC: 'holidayChristian', holJ: 'holidayJewish',
      holW: 'holidayWicca', holI: 'holidayIslamic',
    };
    Object.entries(map).forEach(([k, dsKey]) => {
      if (d[k] !== undefined) displayState[dsKey] = !!d[k];
    });
    if (d.gap !== undefined) displayState.ringGap = d.gap;
  }

  // Sync display toggle button classes
  document.querySelectorAll('[data-display-key]').forEach(btn => {
    btn.classList.toggle('on', !!displayState[btn.dataset.displayKey]);
  });

  // Rebuild ring controls with restored state (reads displayState.ringGap automatically)
  buildRingControls();
  rebuildLegend();

  if (p.city) {
    document.getElementById('cityInput').value = p.city;
    fetchCity();
  }

  return true;
}

// ─── Export ──────────────────────────────────────────────────────────────────
function patchC2S(ctx) {
  // canvas2svg v1.0.x omits several Canvas 2D methods; patch them onto the instance.
  let _dash = [];
  const _origStroke = ctx.stroke.bind(ctx);

  ctx.setLineDash = arr => { _dash = arr ? [...arr] : []; };
  ctx.getLineDash = () => [..._dash];

  // Apply stroke-dasharray whenever stroke() is called so each path element
  // inherits the correct dash pattern at the moment it is stroked.
  ctx.stroke = function (...args) {
    _origStroke(...args);
    if (ctx.__currentElement) {
      const val = _dash.length ? _dash.join(',') : 'none';
      ctx.__currentElement.setAttribute('stroke-dasharray', val);
    }
  };

  // canvas2svg's __parseFont regex only allows [-,"a-z\s] in the family name,
  // so single-quoted names like 'Crimson Pro' crash it. Strip the quotes.
  let _font = ctx.font ?? '10px sans-serif';
  Object.defineProperty(ctx, 'font', {
    get() { return _font; },
    set(v) { _font = typeof v === 'string' ? v.replace(/'/g, '') : v; },
    configurable: true,
  });
}

function exportSVG() {
  const { W, H } = canvas;
  const svgCtx = new C2S(W, H);
  patchC2S(svgCtx);
  const realCtx = canvas.ctx;
  canvas.ctx = svgCtx;
  draw();
  canvas.ctx = realCtx;

  // Inject Google Fonts inside a CDATA block so the URL's & characters are
  // not treated as XML entities, and the typefaces render in standalone SVG.
  const fontStyle = `<style><![CDATA[@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600&family=Crimson+Pro:ital,wght@0,300;0,400;1,300&display=swap');]]></style>`;
  let svg = svgCtx.getSerializedSvg(true);
  svg = svg.includes('<defs>')
    ? svg.replace('<defs>', `<defs>${fontStyle}`)
    : svg.replace(/(<svg[^>]*>)/, `$1<defs>${fontStyle}</defs>`);

  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.download = `wheel-${currentData.name.replace(/[^a-z0-9]/gi, '_')}.svg`;
  a.href = url;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  window.fetchCity     = fetchCity;
  window.loadPreset    = loadPreset;
  window.exportSVG     = exportSVG;
  window.copyLink      = copyLink;
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

  // Restore from URL params if present; otherwise fetch actuals for the default preset
  if (applyUrlParams()) return;

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
}

window.addEventListener('DOMContentLoaded', init);
