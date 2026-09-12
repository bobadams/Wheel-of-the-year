import './styles.css';

import { PRESETS } from './data/presets.js';
import {
  canvas, ringOrder, ringState, displayState,
  currentData, actuals,
  setCurrentData, mergeCurrentData, setActivePreset, setActuals, setTodayDOY,
  setPhenologyEvents, setPhenologyCategory,
} from './state.js';
import { computeRingLayouts } from './draw/layout.js';
import { paintWheel, paintPaper } from './draw/wheel.js';
import { geocode, fetchClimateAPI, aggregateClimate } from './fetch/climate.js';
import { fetchModisEVI, eviProxyFallback } from './fetch/evi.js';
import { fetchPm25 } from './fetch/pm25.js';
import { fetchVisibility } from './fetch/visibility.js';
import { fetchDewpoint } from './fetch/humidity.js';
import {
  fetchActuals, fetchRecentEVI, fetchActualsPm25, fetchActualsVisibility,
  fetchActualsDewpoint, calendarDOY, todayDate,
} from './fetch/actuals.js';
import { fetchPhenology } from './fetch/phenology.js';
import { setStatus, setLoading, setEviProgress } from './ui/status.js';
import { rebuildLegend } from './ui/legend.js';
import { buildRingControls, toggleDisplay, setDrawCallback, refreshSourceBadges } from './ui/controls.js';
import { setupTooltip } from './ui/tooltip.js';
import { buildEmbeddedFontStyle, renderSVG, downloadFile, fileStem } from './export/svg.js';
import { printPoster, downloadPosterSVG, POSTER_SIZES, DEFAULT_SIZE } from './print/poster.js';
import { showRingChart } from './ui/ringChart.js';
import {
  locationKey, loadLocationCache, saveLocationCache,
  hasSeries, newestDate, daysSince, actualsForDisplay, mergeActuals,
  entriesToDates, normalsFromData, isSamePlace, coordSuffix, eviProgressRecorder,
} from './data/locationCache.js';
import { applySavedPrefs, restoreOrder, syncDisplayToggles, setLastLocation } from './data/prefs.js';

// ─── Draw ────────────────────────────────────────────────────────────────────
function draw() {
  const { W, H } = canvas;
  paintPaper(W, H);
  paintWheel();
}

// ─── Location loading ────────────────────────────────────────────────────────
// Everything the app downloads is recorded on the Mac mini (see
// src/data/locationCache.js). Loading a location therefore means: paint what has
// already been recorded, fetch only what is genuinely missing, and record each
// piece the moment it lands — so a visit abandoned partway through leaves the
// next one less to do rather than nothing.

// The 365-point normals a single ERA5 call yields. `windDir` rides along but is
// not part of the presence test (it is null wherever the wind was calm).
const CLIMATE_NORMALS = ['temp', 'rain', 'daylight', 'wind', 'snow', 'cloud'];
// The daily observation series its recent-observations sibling yields.
const WEATHER_ACTUALS = ['temp', 'rain', 'wind', 'snow', 'cloud'];

// MODIS publishes a composite every 16 days, so there is nothing new to ask for
// until the stored one is that old.
const EVI_COMPOSITE_DAYS = 16;

/** Oldest of the newest stored dates across a group of series; null if any is absent. */
function actualsSince(store, ids) {
  let oldest = null;
  for (const id of ids) {
    const d = newestDate(store[id]);
    if (!d) return null;
    if (!oldest || d < oldest) oldest = d;
  }
  return oldest;
}

/**
 * Load `name` into the wheel, using the server's record for whatever it already
 * holds. Resolves once every stage has settled.
 *
 * @param {boolean} opts.skipNormals preset locations ship their normals in the
 *   bundle, so only their actuals come from (and go to) the cache.
 */
async function loadLocation({ key, name, lat, lon, skipNormals = false }) {
  // Anything that lands after the user has moved on belongs to a stale load.
  const stale = () => currentData.name !== name;

  let cached = await loadLocationCache(key);
  // If the key already belongs to a different place, hand this one its own key
  // rather than let the two overwrite each other on every visit.
  if (cached && !isSamePlace(cached, lat, lon)) {
    console.warn(`Location cache: "${key}" holds ${cached.name} (${cached.lat}, ${cached.lon}) — filing ${name} separately`);
    key = `${key}-${coordSuffix(lat, lon)}`;
    cached = await loadLocationCache(key);
    if (cached && !isSamePlace(cached, lat, lon)) cached = null;
  }
  if (stale()) return;

  // ── Paint what is already recorded ────────────────────────────────────────
  if (!skipNormals && cached?.normals && Object.keys(cached.normals).length) {
    mergeCurrentData(cached.normals);
    refreshSourceBadges();
  }

  // Actuals are held date-keyed so repeat visits accumulate instead of
  // overwriting; the wheel draws the trailing year of whatever the store holds.
  const store = { ...(cached?.actuals ?? {}) };
  setTodayDOY(calendarDOY(todayDate()));
  const paintActuals = () => { setActuals(actualsForDisplay(store)); draw(); };
  paintActuals();

  const record = patch => saveLocationCache(key, { name, lat, lon, ...patch });

  const needClimate    = !skipNormals && !CLIMATE_NORMALS.every(k => hasSeries(currentData[k]));
  const needEvi        = !skipNormals && !hasSeries(currentData.evi);
  const needPm25       = !skipNormals && !hasSeries(currentData.pm25);
  const needVisibility = !skipNormals && !hasSeries(currentData.visibility);
  const needDewpoint   = !skipNormals && !hasSeries(currentData.dewpoint);

  if (needEvi || needPm25 || needVisibility || needDewpoint) {
    mergeCurrentData({
      meta: {
        ...currentData.meta,
        ...(needEvi        ? { evi:        { sourceInterval: 'pending', source: 'fetching…' } } : {}),
        ...(needPm25       ? { pm25:       { sourceInterval: 'hourly',  source: 'fetching…' } } : {}),
        ...(needVisibility ? { visibility: { sourceInterval: 'hourly',  source: 'fetching…' } } : {}),
        ...(needDewpoint   ? { dewpoint:   { sourceInterval: 'hourly',  source: 'fetching…' } } : {}),
      },
    });
    refreshSourceBadges();
    draw();
  }

  // ── Climate normals (ERA5 1991–2020) — a fixed window, so fetched at most once
  if (needClimate) {
    setStatus('loading', `${name} — fetching climate normals…`);
    const climate = aggregateClimate(await fetchClimateAPI(lat, lon), lat);
    if (stale()) return;
    mergeCurrentData({
      temp: climate.tempF, rain: climate.rainIn, daylight: climate.daylight,
      wind: climate.windMph, windDir: climate.windDir,
      snow: climate.snowIn, cloud: climate.cloudMean,
      resolution: climate.resolution,
      meta: {
        ...currentData.meta,
        temp:     { sourceInterval: 'daily',      source: 'ERA5 1991–2020' },
        rain:     { sourceInterval: 'daily',      source: 'ERA5 1991–2020' },
        daylight: { sourceInterval: 'calculated', source: `astronomical, lat ${lat.toFixed(1)}°` },
        wind:     { sourceInterval: 'daily',      source: 'ERA5 1991–2020' },
        snow:     { sourceInterval: 'daily',      source: 'ERA5 1991–2020' },
        cloud:    { sourceInterval: 'daily',      source: 'ERA5 1991–2020' },
      },
    });
    refreshSourceBadges();
    draw();
    record({ normals: normalsFromData(currentData, [...CLIMATE_NORMALS, 'windDir', 'resolution']) });
  }

  // ── Recent weather actuals — only the days past what is already stored ────
  setStatus('loading', `${name} — fetching recent observations…`);
  const weatherActuals = fetchActuals(lat, lon, actualsSince(store, WEATHER_ACTUALS))
    .then(w => {
      if (stale()) return;
      const patch = {};
      WEATHER_ACTUALS.forEach(id => {
        if (mergeActuals(store, id, w[id])) patch[id] = entriesToDates(w[id]);
      });
      paintActuals();
      if (Object.keys(patch).length) record({ actuals: patch });
    })
    .catch(() => {});

  // ── EVI normals (MODIS 2013–2022) — the slow one; draw as soon as it lands ─
  if (needEvi) {
    setStatus('loading', `${name} — fetching MODIS vegetation history (slowest step)…`);
    setEviProgress(true, 0, 'Fetching MODIS satellite data…');
    let evi = null, sampLat = lat, sampLon = lon, sampMapUrl = null, peakKey = null, troughKey = null;
    let complete = false;
    // Resume rather than restart: this fetch is ~30 MODIS calls, and a visit
    // closed partway through has already banked the batches it finished.
    const progress = eviProgressRecorder(record);
    try {
      ({ evi, sampLat, sampLon, sampMapUrl, peakKey, troughKey, complete } =
        await fetchModisEVI(lat, lon, pct => setEviProgress(true, pct, `MODIS EVI: ${pct}%…`), {
          have:     cached?.baseline?.evi,
          doneKeys: cached?.baseline?.eviDoneKeys ?? [],
          // The pixel a previous visit picked. Reusing it skips the search and
          // keeps every stored composite comparable with the new ones.
          sample: {
            lat: cached?.normals?.eviSampLat, lon: cached?.normals?.eviSampLon,
            peakKey: cached?.normals?.eviPeakKey, troughKey: cached?.normals?.eviTroughKey,
          },
          // Record the chosen pixel up front, so an interrupted visit doesn't
          // leave the next one with composites it can't attribute to a pixel.
          onSample: s => record({
            normals: {
              eviSampLat: s.sampLat, eviSampLon: s.sampLon,
              ...(s.peakKey   ? { eviPeakKey:   s.peakKey }   : {}),
              ...(s.troughKey ? { eviTroughKey: s.troughKey } : {}),
            },
          }),
          onBatch: progress.onBatch,
        }));
    } catch {
      evi = eviProxyFallback(currentData.temp, currentData.rain);
    }
    progress.flush();
    setEviProgress(false);
    if (stale()) return;
    const real = !!sampMapUrl; // only a genuine MODIS result carries a sample point
    mergeCurrentData({
      evi,
      eviSampLat: sampLat, eviSampLon: sampLon, eviSampMapUrl: sampMapUrl,
      eviPeakKey: peakKey, eviTroughKey: troughKey,
      eviSource: real ? 'MODIS EVI 2013–2022' : 'proxy',
      meta: {
        ...currentData.meta,
        evi: real
          ? { sourceInterval: '16-day', source: 'MODIS MOD13Q1 EVI 2013–2022' }
          : { sourceInterval: 'proxy',  source: 'ERA5-derived proxy' },
      },
    });
    refreshSourceBadges();
    draw();
    // Two things are deliberately not recorded as a normal:
    //   · the proxy — a stand-in for a failed fetch, not data. Leaving it out is
    //     what lets the next visit try MODIS again.
    //   · a curve built from an incomplete baseline — the raw composites are
    //     already banked, so the next visit fetches only the missing batches and
    //     stores the finished curve then. Storing it now would freeze a partial
    //     year in place, since nothing refetches a normal once it exists.
    if (real && complete) {
      record({ normals: normalsFromData(currentData, ['evi', 'eviSampLat', 'eviSampLon', 'eviSampMapUrl', 'eviPeakKey', 'eviTroughKey', 'eviSource']) });
    }
  }

  // ── PM2.5 normals (CAMS 2014–2023) ────────────────────────────────────────
  if (needPm25) {
    setStatus('loading', `${name} — fetching PM2.5 air quality normals…`);
    let pm25 = null;
    try { pm25 = await fetchPm25(lat, lon); } catch { /* optional */ }
    // A location the upstream has no data for comes back as a series of nulls
    // rather than an error; treat that as unavailable instead of an empty ring.
    if (!hasSeries(pm25)) pm25 = null;
    if (stale()) return;
    mergeCurrentData({
      pm25,
      meta: { ...currentData.meta, pm25: { sourceInterval: 'hourly', source: pm25 ? 'CAMS 2014–2023' : 'unavailable' } },
    });
    refreshSourceBadges();
    draw();
    if (pm25) record({ normals: normalsFromData(currentData, ['pm25']) });
  }

  // Phenology band — non-blocking; biome is informed by EVI, so start it once
  // that has landed. Has its own server-side cache. Fails silently.
  loadPhenology(currentData);

  // ── Visibility normals (ERA5 2010–2020) ───────────────────────────────────
  if (needVisibility) {
    setStatus('loading', `${name} — fetching visibility normals…`);
    let visibility = null;
    try { visibility = await fetchVisibility(lat, lon); } catch { /* optional */ }
    if (!hasSeries(visibility)) visibility = null;
    if (stale()) return;
    mergeCurrentData({
      visibility,
      meta: { ...currentData.meta, visibility: { sourceInterval: 'hourly', source: visibility ? 'ERA5 2010–2020' : 'unavailable' } },
    });
    refreshSourceBadges();
    draw();
    if (visibility) record({ normals: normalsFromData(currentData, ['visibility']) });
  }

  // ── Dew point normals (ERA5 2010–2020) ────────────────────────────────────
  // The mugginess axis, and one of the axes the seasons band can be derived
  // from — a place whose year turns on humidity rather than temperature has
  // nothing to say for itself without this.
  if (needDewpoint) {
    setStatus('loading', `${name} — fetching humidity normals…`);
    let dewpoint = null;
    try { dewpoint = await fetchDewpoint(lat, lon); } catch { /* optional */ }
    if (!hasSeries(dewpoint)) dewpoint = null;
    if (stale()) return;
    mergeCurrentData({
      dewpoint,
      meta: { ...currentData.meta, dewpoint: { sourceInterval: 'hourly', source: dewpoint ? 'ERA5 2010–2020' : 'unavailable' } },
    });
    refreshSourceBadges();
    draw();
    if (dewpoint) record({ normals: normalsFromData(currentData, ['dewpoint']) });
  }

  await weatherActuals;
  if (stale()) return;
  setStatus('ok', `${name} — loaded.`);

  // ── The remaining actuals series, each topped up from its own newest date ──
  const eviSince = newestDate(store.evi);
  if (daysSince(eviSince) >= EVI_COMPOSITE_DAYS) {
    try {
      const recent = await fetchRecentEVI(
        currentData.eviSampLat ?? lat,
        currentData.eviSampLon ?? lon,
        eviSince,
      );
      if (!stale() && mergeActuals(store, 'evi', recent)) {
        paintActuals();
        record({ actuals: { evi: entriesToDates(recent) } });
      }
    } catch { /* EVI actuals optional */ }
  }

  for (const [id, fetchFn] of [['pm25', fetchActualsPm25], ['visibility', fetchActualsVisibility], ['dewpoint', fetchActualsDewpoint]]) {
    try {
      const recent = await fetchFn(lat, lon, newestDate(store[id]));
      if (!stale() && mergeActuals(store, id, recent)) {
        paintActuals();
        record({ actuals: { [id]: entriesToDates(recent) } });
      }
    } catch { /* optional */ }
  }

  if (!stale()) setStatus('ok', `${name} — all data loaded.`);
}

// ─── Live fetch ──────────────────────────────────────────────────────────────
/**
 * Show an already-resolved place: paint it at once, load its data, and record it
 * as the location to reopen on the next visit. Coordinates are remembered
 * alongside the name, so restoring one skips the geocoder entirely.
 *
 * @param {boolean} opts.remember false while restoring a shared `?s=` link,
 *   whose city belongs to whoever built the link, not to this browser.
 */
async function showLocation({ name, lat, lon, found = false, remember = true }) {
  setActuals(null); setTodayDOY(null);
  setPhenologyEvents([]);
  setEviProgress(false);

  // Draw immediately with just location so decorations/labels appear right away
  setCurrentData({ name, lat, lon });
  setActivePreset('');
  refreshPresets();
  refreshSourceBadges();
  draw();

  if (remember) setLastLocation({ name, lat, lon });
  setStatus('loading', `${found ? `Found ${name}` : name} — checking saved data…`);
  await loadLocation({ key: locationKey({ name, lat, lon }), name, lat, lon });
}

async function fetchCity({ remember = true } = {}) {
  const q = document.getElementById('cityInput').value.trim();
  if (!q) return;
  setStatus('loading', 'Geocoding…');
  setLoading(true);

  try {
    const geo = await geocode(q);
    await showLocation({
      name: geo.name.split(',').slice(0, 2).join(',').trim(),
      lat: geo.lat, lon: geo.lon, found: true, remember,
    });
  } catch (e) {
    setStatus('error', e.message);
    setEviProgress(false);
  } finally {
    setLoading(false);
  }
}

// Fetch the phenology band for `data` (non-blocking). Tagged with the location
// name so a stale response from a previous location is ignored when the user
// switches quickly. Fails silently — the band just stays empty.
function loadPhenology(data, opts = {}) {
  const forName = data.name;
  setPhenologyEvents([]);
  draw();
  fetchPhenology(data, {
    ...opts,
    // Render each animal/plant category the moment it streams in (ignoring a
    // stale response if the user has since switched locations).
    onCategory: (category, events) => {
      if (currentData.name === forName) { setPhenologyCategory(category, events); draw(); }
    },
  }).catch(() => {});
}

// ─── Presets ─────────────────────────────────────────────────────────────────
function loadPreset(p) {
  setCurrentData(p.data);
  setActuals(null); setTodayDOY(null);
  setPhenologyEvents([]);
  document.getElementById('cityInput').value = p.city;
  setActivePreset(p.label);
  setLastLocation({ preset: p.label });
  refreshPresets(); refreshSourceBadges(); draw();
  setStatus('ok', `Loaded built-in data for ${p.data.name} — fetching actuals overlay…`);
  // Normals ship in the bundle; the actuals overlay and the phenology band come
  // from the location cache, topped up from the upstream APIs.
  loadLocation({ key: locationKey(p.data), name: p.data.name, lat: p.data.lat, lon: p.data.lon, skipNormals: true })
    .catch(e => setStatus('error', `Preset loaded. Actuals failed: ${e.message}`));
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

  restoreOrder(p.order);

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
  syncDisplayToggles();

  // Rebuild ring controls with restored state (reads displayState.ringGap automatically)
  buildRingControls();
  rebuildLegend();

  if (p.city) {
    document.getElementById('cityInput').value = p.city;
    // A link's city is not this browser's choice, so it is not recorded as the
    // one to reopen — the visitor's own saved default survives the visit.
    fetchCity({ remember: false });
  }

  return true;
}

// ─── Export ──────────────────────────────────────────────────────────────────
async function exportSVG() {
  setLoading(true);
  setStatus('loading', 'Embedding fonts…');
  try {
    const fontStyle = await buildEmbeddedFontStyle();
    const { W, H } = canvas;
    const svg = renderSVG(W, H, () => { paintPaper(W, H); paintWheel(); }, fontStyle);
    downloadFile(svg, `${fileStem(currentData.name)}.svg`, 'image/svg+xml');
    setStatus('ok', '');
  } catch (e) {
    setStatus('error', `SVG export failed: ${e.message}`);
  } finally {
    setLoading(false);
  }
}

/** The chosen poster stock, from the size selector next to the print button. */
function posterSize() {
  return document.getElementById('posterSize')?.value || DEFAULT_SIZE;
}

async function exportPoster() {
  setLoading(true);
  setStatus('loading', `Composing the ${POSTER_SIZES[posterSize()].label} sheet…`);
  try {
    await printPoster(posterSize());
    setStatus('ok', 'Poster opened in a new tab — choose “Save as PDF” in the print dialog.');
  } catch (e) {
    setStatus('error', e.message);
  } finally {
    setLoading(false);
  }
}

async function exportPosterSVG() {
  setLoading(true);
  setStatus('loading', 'Composing the poster…');
  try {
    await downloadPosterSVG(posterSize());
    setStatus('ok', 'Poster SVG downloaded — vector at full size, fonts embedded.');
  } catch (e) {
    setStatus('error', `Poster export failed: ${e.message}`);
  } finally {
    setLoading(false);
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────
function resizeCanvas() {
  const sz = Math.min(660, window.innerWidth * .92);

  // Render the backing store at a higher resolution than the CSS display size so
  // the wheel stays crisp on retina screens and when pinch-zoomed in mobile
  // Safari. The drawing code works in logical (CSS) units; setTransform(scale…)
  // maps those onto the denser pixel grid.
  //
  // Pinch-zoom magnifies the existing bitmap WITHOUT re-rendering the canvas, so
  // the only way to keep the zoomed-in wheel sharp is to oversample up front.
  // Oversample to ~3× the device resolution (crisp to roughly 3× pinch), but cap
  // the longest backing edge to stay under iOS Safari's ~16M-pixel canvas limit.
  const dpr     = window.devicePixelRatio || 1;
  const scale   = Math.max(dpr, Math.min(dpr * 3, 4096 / sz));
  canvas.el.width        = Math.round(sz * scale);
  canvas.el.height       = Math.round(sz * scale);
  canvas.el.style.width  = sz + 'px';
  canvas.el.style.height = sz + 'px';
  canvas.ctx.setTransform(scale, 0, 0, scale, 0, 0);

  canvas.scale = scale;
  canvas.W  = sz;
  canvas.H  = sz;
  canvas.CX = sz / 2;
  canvas.CY = sz / 2;

  resetWheelZoom();
}

// ─── Pinch-zoom on the wheel ──────────────────────────────────────────────────
// Lets the user pinch/pan *just* the canvas in place (the page itself never
// zooms). The high-resolution backing store from resizeCanvas() keeps the
// CSS-scaled wheel crisp. Coordinates are tracked in the untransformed
// .wheel-wrap box; the canvas carries the live transform.
const ZOOM_MAX = 4;
const zoom = { scale: 1, tx: 0, ty: 0 };
const zPointers = new Map();   // pointerId → {x, y} client coords
let zPinch = null;             // pinch anchor while two fingers are down
let zPanLast = null;           // last client point while one finger pans

function resetWheelZoom() {
  zoom.scale = 1; zoom.tx = 0; zoom.ty = 0;
  zPointers.clear(); zPinch = null; zPanLast = null;
  if (canvas.el) applyWheelZoom();
}

function applyWheelZoom() {
  const el = canvas.el;
  const w = el.clientWidth, h = el.clientHeight;
  // Keep the scaled canvas covering its box (no gaps at the edges).
  zoom.tx = Math.min(0, Math.max(-(zoom.scale - 1) * w, zoom.tx));
  zoom.ty = Math.min(0, Math.max(-(zoom.scale - 1) * h, zoom.ty));
  el.style.transform = `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`;
  // While zoomed we own all gestures; at rest, allow normal vertical page scroll.
  el.style.touchAction = zoom.scale > 1.001 ? 'none' : 'pan-y';
}

function setupWheelZoom() {
  const el = canvas.el;
  const wrapRect = () => el.parentElement.getBoundingClientRect();

  el.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    el.setPointerCapture(e.pointerId);
    zPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (zPointers.size === 2) {
      const [a, b] = [...zPointers.values()];
      const r = wrapRect();
      const fx = (a.x + b.x) / 2 - r.left, fy = (a.y + b.y) / 2 - r.top;
      zPinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        scale: zoom.scale,
        cx: (fx - zoom.tx) / zoom.scale,   // content point under the pinch midpoint
        cy: (fy - zoom.ty) / zoom.scale,
      };
      zPanLast = null;
    } else if (zPointers.size === 1) {
      zPanLast = { x: e.clientX, y: e.clientY };
    }
  });

  el.addEventListener('pointermove', e => {
    if (e.pointerType !== 'touch' || !zPointers.has(e.pointerId)) return;
    zPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (zPointers.size >= 2 && zPinch) {
      const [a, b] = [...zPointers.values()];
      const r = wrapRect();
      const fx = (a.x + b.x) / 2 - r.left, fy = (a.y + b.y) / 2 - r.top;
      const newScale = Math.max(1, Math.min(ZOOM_MAX,
        zPinch.scale * Math.hypot(a.x - b.x, a.y - b.y) / zPinch.dist));
      zoom.scale = newScale;
      zoom.tx = fx - zPinch.cx * newScale;   // pin the original point under the fingers
      zoom.ty = fy - zPinch.cy * newScale;
      applyWheelZoom();
      e.preventDefault();
    } else if (zPointers.size === 1 && zoom.scale > 1.001 && zPanLast) {
      zoom.tx += e.clientX - zPanLast.x;
      zoom.ty += e.clientY - zPanLast.y;
      zPanLast = { x: e.clientX, y: e.clientY };
      applyWheelZoom();
      e.preventDefault();
    }
  }, { passive: false });

  const onUp = e => {
    if (e.pointerType !== 'touch') return;
    zPointers.delete(e.pointerId);
    zPinch = null;
    // If one finger remains, hand off to panning from its current position.
    zPanLast = zPointers.size === 1 ? [...zPointers.values()][0] : null;
  };
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
}

function init() {
  canvas.el  = document.getElementById('wheel');
  canvas.ctx = canvas.el.getContext('2d');
  resizeCanvas();

  setDrawCallback(draw);

  // Layering is defaults → saved prefs → URL params. The saved ones have to land
  // before the panel is built, since the controls render from ringState /
  // displayState rather than reading them later.
  const savedLocation = applySavedPrefs();
  syncDisplayToggles();

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

  setupWheelZoom();

  // Wire up buttons/inputs that use onclick in HTML via module-scope exposure
  window.fetchCity     = fetchCity;
  window.loadPreset    = loadPreset;
  window.exportSVG     = exportSVG;
  window.exportPoster  = exportPoster;
  window.exportPosterSVG = exportPosterSVG;
  window.copyLink      = copyLink;
  window.toggleDisplay = toggleDisplay;
  window.refreshPhenology = () => loadPhenology(currentData, { force: true });

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

  // A shared link wins over anything saved locally — it should show what it
  // encodes, whatever this visitor happens to have stored.
  if (applyUrlParams()) return;

  // Otherwise reopen the location this browser last loaded.
  const savedPreset = savedLocation?.preset && PRESETS.find(p => p.label === savedLocation.preset);
  if (savedPreset) { loadPreset(savedPreset); return; }

  if (savedLocation?.name && savedLocation.lat != null && savedLocation.lon != null) {
    // Stored resolved, so this skips the geocoder — and the location cache
    // usually has everything, making it a near-instant repaint.
    document.getElementById('cityInput').value = savedLocation.name;
    setLoading(true);
    showLocation(savedLocation)
      .catch(e => { setStatus('error', e.message); setEviProgress(false); })
      .finally(() => setLoading(false));
    return;
  }

  // Nothing saved: the default preset's actuals overlay and phenology band (its
  // normals ship in the bundle).
  const p0 = PRESETS[0].data;
  setStatus('loading', 'Fetching actuals for past year…');
  loadLocation({ key: locationKey(p0), name: p0.name, lat: p0.lat, lon: p0.lon, skipNormals: true })
    .catch(e => setStatus('error', `Preset loaded. Actuals failed: ${e.message}`));
}

window.addEventListener('DOMContentLoaded', init);
