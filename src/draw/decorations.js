import { canvas, currentData, todayDOY } from '../state.js';
import { doy2angle, polar, drawArcText, arcTextSpan } from './canvas.js';
import { INK, R, hairline, haloText, drawTracked } from './theme.js';
import { yearSummary, coordLabel } from '../data/summary.js';
import { DIM, MON_S, MON_L, MONTH_START, dateToDOY, monthDayToDOY, doyLabel } from '../data/calendar.js';

/**
 * Mean new and full moons in calendar `year`, as DOYs.
 *
 * Each phase is dated by its UTC calendar day and placed through the calendar
 * like every other marker. Counting days from Jan 1 instead runs one day long
 * after Feb 29, which put every moon from March on a day late in a leap year.
 */
function computeMoonPhases(year) {
  const SYNODIC = 29.530588853;
  const msPerDay = 86400000;
  const j2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
  const toJD  = ms => 2451545.0 + (ms - j2000) / msPerDay;
  const toDOY = jd => dateToDOY(new Date(j2000 + (jd - 2451545.0) * msPerDay).toISOString().slice(0, 10), { leapDay: 'mar1' });
  const startJD = toJD(Date.UTC(year, 0, 1));
  const endJD   = toJD(Date.UTC(year + 1, 0, 1));
  const refJD = 2451550.09765; // Meeus k=0 mean new moon (Jan 6, 2000 14:21 UTC)
  const kStart = Math.floor((startJD - refJD) / SYNODIC) - 1;
  const newMoons = [], fullMoons = [];
  for (let k = kStart; k <= kStart + 15; k++) {
    const newJD  = refJD + k * SYNODIC;
    const fullJD = refJD + (k + 0.5) * SYNODIC;
    if (newJD  >= startJD && newJD  < endJD) newMoons.push(toDOY(newJD));
    if (fullJD >= startJD && fullJD < endJD) fullMoons.push(toDOY(fullJD));
  }
  return { newMoons, fullMoons };
}

const { newMoons: MOON_NEW, fullMoons: MOON_FULL } = computeMoonPhases(new Date().getFullYear());

/**
 * Moon lane — one marker per syzygy on its own thin circle, outside the
 * calendar band. Full moons read as filled discs, new moons as open rings; the
 * lunar month is visible as the rhythm of the alternation rather than from any
 * one marker.
 */
export function drawMoon() {
  const { ctx, W, CX, CY } = canvas;
  const r  = W * R.moon;
  const dr = W * R.moonDot;
  ctx.save();
  // +0.5 centers each marker on the middle of its day's arc, matching the
  // convention used by min/max, today-dot, and actuals overlays.
  MOON_FULL.forEach(d => {
    const a = doy2angle(d + 0.5);
    const [x, y] = polar(CX, CY, a, r);
    ctx.beginPath(); ctx.arc(x, y, dr, 0, Math.PI * 2);
    ctx.fillStyle = INK.moon; ctx.globalAlpha = .8; ctx.fill();
  });
  MOON_NEW.forEach(d => {
    const a = doy2angle(d + 0.5);
    const [x, y] = polar(CX, CY, a, r);
    ctx.beginPath(); ctx.arc(x, y, dr * .78, 0, Math.PI * 2);
    ctx.strokeStyle = INK.moon; ctx.lineWidth = hairline(W, 0.0016, 1); ctx.globalAlpha = .55; ctx.stroke();
  });
  ctx.restore();
}

/**
 * Calendar band — the ring that turns an angle into a date.
 *
 * Alternating months carry a faint tint, so a month boundary is legible even
 * where a tick is crossed by something else, and the month name is set as arc
 * text inside the band, curving with it. Setting the names along the circle
 * (rather than as one rotated word) is what keeps them upright and evenly
 * spaced all the way round; the old radial placement left the bottom third of
 * the year reading upside down.
 */
export function drawTicks() {
  const { ctx, W, CX, CY } = canvas;
  const inner = W * R.calInner, outer = W * R.calOuter;
  const mid   = (inner + outer) / 2;
  const long  = canvas.print; // full month names earn their space only on paper

  ctx.save();

  // Alternating month tint.
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = INK.rule;
  MONTH_START.forEach((start, i) => {
    if (i % 2) return;
    const a1 = doy2angle(start), a2 = doy2angle(start + DIM[i]);
    ctx.beginPath();
    ctx.arc(CX, CY, outer, a1, a2);
    ctx.arc(CX, CY, inner, a2, a1, true);
    ctx.closePath();
    ctx.globalAlpha = 0.13;
    ctx.fill();
  });

  // Band edges.
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = INK.rule;
  ctx.lineWidth = hairline(W, 0.0009, 0.5);
  [inner, outer].forEach(rr => {
    ctx.beginPath(); ctx.arc(CX, CY, rr, 0, Math.PI * 2); ctx.stroke();
  });

  // Month boundary ticks, drawn across the whole band.
  ctx.lineWidth = hairline(W, 0.0013, 0.7);
  ctx.globalAlpha = 0.7;
  MONTH_START.forEach(start => {
    const a = doy2angle(start);
    const [x1, y1] = polar(CX, CY, a, inner);
    const [x2, y2] = polar(CX, CY, a, outer);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  });

  // Month names, curved inside the band.
  ctx.fillStyle = INK.light;
  ctx.globalAlpha = 0.92;
  MONTH_START.forEach((start, i) => {
    const aMid = doy2angle(start + DIM[i] / 2);
    let size = W * (long ? 0.0135 : 0.0155);
    let text = (long ? MON_L : MON_S)[i].toUpperCase();
    ctx.font = `${size}px Cinzel,serif`;
    // Letterspacing by hand: arc text lays out glyph by glyph, so inserting
    // hair spaces is the only way to open the tracking the caps want.
    text = [...text].join(' ');
    // Shrink anything that would overrun its month's slice of the circle.
    const slice = (DIM[i] / 365) * Math.PI * 2 * 0.88;
    let span = arcTextSpan(ctx, text, mid);
    if (span > slice) {
      size *= slice / span;
      ctx.font = `${size}px Cinzel,serif`;
    }
    drawArcText(ctx, CX, CY, text, aMid, mid - size * 0.06);
  });

  ctx.restore();
}

// The cardinal days of the solar year, each on the middle of the day it is
// named for — the same +0.5 as every other day marker, so the winter solstice
// (DOY 0) points straight up. They are deliberately NOT a perfect cross. The
// Earth's orbit is eccentric: Sep 22 → Mar 20 is 179 days and Mar 20 → Sep 22
// is 186. Spaced evenly as two diameters, the axes sat up to two and a quarter
// days away from the dates they are labelled with.
const CARDINALS = [
  { doy: monthDayToDOY(12, 21) + 0.5, label: 'Winter Solstice' },
  { doy: monthDayToDOY(3, 20) + 0.5,  label: 'Spring Equinox' },
  { doy: monthDayToDOY(6, 21) + 0.5,  label: 'Summer Solstice' },
  { doy: monthDayToDOY(9, 22) + 0.5,  label: 'Autumn Equinox' },
];

/**
 * The solar cross and its four labels.
 *
 * The dashed axes run from the cartouche to the calendar band rather than rim
 * to rim, so they mark the four turning points without cutting through either
 * the centre block or the annotation registers, and the
 * labels ride as arc text in the gap above the rings — the one radius on the
 * wheel where four short labels can sit upright without colliding with
 * anything else.
 */
export function drawAxes() {
  const { ctx, W, CX, CY } = canvas;
  const outer = W * R.axisOuter;
  const size  = W * 0.0118;          // the label, and so the gap left for it
  ctx.save();
  ctx.strokeStyle = INK.ink; ctx.lineWidth = hairline(W, 0.0011, 0.6);
  ctx.globalAlpha = .26; ctx.setLineDash([W * 0.006, W * 0.007]);
  // The line stops short of its own label and picks up beyond it. A halo can't
  // do that job here: the label is letterspaced arc text, so the line simply
  // showed through the gaps between its glyphs.
  const gapLo  = W * R.seasonLabel - size * 0.95;
  const gapHi  = W * R.seasonLabel + size * 0.95;
  CARDINALS.forEach(({ doy }) => {
    const a = doy2angle(doy);
    [[W * R.holeOuter, gapLo], [gapHi, outer]].forEach(([r1, r2]) => {
      const [x1, y1] = polar(CX, CY, a, r1);
      const [x2, y2] = polar(CX, CY, a, r2);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    });
  });
  ctx.setLineDash([]);
  ctx.restore();

  ctx.save();
  ctx.font = `${size}px Cinzel,serif`;
  ctx.fillStyle = INK.light;
  ctx.globalAlpha = 0.85;
  CARDINALS.forEach(({ doy, label }) => {
    const text = [...label.toUpperCase()].join(' ');
    drawArcText(ctx, CX, CY, text, doy2angle(doy), W * R.seasonLabel,
      (c, ch, x, y) => haloText(c, ch, x, y, size * 0.42));
  });
  ctx.restore();
}

/**
 * Centre cartouche — the place the wheel names itself.
 *
 * The location used to sit in a strip above the wheel, which cost height and
 * left the centre hole empty. Putting it in the middle follows the convention
 * of a printed map, and gives the year's headline figures somewhere to live
 * where they can be read against the rings that produced them.
 *
 * @param {boolean} [opts.showName]  false on the poster, where the masthead
 *   already carries the location and the centre is given over to the figures.
 * @param {number}  [opts.stats]     how many summary figures to show.
 */
export function drawCenter(opts = {}) {
  const { ctx, W, CX, CY } = canvas;
  const { showName = true, stats = canvas.print ? 5 : 3 } = opts;
  const hole = W * R.holeOuter;

  const name   = currentData.name ?? '';
  const parts  = name.split(',').map(s => s.trim());
  const place  = parts[0] ?? '';
  const region = parts.slice(1).join(', ');
  const coords = coordLabel(currentData.lat, currentData.lon);
  const rows   = yearSummary(currentData).slice(0, stats);

  // Lay the block out as a stack of measured rows, then centre the whole stack
  // vertically in the hole — so the cartouche stays balanced whether or not the
  // name is shown and however many figures there are.
  const lines = [];
  if (showName && place) {
    lines.push({ h: W * 0.0335, draw: y => {
      ctx.font = `600 ${W * 0.0275}px Cinzel,serif`;
      ctx.fillStyle = INK.ink; ctx.globalAlpha = .92;
      fitText(ctx, place, CX, y, hole * 1.72);
    } });
    if (region) lines.push({ h: W * 0.0245, draw: y => {
      ctx.font = `italic ${W * 0.0195}px 'Crimson Pro',serif`;
      ctx.fillStyle = INK.light; ctx.globalAlpha = .9;
      fitText(ctx, region, CX, y, hole * 1.72);
    } });
    if (coords) lines.push({ h: W * 0.020, draw: y => {
      ctx.font = `${W * 0.0105}px Cinzel,serif`;
      ctx.fillStyle = INK.faint; ctx.globalAlpha = 1;
      ctx.fillText([...coords].join(' '), CX, y);
    } });
    lines.push({ h: W * 0.014, draw: y => {
      ctx.strokeStyle = INK.rule; ctx.globalAlpha = .8;
      ctx.lineWidth = hairline(W, 0.0009, 0.5);
      ctx.beginPath();
      ctx.moveTo(CX - hole * 0.44, y - W * 0.006);
      ctx.lineTo(CX + hole * 0.44, y - W * 0.006);
      ctx.stroke();
    } });
  }

  rows.forEach(row => {
    lines.push({ h: W * 0.0285, draw: y => {
      ctx.font = `${W * 0.0185}px 'Crimson Pro',serif`;
      ctx.fillStyle = INK.ink; ctx.globalAlpha = .88;
      ctx.fillText(row.value, CX, y);
      ctx.font = `${W * 0.0092}px Cinzel,serif`;
      ctx.fillStyle = INK.faint; ctx.globalAlpha = 1;
      ctx.fillText([...row.label.toUpperCase()].join(' '), CX, y + W * 0.0115);
    } });
    lines[lines.length - 1].h += W * 0.0075;
  });

  // Today's date closes the block, in the same brick as the radial marker — the
  // line on the wheel says *where* now is, this says what day that is.
  if (todayDOY !== null) {
    lines.push({ h: W * 0.020, draw: y => {
      ctx.font = `${W * 0.0096}px Cinzel,serif`;
      ctx.fillStyle = INK.today; ctx.globalAlpha = .85;
      drawTracked(ctx, `TODAY · ${doyLabel(todayDOY).toUpperCase()}`, CX, y + W * 0.004, W * 0.0096 * 0.22);
    } });
  }

  const total = lines.reduce((s, l) => s + l.h, 0);
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  let y = CY - total / 2 + lines[0]?.h * 0.78;
  lines.forEach(l => { l.draw(y); y += l.h; });
  ctx.restore();
}

/** fillText, shrinking the font until the string fits `maxW`. */
function fitText(ctx, text, x, y, maxW) {
  const m = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
  if (m) {
    let size = parseFloat(m[1]);
    while (ctx.measureText(text).width > maxW && size > 4) {
      size *= 0.94;
      ctx.font = ctx.font.replace(/(\d+(?:\.\d+)?)px/, `${size}px`);
    }
  }
  ctx.fillText(text, x, y);
}
