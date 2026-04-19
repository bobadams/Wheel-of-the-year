import { RING_DEFS, RING_LABELS } from '../data/ringDefs.js';
import { canvas, ringState, currentData } from '../state.js';
import { doy2angle, polar, norm } from './canvas.js';

export function drawMinMaxMarkers(layouts) {
  const { ctx, W, CX, CY } = canvas;
  RING_DEFS.forEach(r => {
    const s = ringState[r.id];
    if (!s.visible || !layouts[r.id]) return;
    const data = currentData[r.id];
    const { innerFrac, thickFrac } = layouts[r.id];
    const innerR = innerFrac * W;
    const maxThick = thickFrac * W;
    const cfg = RING_LABELS[r.id];

    let maxD = 0, minD = 0;
    data.forEach((v, i) => { if (v > data[maxD]) maxD = i; if (v < data[minD]) minD = i; });

    [[maxD, 'max'], [minD, 'min']].forEach(([dayIdx, type]) => {
      const val = data[dayIdx];
      const peakR = innerR + norm(val, r.normLo, r.normHi) * maxThick;
      const angle = doy2angle(dayIdx + 0.5);
      const tickInner = peakR + W * .004;
      const tickOuter = peakR + W * .018;
      const [x1, y1] = polar(CX, CY, angle, tickInner);
      const [x2, y2] = polar(CX, CY, angle, tickOuter);

      ctx.save();
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

      const [dx, dy] = polar(CX, CY, angle, tickOuter + W * .006);
      ctx.strokeStyle = s.color; ctx.globalAlpha = 1.0;
      ctx.beginPath(); ctx.arc(dx, dy, W * .005, 0, Math.PI * 2); ctx.stroke();

      const [lx, ly] = polar(CX, CY, angle, tickOuter + W * .024);
      ctx.save();
      ctx.translate(lx, ly);
      let rot = angle + Math.PI / 2;
      const normRot = ((rot % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      if (normRot > Math.PI / 2 && normRot < Math.PI * 3 / 2) rot += Math.PI;
      ctx.rotate(rot);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const fs = W * .016;
      const word = type === 'max' ? cfg.maxWord : cfg.minWord;
      ctx.font = `italic ${fs}px 'Crimson Pro',serif`; ctx.fillStyle = s.color; ctx.globalAlpha = 0.75;
      ctx.fillText(`${word}: ${cfg.fmt(val)}`, 0, 0);
      ctx.restore(); ctx.restore();
    });
  });
}
