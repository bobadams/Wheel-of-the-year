import { canvas, currentData, actuals, todayDOY } from '../state.js';
import { doy2angle, polar } from './canvas.js';

export const DIM     = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MON_S   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const MON_L   = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function computeMoonPhases(year) {
  const SYNODIC = 29.530588853;
  const msPerDay = 86400000;
  const j2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
  const startJD = 2451545.0 + (Date.UTC(year, 0, 1) - j2000) / msPerDay;
  const endJD   = 2451545.0 + (Date.UTC(year + 1, 0, 1) - j2000) / msPerDay;
  const refJD = 2451550.09765; // Meeus k=0 mean new moon (Jan 6, 2000 14:21 UTC)
  const kStart = Math.floor((startJD - refJD) / SYNODIC) - 1;
  const newMoons = [], fullMoons = [];
  for (let k = kStart; k <= kStart + 15; k++) {
    const newJD  = refJD + k * SYNODIC;
    const fullJD = refJD + (k + 0.5) * SYNODIC;
    if (newJD  >= startJD && newJD  < endJD) newMoons.push( Math.floor(newJD  - startJD));
    if (fullJD >= startJD && fullJD < endJD) fullMoons.push(Math.floor(fullJD - startJD));
  }
  return { newMoons, fullMoons };
}

const { newMoons: MOON_NEW, fullMoons: MOON_FULL } = computeMoonPhases(new Date().getFullYear());

export function drawMoon() {
  const { ctx, W, CX, CY } = canvas;
  const r = W * .430, dr = W * .009;
  ctx.save();
  // +0.5 centers each marker on the middle of its day's arc, matching the
  // convention used by min/max, today-dot, and actuals overlays.
  MOON_FULL.forEach(d => {
    const a = doy2angle(d + 0.5);
    const [x, y] = polar(CX, CY, a, r);
    ctx.beginPath(); ctx.arc(x, y, dr, 0, Math.PI * 2);
    ctx.fillStyle = '#8e7cc3'; ctx.globalAlpha = .85; ctx.fill();
  });
  MOON_NEW.forEach(d => {
    const a = doy2angle(d + 0.5);
    const [x, y] = polar(CX, CY, a, r);
    ctx.beginPath(); ctx.arc(x, y, dr * .65, 0, Math.PI * 2);
    ctx.strokeStyle = '#8e7cc3'; ctx.lineWidth = 1.2; ctx.globalAlpha = .6; ctx.stroke();
  });
  ctx.restore();
}

export function drawTicks() {
  const { ctx, W, CX, CY } = canvas;
  const tr = W * .444, lr = W * .463;
  ctx.save();
  ctx.strokeStyle = '#b0a090'; ctx.lineWidth = 1; ctx.globalAlpha = .55;
  let doy = 0;
  MON_S.forEach((m, i) => {
    const a = doy2angle(doy);
    const [x1, y1] = polar(CX, CY, a, tr - W * .012);
    const [x2, y2] = polar(CX, CY, a, tr);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    const ma = doy2angle(doy + DIM[i] / 2);
    const [lx, ly] = polar(CX, CY, ma, lr);
    ctx.save();
    ctx.globalAlpha = .85;
    ctx.font = `${W * .021}px Cinzel,serif`;
    ctx.fillStyle = '#6b5e4a';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.translate(lx, ly); ctx.rotate(ma + Math.PI / 2);
    ctx.fillText(m, 0, 0);
    ctx.restore();
    doy += DIM[i];
  });
  ctx.restore();
}

export function drawAxes() {
  const { ctx, W, CX, CY } = canvas;
  const R = W * .485;
  // Cardinal-point DOYs use +0.5 so the axis line passes through the *center*
  // of each solstice/equinox day (matching the ring arc convention) and so the
  // winter-solstice endpoint (d=353.5) lands exactly on the top of the wheel
  // defined by SOLSTICE_OFFSET. Paired endpoints are 182.5 days apart, so each
  // line is exactly a diameter through the center.
  const WINTER = 353.5; // Dec 20 midday
  const SUMMER = 171.0; // opposite of WINTER on a 365-day wheel
  const SPRING =  79.75; // perpendicular to solstice axis (≈ Mar 20 evening)
  const AUTUMN = 262.25; // perpendicular to solstice axis (≈ Sep 19 evening)
  ctx.save();
  ctx.strokeStyle = '#2c2416'; ctx.lineWidth = .8; ctx.globalAlpha = .28; ctx.setLineDash([3, 4]);
  [[SUMMER, WINTER], [SPRING, AUTUMN]].forEach(([a, b]) => {
    const [ax, ay] = polar(CX, CY, doy2angle(a), R);
    const [bx, by] = polar(CX, CY, doy2angle(b), R);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  });
  ctx.setLineDash([]); ctx.restore();
  ctx.save();
  ctx.font = `italic ${W * .019}px 'Crimson Pro',serif`;
  ctx.fillStyle = '#2c2416'; ctx.globalAlpha = .48; ctx.textAlign = 'center';
  const ld = W * .455;
  [
    { doy: SUMMER, t: 'Summer\nSolstice' },
    { doy: WINTER, t: 'Winter\nSolstice' },
    { doy: SPRING, t: 'Spring\nEquinox'  },
    { doy: AUTUMN, t: 'Autumn\nEquinox'  },
  ].forEach(({ doy, t }) => {
    const [lx, ly] = polar(CX, CY, doy2angle(doy), ld);
    t.split('\n').forEach((line, li, arr) =>
      ctx.fillText(line, lx, ly + (li - (arr.length - 1) / 2) * W * .021));
  });
  ctx.restore();
}

export function drawCenter() {
  const { ctx, W, CX, CY } = canvas;
  ctx.save();
  ctx.textAlign = 'center'; ctx.fillStyle = '#2c2416';
  const parts = currentData.name.split(', ');
  ctx.font = `600 ${W * .026}px Cinzel,serif`; ctx.globalAlpha = .82;
  ctx.fillText(parts[0], CX, CY - W * .027);
  if (parts[1]) {
    ctx.font = `italic ${W * .020}px 'Crimson Pro',serif`; ctx.globalAlpha = .50;
    ctx.fillText(parts[1], CX, CY + W * .016);
  }
  if (currentData.eviSource) {
    ctx.font = `italic ${W * .014}px 'Crimson Pro',serif`; ctx.globalAlpha = .35;
    ctx.fillText('EVI: ' + currentData.eviSource, CX, CY + W * .044);
  }
  if (actuals) {
    const tLen = actuals.temp?.length ?? 0;
    const rLen = actuals.rain?.length ?? 0;
    ctx.font = `italic ${W * .013}px 'Crimson Pro',serif`; ctx.globalAlpha = .50;
    ctx.fillStyle = '#27ae60';
    ctx.fillText(`actuals: ${tLen}d temp · ${rLen}d rain · today=DOY${todayDOY}`, CX, CY + W * .062);
  }
  ctx.restore();
}
