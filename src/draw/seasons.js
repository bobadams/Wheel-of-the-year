/**
 * The seasons band — this location's own year, named and dated from its data.
 *
 * Unlike every other ring this one is CATEGORICAL: it has no value per day and
 * so no baseline to grow from, which is why it is not drawn by drawRing(). It
 * occupies a ring slot all the same — it is laid out by computeRingLayouts()
 * like the others, so it can be reordered, resized and hidden from the same
 * panel — and paints as a set of contiguous arcs, one per season, each carrying
 * its own name.
 *
 * The seasons themselves come from src/data/seasons.js; nothing here decides
 * anything about them beyond how they look.
 */

import { canvas } from '../state.js';
import { doy2angle, polar, drawArcText, arcTextSpan } from './canvas.js';
import { INK, hairline, haloText } from './theme.js';
import { seasonRangeLabel } from '../data/seasons.js';

// Fill strength. Heavier than a data ring's 0.32 because a season is a solid
// region rather than a profile, and the band has to read as one object at a
// glance without drowning the rings it sits against.
const FILL_ALPHA = 0.42;

/** Angular midpoint of a season, in radians. */
function midAngle(s) {
  return doy2angle(s.startDOY + s.days / 2);
}

/**
 * Paint the seasons into the ring slot at `innerR`, `thick`.
 *
 * @param {object[]} seasons from computeSeasons()
 * @param {number} alpha the ring's opacity setting
 */
export function drawSeasonBand(seasons, innerR, thick, alpha = 1) {
  if (!seasons?.length) return;
  const { ctx, W, CX, CY } = canvas;
  const outerR = innerR + thick;

  ctx.save();

  // ── Bodies ────────────────────────────────────────────────────────────────
  seasons.forEach(s => {
    const a1 = doy2angle(s.startDOY), a2 = doy2angle(s.startDOY + s.days);
    ctx.beginPath();
    ctx.arc(CX, CY, outerR, a1, a2);
    ctx.arc(CX, CY, innerR, a2, a1, true);
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.globalAlpha = alpha * FILL_ALPHA;
    ctx.fill();
  });

  // ── Edges ─────────────────────────────────────────────────────────────────
  // The two circles that close the band, then a radial rule at each turn of the
  // year. The rules are what make the dates legible: a colour change alone is
  // read as a gradient, a line is read as a date.
  ctx.globalAlpha = alpha * 0.55;
  ctx.strokeStyle = INK.rule;
  ctx.lineWidth = hairline(W, 0.0008, 0.4);
  [innerR, outerR].forEach(r => {
    ctx.beginPath(); ctx.arc(CX, CY, r, 0, Math.PI * 2); ctx.stroke();
  });

  ctx.globalAlpha = alpha * 0.8;
  ctx.lineWidth = hairline(W, 0.0013, 0.7);
  seasons.forEach(s => {
    const a = doy2angle(s.startDOY);
    const [x1, y1] = polar(CX, CY, a, innerR);
    const [x2, y2] = polar(CX, CY, a, outerR);
    ctx.strokeStyle = s.color;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  });

  ctx.restore();
}

/**
 * The seasons' names, drawn in the annotation pass rather than with the band.
 *
 * They are the band's own labels, but they are still labels: drawn with the
 * bodies they went down before the solstice cross, which then ruled straight
 * through "OCT 26 – FEB 14". Drawn here, after it, their halos break it the way
 * every other label on the wheel does.
 */
export function drawSeasonLabels(seasons, innerR, thick, alpha = 1) {
  if (!seasons?.length) return;
  const { ctx, W, CX, CY } = canvas;
  const midR = innerR + thick / 2;

  ctx.save();
  // ── Names ─────────────────────────────────────────────────────────────────
  // Set in the band itself rather than outside it, which keeps the seasons
  // clear of the solstice/equinox lane the wheel already spends at R.seasonLabel.
  // At wall size each season can carry the dates it turns on, which is the
  // detail a reader standing in front of the sheet actually wants and the
  // screen has no room for. The threshold is on the band's own thickness, not
  // on the sheet size: with nine rings switched on there is no room even on A0.
  const showDates = canvas.print && thick > W * 0.020;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  seasons.forEach(s => {
    const aMid  = midAngle(s);
    const avail = (s.days / 365) * Math.PI * 2 * 0.9;   // leave the turns clear
    const label = s.name.toUpperCase();

    // Fit the name to its arc: shrink to a floor, then give up rather than
    // print one season's name across its neighbour's.
    let size = Math.min(thick * 0.42, W * 0.0135);
    const minSize = W * 0.0068;
    let tracking = size * 0.16;
    ctx.font = `${size}px Cinzel,serif`;
    while (arcTextSpan(ctx, label, midR, tracking) > avail && size > minSize) {
      size *= 0.92;
      tracking = size * 0.16;
      ctx.font = `${size}px Cinzel,serif`;
    }
    if (arcTextSpan(ctx, label, midR, tracking) > avail) return;

    const nameR = showDates ? midR + size * 0.5 : midR;
    ctx.fillStyle = INK.ink;
    ctx.globalAlpha = alpha * 0.9;
    drawArcText(ctx, CX, CY, label, aMid, nameR,
      { tracking, paint: (c, ch, x, y) => haloText(c, ch, x, y, size * 0.5) });

    if (!showDates) return;
    const dates = seasonRangeLabel(s).toUpperCase();
    const dSize = size * 0.66;
    ctx.font = `${dSize}px Cinzel,serif`;
    if (arcTextSpan(ctx, dates, midR, dSize * 0.1) > avail) return;
    ctx.fillStyle = INK.light;
    ctx.globalAlpha = alpha * 0.8;
    drawArcText(ctx, CX, CY, dates, aMid, midR - size * 0.72,
      { tracking: dSize * 0.1, paint: (c, ch, x, y) => haloText(c, ch, x, y, dSize * 0.5) });
  });


  ctx.restore();
}
