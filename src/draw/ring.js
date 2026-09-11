import { canvas } from '../state.js';
import { doy2angle, norm } from './canvas.js';
import { hairline } from './theme.js';

/**
 * Draw one ring: a year of daily arcs growing outward from a common baseline.
 *
 * Three strokes carry the shape, in ascending weight:
 *   · the baseline circle at innerR — the zero line the eye measures against,
 *     and what keeps two adjacent rings from reading as one blurred band;
 *   · the day-by-day fill;
 *   · the profile along the outer edge, which is what actually renders the
 *     year's shape and so takes the full-strength color.
 */
export function drawRing(data, lo, hi, innerR, maxThick, color, alpha, blankZero = false, rawData = null) {
  if (!data) return;
  const { ctx, W, CX, CY } = canvas;
  const raw = rawData ?? data;
  ctx.save();

  // Baseline — the ring's floor, drawn first so the fill sits on top of it.
  ctx.beginPath();
  ctx.arc(CX, CY, innerR, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth   = hairline(W, 0.0008, 0.4);
  ctx.globalAlpha = alpha * 0.35;
  ctx.stroke();

  // Body of the ring.
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha * 0.32;
  for (let d = 0; d < 365; d++) {
    if (blankZero && raw[d] <= 0) continue;
    const a1 = doy2angle(d), a2 = doy2angle(d + 1);
    const outerR = innerR + norm(data[d], lo, hi) * maxThick;
    ctx.beginPath();
    ctx.arc(CX, CY, outerR, a1, a2);
    ctx.arc(CX, CY, innerR, a2, a1, true);
    ctx.closePath();
    ctx.fill();
  }

  // The profile: a continuous line along the outer edge at full strength.
  ctx.strokeStyle = color;
  ctx.lineWidth = hairline(W, 0.0016, 0.75);
  ctx.lineJoin  = 'round';
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  let pathStarted = false;
  for (let d = 0; d < 365; d++) {
    if (blankZero && raw[d] <= 0) { pathStarted = false; continue; }
    const a1 = doy2angle(d), a2 = doy2angle(d + 1);
    const outerR = innerR + norm(data[d], lo, hi) * maxThick;
    if (!pathStarted) {
      ctx.moveTo(CX + Math.cos(a1) * outerR, CY + Math.sin(a1) * outerR);
      pathStarted = true;
    }
    ctx.arc(CX, CY, outerR, a1, a2);
  }
  ctx.stroke();

  ctx.restore();
}
