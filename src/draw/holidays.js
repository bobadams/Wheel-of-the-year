/**
 * Holidays ring — Christianity, Judaism, Wicca, Islam
 *
 * Holiday positions are calculated for the current Gregorian calendar year so
 * that moveable feasts (Easter, Passover, Rosh Hashanah, Islamic dates, etc.)
 * always reflect the actual dates.  Fixed feasts and Wiccan sabbats use their
 * fixed calendar dates.  The year is derived from new Date().getFullYear() at
 * draw time.
 */

import { canvas, displayState } from '../state.js';
import { doy2angle, polar } from './canvas.js';

const TRAD_STATE_KEY = {
  christian: 'holidayChristian',
  jewish:    'holidayJewish',
  wicca:     'holidayWicca',
  islamic:   'holidayIslamic',
};

// ─── Calendar helpers ─────────────────────────────────────────────────────────

// Month lengths for a non-leap 365-day year (DOY is 0-indexed, Feb 29 excluded)
const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Convert a Gregorian month (1-based) + day to a 0-indexed DOY (0–364). */
function dateToDOY(month, day) {
  let d = 0;
  for (let m = 0; m < month - 1; m++) d += DIM[m];
  // Clamp to 364 so dates in leap years never fall outside array bounds
  return Math.min(d + day - 1, 364);
}

// ─── Easter (Anonymous Gregorian / Meeus algorithm) ──────────────────────────

/** Returns the 0-indexed DOY of Easter Sunday for the given Gregorian year. */
function easterDOY(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day   = ((h + l - 7 * m + 114) % 31) + 1;
  return dateToDOY(month, day);
}

// ─── Shared JDN → Gregorian conversion ───────────────────────────────────────

/** Convert a Julian Day Number to a Gregorian {year, month, day}. */
function jdnToGregorian(jdn) {
  const l  = jdn + 68569;
  const n  = Math.floor(4 * l / 146097);
  const l2 = l - Math.floor((146097 * n + 3) / 4);
  const i  = Math.floor(4000 * (l2 + 1) / 1461001);
  const l3 = l2 - Math.floor(1461 * i / 4) + 31;
  const j  = Math.floor(80 * l3 / 2447);
  const day   = l3 - Math.floor(2447 * j / 80);
  const l4    = Math.floor(j / 11);
  const month = j + 2 - 12 * l4;
  const year  = 100 * (n - 49) + i + l4;
  return { year, month, day };
}

// ─── Hebrew calendar ──────────────────────────────────────────────────────────
// Based on the traditional molad-based calculation.
// Epoch: JDN 347997 = 1 Tishrei, Year 1 AM (proleptic Julian calendar)

const H_EPOCH = 347997;

function isHebrewLeap(y) { return ((7 * y + 1) % 19) < 7; }

/**
 * Compute the elapsed whole days from the Hebrew epoch to the start (molad)
 * of Hebrew year y, before postponement rules are applied.
 */
function hebrewElapsed(y) {
  const m = Math.floor((235 * y - 234) / 19); // months elapsed before year y
  const parts = 12084 + 13753 * m;
  let day = 29 * m + Math.floor(parts / 25920);
  // ADU postponement: year cannot start on Sunday (1), Wednesday (4), or Friday (6)
  if (((3 * (day + 1)) % 7) < 3) day++;
  return day;
}

/** Additional days added to hebrewElapsed to prevent certain year lengths. */
function hebrewDelay(y) {
  const d0 = hebrewElapsed(y - 1);
  const d1 = hebrewElapsed(y);
  const d2 = hebrewElapsed(y + 1);
  if (d2 - d1 === 356) return 2; // would create too-long following year
  if (d1 - d0 === 382) return 1; // would create too-long current year
  return 0;
}

/** JDN of 1 Tishrei (Rosh Hashanah) of Hebrew year y. */
function hebrewNewYear(y) {
  return H_EPOCH + hebrewElapsed(y) + hebrewDelay(y);
}

/** Length in days of Hebrew year y. */
function hebrewYearDays(y) {
  return hebrewNewYear(y + 1) - hebrewNewYear(y);
}

/**
 * Length of month m in Hebrew year y.
 * Month numbering: Nisan=1…Elul=6, Tishrei=7…Adar=12, Adar II=13 (leap).
 */
function hebrewMonthLen(y, m) {
  // Always 29: Iyar(2), Tammuz(4), Elul(6), Tevet(10), Adar II(13)
  if (m === 2 || m === 4 || m === 6 || m === 10 || m === 13) return 29;
  // Adar in a non-leap year: 29
  if (m === 12 && !isHebrewLeap(y)) return 29;
  const yd = hebrewYearDays(y);
  // Heshvan(8): 30 only in a "complete" year (355 or 385 days)
  if (m === 8) return (yd % 10 === 5) ? 30 : 29;
  // Kislev(9): 29 only in a "deficient" year (353 or 383 days)
  if (m === 9) return (yd % 10 === 3) ? 29 : 30;
  return 30; // Nisan(1), Sivan(3), Av(5), Tishrei(7), Shevat(11), Adar I(12 leap)
}

/** Convert a Hebrew date (year, month, day) to a Julian Day Number. */
function hebrewToJDN(hy, hm, hd) {
  let jdn = hebrewNewYear(hy) + hd - 1;
  const lastM = isHebrewLeap(hy) ? 13 : 12;
  if (hm < 7) {
    // Months from Tishrei(7) to end of year, then up to hm
    for (let m = 7; m <= lastM; m++) jdn += hebrewMonthLen(hy, m);
    for (let m = 1; m < hm; m++)    jdn += hebrewMonthLen(hy, m);
  } else {
    for (let m = 7; m < hm; m++)    jdn += hebrewMonthLen(hy, m);
  }
  return jdn;
}

/**
 * Return the 0-indexed DOY in the given Gregorian year for a Hebrew date.
 * (hm/hd belong to the same Hebrew year that contains that Gregorian year's
 * spring or autumn, as controlled by the caller.)
 */
function hebrewDOY(hy, hm, hd) {
  const { month, day } = jdnToGregorian(hebrewToJDN(hy, hm, hd));
  return dateToDOY(month, day);
}

// ─── Islamic (Hijri) calendar ─────────────────────────────────────────────────
// Tabular Islamic calendar (civil epoch). Dates may differ 1–2 days from
// actual crescent-sighting practice, which varies by country.
//
// Epoch: JDN 1948439 = 1 Muharram 1 AH (Friday, 16 July 622 CE Julian)
// Month lengths: odd months = 30 days, even months = 29 days;
//   Dhul Hijjah (12) = 30 in leap years.
// Leap years in 30-yr cycle: 2,5,7,10,13,16,18,21,24,26,29

const I_EPOCH = 1948439;

/**
 * Convert a Hijri date (year, month, day) to a Julian Day Number.
 * Formula: JDN = I_EPOCH + (Y-1)*354 + floor((3+11*Y)/30)
 *              + 29*(M-1) + floor(M/2) + D - 1
 */
function islamicToJDN(iy, im, id) {
  return I_EPOCH
    + (iy - 1) * 354
    + Math.floor((3 + 11 * iy) / 30)
    + 29 * (im - 1)
    + Math.floor(im / 2)
    + id - 1;
}

/**
 * Return the 0-indexed DOY for a Hijri date, or null if that date falls
 * outside the target Gregorian year.
 */
function islamicDOY(iy, im, id, gregYear) {
  const { year, month, day } = jdnToGregorian(islamicToJDN(iy, im, id));
  return year === gregYear ? dateToDOY(month, day) : null;
}

// ─── Holiday list ─────────────────────────────────────────────────────────────

/**
 * Returns an array of { doy, label, trad } objects for the given Gregorian year.
 *
 * Hebrew year mapping:
 *   Spring holidays (Nisan/Sivan): Hebrew year = Gregorian year + 3760
 *   Autumn/winter holidays (Tishrei/Kislev): Hebrew year = Gregorian year + 3761
 *
 * Islamic year mapping:
 *   The Hijri year regresses ~11 days/yr vs Gregorian, so two Hijri years
 *   partially overlap each Gregorian year. For each feast we try the estimated
 *   base year ±1 and keep whichever date falls within the target year.
 */
export function getHolidays(year) {
  const e        = easterDOY(year);
  const hy_spr   = year + 3760; // Hebrew year for spring feasts in this Gregorian year
  const hy_fall  = year + 3761; // Hebrew year for autumn feasts in this Gregorian year

  // Estimated Hijri year whose start falls nearest to this Gregorian year
  const iy_base  = Math.round((year - 621.5) * 365.25 / 354.367);

  const holidays = [
    // ── Christianity ─────────────────────────────────────────────────────────
    { doy: dateToDOY(1,  6),  label: 'Epiphany',   trad: 'christian' },
    { doy: e - 46,            label: 'Ash Wed',     trad: 'christian' },
    { doy: e - 7,             label: 'Palm Sun',    trad: 'christian' },
    { doy: e - 2,             label: 'Good Fri',    trad: 'christian' },
    { doy: e,                 label: 'Easter',      trad: 'christian' },
    { doy: e + 49,            label: 'Pentecost',   trad: 'christian' },
    { doy: dateToDOY(11, 1),  label: 'All Saints',  trad: 'christian' },
    { doy: dateToDOY(12, 25), label: 'Christmas',   trad: 'christian' },

    // ── Judaism ───────────────────────────────────────────────────────────────
    { doy: hebrewDOY(hy_spr, 11, 15), label: "Tu B'Shevat", trad: 'jewish' },
    { doy: hebrewDOY(hy_spr,  1, 15), label: 'Passover',    trad: 'jewish' },
    { doy: hebrewDOY(hy_spr,  3,  6), label: 'Shavuot',     trad: 'jewish' },
    { doy: hebrewDOY(hy_fall, 7,  1), label: 'Rosh H.',     trad: 'jewish' },
    { doy: hebrewDOY(hy_fall, 7, 10), label: 'Yom Kip.',    trad: 'jewish' },
    { doy: hebrewDOY(hy_fall, 7, 15), label: 'Sukkot',      trad: 'jewish' },
    { doy: hebrewDOY(hy_fall, 9, 25), label: 'Hanukkah',    trad: 'jewish' },

    // ── Wicca / Pagan (eight Sabbats) ────────────────────────────────────────
    { doy: dateToDOY(2,  1),  label: 'Imbolc',     trad: 'wicca' },
    { doy: dateToDOY(3, 20),  label: 'Ostara',     trad: 'wicca' },
    { doy: dateToDOY(5,  1),  label: 'Beltane',    trad: 'wicca' },
    { doy: dateToDOY(6, 21),  label: 'Litha',      trad: 'wicca' },
    { doy: dateToDOY(8,  1),  label: 'Lughnasadh', trad: 'wicca' },
    { doy: dateToDOY(9, 22),  label: 'Mabon',      trad: 'wicca' },
    { doy: dateToDOY(10, 31), label: 'Samhain',    trad: 'wicca' },
    { doy: dateToDOY(12, 21), label: 'Yule',       trad: 'wicca' },
  ];

  // ── Islam ─────────────────────────────────────────────────────────────────
  // Two Hijri years can overlap a single Gregorian year, so for each feast we
  // try iy_base-1, iy_base, and iy_base+1, keeping the first that lands in year.
  const ISLAMIC_DEFS = [
    { im: 1,  id: 1,  label: 'Islamic\nNew Year' },
    { im: 3,  id: 12, label: 'Mawlid'            },
    { im: 9,  id: 1,  label: 'Ramadan'           },
    { im: 10, id: 1,  label: 'Eid al-Fitr'       },
    { im: 12, id: 10, label: 'Eid al-Adha'       },
  ];
  for (const { im, id, label } of ISLAMIC_DEFS) {
    for (const delta of [0, -1, 1]) {
      const doy = islamicDOY(iy_base + delta, im, id, year);
      if (doy !== null) { holidays.push({ doy, label, trad: 'islamic' }); break; }
    }
  }

  // Wrap any negative DOYs (e.g. Ash Wed in very early Easter years)
  return holidays.map(h => ({ ...h, doy: ((h.doy % 365) + 365) % 365 }));
}

// ─── Glyph support detection ──────────────────────────────────────────────────

// Render ⛤ and a plain outlined square (U+25A1 — the typical tofu shape) to an
// offscreen canvas and compare pixels. If they're identical the system has no
// font that covers U+26E4, so we fall back to the drawn path.
function glyphOk(char) {
  const size = 24;
  const oc = document.createElement('canvas');
  oc.width = size * 2; oc.height = size;
  const ctx = oc.getContext('2d');
  ctx.font = `${size}px serif`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#000';
  ctx.fillText(char, 0,    0);
  ctx.fillText('□',  size, 0); // WHITE SQUARE — matches typical tofu-box outline
  const a = ctx.getImageData(0,    0, size, size).data;
  const b = ctx.getImageData(size, 0, size, size).data;
  return !Array.from(a).every((v, i) => v === b[i]);
}

let _pentagramGlyphOk = null;
function pentagramGlyphOk() {
  if (_pentagramGlyphOk === null) _pentagramGlyphOk = glyphOk('⛤');
  return _pentagramGlyphOk;
}

let _crescentGlyphOk = null;
function crescentGlyphOk() {
  if (_crescentGlyphOk === null) _crescentGlyphOk = glyphOk('☪');
  return _crescentGlyphOk;
}

let _crossGlyphOk = null;
function crossGlyphOk() {
  if (_crossGlyphOk === null) _crossGlyphOk = glyphOk('✝');
  return _crossGlyphOk;
}

let _mogenDavidGlyphOk = null;
function mogenDavidGlyphOk() {
  if (_mogenDavidGlyphOk === null) _mogenDavidGlyphOk = glyphOk('✡');
  return _mogenDavidGlyphOk;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

export const TRAD_COLORS = {
  christian: '#9b2335', // deep crimson
  jewish:    '#1a4fa0', // cobalt blue
  wicca:     '#2e7d32', // forest green
  islamic:   '#c68400', // golden amber
};

/**
 * Draw a tradition-specific symbol centred at (x, y) with bounding radius r.
 * ctx save/restore is handled internally.
 */
function drawSymbol(ctx, trad, x, y, r) {
  ctx.save();
  ctx.strokeStyle = TRAD_COLORS[trad];
  ctx.lineWidth   = Math.max(0.8, r * 0.45);
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';

  if (trad === 'christian') {
    if (crossGlyphOk()) {
      // U+271D LATIN CROSS glyph
      ctx.fillStyle = TRAD_COLORS[trad];
      ctx.font = `${r * 2.4}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✝', x, y);
    } else {
      // Drawn fallback: Latin cross
      ctx.beginPath();
      ctx.moveTo(x,           y - r);
      ctx.lineTo(x,           y + r);
      ctx.moveTo(x - r * 0.6, y - r * 0.15);
      ctx.lineTo(x + r * 0.6, y - r * 0.15);
      ctx.stroke();
    }

  } else if (trad === 'jewish') {
    if (mogenDavidGlyphOk()) {
      // U+2721 STAR OF DAVID glyph
      ctx.fillStyle = TRAD_COLORS[trad];
      ctx.font = `${r * 2.4}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✡', x, y);
    } else {
      // Drawn fallback: two interlocking equilateral triangles
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const a  = (pass === 0 ? -Math.PI / 2 : Math.PI / 2) + i * (2 * Math.PI / 3);
          const px = x + r * Math.cos(a);
          const py = y + r * Math.sin(a);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }

  } else if (trad === 'wicca') {
    if (pentagramGlyphOk()) {
      // U+26E4 PENTAGRAM glyph — outlined star with internal crossing lines
      ctx.fillStyle = TRAD_COLORS[trad];
      ctx.font = `${r * 2.4}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⛤', x, y);
    } else {
      // Drawn fallback: thin-stroke pentagram so the internal crossing lines show
      ctx.lineWidth = Math.max(0.5, r * 0.18);
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const a  = -Math.PI / 2 + i * (4 * Math.PI / 5); // 144° step = pentagram
        const px = x + r * Math.cos(a);
        const py = y + r * Math.sin(a);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }

  } else if (trad === 'islamic') {
    if (crescentGlyphOk()) {
      // U+262A STAR AND CRESCENT glyph
      ctx.fillStyle = TRAD_COLORS[trad];
      ctx.font = `${r * 2.4}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('☪', x, y);
    } else {
      // Drawn fallback: Rub el Hizb — two interlocking squares rotated 45° apart
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const a  = pass * (Math.PI / 4) + i * (Math.PI / 2);
          const px = x + r * Math.cos(a);
          const py = y + r * Math.sin(a);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }
  }

  ctx.restore();
}

/**
 * Draw all holiday markers for the current calendar year.
 * Call this after all ring/decoration drawing is complete.
 */
export function drawHolidays() {
  const { ctx, W, CX, CY } = canvas;
  const year = new Date().getFullYear();

  const R_MARK    = W * 0.465; // centre of symbol
  const R_LABEL   = W * 0.481; // default centre of rotated text
  const SYM_R     = W * 0.0055;
  const FONT_SIZE = W * 0.012;
  // Step must exceed the radial-overlap threshold (FONT_SIZE + 2) so that
  // labels placed one step apart are guaranteed to clear each other radially.
  const STEP      = FONT_SIZE + 3;
  // Floor: label centre must clear the outer edge of the symbol marker plus
  // half the label height and a small gap, so shifted labels never cover markers.
  const MIN_R     = R_MARK + SYM_R + FONT_SIZE / 2 + 2;
  // Prefer outward shifts; filter any candidate that would fall below the floor.
  const CANDIDATES = [0, +1, +2, +3].map(n => R_LABEL + n * STEP).filter(r => r >= MIN_R);

  ctx.save();

  // Filter to visible holidays and attach pre-computed angles + text widths.
  ctx.font = `${FONT_SIZE}px 'Crimson Pro',serif`;
  const items = getHolidays(year)
    .filter(h => displayState[TRAD_STATE_KEY[h.trad]])
    .map(h => {
      const text = h.label.replace('\n', ' ');
      return { ...h, a: doy2angle(h.doy + 0.5), text, textW: ctx.measureText(text).width, labelR: R_LABEL };
    });

  // Sort by angle so the greedy pass processes labels in wheel order.
  items.sort((a, b) => a.a - b.a);

  // Two labels collide when they overlap both tangentially (arc-length) and radially.
  function collides(a, b) {
    let dAngle = Math.abs(a.a - b.a);
    if (dAngle > Math.PI) dAngle = 2 * Math.PI - dAngle;
    return dAngle * Math.min(a.labelR, b.labelR) < (a.textW + b.textW) / 2 + 2
        && Math.abs(a.labelR - b.labelR) < FONT_SIZE + 2;
  }

  // Greedy: for each label try each candidate radius until one is collision-free.
  const placed = [];
  for (const item of items) {
    for (const r of CANDIDATES) {
      if (!placed.some(p => collides({ ...item, labelR: r }, p))) {
        item.labelR = r;
        break;
      }
    }
    placed.push(item);
  }

  // Draw symbols first (no label radius needed).
  for (const h of items) {
    const [sx, sy] = polar(CX, CY, h.a, R_MARK);
    ctx.globalAlpha = 0.82;
    drawSymbol(ctx, h.trad, sx, sy, SYM_R);
  }

  // Draw labels at their resolved radii.
  for (const h of items) {
    const [lx, ly] = polar(CX, CY, h.a, h.labelR);
    ctx.save();
    ctx.globalAlpha  = 0.72;
    ctx.fillStyle    = TRAD_COLORS[h.trad];
    ctx.font         = `${FONT_SIZE}px 'Crimson Pro',serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(lx, ly);
    ctx.rotate(h.a + Math.PI / 2);
    ctx.fillText(h.text, 0, 0);
    ctx.restore();
  }

  ctx.restore();
}
