import { RING_DEFS } from '../data/ringDefs.js';
import { ringState } from '../state.js';

function percentile(sorted, p) {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function computeNormBounds(data) {
  const bounds = {};
  RING_DEFS.forEach(r => {
    const arr = data[r.id];
    const mode = ringState[r.id]?.normMode ?? r.defaultNormMode;
    if (!Array.isArray(arr)) {
      bounds[r.id] = { lo: r.normLo, hi: r.normHi };
      return;
    }
    if (mode === 'fixed') {
      bounds[r.id] = { lo: r.normLo, hi: r.normHi };
    } else if (mode === 'minmax') {
      let lo = arr[0], hi = arr[0];
      for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v; }
      if (hi === lo) hi = lo + 1;
      bounds[r.id] = { lo, hi };
    } else if (mode === 'percentile') {
      const sorted = [...arr].sort((a, b) => a - b);
      const lo = percentile(sorted, 5), hi = percentile(sorted, 95);
      bounds[r.id] = { lo, hi: hi === lo ? lo + 1 : hi };
    }
  });
  return bounds;
}
