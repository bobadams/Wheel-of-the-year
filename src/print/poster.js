/**
 * Poster — a portrait, large-format print of the wheel.
 *
 * The screen wheel is an instrument you interrogate: you hover a day, toggle a
 * ring, open a chart. A poster can do none of that, so everything the pointer
 * would have told you has to be on the sheet — what each ring is, what it was
 * measured with, over what years, and how to read a band's width as a value.
 * That is what the masthead, the centre figures and the key below the wheel are
 * for; the wheel drawing itself is the same code the screen uses, pointed at a
 * much larger canvas.
 *
 * Output is a single self-contained SVG: vector at any size, with the fonts
 * embedded and the paper drawn as a filled rectangle rather than a CSS
 * background, so it survives a browser print with "background graphics" off.
 */

import { RING_DEFS, RING_LABELS } from '../data/ringDefs.js';
import { canvas, ringOrder, ringState, displayState, currentData, actuals, seasons } from '../state.js';
import { computeNormBounds } from '../draw/normalize.js';
import { paintWheel, paintPaper } from '../draw/wheel.js';
import { INK, hairline, drawTracked } from '../draw/theme.js';
import { TRAD_COLORS, TRAD_LABELS, drawSymbol } from '../draw/holidays.js';
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../draw/phenology.js';
import { coordLabel } from '../data/summary.js';
import { seasonRangeLabel } from '../data/seasons.js';
import { buildEmbeddedFontStyle, renderSVG, downloadFile, fileStem } from '../export/svg.js';

const IN = 72;                       // PDF points per inch
const MM = 72 / 25.4;

/** Portrait poster stocks, in points. */
export const POSTER_SIZES = {
  '18x24': { label: '18 × 24 in',  w: 18 * IN,  h: 24 * IN },
  '24x36': { label: '24 × 36 in',  w: 24 * IN,  h: 36 * IN },
  'A2':    { label: 'A2 · 420 × 594 mm', w: 420 * MM, h: 594 * MM },
  'A1':    { label: 'A1 · 594 × 841 mm', w: 594 * MM, h: 841 * MM },
  'A0':    { label: 'A0 · 841 × 1189 mm', w: 841 * MM, h: 1189 * MM },
};

export const DEFAULT_SIZE = '24x36';

// ─── Small typographic helpers ───────────────────────────────────────────────

/** Small-caps setting for headings and rules; drawTracked does the spacing. */
function caps(ctx, text, x, y, size, track = 0.14) {
  return drawTracked(ctx, String(text).toUpperCase(), x, y, size * track);
}

function setFont(ctx, { size, family = 'Crimson Pro', style = '', weight = '' }) {
  ctx.font = `${style} ${weight} ${size}px '${family}',serif`.replace(/\s+/g, ' ').trim();
}

/** Greedy word wrap against the current font. */
function wrapText(ctx, text, maxW) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxW) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** fillText, shrinking the size until the string fits `maxW`. */
function fitText(ctx, text, x, y, maxW, size, opts) {
  let s = size;
  setFont(ctx, { ...opts, size: s });
  while (ctx.measureText(text).width > maxW && s > 6) {
    s *= 0.95;
    setFont(ctx, { ...opts, size: s });
  }
  ctx.fillText(text, x, y);
  return s;
}

function rule(ctx, x1, x2, y, W, alpha = 1, weight = 0.0007) {
  ctx.save();
  ctx.strokeStyle = INK.rule;
  ctx.lineWidth = hairline(W, weight, 0.5);
  ctx.globalAlpha = alpha;
  ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
  ctx.restore();
}

// ─── Key content ─────────────────────────────────────────────────────────────

/** Scale range actually in force for a ring, in its own units. */
function ringRange(id, bounds) {
  const def = RING_DEFS.find(r => r.id === id);
  const b = bounds[id] ?? { lo: def.normLo, hi: def.normHi };
  const fmt = RING_LABELS[id]?.fmt ?? (v => `${v}`);
  return `${fmt(b.lo)} – ${fmt(b.hi)}`;
}

/**
 * The blocks that make up the key, as data. Each item carries an optional
 * `swatch(ctx, x, y, w, h)` painter, a title, and a detail line; the column
 * renderer below can measure them without drawing, which is what lets the wheel
 * be sized to whatever height the key leaves over.
 */
function keyBlocks(S) {
  const bounds = computeNormBounds(currentData);
  const visible = ringOrder.filter(id => ringState[id].visible);
  const meta = currentData.meta ?? {};

  // The seasons band is not a scaled ring, so it gets its own block below
  // rather than a range that would read "undefined – undefined".
  const ringItems = visible.filter(id => !RING_DEFS.find(r => r.id === id)?.categorical).map(id => {
    const def = RING_DEFS.find(r => r.id === id);
    const color = ringState[id].color;
    // The ring definition carries the short form of the provenance; the live
    // metadata is only preferred when it says something the short form would
    // hide — that this ring is a stand-in rather than the real measurement.
    const live = meta[id]?.source ?? '';
    const source = /proxy|unavailable/i.test(live) ? live : def.source;
    return {
      title: `${def.label} · ${def.unit}`,
      detail: `${ringRange(id, bounds)} · ${source}`,
      swatch: (ctx, x, y, w, h) => {
        ctx.save();
        // The swatch is the ring's own treatment in miniature: a body at the
        // same fill strength, its profile line on top, its baseline below.
        ctx.fillStyle = color; ctx.globalAlpha = 0.32;
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1; ctx.strokeStyle = color;
        ctx.lineWidth = hairline(S.W, 0.0016, 0.75);
        ctx.beginPath(); ctx.moveTo(x, y + 0.5); ctx.lineTo(x + w, y + 0.5); ctx.stroke();
        ctx.globalAlpha = 0.35; ctx.lineWidth = hairline(S.W, 0.0008, 0.4);
        ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.stroke();
        ctx.restore();
      },
    };
  });

  const markItems = [];
  markItems.push({
    title: 'Ring width',
    detail: 'A day’s value, measured out from the ring’s baseline.',
    swatch: (ctx, x, y, w, h) => {
      ctx.save();
      // A ring in cross-section: baseline, a year's worth of rise and fall
      // above it, filled the way the ring itself is filled.
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.bezierCurveTo(x + w * 0.28, y + h * 0.15, x + w * 0.55, y + h * 1.05, x + w, y + h * 0.25);
      ctx.lineTo(x + w, y + h); ctx.closePath();
      ctx.fillStyle = INK.light; ctx.globalAlpha = 0.22; ctx.fill();
      ctx.strokeStyle = INK.light; ctx.globalAlpha = 0.85;
      ctx.lineWidth = hairline(S.W, 0.0014, 0.7);
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.bezierCurveTo(x + w * 0.28, y + h * 0.15, x + w * 0.55, y + h * 1.05, x + w, y + h * 0.25);
      ctx.stroke();
      ctx.globalAlpha = 0.5; ctx.lineWidth = hairline(S.W, 0.0009, 0.5);
      ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.stroke();
      ctx.restore();
    },
  });
  markItems.push({
    title: 'Extremes',
    detail: 'Each ring’s yearly high and low, and its date.',
    swatch: (ctx, x, y, w, h) => {
      ctx.save();
      const cy = y + h / 2, r = h * 0.34;
      ctx.beginPath(); ctx.arc(x + r + 1, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = INK.paper; ctx.fill();
      ctx.strokeStyle = INK.light; ctx.lineWidth = hairline(S.W, 0.0022, 1.2); ctx.stroke();
      ctx.globalAlpha = 0.6; ctx.lineWidth = hairline(S.W, 0.0013, 0.7);
      ctx.beginPath(); ctx.moveTo(x + r * 2 + 3, cy); ctx.lineTo(x + w, cy); ctx.stroke();
      ctx.restore();
    },
  });
  if (displayState.moon) markItems.push({
    title: 'Moon',
    detail: 'Full moon filled, new moon open.',
    swatch: (ctx, x, y, w, h) => {
      ctx.save();
      const cy = y + h / 2, r = h * 0.36;
      ctx.beginPath(); ctx.arc(x + r, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = INK.moon; ctx.globalAlpha = 0.8; ctx.fill();
      ctx.beginPath(); ctx.arc(x + r * 4, cy, r * 0.78, 0, Math.PI * 2);
      ctx.strokeStyle = INK.moon; ctx.globalAlpha = 0.55;
      ctx.lineWidth = hairline(S.W, 0.0016, 1); ctx.stroke();
      ctx.restore();
    },
  });
  if (displayState.actuals && actuals) markItems.push({
    title: 'Observed year',
    detail: 'The past twelve months as measured.',
    swatch: (ctx, x, y, w, h) => {
      ctx.save();
      ctx.strokeStyle = INK.light; ctx.globalAlpha = 0.9;
      ctx.lineWidth = hairline(S.W, 0.0014, 0.9);
      ctx.lineCap = 'round';
      ctx.setLineDash([S.W * 0.009, S.W * 0.007]);
      ctx.beginPath(); ctx.moveTo(x, y + h / 2); ctx.lineTo(x + w, y + h / 2); ctx.stroke();
      ctx.restore();
    },
  });
  markItems.push({
    title: 'Today',
    detail: 'The day this sheet was made.',
    swatch: (ctx, x, y, w, h) => {
      ctx.save();
      ctx.strokeStyle = INK.today; ctx.globalAlpha = 0.8;
      ctx.lineWidth = hairline(S.W, 0.0013, 0.7);
      ctx.beginPath(); ctx.moveTo(x, y + h / 2); ctx.lineTo(x + w * 0.82, y + h / 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(x + w * 0.86, y + h / 2, h * 0.22, 0, Math.PI * 2);
      ctx.fillStyle = INK.today; ctx.globalAlpha = 0.9; ctx.fill();
      ctx.restore();
    },
  });

  const blocks = [
    { heading: 'The rings', items: ringItems },
    { heading: 'Marks', items: markItems },
  ];

  // The seasons this location actually has, printed with the dates they turn on
  // and a note saying what they were derived from — a reader looking at an
  // unfamiliar set of seasons needs to know they came from the data on the
  // sheet rather than from a calendar.
  const seasonsVisible = visible.includes('seasons');
  if (seasonsVisible && seasons.seasons.length) {
    blocks.push({
      heading: 'The seasons',
      items: seasons.seasons.map(sn => ({
        title: sn.name,
        detail: `${seasonRangeLabel(sn)} · ${sn.days} days`,
        swatch: (ctx, x, y, w, h) => {
          ctx.save();
          ctx.fillStyle = sn.color; ctx.globalAlpha = 0.42;
          ctx.fillRect(x, y, w, h);
          ctx.globalAlpha = 0.8; ctx.strokeStyle = sn.color;
          ctx.lineWidth = hairline(S.W, 0.0013, 0.7);
          ctx.strokeRect(x, y + 0.5, w, h - 1);
          ctx.restore();
        },
      })),
      note: `Derived from this location’s own normals (${seasons.basis.join(', ')}) — `
        + 'the boundaries are where the year actually turns here, not calendar dates.',
    });
  } else if (seasonsVisible && seasons.note) {
    blocks.push({
      heading: 'The seasons',
      items: [{ title: 'None found', detail: seasons.note }],
    });
  }

  if (displayState.holidays) {
    const trads = Object.keys(TRAD_COLORS).filter(t => displayState[{
      christian: 'holidayChristian', jewish: 'holidayJewish',
      wicca: 'holidayWicca', islamic: 'holidayIslamic',
    }[t]]);
    if (trads.length) blocks.push({
      heading: 'Observances',
      items: trads.map(t => ({
        title: TRAD_LABELS[t],
        swatch: (ctx, x, y, w, h) => {
          ctx.save();
          ctx.globalAlpha = 0.9;
          drawSymbol(ctx, t, x + h * 0.45, y + h / 2, h * 0.4);
          ctx.restore();
        },
      })),
      note: 'Moveable feasts are computed for this calendar year. Islamic dates follow the tabular calendar and may differ a day or two from local sighting.',
    });
  }

  if (displayState.phenology && currentData.name) {
    blocks.push({
      heading: 'Wildlife & blooms',
      items: Object.keys(CATEGORY_COLORS).map(c => ({
        title: CATEGORY_LABELS[c],
        swatch: (ctx, x, y, w, h) => {
          ctx.save();
          ctx.strokeStyle = CATEGORY_COLORS[c]; ctx.globalAlpha = 0.85;
          ctx.lineWidth = Math.max(1.2, h * 0.22); ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(x + h * 0.2, y + h / 2); ctx.lineTo(x + w * 0.9, y + h / 2); ctx.stroke();
          ctx.restore();
        },
      })),
      note: 'Each arc spans the window of a characteristic local event. A dashed arc marked * is estimated rather than anchored to nearby observations.',
    });
  }

  return blocks;
}

/**
 * The two sentences a reader needs before anything else. They run full width
 * under the wheel rather than sitting in a column, because they are addressed
 * to someone who has just looked at the picture and does not yet know that a
 * band's width is a value.
 */
const LEAD = [
  'One turn of the wheel is one year — clockwise from the winter solstice at the top, so the calendar band turns any angle on the sheet into a date. Each ring is a single measurement drawn day by day: the further a band reaches out from its own baseline, the higher that day’s value. Filled bands are long-term normals, the shape of a year in this place averaged over decades, rather than the year now in progress.',
];

// ─── Column layout ───────────────────────────────────────────────────────────

/**
 * Flatten the key's blocks into a flat list of measured rows.
 *
 * Flowing rows rather than whole blocks is what lets the key fit its columns
 * tightly: with block granularity a single tall block (the rings) sets the
 * height of the whole key, and the wheel loses the space that block wasted.
 * `keepNext` marks a row that must not be orphaned at the foot of a column.
 */
function keyRows(ctx, blocks, colW, S) {
  const units = [];

  blocks.forEach(block => {
    const rows = [];
    units.push(rows);

    rows.push({
      h: S.head * 1.6, keepNext: true,
      draw: (x, y) => {
        setFont(ctx, { size: S.head, family: 'Cinzel' });
        ctx.fillStyle = INK.light; ctx.globalAlpha = 1;
        caps(ctx, block.heading, x, y, S.head, 0.18);
        rule(ctx, x, x + colW, y + S.head * 0.55, S.W, 0.9);
      },
    });

    (block.paragraphs ?? []).forEach(p => {
      setFont(ctx, { size: S.body });
      const lines = wrapText(ctx, p, colW);
      rows.push({
        h: lines.length * S.body * 1.42 + S.body * 0.5,
        draw: (x, y) => {
          setFont(ctx, { size: S.body });
          ctx.fillStyle = INK.ink; ctx.globalAlpha = 0.88;
          lines.forEach((line, i) => ctx.fillText(line, x, y + i * S.body * 1.42));
        },
      });
    });

    (block.items ?? []).forEach(item => {
      const textX = S.swatch + S.gutter;
      const textW = colW - textX;
      setFont(ctx, { size: S.body, style: 'italic' });
      const lines = item.detail ? wrapText(ctx, item.detail, textW) : [];
      rows.push({
        h: S.title * 1.18 + lines.length * S.body * 1.34 + S.itemGap,
        draw: (x, y) => {
          item.swatch?.(ctx, x, y - S.swatchH * 0.78, S.swatch, S.swatchH);
          setFont(ctx, { size: S.title });
          ctx.fillStyle = INK.ink; ctx.globalAlpha = 0.92;
          ctx.fillText(item.title, x + textX, y);
          setFont(ctx, { size: S.body, style: 'italic' });
          ctx.fillStyle = INK.light; ctx.globalAlpha = 0.95;
          lines.forEach((line, i) =>
            ctx.fillText(line, x + textX, y + S.title * 1.18 + i * S.body * 1.34));
        },
      });
    });

    if (block.note) {
      setFont(ctx, { size: S.body, style: 'italic' });
      const lines = wrapText(ctx, block.note, colW);
      rows.push({
        h: lines.length * S.body * 1.34, keepPrev: true,
        draw: (x, y) => {
          setFont(ctx, { size: S.body, style: 'italic' });
          ctx.fillStyle = INK.faint; ctx.globalAlpha = 1;
          lines.forEach((line, i) => ctx.fillText(line, x, y + i * S.body * 1.34));
        },
      });
    }
  });

  return units;
}

/**
 * Glue rows that must not be separated into single atomic rows: a heading to
 * the row under it, a block's closing note to the row above it. Without this
 * the packer will happily start a column with an orphaned "Moveable feasts are
 * computed…" whose heading is in the previous column.
 */
function bindRows(rows) {
  const out = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    if (prev && (prev.keepNext || row.keepPrev)) {
      const a = prev, b = row, offset = a.h;
      out[out.length - 1] = {
        h: a.h + b.h,
        keepNext: b.keepNext,
        draw: (x, y) => { a.draw(x, y); b.draw(x, y + offset); },
      };
    } else {
      out.push(row);
    }
  }
  return out;
}

/**
 * Deal rows into `n` columns, minimising the height of the tallest one.
 *
 * A greedy "fill to the average" pass leaves the last column badly short,
 * which on a poster shows up as one column running a third longer than its
 * neighbours. Binary-searching the smallest workable column height and packing
 * against it costs a few lines and balances properly.
 */
function flowColumns(units, n, blockGap) {
  // A block is the unit of packing and is never split: doing so puts its
  // heading in a different column from half its entries, which is how
  // "Wildlife & blooms" once printed with three of its five categories
  // orphaned overleaf. The search therefore starts at the tallest single
  // block, so a long block simply sets the key's height (and the wheel takes
  // what is left) rather than being broken across a column boundary.
  const bound = units.map(rows => bindRows(rows));
  const height = u => u.reduce((a, r) => a + r.h, 0);

  // The gap between blocks belongs to the join, not to a block — otherwise a
  // block that begins a column carries leading space and its heading sits
  // lower than the headings beside it.
  const fits = limit => {
    let cols = 1, used = 0;
    for (const u of bound) {
      const h = height(u);
      if (used > 0 && used + blockGap + h > limit) { cols++; used = h; }
      else used += (used > 0 ? blockGap : 0) + h;
      if (cols > n) return false;
    }
    return true;
  };

  let lo = Math.max(...bound.map(height), 1);
  let hi = bound.reduce((a, u) => a + height(u), 0);
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid; else lo = mid;
  }
  const limit = hi;

  const cols = Array.from({ length: n }, () => []);
  let ci = 0, used = 0;
  for (const u of bound) {
    const h = height(u) + (used > 0 ? blockGap : 0);
    if (ci < n - 1 && used > 0 && used + h > limit) { ci++; used = 0; }
    if (used > 0) { cols[ci].push({ h: blockGap, draw: () => {} }); used += blockGap; }
    cols[ci].push(...u);
    used += height(u);
  }
  return cols;
}

const colHeight = col => col.reduce((a, r) => a + r.h, 0);

/** Draw one column's rows from `top` down. */
function drawColumn(col, x, top) {
  let y = top;
  col.forEach(row => { row.draw(x, y); y += row.h; });
}

// ─── The sheet ───────────────────────────────────────────────────────────────

function paintPoster(ctx, PW, PH) {
  const M = PW * 0.050;
  const contentW = PW - M * 2;

  // Type scale, all derived from the sheet width so every stock looks the same.
  const S = {
    W: PW,
    head:    PW * 0.0125,
    title:   PW * 0.0160,
    body:    PW * 0.0118,
    lead:    PW * 0.0138,
    swatch:  PW * 0.0300,
    swatchH: PW * 0.0135,
    gutter:  PW * 0.0110,
    itemGap: PW * 0.0098,
    blockGap: PW * 0.0215,
  };

  paintPaper(PW, PH);

  ctx.save();
  ctx.textBaseline = 'alphabetic';

  // ── Masthead ───────────────────────────────────────────────────────────────
  let y = M;
  ctx.textAlign = 'center';
  const cx = PW / 2;

  rule(ctx, M, PW - M, y, PW, 0.9, 0.0011);
  y += PW * 0.0245;

  setFont(ctx, { size: PW * 0.0155, family: 'Cinzel' });
  ctx.fillStyle = INK.light; ctx.globalAlpha = 0.9;
  caps(ctx, 'Wheel of the Year', cx, y, PW * 0.0155, 0.30);
  y += PW * 0.0590;

  const parts = (currentData.name ?? '').split(',').map(s => s.trim());
  ctx.fillStyle = INK.ink; ctx.globalAlpha = 1;
  fitText(ctx, parts[0] ?? '', cx, y, contentW, PW * 0.070, { family: 'Cinzel', weight: '600' });

  const region = parts.slice(1).join(', ');
  if (region) {
    y += PW * 0.0350;
    ctx.fillStyle = INK.light; ctx.globalAlpha = 0.95;
    fitText(ctx, region, cx, y, contentW, PW * 0.0300, { style: 'italic' });
  }

  y += PW * 0.0225;
  const meta = [
    coordLabel(currentData.lat, currentData.lon),
    'A Climate & Ecological Calendar',
    String(new Date().getFullYear()),
  ].filter(Boolean).join('  ·  ');
  setFont(ctx, { size: PW * 0.0115, family: 'Cinzel' });
  ctx.fillStyle = INK.faint; ctx.globalAlpha = 1;
  caps(ctx, meta, cx, y, PW * 0.0115, 0.16);

  y += PW * 0.0140;
  rule(ctx, M, PW - M, y, PW, 0.9, 0.0011);

  const mastheadBottom = y;

  // ── Footer, measured from the bottom up ───────────────────────────────────
  const footTop = PH - M - PW * 0.0150;
  ctx.textAlign = 'center';
  setFont(ctx, { size: PW * 0.0100, style: 'italic' });
  ctx.fillStyle = INK.faint; ctx.globalAlpha = 1;
  const sources = 'Climate normals: ECMWF ERA5 via Open-Meteo · Vegetation: NASA MODIS MOD13Q1 '
    + '· Air quality: Copernicus CAMS · Geocoding: OpenStreetMap Nominatim';
  ctx.fillText(sources, cx, footTop + PW * 0.0125);
  rule(ctx, M, PW - M, footTop, PW, 0.7);

  setFont(ctx, { size: PW * 0.0095, family: 'Cinzel' });
  ctx.textAlign = 'left';
  const drawn = new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
  caps(ctx, `Drawn ${drawn}`, M, footTop - PW * 0.0075, PW * 0.0095, 0.16);
  ctx.textAlign = 'right';
  caps(ctx, siteLabel(), PW - M, footTop - PW * 0.0075, PW * 0.0095, 0.16);

  // ── Key ───────────────────────────────────────────────────────────────────
  // Four columns of roughly one alphabet and a half — a readable measure at
  // this width — with the reading instructions set full width above them. The
  // key is laid out first so the wheel can take whatever height is left over.
  const gapTop   = mastheadBottom + PW * 0.016;
  const keyFloor = footTop - PW * 0.026;

  const N_COLS = 4;
  const gut  = PW * 0.028;
  const colW = (contentW - gut * (N_COLS - 1)) / N_COLS;
  const cols = flowColumns(keyRows(ctx, keyBlocks(S), colW, S), N_COLS, S.blockGap);
  const colH = Math.max(...cols.map(colHeight));

  setFont(ctx, { size: S.lead, style: 'italic' });
  const leadW = contentW * 0.72;
  const leadLines = LEAD.flatMap((p, i) => [...wrapText(ctx, p, leadW), ...(i < LEAD.length - 1 ? [''] : [])]);
  const leadH = leadLines.length * S.lead * 1.45 + PW * 0.018;

  const keyTop = keyFloor - colH;
  const leadTop = keyTop - leadH;

  ctx.textAlign = 'center';
  ctx.fillStyle = INK.ink; ctx.globalAlpha = 0.86;
  setFont(ctx, { size: S.lead, style: 'italic' });
  leadLines.forEach((line, i) => ctx.fillText(line, cx, leadTop + i * S.lead * 1.45));
  rule(ctx, cx - leadW / 2, cx + leadW / 2, leadTop - S.lead * 1.6, PW, 0.8);

  ctx.textAlign = 'left';
  cols.forEach((col, i) => drawColumn(col, M + i * (colW + gut), keyTop));

  const wheelBox = leadTop - S.lead * 1.6 - PW * 0.020 - gapTop;
  const wheelW   = Math.min(contentW, wheelBox);

  // ── The wheel ─────────────────────────────────────────────────────────────
  // Point the shared canvas state at a square region of the sheet; every draw
  // module works in fractions of canvas.W, so this is the whole of "scaling".
  const saved = { W: canvas.W, H: canvas.H, CX: canvas.CX, CY: canvas.CY, print: canvas.print };
  canvas.W  = wheelW;
  canvas.H  = wheelW;
  canvas.CX = PW / 2;
  canvas.CY = gapTop + wheelBox / 2;
  canvas.print = true;
  try {
    // The masthead already names the place, so the centre gives its space over
    // to the figures instead of repeating it.
    paintWheel({ center: { showName: false } });
  } finally {
    Object.assign(canvas, saved);
  }

  ctx.restore();
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Render the poster and open it in a print window, sized so a browser's
 * "Save as PDF" produces a PDF of exactly the chosen stock.
 *
 * @param {string} sizeKey  a key of POSTER_SIZES
 * @returns {Promise<void>}
 */
export async function printPoster(sizeKey = DEFAULT_SIZE) {
  const size = POSTER_SIZES[sizeKey] ?? POSTER_SIZES[DEFAULT_SIZE];

  // Metrics drive every placement decision below, so make sure the real faces
  // are loaded before anything is measured.
  if (document.fonts?.ready) await document.fonts.ready;
  const fontStyle = await buildEmbeddedFontStyle();

  const svg = renderSVG(size.w, size.h, ctx => paintPoster(ctx, size.w, size.h), fontStyle);
  const name = `${fileStem(currentData.name)}-poster-${sizeKey}`;

  const win = window.open('', '_blank');
  if (!win) {
    // Popup blocked — hand over the file instead of failing silently.
    downloadFile(svg, `${name}.svg`, 'image/svg+xml');
    throw new Error('Pop-up blocked — the poster was downloaded as an SVG instead.');
  }

  // Write the shell, then graft the drawing on as parsed DOM.
  //
  // Passing the SVG through document.write does not survive: at this size the
  // parser takes the markup in chunks, and the break lands inside the foreign
  // content — the sheet arrives holding its <defs> and nothing else, and prints
  // as a blank page of exactly the right dimensions. Parsing it as XML and
  // importing the root node hands the window the same tree the file has.
  win.document.open();
  win.document.write(printShell(size, sizeKey));
  win.document.close();

  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) throw new Error('The poster could not be composed.');
  win.document.querySelector('.sheet').appendChild(win.document.importNode(parsed.documentElement, true));
  win.__posterReady?.(svg, `${name}.svg`);
}

/** Download the poster as a print-ready SVG, without going via a print dialog. */
export async function downloadPosterSVG(sizeKey = DEFAULT_SIZE) {
  const size = POSTER_SIZES[sizeKey] ?? POSTER_SIZES[DEFAULT_SIZE];
  if (document.fonts?.ready) await document.fonts.ready;
  const fontStyle = await buildEmbeddedFontStyle();
  const svg = renderSVG(size.w, size.h, ctx => paintPoster(ctx, size.w, size.h), fontStyle);
  downloadFile(svg, `${fileStem(currentData.name)}-poster-${sizeKey}.svg`, 'image/svg+xml');
}

/**
 * The print window's shell: the poster on screen at a readable scale, a toolbar
 * that does not print, and an @page rule that puts the exact stock size into
 * the print dialog so "Save as PDF" needs no further setting.
 *
 * The drawing is not part of this markup — printPoster appends it as parsed DOM
 * and then calls `__posterReady`, which wires the download button and opens the
 * dialog once the embedded faces have decoded.
 */
function printShell(size, sizeKey) {
  const title = `${currentData.name ?? 'Wheel of the Year'} — ${POSTER_SIZES[sizeKey].label}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  @page { size: ${size.w}pt ${size.h}pt; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #6f6a61; }
  .bar {
    position: sticky; top: 0; z-index: 10;
    display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;
    padding: .7rem 1.1rem; background: #221e18; color: #efe9dd;
    font: 14px/1.5 Georgia, serif;
  }
  .bar b { font-weight: 600; letter-spacing: .04em; }
  .bar span { opacity: .72; }
  .bar button {
    font: inherit; font-size: 13px; cursor: pointer;
    background: #efe9dd; color: #221e18; border: 0; border-radius: 3px; padding: .35rem .9rem;
  }
  .bar button.ghost { background: transparent; color: #efe9dd; border: 1px solid #6f675a; }
  .sheet { margin: 1.6rem auto; width: min(94vw, ${Math.round(size.w)}pt); box-shadow: 0 10px 50px rgba(0,0,0,.45); }
  .sheet svg { display: block; width: 100%; height: auto; }
  @media print {
    html, body { background: #fff; }
    .bar { display: none; }
    .sheet { margin: 0; width: ${size.w}pt; height: ${size.h}pt; box-shadow: none; }
    .sheet svg { width: ${size.w}pt; height: ${size.h}pt; }
  }
</style></head>
<body>
  <div class="bar">
    <b>${escapeHtml(POSTER_SIZES[sizeKey].label)} portrait</b>
    <span>In the print dialog choose <b>Save as PDF</b>, paper size <b>${escapeHtml(POSTER_SIZES[sizeKey].label)}</b>, margins <b>none</b>.</span>
    <button onclick="window.print()">Print / Save as PDF</button>
    <button class="ghost" id="dl">Download SVG</button>
  </div>
  <div class="sheet"></div>
  <script>
    window.__posterReady = function (svgText, filename) {
      document.getElementById('dl').addEventListener('click', function () {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
        a.download = filename;
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      });
      // Give the embedded faces a moment to decode before the dialog measures the page.
      (document.fonts ? document.fonts.ready : Promise.resolve())
        .then(function () { setTimeout(function () { window.print(); }, 300); });
    };
  <\/script>
</body></html>`;
}

/** Where this sheet came from, for the footer — the app's own address. */
function siteLabel() {
  try {
    const { host, pathname } = window.location;
    if (!host || host.startsWith('localhost') || host.startsWith('127.')) return 'Wheel of the Year';
    return `${host}${pathname}`.replace(/\/index\.html$/, '').replace(/\/$/, '');
  } catch {
    return 'Wheel of the Year';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
