import { RING_DEFS } from '../data/ringDefs.js';
import { RING_LABELS } from '../data/ringDefs.js';
import { ringState, displayState, currentData, seasons } from '../state.js';
import { seasonRangeLabel } from '../data/seasons.js';
import { computeNormBounds } from '../draw/normalize.js';
import { hasSeries } from '../data/locationCache.js';
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
    // The seasons band has no scale to report; what a reader needs from it is
    // which seasons were found and when they run, so it expands to one row each.
    if (r.categorical) {
      if (!seasons.seasons.length) {
        const d = document.createElement('div');
        d.className = 'legend-item';
        d.innerHTML = `<div class="legend-swatch" style="background:${r.color};opacity:.35"></div>`
          + `${r.label} <span class="legend-range">${seasons.note ?? 'none found'}</span>`;
        el.appendChild(d);
        return;
      }
      seasons.seasons.forEach(sn => {
        const d = document.createElement('div');
        d.className = 'legend-item';
        d.title = `Derived from ${seasons.basis.join(', ')} — ${sn.days} days`;
        d.innerHTML = `<div class="legend-swatch" style="background:${sn.color}"></div>`
          + `${sn.name} <span class="legend-range">${seasonRangeLabel(sn)}</span>`;
        el.appendChild(d);
      });
      return;
    }
    const color = ringState[r.id].color;
    const d = document.createElement('div');
    d.className = 'legend-item';
    // A ring this location has no series for says so, rather than showing the
    // fallback scale and the source that would have supplied it — the same
    // claim the poster's key used to print under an empty lane.
    if (!hasSeries(currentData[r.id])) {
      d.title = 'No data for this location';
      d.innerHTML = `<div class="legend-swatch" style="background:${color};opacity:.35"></div>`
        + `${r.label} <span class="legend-range">no data</span>`;
      el.appendChild(d);
      return;
    }
    const b = bounds[r.id] ?? { lo: r.normLo, hi: r.normHi };
    const fmt = RING_LABELS[r.id]?.fmt ?? (v => `${v}`);
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
