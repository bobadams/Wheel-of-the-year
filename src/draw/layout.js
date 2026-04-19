import { RING_START, RING_END } from '../data/ringDefs.js';
import { ringOrder, ringState, displayState } from '../state.js';

export function computeRingLayouts() {
  const visible = ringOrder.filter(id => ringState[id].visible);
  if (visible.length === 0) return {};
  const gap = displayState.ringGap;
  const totalSpace = RING_END - RING_START - gap * (visible.length - 1);
  const baseThick = totalSpace / visible.length;
  // Position from outside in so the outermost ring always ends at RING_END;
  // reducing a ring's thickness expands the center hole instead of leaving a gap at the edge.
  let cursor = RING_END;
  const layouts = {};
  [...ringOrder].reverse().forEach(id => {
    if (!ringState[id].visible) return;
    const thick = baseThick * ringState[id].thickness;
    layouts[id] = { innerFrac: cursor - thick, thickFrac: thick };
    cursor -= thick + gap;
  });
  return layouts;
}
