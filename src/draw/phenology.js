/**
 * Phenology band — "Wildlife & blooms"
 *
 * Draws the characteristic seasonal ecological events for the current location as
 * colored range-arcs (each spanning its date window) with a rotated label at the
 * arc's midpoint. Events are fetched from the phenology service and held in
 * state.phenologyEvents; timing is anchored to iNaturalist observations where
 * coverage is good (verified) or estimated by the LLM where it is thin
 * (verified:false — drawn dashed with a trailing '*').
 *
 * Sits in an outer band between the holidays labels (~.43·W) and the axis radius
 * (.49·W). Overlapping events are staggered outward across radial levels, mirroring
 * the greedy collision avoidance in draw/holidays.js.
 */

import { canvas, phenologyEvents } from '../state.js';
import { doy2angle, polar } from './canvas.js';

const TYPE_COLORS = {
  bloom:     '#c2477f', // pink — flower blooms
  migration: '#2f7fb0', // blue — passages
  arrival:   '#1f9e89', // teal — seasonal arrivals
  emergence: '#8e6fb0', // violet — insect emergences
  breeding:  '#cf6a3a', // amber — breeding / birthing
  other:     '#7a8a4a', // olive — everything else
};

/** Circular distance between two DOY values, in days (0–182.5). */
function doyDist(a, b) {
  let d = Math.abs(a - b) % 365;
  return d > 182.5 ? 365 - d : d;
}

/** Half the angular span an event occupies, in DOY, = max(date span, label width). */
function halfSpan(ev, labelDOY) {
  let dateSpan = (ev.endDOY - ev.startDOY + 365) % 365;
  return Math.max(dateSpan / 2, labelDOY / 2);
}

export function drawPhenology() {
  const { ctx, W, CX, CY } = canvas;
  if (!phenologyEvents.length) return;

  const R_BASE    = W * 0.438; // innermost arc level
  const STEP      = W * 0.020; // radial gap between levels
  const ARC_W     = W * 0.0045;
  const FONT_SIZE = W * 0.0125;
  const MAX_LEVEL = 3;

  ctx.save();
  ctx.font = `${FONT_SIZE}px 'Crimson Pro',serif`;

  // Pre-compute geometry: center DOY (label anchor), text, and angular footprint.
  const items = phenologyEvents.map(ev => {
    const text = ev.verified === false ? `${ev.label}*` : ev.label;
    const textW = ctx.measureText(text).width;
    // Label width expressed in DOY at the base radius (a conservative estimate).
    const labelDOY = (textW / (R_BASE)) / (2 * Math.PI) * 365;
    const center = ev.peakDOY;
    return { ...ev, text, textW, center, half: halfSpan(ev, labelDOY) };
  });

  // Sort by center DOY so the greedy pass walks the wheel in order.
  items.sort((a, b) => a.center - b.center);

  // Greedy radial-level assignment: an event takes the lowest level whose already
  // placed events don't angularly overlap it.
  const levels = [];
  for (const it of items) {
    let lvl = 0;
    for (; lvl < MAX_LEVEL; lvl++) {
      const occupants = levels[lvl] || (levels[lvl] = []);
      const clash = occupants.some(o => doyDist(o.center, it.center) < o.half + it.half + 2);
      if (!clash) { occupants.push(it); break; }
    }
    if (lvl === MAX_LEVEL) { lvl = MAX_LEVEL - 1; (levels[lvl] || (levels[lvl] = [])).push(it); }
    it.level = lvl;
    it.r = R_BASE + lvl * STEP;
  }

  // Draw arcs.
  for (const it of items) {
    const color = TYPE_COLORS[it.event_type] || TYPE_COLORS.other;
    const a1 = doy2angle(it.startDOY + 0.5);
    let a2 = doy2angle(it.endDOY + 0.5);
    if (it.endDOY < it.startDOY) a2 += Math.PI * 2; // wrap across the solstice seam
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth   = ARC_W;
    ctx.lineCap     = 'round';
    ctx.globalAlpha = it.verified === false ? 0.45 : 0.8;
    if (it.verified === false) ctx.setLineDash([ARC_W * 1.5, ARC_W * 1.8]);
    ctx.beginPath();
    ctx.arc(CX, CY, it.r, a1, a2);
    ctx.stroke();
    ctx.restore();
  }

  // Draw labels centered on each arc, just outside the stroke.
  for (const it of items) {
    const color = TYPE_COLORS[it.event_type] || TYPE_COLORS.other;
    const a = doy2angle(it.center + 0.5);
    const [lx, ly] = polar(CX, CY, a, it.r + ARC_W / 2 + FONT_SIZE * 0.7);
    // Keep text upright (never upside-down) regardless of wheel position.
    let textAngle = a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
    if (textAngle >= Math.PI / 2)  textAngle -= Math.PI;
    if (textAngle <  -Math.PI / 2) textAngle += Math.PI;
    ctx.save();
    ctx.globalAlpha  = it.verified === false ? 0.6 : 0.82;
    ctx.fillStyle    = color;
    ctx.font         = `${FONT_SIZE}px 'Crimson Pro',serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(lx, ly);
    ctx.rotate(textAngle);
    ctx.fillText(it.text, 0, 0);
    ctx.restore();
  }

  ctx.restore();
}
