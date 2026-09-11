import { RING_DEFS } from '../data/ringDefs.js';
import { canvas, ringOrder, ringState, displayState, currentData, smoothedData, actuals } from '../state.js';
import { computeRingLayouts } from './layout.js';
import { computeNormBounds } from './normalize.js';
import { drawRing } from './ring.js';
import { drawMoon, drawTicks, drawAxes, drawCenter } from './decorations.js';
import { drawHolidays } from './holidays.js';
import { drawPhenology } from './phenology.js';
import { drawMinMaxMarkers } from './labels.js';
import { drawWindBarbs } from './windBarbs.js';
import { drawActualsLine, drawTodayDot } from './actuals.js';
import { INK } from './theme.js';

const ACTUALS_RINGS = ['temp', 'rain', 'evi', 'wind', 'pm25', 'visibility', 'snow', 'cloud'];

/**
 * Paint the whole wheel into whatever `canvas` currently points at.
 *
 * Everything is placed relative to `canvas.W`, `CX` and `CY`, so the same
 * sequence draws the 660 px screen wheel and the three-foot printed one; the
 * poster simply points those fields at a region of a much larger page before
 * calling in. Order matters — the annotation registers are drawn last so their
 * halos sit on top of the ring fills they cross.
 */
export function paintWheel(opts = {}) {
  const layouts = computeRingLayouts();
  const normBounds = computeNormBounds(currentData);

  ringOrder.forEach(id => {
    const s = ringState[id];
    if (!s.visible || !layouts[id]) return;
    const r = RING_DEFS.find(r => r.id === id);
    const { innerFrac, thickFrac } = layouts[id];
    const ringData = s.smooth && smoothedData[id] ? smoothedData[id] : currentData[id];
    const { lo, hi } = normBounds[id];
    drawRing(ringData, lo, hi, innerFrac * canvas.W, thickFrac * canvas.W, s.color, s.opacity, r.blankZero, currentData[id]);
  });

  if (actuals && displayState.actuals) {
    ACTUALS_RINGS.forEach(id => {
      const r = RING_DEFS.find(r => r.id === id);
      if (r && actuals[id] && layouts[id]) drawActualsLine(r, actuals[id], layouts[id], normBounds);
    });
    drawTodayDot(layouts, normBounds);
  }

  drawMinMaxMarkers(layouts, normBounds);
  if (displayState.windBarbs) drawWindBarbs(layouts);
  if (displayState.ticks)     drawTicks();
  if (displayState.moon)      drawMoon();
  if (displayState.axis)      drawAxes();
  if (displayState.holidays)  drawHolidays();
  if (displayState.phenology) drawPhenology();
  drawCenter(opts.center);
}

/** Fill the current target with the paper color. */
export function paintPaper(w, h) {
  const { ctx } = canvas;
  ctx.save();
  ctx.fillStyle = INK.paper;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}
