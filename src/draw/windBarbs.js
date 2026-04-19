import { canvas, currentData } from '../state.js';
import { doy2angle, polar } from './canvas.js';

const INTERVAL = 14; // one barb every 14 days (~26 per year)

// Circular mean of meteorological directions (degrees clockwise from north)
function circMeanDir(dirs) {
  let sx = 0, sy = 0;
  for (const d of dirs) {
    const r = d * Math.PI / 180;
    sx += Math.cos(r); sy += Math.sin(r);
  }
  return ((Math.atan2(sy, sx) * 180 / Math.PI) + 360) % 360;
}

// Draw a single meteorological wind barb at (x, y).
// fromDirDeg: direction FROM which wind blows (0 = north, clockwise).
// Shaft tip points toward wind source; barbs on the left when looking tail→tip.
function drawBarb(ctx, x, y, speedMph, fromDirDeg, W) {
  const shaft   = W * 0.028;
  const feather = W * 0.015;
  const spacing = W * 0.010;

  // Round speed to nearest 5 mph, then encode as pennants/fulls/halves
  const rounded  = Math.round(speedMph / 5) * 5;
  let rem        = rounded;
  const pennants = Math.floor(rem / 50); rem %= 50;
  const fulls    = Math.floor(rem / 10); rem %= 10;
  const halves   = Math.floor(rem / 5);

  // Rotation: canvas angle for a shaft pointing toward fromDirDeg
  // Met 0° (N) → canvas up (-π/2); formula: θ = fromDirDeg * π/180
  // (canvas rotate is clockwise; drawing (0,-shaft) maps to the FROM direction)
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(fromDirDeg * Math.PI / 180);

  // Shaft: tail at origin, tip at (0, -shaft)
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -shaft);
  ctx.stroke();

  // Barbs drawn at the tip end, working toward the tail.
  // Left of shaft (looking tail→tip in a left-handed canvas coord) = -X direction.
  let yp = -shaft;

  for (let i = 0; i < pennants; i++) {
    ctx.beginPath();
    ctx.moveTo(0, yp);
    ctx.lineTo(-feather, yp + spacing * 0.5);
    ctx.lineTo(0, yp + spacing);
    ctx.closePath();
    ctx.fill();
    yp += spacing;
  }
  for (let i = 0; i < fulls; i++) {
    ctx.beginPath();
    ctx.moveTo(0, yp);
    ctx.lineTo(-feather, yp + spacing * 0.5);
    ctx.stroke();
    yp += spacing;
  }
  if (halves) {
    ctx.beginPath();
    ctx.moveTo(0, yp);
    ctx.lineTo(-feather * 0.5, yp + spacing * 0.25);
    ctx.stroke();
  }

  ctx.restore();
}

// Draw biweekly wind barbs overlaid on the wind ring.
// layouts: object from computeRingLayouts(); skips if wind ring is hidden.
export function drawWindBarbs(layouts) {
  const { windDir, wind } = currentData;
  if (!windDir || !layouts.wind) return;

  const { ctx, W, CX, CY } = canvas;
  const { innerFrac, thickFrac } = layouts.wind;
  // Position barbs at the midpoint of the wind ring radially
  const midR = (innerFrac + thickFrac * 0.5) * W;

  ctx.save();
  ctx.strokeStyle = '#1a1510';
  ctx.fillStyle   = '#1a1510';
  ctx.lineWidth   = Math.max(0.7, W * 0.0014);
  ctx.globalAlpha = 0.72;

  for (let doy = 0; doy < 365; doy += INTERVAL) {
    const end    = Math.min(doy + INTERVAL, 365);
    const center = (doy + end - 1) / 2;

    const speeds = wind.slice(doy, end).filter(v => v != null);
    const dirs   = windDir.slice(doy, end).filter(v => v != null);
    if (!speeds.length || !dirs.length) continue;

    const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    const avgDir   = circMeanDir(dirs);

    const a      = doy2angle(center);
    const [x, y] = polar(CX, CY, a, midR);
    drawBarb(ctx, x, y, avgSpeed, avgDir, W);
  }

  ctx.restore();
}
