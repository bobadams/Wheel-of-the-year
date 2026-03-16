import { RING_DEFS } from '../data/ringDefs.js';
import { canvas, ringOrder, ringState, displayState, currentData, actuals } from '../state.js';
import { doy2angle, norm } from '../draw/canvas.js';
import { DIM, MON_S } from '../draw/decorations.js';

const ICONS = { temp: '🌡', rain: '🌧', daylight: '☀️', ndvi: '🌿', wind: '💨' };
const ACTUALS_RINGS = new Set(['temp', 'rain', 'ndvi']);

export function setupTooltip() {
  const tip = document.getElementById('tooltip');
  const { el } = canvas;

  el.addEventListener('mousemove', e => {
    const rect = el.getBoundingClientRect();
    const sx = canvas.W / rect.width, sy = canvas.H / rect.height;
    const mx = (e.clientX - rect.left) * sx, my = (e.clientY - rect.top) * sy;
    const dx = mx - canvas.CX, dy = my - canvas.CY;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r < canvas.W * .055 || r > canvas.W * .455) { tip.style.display = 'none'; return; }

    let frac = (Math.atan2(dy, dx) + Math.PI / 2) / (2 * Math.PI);
    if (frac < 0) frac += 1;
    const doy = Math.min(364, Math.floor(frac * 365));

    let acc = 0, m = 0;
    for (let i = 0; i < 12; i++) { if (acc + DIM[i] > doy) { m = i; break; } acc += DIM[i]; }

    tip.style.display = 'block';
    tip.style.left = (e.clientX + 14) + 'px';
    tip.style.top  = (e.clientY - 10) + 'px';

    const rows = ringOrder.filter(id => ringState[id].visible).map(id => {
      const r = RING_DEFS.find(r => r.id === id);
      const v = currentData[id][doy];
      const disp = id === 'ndvi' ? v.toFixed(3) : id === 'rain' ? v.toFixed(2) : Math.round(v * 10) / 10;
      let actual = '';
      if (actuals && displayState.actuals && ACTUALS_RINGS.has(id)) {
        const entries = actuals[id];
        if (entries?.length) {
          const entry = entries.reduce((b, x) => Math.abs(x.doy - doy) < Math.abs(b.doy - doy) ? x : b, entries[0]);
          if (Math.abs(entry.doy - doy) <= 8) {
            const ad   = id === 'ndvi' ? entry.value.toFixed(3) : id === 'rain' ? entry.value.toFixed(2) : Math.round(entry.value * 10) / 10;
            const diff = Math.round((entry.value - v) * 10) / 10;
            actual = ` <span style="opacity:.7;font-size:.85em">(actual: ${ad}, ${diff > 0 ? '+' : ''}${diff})</span>`;
          }
        }
      }
      const srcTag = currentData.meta?.[id]
        ? `<span style="opacity:.45;font-size:.75em;margin-left:.3em">${currentData.meta[id].sourceInterval}</span>`
        : '';
      return `<span style="color:${ringState[id].color}">${ICONS[id]}</span> ${disp} ${r.unit}${srcTag}${actual}`;
    }).join('<br>');

    tip.innerHTML = `<strong>${MON_S[m]} ${doy - acc + 1}</strong><br>${rows}`;
  });

  el.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}
