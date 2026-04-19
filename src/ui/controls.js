import { RING_DEFS } from '../data/ringDefs.js';
import { ringOrder, ringState, displayState, currentData } from '../state.js';
import { rebuildLegend } from './legend.js';

// draw is passed in to avoid a circular dependency (main.js owns draw)
let _draw = null;
export function setDrawCallback(fn) { _draw = fn; }

const NORM_MODES = [
  { id: 'fixed',      label: 'Fixed',      title: 'Fixed global scale — compare across cities' },
  { id: 'minmax',     label: 'Min/Max',    title: "Stretched to each ring's actual min and max" },
  { id: 'percentile', label: 'Percentile', title: 'Stretched to 5th–95th percentile, clipping outliers' },
  { id: 'zscore',     label: 'Std Dev',    title: 'Scaled by standard deviation — zero stays at zero' },
];

export function buildRingControls() {
  const c = document.getElementById('ringControls');
  c.innerHTML = '';
  c.style.cssText = 'display:flex;flex-direction:column;gap:0';

  // Normalization mode selector
  const normDiv = document.createElement('div');
  normDiv.className = 'norm-section';
  normDiv.innerHTML = `
    <div class="panel-title" style="margin-bottom:.45rem">Normalization</div>
    <div class="norm-btn-group" id="normBtnGroup">
      ${NORM_MODES.map(m => `<button class="norm-btn${displayState.normMode === m.id ? ' active' : ''}" data-norm="${m.id}" title="${m.title}">${m.label}</button>`).join('')}
    </div>`;
  normDiv.addEventListener('click', e => {
    const btn = e.target.closest('[data-norm]');
    if (!btn) return;
    displayState.normMode = btn.dataset.norm;
    normDiv.querySelectorAll('.norm-btn').forEach(b => b.classList.toggle('active', b.dataset.norm === displayState.normMode));
    _draw?.();
  });
  c.appendChild(normDiv);

  const divider = document.createElement('hr');
  divider.className = 'divider';
  divider.style.margin = '.5rem 0 .4rem';
  c.appendChild(divider);

  ringOrder.forEach((id, idx) => {
    const r = RING_DEFS.find(r => r.id === id);
    const s = ringState[id];
    const div = document.createElement('div');
    div.className = 'ring-row'; div.dataset.id = id; div.draggable = true;
    div.innerHTML = `
      <div class="ring-header">
        <span class="drag-handle" title="Drag to reorder">⠿</span>
        <div class="ring-dot" id="dot-${id}" style="background:${s.color}"></div>
        <span class="ring-name">${r.label}<span class="ring-source" id="rs-${id}"></span></span>
        <div class="reorder-btns">
          <button class="reorder-btn" data-id="${id}" data-dir="-1" title="Move inward" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button class="reorder-btn" data-id="${id}" data-dir="1"  title="Move outward" ${idx === ringOrder.length - 1 ? 'disabled' : ''}>↓</button>
        </div>
        <button class="toggle ${s.visible ? 'on' : ''}" data-id="${id}" data-action="toggleRing"></button>
      </div>
      <div class="ring-subcontrols" style="${s.visible ? '' : 'opacity:.4;pointer-events:none'}">
        <div class="slider-row">
          <span class="slider-label">Thickness</span>
          <input type="range" min=".2" max="2.5" step=".05" value="${s.thickness}" data-id="${id}" data-prop="thickness">
          <span class="slider-val" id="sv-thick-${id}">${s.thickness.toFixed(1)}×</span>
        </div>
        <div class="slider-row">
          <span class="slider-label">Opacity</span>
          <input type="range" min=".1" max="1" step=".05" value="${s.opacity}" data-id="${id}" data-prop="opacity">
          <span class="slider-val" id="sv-opac-${id}">${Math.round(s.opacity * 100)}%</span>
        </div>
        <div class="color-row"><label>Color</label><input type="color" value="${s.color}" data-id="${id}" data-action="color"></div>
        <div class="misc-row" style="padding-left:1.3rem">
          <span class="misc-label">Smoothing</span>
          <button class="toggle ${s.smooth ? 'on' : ''}" data-id="${id}" data-action="toggleSmooth"></button>
        </div>
        ${id === 'ndvi' ? `<div class="misc-row" style="padding-left:1.3rem"><a id="ndvi-map-link" href="" target="_blank" style="display:none;font-size:.75rem">View sampled pixel on map</a></div>` : ''}
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
        buildRingControls(); _draw?.(); rebuildLegend();
      }
    });

    c.appendChild(div);
  });

  // Delegated event handling for all controls inside the panel
  c.addEventListener('click', handleControlClick);
  c.addEventListener('input', handleControlInput);

  refreshSourceBadges();
}

/** Update the per-ring source-interval badges from currentData.meta */
export function refreshSourceBadges() {
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

  const mapLink = document.getElementById('ndvi-map-link');
  if (mapLink) {
    if (currentData.ndviSampMapUrl) {
      mapLink.href = currentData.ndviSampMapUrl;
      mapLink.style.display = '';
    } else {
      mapLink.style.display = 'none';
    }
  }
}

function handleControlClick(e) {
  const reorderBtn = e.target.closest('.reorder-btn');
  if (reorderBtn) {
    moveRing(reorderBtn.dataset.id, Number(reorderBtn.dataset.dir)); return;
  }
  const toggle = e.target.closest('[data-action="toggleRing"]');
  if (toggle) { toggleRing(toggle); return; }
  const smoothBtn = e.target.closest('[data-action="toggleSmooth"]');
  if (smoothBtn) { toggleSmooth(smoothBtn); return; }
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
  buildRingControls(); _draw?.(); rebuildLegend();
}

function toggleRing(btn) {
  const id = btn.dataset.id;
  ringState[id].visible = !ringState[id].visible;
  btn.classList.toggle('on', ringState[id].visible);
  const sub = btn.closest('.ring-row').querySelector('.ring-subcontrols');
  if (sub) sub.style.cssText = ringState[id].visible ? '' : 'opacity:.4;pointer-events:none';
  _draw?.(); rebuildLegend();
}

function updateRing(id, prop, val) {
  val = parseFloat(val); ringState[id][prop] = val;
  if (prop === 'thickness') document.getElementById(`sv-thick-${id}`).textContent = val.toFixed(1) + '×';
  if (prop === 'opacity')   document.getElementById(`sv-opac-${id}`).textContent  = Math.round(val * 100) + '%';
  _draw?.();
}

function toggleSmooth(btn) {
  const id = btn.dataset.id;
  ringState[id].smooth = !ringState[id].smooth;
  btn.classList.toggle('on', ringState[id].smooth);
  _draw?.();
}

function updateRingColor(id, val) {
  ringState[id].color = val;
  document.getElementById(`dot-${id}`).style.background = val;
  _draw?.(); rebuildLegend();
}

export function toggleDisplay(btn, key) {
  displayState[key] = !displayState[key];
  btn.classList.toggle('on', displayState[key]);
  _draw?.();
}
