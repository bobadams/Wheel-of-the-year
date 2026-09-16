import { RING_DEFS } from '../data/ringDefs.js';
import { canvas, ringOrder, ringState, displayState, currentData, actuals, seasons } from '../state.js';
import { seasonAt, seasonRangeLabel } from '../data/seasons.js';
import { angle2doy } from '../draw/canvas.js';
import { doyLabel } from '../data/calendar.js';
import { R } from '../draw/theme.js';

const ICONS = { temp: '🌡', rain: '🌧', daylight: '☀️', evi: '🌿', wind: '💨', dewpoint: '💧', seasons: '🍂' };
const ACTUALS_RINGS = new Set(['temp', 'rain', 'evi']);

export function setupTooltip() {
  const tip = document.getElementById('tooltip');
  const { el } = canvas;

  el.addEventListener('mousemove', e => {
    const rect = el.getBoundingClientRect();
    const sx = canvas.W / rect.width, sy = canvas.H / rect.height;
    const mx = (e.clientX - rect.left) * sx, my = (e.clientY - rect.top) * sy;
    const dx = mx - canvas.CX, dy = my - canvas.CY;
    const r = Math.sqrt(dx * dx + dy * dy);
    // Only the data rings carry per-day values worth reporting.
    if (r < canvas.W * R.ringStart || r > canvas.W * R.ringEnd) { tip.style.display = 'none'; return; }

    // The day whose arc is under the pointer — the same mapping the rings are
    // drawn with, so the date read out is the day painted beneath it.
    const doy = Math.min(364, Math.floor(angle2doy(Math.atan2(dy, dx))));

    tip.style.display = 'block';
    tip.style.left = (e.clientX + 14) + 'px';
    tip.style.top  = (e.clientY - 10) + 'px';

    const rows = ringOrder.filter(id => ringState[id].visible).map(id => {
      const r = RING_DEFS.find(r => r.id === id);
      // The seasons band reports which season this day falls in, not a value.
      if (r.categorical) {
        const sn = seasonAt(seasons.seasons, doy);
        return sn
          ? `<span style="color:${sn.color}">${ICONS.seasons}</span> ${sn.name}`
            + `<span style="opacity:.45;font-size:.75em;margin-left:.3em">${seasonRangeLabel(sn)}</span>`
          : null;
      }
      // A ring can be switched on before (or without) its series ever arriving —
      // an optional normal that failed, or a preset that never carried it.
      const v = currentData[id]?.[doy];
      if (!Number.isFinite(v)) {
        return `<span style="color:${ringState[id].color}">${ICONS[id] ?? '·'}</span> <span style="opacity:.5">no data</span>`;
      }
      const disp = id === 'evi' ? v.toFixed(3) : id === 'rain' ? v.toFixed(2) : Math.round(v * 10) / 10;
      let actual = '';
      if (actuals && displayState.actuals && ACTUALS_RINGS.has(id)) {
        const entries = actuals[id];
        if (entries?.length) {
          // Distance around the wheel, so an observation just before the top
          // of the wheel is found from just after it.
          const gap = x => { const d = Math.abs(x.doy - doy); return Math.min(d, 365 - d); };
          const entry = entries.reduce((b, x) => gap(x) < gap(b) ? x : b, entries[0]);
          if (gap(entry) <= 8) {
            const ad   = id === 'evi' ? entry.value.toFixed(3) : id === 'rain' ? entry.value.toFixed(2) : Math.round(entry.value * 10) / 10;
            const diff = Math.round((entry.value - v) * 10) / 10;
            actual = ` <span style="opacity:.7;font-size:.85em">(actual: ${ad}, ${diff > 0 ? '+' : ''}${diff})</span>`;
          }
        }
      }
      const srcTag = currentData.meta?.[id]
        ? `<span style="opacity:.45;font-size:.75em;margin-left:.3em">${currentData.meta[id].sourceInterval}</span>`
        : '';
      return `<span style="color:${ringState[id].color}">${ICONS[id] ?? '·'}</span> ${disp} ${r.unit}${srcTag}${actual}`;
    }).filter(Boolean).join('<br>');

    tip.innerHTML = `<strong>${doyLabel(doy)}</strong><br>${rows}`;
  });

  el.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}
