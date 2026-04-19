export const RING_DEFS = [
  { id: 'temp',     label: 'Temperature', unit: '°F',   color: '#c0392b', normLo: 32,   normHi: 100, defaultNormMode: 'fixed'      },
  { id: 'rain',     label: 'Rainfall',    unit: 'in',   color: '#2471a3', normLo: 0,    normHi: 10,  defaultNormMode: 'minmax',    blankZero: true },
  { id: 'daylight', label: 'Daylight',    unit: 'hrs',  color: '#c8980a', normLo: 7,    normHi: 18,  defaultNormMode: 'fixed'      },
  { id: 'evi',      label: 'Vegetation',  unit: 'EVI',  color: '#27ae60', normLo: .02,  normHi: .65, defaultNormMode: 'minmax'     },
  { id: 'wind',     label: 'Wind',        unit: 'mph',  color: '#7f8c8d', normLo: 3,    normHi: 16,  defaultNormMode: 'percentile' },
  { id: 'pm25',     label: 'Air Quality', unit: 'µg/m³', color: '#8e44ad', normLo: 0,   normHi: 35,  defaultNormMode: 'percentile' },
];

export const RING_GAP   = 0.010;
export const RING_START = 0.147;
export const RING_END   = 0.415;

export const RING_LABELS = {
  temp:     { fmt: v => `${Math.round(v)}°F`,      maxWord: 'hottest',  minWord: 'coldest'  },
  rain:     { fmt: v => `${v.toFixed(1)}"`,         maxWord: 'wettest',  minWord: 'driest'   },
  daylight: { fmt: v => `${v.toFixed(1)}h`,         maxWord: 'longest',  minWord: 'shortest' },
  evi:      { fmt: v => `EVI ${v.toFixed(2)}`,      maxWord: 'greenest', minWord: 'brownest' },
  wind:     { fmt: v => `${v.toFixed(1)} mph`,      maxWord: 'windiest', minWord: 'calmest'  },
  pm25:     { fmt: v => `${v.toFixed(1)} µg/m³`,   maxWord: 'most polluted', minWord: 'cleanest' },
};
