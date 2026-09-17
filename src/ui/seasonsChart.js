/**
 * The seasons modal — how this location's seasons were found.
 *
 * The seasons band states a conclusion; this shows the working. Every dataset
 * the calculation used gets its own panel, and the panels share one year that
 * runs from winter solstice to winter solstice like the wheel (ui/yearAxis.js).
 * The season changes are drawn as vertical lines through every panel, dated
 * along the top, and each season is shaded and named in its stretch of the
 * year — so a boundary can be read against the curves that put it there.
 *
 * What is plotted is exactly what computeSeasons measured: the smoothed series
 * each gate was tested on (`seasons.axes[].series`), in its own units. When the
 * year passed the four-season test the dates came from temperature alone, and
 * the temperature panel shows the two thresholds they were read off.
 */

import { RING_DEFS } from '../data/ringDefs.js';
import { ringState, currentData, seasons } from '../state.js';
import { seasonRangeLabel, QUARTET_EXTREME } from '../data/seasons.js';
import { N, doyLabel } from '../data/calendar.js';
import { openChartModal } from './ringChart.js';
import { yearAxis, closeYear, drawMonthAxis } from './yearAxis.js';

const W = 760;
const PAD = { l: 58, r: 18, t: 52, b: 34 };   // t holds the season dates and names
const PAD_T_NO_SEASONS = 16;
const padTop = () => (seasons.seasons.length ? PAD.t : PAD_T_NO_SEASONS);
const PANEL_H = 66;
const PANEL_GAP = 10;
const PAPER = '#faf7f2';

const mod = v => ((v % N) + N) % N;

// Axis position (in day-centre units, 0–365) of the boundary a season starts
// on: half a day before its first day, as its tick is on the wheel.
const boundaryAt = doy => mod(doy - 0.5);

// A season's stretch of the axis, in two pieces when it runs over the solstice.
function pieces(sn) {
  const a = boundaryAt(sn.startDOY), b = a + sn.days;
  return b <= N ? [[a, b]] : [[a, N], [0, b - N]];
}

const VALUE_FMT = {
  temp: v => `${Math.round(v)}°F`, dewpoint: v => `${Math.round(v)}°F`,
  rain: v => `${v.toFixed(2)} in`, snow: v => `${v.toFixed(1)} in`,
  evi: v => v.toFixed(2), visibility: v => `${v.toFixed(1)} mi`, cloud: v => `${Math.round(v)}%`,
};
const fmtValue = (id, v) => (VALUE_FMT[id] ?? (x => x.toFixed(1)))(v);

/** "annual range 50°F, needs 9°F" — what the gate measured and what it asked for. */
function gateText(a) {
  if (a.id === 'rain') return `seasonality index ${a.value.toFixed(2)}, needs ${a.min.toFixed(2)}`;
  const f = a.id === 'evi' ? v => v.toFixed(2) : v => fmtValue(a.id, v);
  return `annual range ${f(a.value)}, needs ${f(a.min)}`;
}

const label = id => RING_DEFS.find(r => r.id === id)?.label ?? id;

// A series that never changes (snow depth in the tropics) has nothing to show.
const isFlat = a => Math.max(...a.series) === Math.min(...a.series);

/** Which datasets to show, and the part each played. */
function shownAxes() {
  const found = seasons.seasons.length > 0;
  return seasons.axes
    // With seasons found, the ones that defined or named them. With none, every
    // dataset the gate looked at — the gate is the whole of the calculation.
    .filter(a => (!found || a.passed || a.nearMiss) && !isFlat(a))
    .map(a => ({
      ...a,
      role: a.passed ? 'defines seasons' : found ? 'names seasons only' : 'too flat to use',
    }));
}

/** Text with a paper-coloured halo, so it reads over a curve or a season's shading. */
function haloFill(ctx, text, x, y) {
  ctx.save();
  ctx.strokeStyle = PAPER; ctx.lineWidth = 3; ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);
  ctx.restore();
  ctx.fillText(text, x, y);
}

function drawSeasonsChart(canvasEl, shown) {
  const ctx = canvasEl.getContext('2d');
  const H = canvasEl.height;
  const axis = yearAxis(PAD.l, W - PAD.l - PAD.r);
  const top = padTop(), bottom = H - PAD.b;
  const sns = seasons.seasons;

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  if (!shown.length) {
    ctx.fillStyle = '#888'; ctx.font = "13px 'Crimson Pro', serif"; ctx.textAlign = 'center';
    ctx.fillText(seasons.note ?? 'Not enough data loaded yet.', W / 2, H / 2);
    return;
  }

  // ── Each season shaded through the whole stack ──
  sns.forEach(sn => pieces(sn).forEach(([a, b]) => {
    ctx.save();
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = sn.color;
    ctx.fillRect(axis.x(a), top, axis.x(b) - axis.x(a), bottom - top);
    ctx.restore();
  }));

  // ── Months, winter solstice at both ends ──
  drawMonthAxis(ctx, axis, { top, bottom, labelY: bottom + 22, dash: [0, 4] });

  // ── One panel per dataset ──
  shown.forEach((a, i) => {
    const pTop = top + i * (PANEL_H + PANEL_GAP), pBot = pTop + PANEL_H;
    const color = ringState[a.id]?.color ?? RING_DEFS.find(r => r.id === a.id)?.color ?? '#555';
    const series = closeYear(a.series);
    const lo = Math.min(...series), hi = Math.max(...series);
    const span = hi - lo || 1, pad = span * 0.12;
    const toY = v => pBot - ((v - lo + pad) / (span + 2 * pad)) * PANEL_H;

    ctx.save();
    ctx.strokeStyle = '#e2dbcf'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(axis.left, pBot + 0.5); ctx.lineTo(axis.right, pBot + 0.5); ctx.stroke();
    ctx.restore();

    // The quartet's dates are where temperature crosses these two lines.
    if (seasons.datesFrom === 'temperature' && a.id === 'temp') {
      const band = QUARTET_EXTREME * (hi - lo);
      ctx.save();
      ctx.strokeStyle = color; ctx.globalAlpha = 0.55; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      [lo + band, hi - band].forEach(v => {
        ctx.beginPath(); ctx.moveTo(axis.left, toY(v)); ctx.lineTo(axis.right, toY(v)); ctx.stroke();
      });
      ctx.restore();
    }

    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 1.7; ctx.lineJoin = 'round';
    ctx.globalAlpha = a.passed ? 0.9 : 0.55;
    if (!a.passed) ctx.setLineDash([5, 3]);
    ctx.beginPath();
    series.forEach((v, d) => (d ? ctx.lineTo(axis.x(d), toY(v)) : ctx.moveTo(axis.x(d), toY(v))));
    ctx.stroke();
    ctx.restore();

    // Scale: the curve's own highest and lowest values.
    ctx.save();
    ctx.font = '9px sans-serif'; ctx.fillStyle = '#999'; ctx.textAlign = 'right';
    ctx.fillText(fmtValue(a.id, hi), PAD.l - 5, toY(hi) + 3);
    ctx.fillText(fmtValue(a.id, lo), PAD.l - 5, toY(lo) + 3);
    ctx.restore();

    ctx.save();
    ctx.textAlign = 'left';
    ctx.font = "600 11px 'Crimson Pro', serif"; ctx.fillStyle = color;
    const title = label(a.id);
    haloFill(ctx, title, axis.left + 6, pTop + 12);
    const tw = ctx.measureText(title).width;
    ctx.font = "italic 10px 'Crimson Pro', serif"; ctx.fillStyle = '#6b5e4a';
    haloFill(ctx, ` · ${a.role} · ${gateText(a)}`, axis.left + 6 + tw, pTop + 12);
    ctx.restore();
  });

  if (!sns.length) return;

  // ── Season changes: a line through every panel, dated at the top ──
  ctx.save();
  sns.forEach(sn => {
    const x = axis.x(boundaryAt(sn.startDOY));
    ctx.strokeStyle = '#5a4e3c'; ctx.globalAlpha = 0.6; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.font = '9px sans-serif'; ctx.fillStyle = '#5a4e3c'; ctx.textAlign = 'center';
    const text = doyLabel(sn.startDOY);
    const half = ctx.measureText(text).width / 2;
    ctx.fillText(text, Math.min(W - half - 2, Math.max(half + 2, x)), 14);
  });
  ctx.restore();

  // ── Season names, in every piece of a season's stretch that can hold one —
  // a season over the solstice is named at both ends of the axis ──
  ctx.save();
  ctx.textAlign = 'center';
  sns.forEach(sn => pieces(sn).forEach(([a, b]) => {
    const x0 = axis.x(a), x1 = axis.x(b), room = x1 - x0 - 8;
    let size = 12;
    ctx.font = `600 ${size}px 'Crimson Pro', serif`;
    while (ctx.measureText(sn.name).width > room && size > 8) {
      size -= 1;
      ctx.font = `600 ${size}px 'Crimson Pro', serif`;
    }
    if (ctx.measureText(sn.name).width > room) return;
    ctx.fillStyle = sn.color;
    haloFill(ctx, sn.name, (x0 + x1) / 2, 38);
  }));
  ctx.restore();
}

/** Open the seasons modal for the location currently on the wheel. */
export function showSeasonsChart() {
  const shown = shownAxes();
  const found = seasons.seasons.length > 0;
  const H = padTop() + Math.max(1, shown.length) * PANEL_H + Math.max(0, shown.length - 1) * PANEL_GAP + PAD.b;
  const name = currentData.name ?? '';

  const method = seasons.datesFrom === 'temperature'
    ? `This year passes the four-season test, so Winter, Spring, Summer and Autumn take their dates from temperature alone: winter is the unbroken run of days within ${Math.round(QUARTET_EXTREME * 1000) / 10}% of the annual range of the coldest day, summer the same around the warmest (the dashed lines on the temperature panel), and spring and autumn fill the gaps between.`
    : seasons.datesFrom === 'segmentation'
      ? 'The season changes are where the year divides most cleanly across every dataset that defines seasons, taken together. Each season is then named for how it departs from the year’s average; a dataset that names seasons only came close to its threshold, so it may describe a season but not place one.'
      : (seasons.note ?? 'No seasons derived.');

  const unused = found ? seasons.axes.filter(a => !a.passed && !a.nearMiss && !isFlat(a)) : [];
  const flat = seasons.axes.filter(isFlat);
  // Listed in the order the chart reads, left to right: the season the winter
  // solstice falls in first.
  const axisOrder = sn => boundaryAt(sn.startDOY) + sn.days > N ? -1 : sn.startDOY;
  const seasonItems = [...seasons.seasons].sort((a, b) => axisOrder(a) - axisOrder(b)).map(sn => `
        <div class="rc-legend-item">
          <div class="rc-swatch" style="background:${sn.color};width:10px;height:10px;border-radius:2px;opacity:.8"></div>
          ${sn.name} · ${seasonRangeLabel(sn)} · ${sn.days} days
        </div>`).join('');

  const overlay = openChartModal(`
      <h2>Seasons</h2>
      <p class="rc-subtitle">${name}${name ? ' · ' : ''}winter solstice to winter solstice</p>
      <div class="rc-chart-wrap">
        <canvas class="rc-chart-canvas" width="${W}" height="${H}"></canvas>
      </div>
      ${seasonItems ? `<div class="rc-legend">${seasonItems}</div>` : ''}
      <p class="rc-subtitle" style="margin:.7rem 0 0">${method}</p>
      ${unused.length ? `<p class="rc-subtitle" style="margin:.35rem 0 0">Too flat here to use: ${
        unused.map(a => `${label(a.id)} (${gateText(a)})`).join('; ')}.</p>` : ''}
      ${flat.length ? `<p class="rc-subtitle" style="margin:.35rem 0 0">No change through the year here: ${
        flat.map(a => label(a.id)).join(', ')}.</p>` : ''}`);

  drawSeasonsChart(overlay.querySelector('.rc-chart-canvas'), shown);
}
