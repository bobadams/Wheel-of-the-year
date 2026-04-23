import { RING_DEFS } from '../data/ringDefs.js';
import { ringState, displayState } from '../state.js';

export function rebuildLegend() {
  const el = document.getElementById('legendEl');
  el.innerHTML = '';
  RING_DEFS.forEach(r => {
    if (!ringState[r.id].visible) return;
    const d = document.createElement('div');
    d.className = 'legend-item';
    d.innerHTML = `<div class="legend-swatch" style="background:${ringState[r.id].color}"></div> ${r.label} (${r.unit})`;
    el.appendChild(d);
  });
  if (displayState.moon) {
    const d = document.createElement('div');
    d.className = 'legend-item';
    d.innerHTML = `<div style="width:8px;height:8px;border-radius:50%;background:#8e7cc3;opacity:.85;flex-shrink:0"></div> Moon phases`;
    el.appendChild(d);
  }
  if (displayState.actuals) {
    const actualsEntry = document.createElement('div');
    actualsEntry.className = 'legend-item';
    actualsEntry.innerHTML = `<div style="width:16px;height:0;border-top:1.5px dashed #888;flex-shrink:0;margin:4px 0"></div> <span style="font-style:italic">actuals (past 6 months)</span>`;
    el.appendChild(actualsEntry);
  }
}
