import { RING_DEFS } from '../data/ringDefs.js';
import { canvas, ringState, actuals, todayDOY } from '../state.js';
import { doy2angle, polar, norm } from './canvas.js';

export function smoothEntries(entries, winDays = 7) {
  return entries.map(e => {
    let sum = 0, cnt = 0;
    for (const other of entries) {
      const d = Math.min(Math.abs(other.doy - e.doy), 365 - Math.abs(other.doy - e.doy));
      if (d <= winDays) { sum += other.value; cnt++; }
    }
    return { doy: e.doy, value: cnt > 0 ? sum / cnt : e.value };
  });
}

export function drawActualsLine(ringDef, entries, layout, normBounds) {
  if (!entries?.length || !layout) return;
  const s = ringState[ringDef.id];
  if (!s.visible) return;
  const { ctx, W, CX, CY } = canvas;
  const innerR = layout.innerFrac * W;
  const maxThick = layout.thickFrac * W;
  const smoothed = smoothEntries(entries, 5);
  const { lo, hi } = normBounds?.[ringDef.id] ?? { lo: ringDef.normLo, hi: ringDef.normHi };

  ctx.save();
  ctx.strokeStyle = s.color; ctx.lineWidth = W * 0.007; ctx.globalAlpha = 1.0;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
  smoothed.forEach((e, i) => {
    const r = innerR + norm(e.value, lo, hi) * maxThick;
    const [x, y] = polar(CX, CY, doy2angle(e.doy + 0.5), r);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  [smoothed[0], smoothed[smoothed.length - 1]].forEach(e => {
    const r = innerR + norm(e.value, lo, hi) * maxThick;
    const [x, y] = polar(CX, CY, doy2angle(e.doy + 0.5), r);
    ctx.beginPath(); ctx.arc(x, y, W * 0.005, 0, Math.PI * 2);
    ctx.fillStyle = s.color; ctx.globalAlpha = 1; ctx.fill();
  });
  ctx.restore();
}

export function drawTodayDot(layouts, normBounds) {
  if (todayDOY === null) return;
  const { ctx, W, CX, CY } = canvas;
  const angle = doy2angle(todayDOY + 0.5);

  let outerR = 0;
  ['temp', 'rain', 'evi'].forEach(id => {
    const r = RING_DEFS.find(r => r.id === id);
    if (!r || !ringState[id].visible || !layouts[id]) return;
    const entries = actuals?.[id];
    if (!entries?.length) return;
    const entry = entries.reduce((best, e) =>
      Math.abs(e.doy - todayDOY) < Math.abs(best.doy - todayDOY) ? e : best, entries[0]);
    const { lo, hi } = normBounds?.[id] ?? { lo: r.normLo, hi: r.normHi };
    const rr = layouts[id].innerFrac * W + norm(entry.value, lo, hi) * layouts[id].thickFrac * W;
    if (rr > outerR) outerR = rr;
  });
  if (outerR === 0) return;

  const dotR = outerR + W * 0.014;
  const [x, y] = polar(CX, CY, angle, dotR);
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, W * 0.011, 0, Math.PI * 2);
  ctx.fillStyle = '#faf7f2'; ctx.globalAlpha = 0.92; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, W * 0.007, 0, Math.PI * 2);
  ctx.fillStyle = '#2c2416'; ctx.globalAlpha = 1; ctx.fill();

  const [lx, ly] = polar(CX, CY, angle, dotR + W * 0.024);
  ctx.save();
  ctx.translate(lx, ly);
  let rot = angle + Math.PI / 2;
  const nr = ((rot % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (nr > Math.PI / 2 && nr < Math.PI * 3 / 2) rot += Math.PI;
  ctx.rotate(rot);
  ctx.font = `italic ${W * .016}px 'Crimson Pro',serif`;
  ctx.fillStyle = '#2c2416'; ctx.globalAlpha = 0.65;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('today', 0, 0);
  ctx.restore(); ctx.restore();
}
