import { canvas } from '../state.js';
import { doy2angle, norm } from './canvas.js';

export function drawRing(data, lo, hi, innerR, maxThick, color, alpha) {
  const { ctx, CX, CY } = canvas;
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let d = 0; d < 365; d++) {
    const a1 = doy2angle(d), a2 = doy2angle(d + 1);
    const outerR = innerR + norm(data[d], lo, hi) * maxThick;
    ctx.beginPath();
    ctx.arc(CX, CY, outerR, a1, a2);
    ctx.arc(CX, CY, innerR, a2, a1, true);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.restore();
}
