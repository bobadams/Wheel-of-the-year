import { canvas, ringState, displayState, todayDOY } from '../state.js';
import { doy2angle, polar, norm, catmullRomPath } from './canvas.js';
import { INK, R, hairline } from './theme.js';

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
  ctx.strokeStyle = s.color; ctx.lineWidth = hairline(W, 0.0014, 0.9); ctx.globalAlpha = 0.95;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.setLineDash([W * 0.009, W * 0.007]);
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

  // A single radial line across the data and the calendar, ending in a filled
  // wedge on the moon lane. The date itself is set in the centre cartouche
  // rather than out here, where it used to sit in the holiday register and
  // collide with whatever feast happened to fall near today.
  const rIn  = W * R.holeOuter;
  const rOut = W * R.todayOuter;
  const [x1, y1] = polar(CX, CY, angle, rIn);
  const [x2, y2] = polar(CX, CY, angle, rOut);

  ctx.save();
  ctx.strokeStyle = INK.today;
  ctx.lineWidth = hairline(W, 0.0013, 0.7);
  ctx.globalAlpha = 0.75;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // A filled terminus on the calendar band, so the line reads as pointing at a
  // date rather than simply running out.
  ctx.beginPath();
  ctx.arc(x2, y2, W * 0.0048, 0, Math.PI * 2);
  ctx.fillStyle = INK.today; ctx.globalAlpha = 0.9; ctx.fill();
  ctx.restore();
}
