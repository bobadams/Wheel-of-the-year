import { canvas, currentData, actuals, todayDOY } from '../state.js';
import { doy2angle, polar } from './canvas.js';

export const DIM     = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MON_S   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const MON_L   = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const MOON_FULL = [26,  55,  85, 112, 142, 170, 202, 231, 259, 288, 316, 345];
const MOON_NEW  = [11,  40,  71, 100, 130, 158, 187, 216, 245, 274, 302, 331];

export function drawMoon() {
  const { ctx, W, CX, CY } = canvas;
  const r = W * .430, dr = W * .009;
  ctx.save();
  MOON_FULL.forEach(d => {
    const a = doy2angle(d);
    const [x, y] = polar(CX, CY, a, r);
    ctx.beginPath(); ctx.arc(x, y, dr, 0, Math.PI * 2);
    ctx.fillStyle = '#8e7cc3'; ctx.globalAlpha = .85; ctx.fill();
  });
  MOON_NEW.forEach(d => {
    const a = doy2angle(d);
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
  ctx.save();
  ctx.strokeStyle = '#2c2416'; ctx.lineWidth = .8; ctx.globalAlpha = .28; ctx.setLineDash([3, 4]);
  [[171, 354], [78, 264]].forEach(([a, b]) => {
    const [ax, ay] = polar(CX, CY, doy2angle(a), R);
    const [bx, by] = polar(CX, CY, doy2angle(b), R);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  });
  ctx.setLineDash([]); ctx.restore();
  ctx.save();
  ctx.font = `italic ${W * .019}px 'Crimson Pro',serif`;
  ctx.fillStyle = '#2c2416'; ctx.globalAlpha = .48; ctx.textAlign = 'center';
  const ld = R + W * .038;
  [
    { doy: 171, t: 'Summer\nSolstice' },
    { doy: 354, t: 'Winter\nSolstice' },
    { doy: 78,  t: 'Spring\nEquinox'  },
    { doy: 264, t: 'Autumn\nEquinox'  },
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
  if (currentData.ndviSource) {
    ctx.font = `italic ${W * .014}px 'Crimson Pro',serif`; ctx.globalAlpha = .35;
    ctx.fillText('NDVI: ' + currentData.ndviSource, CX, CY + W * .044);
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
