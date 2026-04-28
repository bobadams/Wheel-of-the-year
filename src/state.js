import { RING_DEFS } from './data/ringDefs.js';
import { PRESETS } from './data/presets.js';
import { gaussianSmooth } from './utils/smooth.js';

// Ring display order (innermost → outermost)
export const ringOrder = ['temp', 'rain', 'daylight', 'evi', 'wind', 'pm25', 'visibility', 'snow', 'cloud'];

// Per-ring UI state
export const ringState = {};
RING_DEFS.forEach(r => {
  ringState[r.id] = { visible: r.defaultVisible !== false, color: r.color, thickness: 1.0, opacity: 1.0, smooth: true, normMode: r.defaultNormMode };
});

// Global display toggles
export const displayState = { moon: true, axis: true, ticks: true, actuals: true, actualsSmooth: false, windBarbs: false, ringGap: 0.010, holidays: true, holidayChristian: true, holidayJewish: true, holidayWicca: true, holidayIslamic: true };

function precomputeSmoothed(data) {
  const out = {};
  ['temp', 'rain', 'daylight', 'evi', 'wind', 'pm25', 'visibility', 'snow', 'cloud'].forEach(id => {
    if (Array.isArray(data[id])) out[id] = gaussianSmooth(data[id]);
  });
  return out;
}

// Currently displayed climate data
export let currentData = PRESETS[0].data;
export let activePreset = 'Oakland';
export let smoothedData = precomputeSmoothed(PRESETS[0].data);

export function setCurrentData(data) {
  currentData = data;
  smoothedData = precomputeSmoothed(data);
}
export function mergeCurrentData(patch) {
  currentData = { ...currentData, ...patch };
  smoothedData = precomputeSmoothed(currentData);
}
export function setActivePreset(name) { activePreset = name; }

// Actuals overlay (past ~11 months of real observations)
export let actuals = null;
export let todayDOY = null;

export function setActuals(a) { actuals = a; }
export function setTodayDOY(d) { todayDOY = d; }

// Canvas dimensions (set during init, updated on resize)
export const canvas = { el: null, ctx: null, W: 0, H: 0, CX: 0, CY: 0 };
