import { canvas, currentData } from '../state.js';
import { doy2angle, polar } from './canvas.js';

const INTERVAL = 14; // one marker every 14 days (~26 per year)

// Circular mean of meteorological directions (degrees clockwise from north)
function circMeanDir(dirs) {
  let sx = 0, sy = 0;
  for (const d of dirs) {
    const r = d * Math.PI / 180;
    sx += Math.cos(r); sy += Math.sin(r);
  }
  return ((Math.atan2(sy, sx) * 180 / Math.PI) + 360) % 360;
}

// Draw wind direction markers along the inner base of the wind ring.
// Each marker: solid circle + short tic pointing where the wind blows toward.
export function drawWindBarbs(layouts) {
  const { windDir } = currentData;
  if (!windDir || !layouts.wind) return;

  const { ctx, W, CX, CY } = canvas;
  const { innerFrac } = layouts.wind;

  const dotR   = W * 0.006;
  const tickLen = W * 0.018;
  // Sit the dot center just inside the inner edge of the ring
  const baseR  = innerFrac * W + dotR * 1.4;

  ctx.save();
  ctx.strokeStyle = '#1a1510';
  ctx.fillStyle   = '#1a1510';
  ctx.lineWidth   = Math.max(0.8, W * 0.0016);
  ctx.globalAlpha = 0.75;

  for (let doy = 0; doy < 365; doy += INTERVAL) {
    const end    = Math.min(doy + INTERVAL, 365);
    const center = (doy + end - 1) / 2;

    const dirs = windDir.slice(doy, end).filter(v => v != null);
    if (!dirs.length) continue;

    const avgDir = circMeanDir(dirs);
    // Convert compass "from" direction to canvas angle pointing "toward"
    // North (0°) = canvas up (-π/2); adding 90° shifts to "to" direction
    const toCanvasAngle = (avgDir + 90) * Math.PI / 180;

    const a      = doy2angle(center);
    const [x, y] = polar(CX, CY, a, baseR);

    // Solid circle
    ctx.beginPath();
    ctx.arc(x, y, dotR, 0, Math.PI * 2);
    ctx.fill();

    // Tic pointing in the direction the wind blows toward
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(toCanvasAngle) * tickLen, y + Math.sin(toCanvasAngle) * tickLen);
    ctx.stroke();
  }

  ctx.restore();
}
