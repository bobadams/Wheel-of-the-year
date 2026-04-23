// Shared canvas math helpers — no DOM or state imports needed
export const SOLSTICE_OFFSET = -Math.PI / 2 - (354 / 365) * Math.PI * 2;

export function doy2angle(d) {
  return (d / 365) * Math.PI * 2 + SOLSTICE_OFFSET;
}

// Inverse of doy2angle: maps a canvas angle (e.g. from atan2) to a 0-indexed
// day of year. Normalizes the result into [0, 365).
export function angle2doy(angle) {
  let frac = (angle - SOLSTICE_OFFSET) / (Math.PI * 2);
  frac = ((frac % 1) + 1) % 1;
  return frac * 365;
}

export function polar(cx, cy, a, r) {
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
}

export function norm(v, lo, hi) {
  return Math.max(.02, Math.min(1, (v - lo) / (hi - lo)));
}

// Draw a Catmull-Rom spline through pts [{x,y}…]. Caller must ctx.beginPath() first.
export function catmullRomPath(ctx, pts) {
  if (pts.length < 2) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    ctx.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
      p2.x, p2.y,
    );
  }
}
