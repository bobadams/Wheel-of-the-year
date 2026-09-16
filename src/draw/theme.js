/**
 * Shared drawing constants — the palette and the radial register plan.
 *
 * Everything the wheel draws is expressed as a fraction of `canvas.W`, so one
 * set of numbers describes the wheel at 660 px on a laptop and at 36 inches on
 * a poster. Keeping the registers here (rather than scattered as magic numbers
 * across the draw modules) is what makes it possible to see, in one place, that
 * the annotation bands don't collide.
 */

// ─── Ink ─────────────────────────────────────────────────────────────────────
// Warm neutrals matched to the paper. `paper` is also the halo color that lets
// annotation read over a ring fill without a hard box around it.
export const INK = {
  paper:     '#faf7f2',
  ink:       '#2c2416',
  light:     '#6b5e4a',
  faint:     '#b3a68d',
  rule:      '#c8bda6',
  today:     '#a8331d',   // muted brick — a marker, not an alarm
  moon:      '#7a6a9e',
};

// ─── Radial registers (fractions of canvas.W) ────────────────────────────────
// Read outward. Each band is sized so the one outside it starts clear of the
// tallest thing the previous one can draw — the outermost annotation (a
// holiday label on the top level, halo included) lands at ~0.496, just inside
// the canvas. Nothing sits outside the holidays, so if they move inward the
// whole table should scale up with them rather than leave an empty margin.
export const R = {
  // Center cartouche: location, the year's headline numbers, today's date.
  holeOuter:     0.1426,

  // Data rings. computeRingLayouts() divides this span between visible rings.
  ringStart:     0.1490,
  ringEnd:       0.3607,

  // Solstice / equinox labels ride in the gap above the rings, curved to the
  // circle so they stay upright all the way round. The gap is wide enough that
  // the labels touch neither the outermost ring's profile nor the calendar.
  seasonLabel:   0.3748,

  // Calendar band: alternating month tints, boundary ticks, curved month names.
  calInner:      0.3888,
  calOuter:      0.4212,

  // Moon lane, then the two annotation registers.
  moon:          0.4304,
  moonDot:       0.0058,

  holidayMark:   0.4390,
  holidaySym:    0.0052,
  holidayLabel:  0.4493,   // innermost of four candidate label radii
  holidayStep:   0.0127,
  holidayFont:   0.0121,
  holidayLevels: 4,

  // The solstice/equinox cross reaches just past the calendar band.
  axisOuter:     0.4255,
  // Today's radial line spans the data rings and stops on the calendar band.
  todayOuter:    0.4212,
};

/**
 * Hairline width that survives both ends of the scale: proportional to the
 * wheel, but never thinner than a printer can hold or a screen can show.
 */
export function hairline(W, frac = 0.0011, min = 0.55) {
  return Math.max(min, W * frac);
}

/**
 * Draw `text` with a soft paper-colored halo behind it, so annotation stays
 * legible where it crosses a ring fill without needing an opaque plate.
 * Call with the same transform/alignment you would use for fillText.
 */
export function haloText(ctx, text, x, y, width) {
  const prevAlpha = ctx.globalAlpha;
  ctx.save();
  ctx.strokeStyle = INK.paper;
  ctx.lineWidth   = width;
  ctx.lineJoin    = 'round';
  ctx.miterLimit  = 2;
  ctx.globalAlpha = Math.min(1, prevAlpha + 0.25);
  ctx.strokeText(text, x, y);
  ctx.restore();
  ctx.fillText(text, x, y);
}

/**
 * Draw `text` with real letterspacing, honouring the current textAlign.
 *
 * Canvas has no tracking property that survives the SVG export, and padding a
 * string with spaces does not survive it either — XML collapses the run, which
 * is how a letterspaced masthead once printed as WHEELOFTHEYEAR. Placing each
 * glyph by hand is the only form of tracking that renders identically on the
 * screen canvas and in the exported vector.
 *
 * @returns {number} the width the tracked string occupies.
 */
export function drawTracked(ctx, text, x, y, tracking) {
  const chars  = [...text];
  const widths = chars.map(c => ctx.measureText(c).width);
  const total  = widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, chars.length - 1);

  let cx = x;
  const align = ctx.textAlign;
  if (align === 'center')                      cx = x - total / 2;
  else if (align === 'right' || align === 'end') cx = x - total;

  ctx.textAlign = 'left';
  chars.forEach((c, i) => {
    if (c !== ' ') ctx.fillText(c, cx, y);
    cx += widths[i] + tracking;
  });
  ctx.textAlign = align;
  return total;
}

/** Width `text` will occupy under drawTracked, without drawing it. */
export function trackedWidth(ctx, text, tracking) {
  const chars = [...text];
  return chars.reduce((s, c) => s + ctx.measureText(c).width, 0)
    + tracking * Math.max(0, chars.length - 1);
}
