import { RING_DEFS, RING_LABELS } from '../data/ringDefs.js';
import { canvas, ringState, currentData, smoothedData } from '../state.js';
import { doy2angle, polar, norm } from './canvas.js';

export function drawMinMaxMarkers(layouts, normBounds) {
  const { ctx, W, CX, CY } = canvas;
  RING_DEFS.forEach(r => {
    const s = ringState[r.id];
    if (!s.visible || !layouts[r.id]) return;
    const dispData = (s.smooth && smoothedData[r.id]) ? smoothedData[r.id] : currentData[r.id];
    const refData  = smoothedData[r.id] ?? currentData[r.id];
    const { innerFrac, thickFrac } = layouts[r.id];
    const innerR = innerFrac * W;
    const maxThick = thickFrac * W;
    const cfg = RING_LABELS[r.id];
    const { lo, hi } = normBounds?.[r.id] ?? { lo: r.normLo, hi: r.normHi };

    let maxD = 0, minD = 0;
    refData.forEach((v, i) => { if (v > refData[maxD]) maxD = i; if (v < refData[minD]) minD = i; });
    // Snap to midpoint of any flat plateau so labels don't skew to the early edge
    const plateauMid = (first) => {
      let end = first;
      while (end + 1 < refData.length && refData[end + 1] === refData[first]) end++;
      return Math.floor((first + end) / 2);
    };
    maxD = plateauMid(maxD);
    minD = plateauMid(minD);

    [[maxD, 'max'], [minD, 'min']].forEach(([dayIdx, type]) => {
      const val = dispData[dayIdx];
      const peakR = innerR + norm(val, lo, hi) * maxThick;
      const angle = doy2angle(dayIdx + 0.5);
      const dotR = W * .005;
      const lineStart = peakR + dotR;
      const lineEnd   = peakR + W * .019;
      const textR     = lineEnd + W * .004;

      const [dotX, dotY]   = polar(CX, CY, angle, peakR);
      const [lx1, ly1]     = polar(CX, CY, angle, lineStart);
      const [lx2, ly2]     = polar(CX, CY, angle, lineEnd);
      const [tx, ty]       = polar(CX, CY, angle, textR);

      ctx.save();

      // Circle with white fill and colored stroke centered on the ring edge
      ctx.beginPath(); ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.globalAlpha = 1.0; ctx.fill();
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.stroke();

      // Line from circle edge outward
      ctx.beginPath(); ctx.moveTo(lx1, ly1); ctx.lineTo(lx2, ly2);
      ctx.strokeStyle = s.color; ctx.lineWidth = 1; ctx.globalAlpha = 0.7; ctx.stroke();

      // Label at line end, rotated to read along the radius
      ctx.save();
      ctx.translate(tx, ty);
      let rot = angle + Math.PI / 2;
      const normRot = ((rot % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      if (normRot > Math.PI / 2 && normRot < Math.PI * 3 / 2) rot += Math.PI;
      ctx.rotate(rot);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const word = type === 'max' ? cfg.maxWord : cfg.minWord;
      ctx.font = `italic ${W * .016}px 'Crimson Pro',serif`;
      ctx.fillStyle = s.color; ctx.globalAlpha = 0.75;
      ctx.fillText(`${word}: ${cfg.fmt(val)}`, 0, 0);
      ctx.restore(); ctx.restore();
    });
  });
}
