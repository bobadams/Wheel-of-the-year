import { R } from '../draw/theme.js';

/**
 * The data rings.
 *
 * Colors are earth pigments rather than screen primaries: each is desaturated
 * far enough to sit on the warm paper without vibrating, but the hues stay
 * wide apart so nine rings remain tellable apart at a glance — and stay
 * distinguishable in print, where a saturated screen green has nowhere to go.
 *
 * `source` is the provenance shown in the printed key; the live per-ring badge
 * in the control panel still comes from currentData.meta, which knows whether a
 * given ring was actually fetched or fell back to a proxy.
 */
export const RING_DEFS = [
  { id: 'temp',       label: 'Temperature',  unit: '°F',    color: '#a8432f', normLo: 32,  normHi: 100, defaultNormMode: 'fixed',      source: 'ERA5 1991–2020' },
  { id: 'rain',       label: 'Rainfall',     unit: 'in',    color: '#2d5f8a', normLo: 0,   normHi: 10,  defaultNormMode: 'minmax',     source: 'ERA5 1991–2020', blankZero: true },
  { id: 'daylight',   label: 'Daylight',     unit: 'hrs',   color: '#bd8b24', normLo: 7,   normHi: 18,  defaultNormMode: 'fixed',      source: 'astronomical' },
  { id: 'evi',        label: 'Vegetation',   unit: 'EVI',   color: '#4a7c3f', normLo: .02, normHi: .65, defaultNormMode: 'minmax',     source: 'MODIS EVI 2013–2022' },
  { id: 'wind',       label: 'Wind',         unit: 'mph',   color: '#6e7f85', normLo: 3,   normHi: 16,  defaultNormMode: 'percentile', source: 'ERA5 1991–2020' },
  { id: 'pm25',       label: 'Air Quality',  unit: 'µg/m³', color: '#7d5680', normLo: 0,   normHi: 35,  defaultNormMode: 'percentile', source: 'CAMS 2014–2023', defaultVisible: false },
  { id: 'visibility', label: 'Visibility',   unit: 'mi',    color: '#5f97b8', normLo: 2,   normHi: 10,  defaultNormMode: 'percentile', source: 'ERA5 2010–2020', defaultVisible: false },
  { id: 'snow',       label: 'Snow Depth',   unit: 'in',    color: '#7fa8bf', normLo: 0,   normHi: 36,  defaultNormMode: 'minmax',     source: 'ERA5 1991–2020', blankZero: true, defaultVisible: false },
  { id: 'cloud',      label: 'Cloud Cover',  unit: '%',     color: '#8c9498', normLo: 0,   normHi: 100, defaultNormMode: 'fixed',      source: 'ERA5 1991–2020', defaultVisible: false },
];

export const RING_GAP   = 0.010;
export const RING_START = R.ringStart;
export const RING_END   = R.ringEnd;

export const RING_LABELS = {
  temp:     { fmt: v => `${Math.round(v)}°F`,      maxWord: 'hottest',  minWord: 'coldest'  },
  rain:     { fmt: v => `${v.toFixed(1)}"`,         maxWord: 'wettest',  minWord: 'driest'   },
  daylight: { fmt: v => `${v.toFixed(1)}h`,         maxWord: 'longest',  minWord: 'shortest' },
  evi:      { fmt: v => `EVI ${v.toFixed(2)}`,      maxWord: 'greenest', minWord: 'brownest' },
  wind:     { fmt: v => `${v.toFixed(1)} mph`,      maxWord: 'windiest', minWord: 'calmest'  },
  pm25:       { fmt: v => `${v.toFixed(1)} µg/m³`,   maxWord: 'most polluted', minWord: 'cleanest'  },
  visibility: { fmt: v => `${v.toFixed(1)} mi`,      maxWord: 'clearest',      minWord: 'foggiest'  },
  snow:       { fmt: v => `${v.toFixed(1)}"`,         maxWord: 'deepest',       minWord: 'bare'      },
  cloud:      { fmt: v => `${Math.round(v)}%`,        maxWord: 'cloudiest',     minWord: 'clearest'  },
};
