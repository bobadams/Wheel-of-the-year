import { canvas, ringState, displayState, actuals, todayDOY } from '../state.js';
import { doy2angle, polar, norm, catmullRomPath } from './canvas.js';

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
  const { lo, hi } = normBounds?.[ringDef.id] ?? { lo: ringDef.normLo, hi: ringDef.normHi };

  // Deduplicate by DOY, keeping the most recent value (last in chronological order).
  // Entries spanning a full year have the same DOY twice (e.g. today a year apart).
  const dedupMap = new Map();
  entries.forEach(e => dedupMap.set(e.doy, e.value));
  const deduped = Array.from(dedupMap, ([doy, value]) => ({ doy, value }))
    .sort((a, b) => a.doy - b.doy);

  const smoothed = displayState.actualsSmooth ? smoothEntries(deduped, 5) : deduped;

  // Order so the arc runs from (todayDOY+1) → 364 → 0 → todayDOY, leaving a
  // gap at today's position rather than connecting today to last year's data.
  const ordered = todayDOY !== null
    ? [...smoothed.filter(e => e.doy > todayDOY), ...smoothed.filter(e => e.doy <= todayDOY)]
    : smoothed;

  const pts = ordered.map(e => {
    const r = innerR + norm(e.value, lo, hi) * maxThick;
    const [x, y] = polar(CX, CY, doy2angle(e.doy + 0.5), r);
    return { x, y };
  });

  ctx.save();
  ctx.strokeStyle = s.color; ctx.lineWidth = W * 0.001; ctx.globalAlpha = 1.0;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.setLineDash([W * 0.008, W * 0.008]);
  ctx.beginPath();
  if (pts.length < 50) {
    catmullRomPath(ctx, pts);
  } else {
    pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
  }
  ctx.stroke();
  ctx.restore();
}

export function drawTodayDot(layouts, normBounds) {
  if (todayDOY === null) return;
  const { ctx, W, CX, CY } = canvas;
  const angle = doy2angle(todayDOY + 0.5);

  // Hairline red line from center to just past the moon ring (W * 0.430)
  const lineEnd = W * 0.448;
  const [x2, y2] = polar(CX, CY, angle, lineEnd);
  ctx.save();
  ctx.strokeStyle = '#cc2200';
  ctx.lineWidth = 0.8;
  ctx.globalAlpha = 0.82;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(CX, CY);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // "today" label just past the line tip
  const labelR = lineEnd + W * 0.020;
  const [lx, ly] = polar(CX, CY, angle, labelR);
  ctx.save();
  ctx.translate(lx, ly);
  let rot = angle + Math.PI / 2;
  const nr = ((rot % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (nr > Math.PI / 2 && nr < Math.PI * 3 / 2) rot += Math.PI;
  ctx.rotate(rot);
  ctx.font = `italic ${W * 0.016}px 'Crimson Pro',serif`;
  ctx.fillStyle = '#cc2200';
  ctx.globalAlpha = 0.85;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('today', 0, 0);
  ctx.restore();
  ctx.restore();
}
