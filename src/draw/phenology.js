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

import { canvas, phenologyEvents, displayState } from '../state.js';
import { doy2angle, polar } from './canvas.js';

// Per-category visibility toggles (set from the control panel).
const CATEGORY_STATE_KEY = {
  mammals: 'phenoMammals',
  fish:    'phenoFish',
  birds:   'phenoBirds',
  insects: 'phenoInsects',
  plants:  'phenoPlants',
};

// Arcs are colored by animal/plant category (the axis the events are organized
// along), falling back to a per-type color, then olive.
const CATEGORY_COLORS = {
  mammals: '#cf6a3a', // amber — mammals
  fish:    '#1f9e89', // teal — fish
  birds:   '#2f7fb0', // blue — birds
  insects: '#8e6fb0', // violet — insects
  plants:  '#5a9e3a', // green — plants
};

const TYPE_COLORS = {
  bloom:     '#c2477f', // pink — flower blooms
  migration: '#2f7fb0', // blue — passages
  arrival:   '#1f9e89', // teal — seasonal arrivals
  emergence: '#8e6fb0', // violet — insect emergences
  breeding:  '#cf6a3a', // amber — breeding / birthing
  other:     '#7a8a4a', // olive — everything else
};

/** Color for an event: its category, then its type, then olive. */
function eventColor(ev) {
  return CATEGORY_COLORS[ev.category] || TYPE_COLORS[ev.event_type] || TYPE_COLORS.other;
}

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
  // Honor the per-category toggles; an unknown category defaults to visible.
  const events = phenologyEvents.filter(ev => {
    const key = CATEGORY_STATE_KEY[ev.category];
    return !key || displayState[key] !== false;
  });
  if (!events.length) return;

  // Band between the holidays labels and the axis (W·0.49). Four concentric
  // levels fit; events that can't claim a clash-free level are dropped rather
  // than stacked on top of another line.
  const R_BASE    = W * 0.434; // innermost arc level
  const STEP      = W * 0.0145; // radial gap between levels
  const ARC_W     = W * 0.004;
  const FONT_SIZE = W * 0.0112;
  const MAX_LEVEL = 4;

  ctx.save();
  ctx.font = `${FONT_SIZE}px 'Crimson Pro',serif`;

  // Pre-compute geometry: center DOY (label anchor), text, and angular footprint.
  const items = events.map(ev => {
    const text = ev.verified === false ? `${ev.label}*` : ev.label;
    const textW = ctx.measureText(text).width;
    // Label width expressed in DOY at the base radius (a conservative estimate).
    const labelDOY = (textW / (R_BASE)) / (2 * Math.PI) * 365;
    const center = ev.peakDOY;
    return { ...ev, text, textW, center, half: halfSpan(ev, labelDOY) };
  });

  // Place the best-supported events first so, if the band runs out of room, it's
  // the thinnest-evidence events that get dropped.
  items.sort((a, b) => (b.obs_total || 0) - (a.obs_total || 0));

  // Greedy radial-level assignment: an event takes the lowest level whose already
  // placed events don't angularly overlap it. If no level is free, the event is
  // dropped (kept out of `placed`) so lines never overlap.
  const levels = [];
  const placed = [];
  for (const it of items) {
    let lvl = 0;
    for (; lvl < MAX_LEVEL; lvl++) {
      const occupants = levels[lvl] || (levels[lvl] = []);
      const clash = occupants.some(o => doyDist(o.center, it.center) < o.half + it.half + 2);
      if (!clash) { occupants.push(it); break; }
    }
    if (lvl === MAX_LEVEL) continue; // no room without overlapping — drop it
    it.level = lvl;
    it.r = R_BASE + lvl * STEP;
    placed.push(it);
  }

  // Draw arcs.
  for (const it of placed) {
    const color = eventColor(it);
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

  // Draw labels curved along each arc, centered on the arc midpoint and sitting
  // just outside the stroke so the text runs parallel to (and bends with) the
  // line. The 0.55·FONT offset keeps a label clear of the next level's arc.
  for (const it of placed) {
    const color = eventColor(it);
    const aCenter = doy2angle(it.center + 0.5);
    const rText = it.r + ARC_W / 2 + FONT_SIZE * 0.55;
    ctx.save();
    ctx.globalAlpha  = it.verified === false ? 0.6 : 0.82;
    ctx.fillStyle    = color;
    ctx.font         = `${FONT_SIZE}px 'Crimson Pro',serif`;
    drawArcText(ctx, CX, CY, it.text, aCenter, rText);
    ctx.restore();
  }

  ctx.restore();
}

/**
 * Render `text` along a circular arc of radius `r`, centered (tangentially) on
 * the angle `aCenter`. Each glyph is rotated to the local tangent so the whole
 * label bends with the arc. On the lower half of the wheel the text is flipped
 * so it stays upright (read left-to-right) rather than upside-down.
 */
function drawArcText(ctx, cx, cy, text, aCenter, r) {
  const chars  = [...text];
  const widths = chars.map(c => ctx.measureText(c).width);
  const total  = widths.reduce((s, w) => s + w, 0);
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
    ctx.fillText(chars[i], 0, 0);
    ctx.restore();
    a += dir * charAngle;
  }
}
