import { RING_DEFS } from '../data/ringDefs.js';
import { ringOrder, ringState, displayState, currentData, seasons } from '../state.js';
import { seasonRangeLabel } from '../data/seasons.js';
import { savePrefs } from '../data/prefs.js';
import { rebuildLegend } from './legend.js';
import { showEviAnalysis } from './eviAnalysis.js';
import { showSeasonsChart } from './seasonsChart.js';

// draw is passed in to avoid a circular dependency (main.js owns draw)
let _draw = null;
export function setDrawCallback(fn) { _draw = fn; }

const NORM_MODES = [
  { id: 'fixed',      label: 'Fixed',      title: 'Fixed global scale — compare across cities' },
  { id: 'minmax',     label: 'Min/Max',    title: "Stretched to each ring's actual min and max" },
  { id: 'percentile', label: 'Percentile', title: 'Stretched to 5th–95th percentile, clipping outliers' },
];

/**
 * What the seasons band is showing, and what it was derived from.
 *
 * A season the user did not choose needs to account for itself, so the panel
 * lists the axes that passed the amplitude gate as well as the seasons found —
 * including the case where nothing passed, which is a real finding about the
 * place rather than a failed fetch.
 */
function seasonPanel() {
  const pass = seasons.axes.filter(a => a.passed).map(a => a.id);
  const fail = seasons.axes.filter(a => !a.passed).map(a => a.id);
  const rows = seasons.seasons.length
    ? seasons.seasons.map(sn => `
        <div class="misc-row" style="padding-left:1.3rem;gap:.4rem;align-items:center">
          <span class="ring-dot" style="background:${sn.color};width:.55rem;height:.55rem;flex:none"></span>
          <span class="misc-label" style="flex:1">${sn.name}</span>
          <span class="slider-val" style="white-space:nowrap">${seasonRangeLabel(sn)}</span>
        </div>`).join('')
    : `<div class="misc-row" style="padding-left:1.3rem"><span class="misc-label" style="font-style:italic">${seasons.note ?? 'No seasons derived.'}</span></div>`;
  return `${rows}
    <div class="misc-row" style="padding-left:1.3rem;display:block">
      <span class="misc-label" style="font-size:.7rem;opacity:.75">
        derived from ${pass.length ? pass.join(', ') : '—'}${fail.length ? ` · too flat here: ${fail.join(', ')}` : ''}
      </span>
    </div>
    <div class="misc-row" style="padding-left:1.3rem">
      <a href="#" data-action="showSeasons" style="font-size:.75rem">Show how these were found</a>
    </div>`;
}

export function buildRingControls() {
  const c = document.getElementById('ringControls');
  c.innerHTML = '';
  c.style.cssText = 'display:flex;flex-direction:column;gap:0';


  // Ring gap slider
  const gapDiv = document.createElement('div');
  gapDiv.className = 'norm-section';
  gapDiv.style.marginTop = '.5rem';
  gapDiv.innerHTML = `
    <div class="slider-row">
      <span class="panel-title" style="margin:0">Ring Gap</span>
      <input id="ringGapSlider" type="range" min="0" max="0.03" step="0.001" value="${displayState.ringGap}" style="flex:1;margin:0 .5rem">
      <span id="ringGapVal" style="min-width:2.5rem;text-align:right;font-size:.8rem">${Math.round(displayState.ringGap * 1000)}px</span>
    </div>`;
  gapDiv.querySelector('#ringGapSlider').addEventListener('input', e => {
    displayState.ringGap = parseFloat(e.target.value);
    gapDiv.querySelector('#ringGapVal').textContent = Math.round(displayState.ringGap * 1000) + 'px';
    _draw?.(); savePrefs();
  });
  c.appendChild(gapDiv);

  const divider = document.createElement('hr');
  divider.className = 'divider';
  divider.style.margin = '.5rem 0 .4rem';
  c.appendChild(divider);

  ringOrder.forEach((id, idx) => {
    const r = RING_DEFS.find(r => r.id === id);
    const s = ringState[id];
    const div = document.createElement('div');
    if (s.collapsed === undefined) s.collapsed = true; // default: collapsed
    div.className = `ring-row${s.collapsed ? '' : ' expanded'}`; div.dataset.id = id; div.draggable = true;
    div.innerHTML = `
      <div class="ring-header" data-action="toggleCollapse" data-id="${id}">
        <span class="ring-chevron">▶</span>
        <span class="drag-handle" title="Drag to reorder">⠿</span>
        <div class="ring-dot" id="dot-${id}" style="background:${s.color}"></div>
        <span class="ring-name">${r.label}<span class="ring-source" id="rs-${id}"></span></span>
        <button class="toggle ${s.visible ? 'on' : ''}" data-id="${id}" data-action="toggleRing" data-no-collapse></button>
      </div>
      <div class="ring-subcontrols${s.collapsed ? ' collapsed' : ''}" style="${s.visible ? '' : 'opacity:.4;pointer-events:none'}">
        <div class="slider-row">
          <span class="slider-label">Thickness</span>
          <input type="range" min=".2" max="2.5" step=".05" value="${s.thickness}" data-id="${id}" data-prop="thickness">
          <span class="slider-val" id="sv-thick-${id}">${s.thickness.toFixed(1)}×</span>
        </div>
        <div class="slider-row" style="display:none">
          <input type="range" min=".1" max="1" step=".05" value="${s.opacity}" data-id="${id}" data-prop="opacity">
          <span class="slider-val" id="sv-opac-${id}">${Math.round(s.opacity * 100)}%</span>
        </div>
        ${r.categorical ? `<div id="season-panel">${seasonPanel()}</div>` : `
        <div class="color-row"><label>Color</label><input type="color" value="${s.color}" data-id="${id}" data-action="color"></div>
        <div class="misc-row" style="padding-left:1.3rem">
          <span class="misc-label">Smoothing</span>
          <button class="toggle ${s.smooth ? 'on' : ''}" data-id="${id}" data-action="toggleSmooth"></button>
        </div>
        <div class="misc-row" style="padding-left:1.3rem;align-items:center;gap:.3rem">
          <span class="misc-label">Scale</span>
          <div class="norm-btn-group" style="flex:1">
            ${NORM_MODES.map(m => `<button class="norm-btn${s.normMode === m.id ? ' active' : ''}" data-id="${id}" data-norm="${m.id}" title="${m.title}">${m.label}</button>`).join('')}
          </div>
        </div>`}
        ${id === 'evi' ? `<div class="misc-row" style="padding-left:1.3rem"><a id="evi-map-link" href="" target="_blank" style="display:none;font-size:.75rem">View sampled pixel on map</a></div>` : ''}
        ${id === 'wind' ? `<div class="misc-row" style="padding-left:1.3rem"><span class="misc-label">Wind direction</span><button class="toggle ${displayState.windBarbs ? 'on' : ''}" data-action="toggleWindBarbs" title="Show wind direction markers at the base of the wind ring"></button></div>` : ''}
      </div>`;

    // Drag-to-reorder
    div.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', id); div.classList.add('dragging'); });
    div.addEventListener('dragend', () => div.classList.remove('dragging'));
    div.addEventListener('dragover', e => { e.preventDefault(); div.classList.add('drag-over'); });
    div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
    div.addEventListener('drop', e => {
      e.preventDefault(); div.classList.remove('drag-over');
      const fromId = e.dataTransfer.getData('text/plain');
      const fromIdx = ringOrder.indexOf(fromId), toIdx = ringOrder.indexOf(id);
      if (fromIdx !== toIdx) {
        ringOrder.splice(fromIdx, 1); ringOrder.splice(toIdx, 0, fromId);
        buildRingControls(); _draw?.(); rebuildLegend(); savePrefs();
      }
    });

    c.appendChild(div);
  });

  // Delegated event handling for all controls inside the panel
  c.addEventListener('click', handleControlClick);
  c.addEventListener('input', handleControlInput);

  refreshSourceBadges();
}

/**
 * Refresh everything in the panel that is derived from the data rather than
 * from the user's choices. Called after each stage of a load, which is what
 * keeps the seasons — recomputed every time a series lands — from going stale
 * in the panel and the key while the wheel itself has already redrawn.
 */
export function refreshSourceBadges() {
  const seasonEl = document.getElementById('season-panel');
  if (seasonEl) seasonEl.innerHTML = seasonPanel();
  rebuildLegend();

  const meta = currentData.meta;
  RING_DEFS.forEach(r => {
    const el = document.getElementById(`rs-${r.id}`);
    if (!el) return;
    if (meta?.[r.id]) {
      el.textContent = meta[r.id].sourceInterval;
      el.title = meta[r.id].source;
    } else {
      el.textContent = '';
      el.title = '';
    }
  });

  const mapLink = document.getElementById('evi-map-link');
  if (mapLink) {
    const sampLat = currentData.eviSampLat;
    const sampLon = currentData.eviSampLon;
    const hasPx = sampLat != null && sampLon != null;
    if (hasPx) {
      mapLink.textContent = `reference location: ${sampLat.toFixed(4)}, ${sampLon.toFixed(4)}`;
      mapLink.href = '#';
      mapLink.style.display = '';
      // Replace listener each time badges are refreshed (avoid duplicates)
      const fresh = mapLink.cloneNode(true);
      mapLink.parentNode.replaceChild(fresh, mapLink);
      fresh.addEventListener('click', e => { e.preventDefault(); showEviAnalysis(); });
    } else {
      mapLink.style.display = 'none';
    }
  }
}

function handleControlClick(e) {
  const seasonsLink = e.target.closest('[data-action="showSeasons"]');
  if (seasonsLink) { e.preventDefault(); showSeasonsChart(); return; }
  const reorderBtn = e.target.closest('.reorder-btn');
  if (reorderBtn) {
    moveRing(reorderBtn.dataset.id, Number(reorderBtn.dataset.dir)); return;
  }
  // Collapse toggle — fires on header click, but not on buttons/inputs inside it
  const header = e.target.closest('[data-action="toggleCollapse"]');
  if (header && !e.target.closest('[data-no-collapse]')) {
    const id = header.dataset.id;
    const row = header.closest('.ring-row');
    ringState[id].collapsed = !ringState[id].collapsed;
    row.classList.toggle('expanded', !ringState[id].collapsed);
    row.querySelector('.ring-subcontrols').classList.toggle('collapsed', ringState[id].collapsed);
    savePrefs();
    return;
  }
  const toggle = e.target.closest('[data-action="toggleRing"]');
  if (toggle) { toggleRing(toggle); return; }
  const smoothBtn = e.target.closest('[data-action="toggleSmooth"]');
  if (smoothBtn) { toggleSmooth(smoothBtn); return; }
  const windBarbsBtn = e.target.closest('[data-action="toggleWindBarbs"]');
  if (windBarbsBtn) { toggleDisplay(windBarbsBtn, 'windBarbs'); return; }
  const normBtn = e.target.closest('[data-norm][data-id]');
  if (normBtn) {
    const { id, norm } = normBtn.dataset;
    ringState[id].normMode = norm;
    normBtn.closest('.norm-btn-group').querySelectorAll('.norm-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.norm === norm));
    _draw?.(); savePrefs(); return;
  }
}

function handleControlInput(e) {
  const input = e.target;
  if (input.dataset.prop) {
    updateRing(input.dataset.id, input.dataset.prop, input.value); return;
  }
  if (input.dataset.action === 'color') {
    updateRingColor(input.dataset.id, input.value); return;
  }
}

function moveRing(id, dir) {
  const i = ringOrder.indexOf(id), j = i + dir;
  if (j < 0 || j >= ringOrder.length) return;
  [ringOrder[i], ringOrder[j]] = [ringOrder[j], ringOrder[i]];
  buildRingControls(); _draw?.(); rebuildLegend(); savePrefs();
}

function toggleRing(btn) {
  const id = btn.dataset.id;
  ringState[id].visible = !ringState[id].visible;
  btn.classList.toggle('on', ringState[id].visible);
  const sub = btn.closest('.ring-row').querySelector('.ring-subcontrols');
  if (sub) sub.style.cssText = ringState[id].visible ? '' : 'opacity:.4;pointer-events:none';
  _draw?.(); rebuildLegend(); savePrefs();
}

function updateRing(id, prop, val) {
  val = parseFloat(val); ringState[id][prop] = val;
  if (prop === 'thickness') document.getElementById(`sv-thick-${id}`).textContent = val.toFixed(1) + '×';
  if (prop === 'opacity')   document.getElementById(`sv-opac-${id}`).textContent  = Math.round(val * 100) + '%';
  _draw?.(); savePrefs();
}

function toggleSmooth(btn) {
  const id = btn.dataset.id;
  ringState[id].smooth = !ringState[id].smooth;
  btn.classList.toggle('on', ringState[id].smooth);
  _draw?.(); savePrefs();
}

function updateRingColor(id, val) {
  ringState[id].color = val;
  document.getElementById(`dot-${id}`).style.background = val;
  _draw?.(); rebuildLegend(); savePrefs();
}

export function toggleDisplay(btn, key) {
  displayState[key] = !displayState[key];
  btn.classList.toggle('on', displayState[key]);
  _draw?.(); savePrefs();
}
