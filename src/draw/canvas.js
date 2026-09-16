// Shared canvas math helpers — no DOM or state imports needed

// DOY 0 is the winter solstice (see src/data/calendar.js), and the top of the
// wheel is the MIDDLE of that day. Day d's arc runs from doy2angle(d) to
// doy2angle(d + 1), and anything marking a whole day sits at d + 0.5 — so the
// solstice's own marker points straight up.
export const SOLSTICE_OFFSET = -Math.PI / 2 - (0.5 / 365) * Math.PI * 2;

export function doy2angle(d) {
  return (d / 365) * Math.PI * 2 + SOLSTICE_OFFSET;
}

// Inverse of doy2angle: maps a canvas angle (e.g. from atan2) to a fractional
// DOY in [0, 365). Math.floor of it is the day whose arc contains the angle.
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

/**
 * Rotation that keeps tangential text upright anywhere on the wheel.
 * Text set at `a + π/2` runs along the circle; on the lower half that comes out
 * upside-down, so it is flipped a further half-turn.
 */
export function uprightTangent(a) {
  let rot = a + Math.PI / 2;
  const n = ((rot % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (n > Math.PI / 2 && n < Math.PI * 3 / 2) rot += Math.PI;
  return rot;
}

/**
 * Render `text` along a circular arc of radius `r`, centred (tangentially) on
 * the angle `aCenter`. Each glyph is rotated to the local tangent so the whole
 * label bends with the circle. On the lower half of the wheel the run is
 * reversed so the text stays upright and reads left to right.
 *
 * @param {(ctx, ch, x, y) => void} [opts.paint] per-glyph painter; defaults to
 *   fillText. Used to give a label a paper halo one glyph at a time.
 * @param {number} [opts.tracking] extra space between glyphs, in px. Arc text
 *   is laid out glyph by glyph anyway, so tracking is free here — and unlike
 *   padding the string with spaces, it survives the SVG export.
 */
export function drawArcText(ctx, cx, cy, text, aCenter, r, opts = {}) {
  const { paint, tracking = 0 } = opts;
  const chars  = [...text];
  const widths = chars.map(c => ctx.measureText(c).width + tracking);
  const total  = widths.reduce((s, w) => s + w, 0) - tracking;
  // Flip when the label sits on the bottom of the wheel (canvas y grows down).
  const flip = Math.sin(aCenter) > 0;
  const dir  = flip ? -1 : 1;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  // Walk from the leading edge of the label to its trailing edge.
  let a = aCenter - dir * (total / r) / 2;
  for (let i = 0; i < chars.length; i++) {
    const charAngle = widths[i] / r;
    const aMid = a + dir * charAngle / 2;
    const [x, y] = polar(cx, cy, aMid, r);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(aMid + (flip ? -Math.PI / 2 : Math.PI / 2));
    if (chars[i] !== ' ') {
      if (paint) paint(ctx, chars[i], 0, 0); else ctx.fillText(chars[i], 0, 0);
    }
    ctx.restore();
    a += dir * charAngle;
  }
}

/** Angular width, in radians, that `text` occupies as arc text at radius `r`. */
export function arcTextSpan(ctx, text, r, tracking = 0) {
  const chars = [...text];
  const w = chars.reduce((s, c) => s + ctx.measureText(c).width, 0)
    + tracking * Math.max(0, chars.length - 1);
  return w / r;
}
