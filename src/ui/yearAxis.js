/**
 * A year laid along a straight axis — the wheel unrolled from its top.
 *
 * Every chart that plots the year in a modal uses this, so each one runs from
 * winter solstice to winter solstice exactly as the wheel does. The left edge
 * is the middle of DOY 0, which is precisely the top of the wheel
 * (src/draw/canvas.js), and the right edge is that same instant one turn later.
 * So:
 *
 *   - a day's value is plotted at `x(doy)`, its centre;
 *   - a series is closed by plotting DOY 0 once more at `x(365)` — the curve
 *     ends on the solstice it began on, as the ring does;
 *   - a boundary between days (a month start) falls half a day before that
 *     day's centre, at `boundaryX(doy)` — the same place its tick is on the wheel.
 */

import { MON_S, monthSpans } from '../data/calendar.js';

const SOLSTICE_LABEL = 'Dec 21';

/** The x mapping for a year axis `width` wide starting at `left`. */
export function yearAxis(left, width) {
  const x = doy => left + (doy / 365) * width;
  return { x, boundaryX: doy => x(doy - 0.5), left, right: left + width };
}

/** `series` with its first value repeated at DOY 365, so the line closes on the solstice. */
export const closeYear = series => [...series, series[0]];

/**
 * Month dividers and names beneath a year axis. The two ends are named for the
 * winter solstice rather than as slivers of December: December is cut in two by
 * the top of the wheel, and the solstice is what the ends of the axis are.
 *
 * @param {object} opts `top`/`bottom` of the plot area, `labelY` for the names,
 *   `dash` for the divider pattern — the two modals are styled differently.
 */
export function drawMonthAxis(ctx, axis, { top, bottom, labelY, dash }) {
  ctx.save();
  ctx.font = '10px sans-serif';
  ctx.fillStyle = '#aaa';
  ctx.textBaseline = 'alphabetic';

  for (const { month, start, end } of monthSpans()) {
    if (start > 0) {
      ctx.save();
      ctx.strokeStyle = '#d8d0c4';
      ctx.lineWidth = 0.5;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(axis.boundaryX(start), top);
      ctx.lineTo(axis.boundaryX(start), bottom);
      ctx.stroke();
      ctx.restore();
    }
    if (start === 0 || end === 365) continue;   // the solstice ends are named below
    ctx.textAlign = 'center';
    ctx.fillText(MON_S[month], axis.x((start + end - 1) / 2), labelY);
  }

  ctx.fillStyle = '#8a7e6a';
  ctx.textAlign = 'left';
  ctx.fillText(SOLSTICE_LABEL, axis.left, labelY);
  ctx.textAlign = 'right';
  ctx.fillText(SOLSTICE_LABEL, axis.right, labelY);
  ctx.restore();
}
