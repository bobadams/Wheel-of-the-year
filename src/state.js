import { RING_DEFS } from './data/ringDefs.js';
import { PRESETS } from './data/presets.js';

// Ring display order (innermost → outermost)
export const ringOrder = ['temp', 'rain', 'daylight', 'ndvi', 'wind'];

// Per-ring UI state
export const ringState = {};
RING_DEFS.forEach(r => {
  ringState[r.id] = { visible: true, color: r.color, thickness: 1.0, opacity: .82 };
});

// Global display toggles
export const displayState = { moon: true, axis: true, ticks: true, actuals: true };

// Currently displayed climate data
export let currentData = PRESETS[0].data;
export let activePreset = 'Oakland';

export function setCurrentData(data) { currentData = data; }
export function setActivePreset(name) { activePreset = name; }

// Actuals overlay (past ~6 months of real observations)
export let actuals = null;
export let todayDOY = null;

export function setActuals(a) { actuals = a; }
export function setTodayDOY(d) { todayDOY = d; }

// Canvas dimensions (set during init, updated on resize)
export const canvas = { el: null, ctx: null, W: 0, H: 0, CX: 0, CY: 0 };
