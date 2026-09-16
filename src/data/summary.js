/**
 * The year in a handful of numbers.
 *
 * Used by the centre cartouche and by the printed key. Every figure is derived
 * from the same 365-point normals the rings are drawn from, so the summary can
 * never disagree with the picture — and each entry is omitted rather than
 * guessed when its series hasn't loaded.
 *
 * Note on temperature: the ERA5 series the app fetches is `temperature_2m_max`,
 * i.e. the 30-year mean of each day's *high*. It is labelled as such rather
 * than as "average temperature", which would be a different number.
 */

import { MON_L, doyMonth } from './calendar.js';

const has  = a => Array.isArray(a) && a.length === 365 && a.some(v => v != null && !Number.isNaN(v));
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

/** Day of year at which `arr` peaks. */
function argMax(arr) {
  let best = 0;
  arr.forEach((v, i) => { if (v > arr[best]) best = i; });
  return best;
}

/**
 * Headline figures for `data`, in priority order — a caller showing only three
 * takes the first three.
 *
 * @returns {{key: string, label: string, value: string}[]}
 */
export function yearSummary(data) {
  const out = [];
  if (has(data.temp)) {
    out.push({ key: 'temp', label: 'Avg. daily high', value: `${Math.round(mean(data.temp))}°F` });
  }
  if (has(data.rain)) {
    const annual = data.rain.reduce((s, v) => s + v, 0);
    out.push({ key: 'rain', label: 'Annual rainfall', value: `${annual.toFixed(1)}″` });
  }
  if (has(data.daylight)) {
    const lo = Math.min(...data.daylight), hi = Math.max(...data.daylight);
    out.push({ key: 'daylight', label: 'Day length', value: `${lo.toFixed(1)}–${hi.toFixed(1)} h` });
  }
  if (has(data.evi)) {
    out.push({ key: 'evi', label: 'Greenest', value: MON_L[doyMonth(argMax(data.evi))] });
  }
  if (has(data.temp)) {
    const swing = Math.max(...data.temp) - Math.min(...data.temp);
    out.push({ key: 'swing', label: 'Seasonal swing', value: `${Math.round(swing)}°F` });
  }
  if (has(data.snow) && data.snow.some(v => v > 0.05)) {
    const days = data.snow.filter(v => v > 0.05).length;
    out.push({ key: 'snow', label: 'Days with snow', value: `${days}` });
  }
  return out;
}

/** "37.80° N, 122.27° W" — coordinates in the form a printed map would use. */
export function coordLabel(lat, lon) {
  if (lat == null || lon == null) return '';
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}° ${ns}, ${Math.abs(lon).toFixed(2)}° ${ew}`;
}
