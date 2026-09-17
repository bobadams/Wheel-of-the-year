import { RING_DEFS } from '../data/ringDefs.js';
import { catmullRomPath } from '../draw/canvas.js';
import { yearAxis, closeYear, drawMonthAxis } from './yearAxis.js';
import {
  canvas, ringState, smoothedData, currentData,
  actuals, displayState, todayDOY,
} from '../state.js';

const CHART_W = 720, CHART_H = 280;
const PAD = { t: 24, r: 20, b: 36, l: 56 };

function niceStep(range, n) {
  const rough = range / n;
  const exp = Math.floor(Math.log10(rough));
  const frac = rough / 10 ** exp;
  return (frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10) * 10 ** exp;
}

/** The chart-modal stylesheet, shared by every chart that opens in a modal. */
export function injectChartStyles() {
  if (document.getElementById('ring-chart-css')) return;
  const s = document.createElement('style');
  s.id = 'ring-chart-css';
  s.textContent = `
.rc-overlay{position:fixed;inset:0;background:rgba(44,36,22,.55);display:flex;align-items:center;justify-content:center;z-index:9999;}
.rc-modal{background:#faf7f2;border-radius:10px;padding:1.4rem 1.6rem;max-width:860px;width:92vw;position:relative;box-shadow:0 8px 32px rgba(0,0,0,.28);}
.rc-close{position:absolute;top:.6rem;right:.9rem;background:none;border:none;font-size:1.4rem;cursor:pointer;color:#6b5e4a;line-height:1;padding:0;}
.rc-close:hover{color:#2c2416;}
.rc-modal h2{font-family:'Cinzel',serif;font-size:1.1rem;margin:0 0 .2rem;}
.rc-subtitle{font-family:'Crimson Pro',serif;font-size:.88rem;color:#888;margin:0 0 .9rem;}
.rc-chart-wrap{border:1px solid #e8e2d8;border-radius:4px;overflow:hidden;}
.rc-chart-wrap canvas{display:block;width:100%;height:auto;}
.rc-legend{display:flex;gap:1.2rem;margin-top:.65rem;flex-wrap:wrap;}
.rc-legend-item{display:flex;align-items:center;gap:.4rem;font-family:'Crimson Pro',serif;font-size:.78rem;color:#6b5e4a;}
.rc-swatch{width:24px;height:2px;border-radius:1px;flex-shrink:0;}
`;
  document.head.appendChild(s);
}

function drawLineChart(canvasEl, ringDef, normalsData, color, actualsEntries) {
  const ctx = canvasEl.getContext('2d');
  const pw = CHART_W - PAD.l - PAD.r;
  const ph = CHART_H - PAD.t - PAD.b;

  ctx.fillStyle = '#faf7f2';
  ctx.fillRect(0, 0, CHART_W, CHART_H);

  if (!Array.isArray(normalsData) || !normalsData.length) {
    ctx.fillStyle = '#888';
    ctx.font = "13px 'Crimson Pro', serif";
    ctx.textAlign = 'center';
    ctx.fillText('No data loaded for this ring', CHART_W / 2, CHART_H / 2);
    return;
  }

  // Y bounds — fixed floor (32°F for temp, 0 for everything else)
  const lo = ringDef.id === 'temp' ? 32 : 0;
  let hi = Math.max(...normalsData);
  if (actualsEntries) actualsEntries.forEach(e => { hi = Math.max(hi, e.value); });
  hi += (hi - lo) * 0.05;

  // Winter solstice to winter solstice, like the wheel (see ui/yearAxis.js).
  const axis = yearAxis(PAD.l, pw);
  const toX = axis.x;
  const toY = v => PAD.t + (1 - (v - lo) / (hi - lo)) * ph;

  // Horizontal grid lines + Y-axis tick labels
  const step = niceStep(hi - lo, 5);
  const firstTick = Math.ceil(lo / step) * step;
  ctx.textAlign = 'right';
  ctx.font = '10px sans-serif';
  ctx.fillStyle = '#999';
  for (let t = firstTick; t <= hi + step * 0.01; t += step) {
    if (t < lo) continue;
    const y = toY(t);
    ctx.save();
    ctx.strokeStyle = '#e8e2d8';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(PAD.l, y);
    ctx.lineTo(PAD.l + pw, y);
    ctx.stroke();
    ctx.restore();
    const label = ringDef.id === 'evi' ? t.toFixed(2)
      : ringDef.unit === 'in' ? t.toFixed(1)
      : Math.round(t);
    ctx.fillText(label, PAD.l - 5, y + 3.5);
  }

  // Month dividers + X-axis labels, with the winter solstice at both ends.
  drawMonthAxis(ctx, axis, { top: PAD.t, bottom: PAD.t + ph, labelY: PAD.t + ph + 22, dash: [0, 4] });

  // Today marker
  if (todayDOY != null) {
    ctx.save();
    ctx.strokeStyle = '#2c2416';
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.35;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(toX(todayDOY), PAD.t);
    ctx.lineTo(toX(todayDOY), PAD.t + ph);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.5;
    ctx.font = 'italic 9px sans-serif';
    ctx.fillStyle = '#2c2416';
    ctx.textAlign = 'center';
    ctx.fillText('today', toX(todayDOY), PAD.t - 5);
    ctx.restore();
  }

  // Normals, closed back onto the solstice at the right edge.
  const normals = closeYear(normalsData);

  // Normals area fill
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(lo));
  normals.forEach((v, i) => ctx.lineTo(toX(i), toY(v)));
  ctx.lineTo(toX(365), toY(lo));
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Normals line
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.75;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  normals.forEach((v, i) => (i ? ctx.lineTo(toX(i), toY(v)) : ctx.moveTo(toX(i), toY(v))));
  ctx.stroke();
  ctx.restore();

  // Actuals overlay
  if (actualsEntries) {
    // Deduplicate by DOY — keep the most recent reading for each day of the
    // year. Data spans ~350 days, so DOY 0–todayDOY comes from the current turn
    // of the wheel (since the last winter solstice) and DOY (todayDOY+1)–364
    // from the one before.
    const dedupMap = new Map();
    actualsEntries
      .filter(e => e.doy >= 0 && e.doy <= 364)
      .forEach(e => dedupMap.set(e.doy, e.value));
    const allEntries = Array.from(dedupMap, ([doy, value]) => ({ doy, value }))
      .sort((a, b) => a.doy - b.doy);

    if (allEntries.length) {
      // Split at todayDOY so the two halves of the year are drawn as separate
      // segments with a visible gap at today's position.
      const tDOY = todayDOY ?? -1;
      const segments = tDOY >= 0
        ? [allEntries.filter(e => e.doy <= tDOY), allEntries.filter(e => e.doy > tDOY)]
        : [allEntries];
      // The older segment runs up to Dec 20 of the previous turn, and the day
      // after that is the Dec 21 this turn opened with — so it continues to the
      // solstice at the right edge instead of stopping a day short of it.
      const older = segments[1];
      if (older?.length && allEntries[0].doy === 0) older.push({ doy: 365, value: allEntries[0].value });

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.5;
      ctx.globalAlpha = 1.0;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash([3, 3]);
      for (const s of segments) {
        if (!s.length) continue;
        ctx.beginPath();
        if (s.length < 50) {
          catmullRomPath(ctx, s.map(e => ({ x: toX(e.doy), y: toY(e.value) })));
        } else {
          ctx.moveTo(toX(s[0].doy), toY(s[0].value));
          for (let i = 1; i < s.length; i++) ctx.lineTo(toX(s[i].doy), toY(s[i].value));
        }
        ctx.stroke();
      }
      if (allEntries.length <= 30) {
        ctx.fillStyle = color;
        allEntries.forEach(e => {
          ctx.beginPath();
          ctx.arc(toX(e.doy), toY(e.value), 2.5, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      ctx.restore();
    }
  }

  // Axis frame
  ctx.save();
  ctx.strokeStyle = '#bbb';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD.l, PAD.t);
  ctx.lineTo(PAD.l, PAD.t + ph);
  ctx.lineTo(PAD.l + pw, PAD.t + ph);
  ctx.stroke();
  ctx.restore();

  // Y-axis unit label (rotated)
  ctx.save();
  ctx.translate(13, PAD.t + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.font = "11px 'Crimson Pro', serif";
  ctx.fillStyle = '#555';
  ctx.fillText(ringDef.unit, 0, 0);
  ctx.restore();
}

export function showRingChart(ringId) {
  const ringDef = RING_DEFS.find(r => r.id === ringId);
  if (!ringDef) return;

  const ringSt = ringState[ringId];
  const data = ringSt.smooth && smoothedData[ringId] ? smoothedData[ringId] : currentData[ringId];
  const color = ringSt.color;
  const cityName = currentData.name ?? '';
  const normalsLabel = currentData.meta?.[ringId]?.source ?? 'Climate normals';
  const hasActuals = actuals && displayState.actuals
    && ['temp', 'rain', 'evi', 'pm25', 'wind'].includes(ringId)
    && Array.isArray(actuals[ringId])
    && actuals[ringId].length > 0;

  const overlay = openChartModal(`
      <h2 style="color:${color}">${ringDef.label}</h2>
      <p class="rc-subtitle">${cityName}${cityName ? ' · ' : ''}${ringDef.unit}</p>
      <div class="rc-chart-wrap">
        <canvas class="rc-chart-canvas" width="${CHART_W}" height="${CHART_H}"></canvas>
      </div>
      <div class="rc-legend">
        <div class="rc-legend-item">
          <div class="rc-swatch" style="background:${color};opacity:.7"></div>
          ${normalsLabel}
        </div>
        ${hasActuals ? `<div class="rc-legend-item">
          <div class="rc-swatch" style="background:none;border-top:1.5px dashed ${color}"></div>
          Actuals (past 11 mo)
        </div>` : ''}
      </div>`);

  drawLineChart(
    overlay.querySelector('.rc-chart-canvas'),
    ringDef, data, color,
    hasActuals ? actuals[ringId] : null,
  );
}

/**
 * Open a chart modal holding `html`, replacing any chart modal already open.
 * It closes on its × button, a click on the backdrop, or Escape. Returns the
 * overlay element so the caller can find its canvas.
 */
export function openChartModal(html) {
  injectChartStyles();
  document.getElementById('ring-chart-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'ring-chart-overlay';
  overlay.className = 'rc-overlay';
  overlay.innerHTML = `<div class="rc-modal"><button class="rc-close" aria-label="Close">×</button>${html}</div>`;
  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  overlay.querySelector('.rc-close').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  return overlay;
}
