import { RING_DEFS, RING_LABELS } from '../data/ringDefs.js';
import { canvas, ringState, currentData, smoothedData } from '../state.js';
import { doy2angle, polar, norm, uprightTangent } from './canvas.js';
import { INK, R, hairline, haloText } from './theme.js';
import { doyLabel } from '../data/calendar.js';

/**
 * The extremes of each ring: where in the year it peaks and bottoms out.
 *
 * These are the wheel's only quantitative annotations, so each carries both the
 * value and the date it falls on — the date is what turns "hottest 79°F" from a
 * legend entry into a fact about the place.
 *
 * Placement happens in two passes. The first works out where each label wants
 * to sit; the second walks them out (or in) along their own radius until they
 * stop overlapping each other, because two rings whose peaks fall in the same
 * week would otherwise print one label on top of another.
 */
export function drawMinMaxMarkers(layouts, normBounds) {
  const { ctx, W, CX, CY } = canvas;
  const size    = W * .0145;
  const dotR    = W * .0042;
  const half    = size * 1.15;                    // half-height of the two-line block
  const ceiling = W * (R.seasonLabel - 0.010);    // the solstice labels own this lane

  // ── Pass 1: what each label wants ──────────────────────────────────────────
  const marks = [];
  RING_DEFS.forEach(r => {
    const s = ringState[r.id];
    if (!s.visible || !layouts[r.id]) return;
    const dispData = (s.smooth && smoothedData[r.id]) ? smoothedData[r.id] : currentData[r.id];
    const refData  = smoothedData[r.id] ?? currentData[r.id];
    if (!Array.isArray(refData)) return;
    const { innerFrac, thickFrac } = layouts[r.id];
    const innerR = innerFrac * W;
    const maxThick = thickFrac * W;
    const cfg = RING_LABELS[r.id];
    const { lo, hi } = normBounds?.[r.id] ?? { lo: r.normLo, hi: r.normHi };

    let maxD = 0, minD = 0;
    refData.forEach((v, i) => { if (v > refData[maxD]) maxD = i; if (v < refData[minD]) minD = i; });
    // Snap to the midpoint of any flat plateau so labels don't skew to its early
    // edge. The plateau is followed around the circle in both directions: DOY 0
    // is the winter solstice, so the shortest day's plateau straddles the two
    // ends of the array, and a forward-only scan put its label days late.
    const plateauMid = (first) => {
      const n = refData.length, v = refData[first];
      let back = 0, fwd = 0;
      while (back < n - 1 && refData[(first - back - 1 + n) % n] === v) back++;
      while (back + fwd < n - 1 && refData[(first + fwd + 1) % n] === v) fwd++;
      return (first + Math.floor((fwd - back) / 2) + n) % n;
    };
    maxD = plateauMid(maxD);
    minD = plateauMid(minD);

    [[maxD, 'max'], [minD, 'min']].forEach(([dayIdx, type]) => {
      const val   = dispData[dayIdx];
      const peakR = innerR + norm(val, lo, hi) * maxThick;
      const angle = doy2angle(dayIdx + 0.5);
      const value = `${type === 'max' ? cfg.maxWord : cfg.minWord} ${cfg.fmt(val)}`;
      const date  = doyLabel(dayIdx).toUpperCase();

      ctx.font = `italic ${size}px 'Crimson Pro',serif`;
      const w1 = ctx.measureText(value).width;
      ctx.font = `${size * 0.76}px Cinzel,serif`;
      const w2 = ctx.measureText(date).width;

      // Leaders normally point outward. A marker near the top of the outermost
      // ring turns its leader inward instead, rather than pushing a label into
      // the solstice/equinox lane; the halo keeps it readable over its own fill.
      const out = peakR + W * .017 + W * .010 + half <= ceiling ? 1 : -1;

      marks.push({
        color: s.color, angle, peakR, out, value, date,
        textW: Math.max(w1, w2),
        textR: peakR + out * (W * .017 + W * .010),
      });
    });
  });

  // ── Pass 2: separate labels that would print on top of each other ─────────
  const clash = (a, b) => {
    let d = Math.abs(a.angle - b.angle);
    if (d > Math.PI) d = Math.PI * 2 - d;
    return d * Math.min(a.textR, b.textR) < (a.textW + b.textW) / 2 + W * 0.004
        && Math.abs(a.textR - b.textR) < half * 2;
  };
  const settled = [];
  // Innermost first, so a shifted label is always pushed into space that has
  // not been claimed yet.
  marks.sort((a, b) => a.peakR - b.peakR);
  for (const m of marks) {
    for (let n = 0; n < 4 && settled.some(p => clash(m, p)); n++) {
      m.textR += m.out * half * 2.1;
    }
    settled.push(m);
  }

  // ── Draw ──────────────────────────────────────────────────────────────────
  for (const m of settled) {
    const lineStart = m.peakR + m.out * dotR;
    const [dotX, dotY] = polar(CX, CY, m.angle, m.peakR);
    const [lx1, ly1]   = polar(CX, CY, m.angle, lineStart);
    const [lx2, ly2]   = polar(CX, CY, m.angle, m.textR - m.out * half * 0.95);
    const [tx, ty]     = polar(CX, CY, m.angle, m.textR);

    ctx.save();

    // Marker centred on the ring's edge: paper-filled so the profile line reads
    // as passing behind it rather than through it.
    ctx.beginPath(); ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
    ctx.fillStyle = INK.paper; ctx.globalAlpha = 1.0; ctx.fill();
    ctx.strokeStyle = m.color; ctx.lineWidth = hairline(W, 0.0022, 1.2); ctx.stroke();

    // Leader from the marker to the label.
    ctx.beginPath(); ctx.moveTo(lx1, ly1); ctx.lineTo(lx2, ly2);
    ctx.strokeStyle = m.color; ctx.lineWidth = hairline(W, 0.0013, 0.7); ctx.globalAlpha = 0.6; ctx.stroke();

    // Label along the tangent, flipped on the lower half so it stays upright.
    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(uprightTangent(m.angle));
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `italic ${size}px 'Crimson Pro',serif`;
    ctx.fillStyle = m.color; ctx.globalAlpha = 0.92;
    haloText(ctx, m.value, 0, -size * 0.44, size * 0.55);
    ctx.font = `${size * 0.76}px Cinzel,serif`;
    ctx.fillStyle = INK.light; ctx.globalAlpha = 0.75;
    haloText(ctx, m.date, 0, size * 0.56, size * 0.55);
    ctx.restore(); ctx.restore();
  }
}
