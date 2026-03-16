import { RING_GAP, RING_START, RING_END } from '../data/ringDefs.js';
import { ringOrder, ringState } from '../state.js';

export function computeRingLayouts() {
  const visible = ringOrder.filter(id => ringState[id].visible);
  if (visible.length === 0) return {};
  const totalSpace = RING_END - RING_START - RING_GAP * (visible.length - 1);
  const baseThick = totalSpace / visible.length;
  let cursor = RING_START;
  const layouts = {};
  ringOrder.forEach(id => {
    if (!ringState[id].visible) return;
    const thick = baseThick * ringState[id].thickness;
    layouts[id] = { innerFrac: cursor, thickFrac: Math.min(thick, RING_END - cursor) };
    cursor += thick + RING_GAP;
  });
  return layouts;
}
