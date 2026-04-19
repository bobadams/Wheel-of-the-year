import { canvas } from '../state.js';
import { doy2angle, norm } from './canvas.js';

export function drawRing(data, lo, hi, innerR, maxThick, color, alpha, blankZero = false, rawData = null) {
  const { ctx, CX, CY } = canvas;
  const raw = rawData ?? data;
  ctx.save();

  // Fill at 25% opacity
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha * 0.25;
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

  // Hairline outer edge at full opacity
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.75;
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
