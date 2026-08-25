import { RING_DEFS } from '../data/ringDefs.js';
import { RING_LABELS } from '../data/ringDefs.js';
import { ringState, displayState, currentData } from '../state.js';
import { computeNormBounds } from '../draw/normalize.js';
import { INK } from '../draw/theme.js';

/**
 * On-screen key. It carries the same information as the poster's printed key —
 * ring, unit, and the scale actually in force — because a band's width means
 * nothing without the range it is normalized against.
 */
export function rebuildLegend() {
  const el = document.getElementById('legendEl');
  el.innerHTML = '';
  const bounds = computeNormBounds(currentData);

  RING_DEFS.forEach(r => {
    if (!ringState[r.id].visible) return;
    const color = ringState[r.id].color;
    const b = bounds[r.id] ?? { lo: r.normLo, hi: r.normHi };
    const fmt = RING_LABELS[r.id]?.fmt ?? (v => `${v}`);
    const d = document.createElement('div');
    d.className = 'legend-item';
    d.title = currentData.meta?.[r.id]?.source ?? r.source;
    d.innerHTML = `<div class="legend-swatch" style="background:${color}"></div>`
      + `${r.label} <span class="legend-range">${fmt(b.lo)} – ${fmt(b.hi)}</span>`;
    el.appendChild(d);
  });

  const mark = (html, text) => {
    const d = document.createElement('div');
    d.className = 'legend-item';
    d.innerHTML = `${html} <span style="font-style:italic">${text}</span>`;
    el.appendChild(d);
  };

  if (displayState.moon) {
    mark(`<span style="display:inline-flex;gap:3px;align-items:center;flex-shrink:0">`
      + `<span style="width:8px;height:8px;border-radius:50%;background:${INK.moon};opacity:.85"></span>`
      + `<span style="width:8px;height:8px;border-radius:50%;border:1.2px solid ${INK.moon};opacity:.7"></span></span>`,
      'full / new moon');
  }
  if (displayState.actuals) {
    mark(`<span style="width:18px;border-top:1.5px dashed ${INK.light};flex-shrink:0"></span>`,
      'past 12 months observed');
  }
  mark(`<span style="width:18px;border-top:1.5px solid ${INK.today};flex-shrink:0"></span>`, 'today');
}
