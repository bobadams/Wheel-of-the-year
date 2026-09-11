// Persisted UI preferences — every choice the user makes in the control panel,
// plus the location they last loaded, kept in localStorage so the next visit
// opens exactly where the last one left off.
//
// Only *changed* values are stored. Each ring is diffed against
// `defaultRingState()` and the toggles against `DISPLAY_DEFAULTS`, so a build
// that changes a default (a ring's color, whether it starts visible) still
// reaches everyone who never overrode it — and a record stays a few hundred
// bytes rather than a full snapshot.
//
// Precedence at startup is defaults → saved prefs → `?s=` URL params, so a
// shared link always shows what it encodes, whatever the visitor has saved.
// Nothing is written back while a link is being restored, so opening someone
// else's wheel doesn't overwrite your own default view; the first control the
// visitor then touches saves the state they are looking at, as usual.

import { RING_DEFS } from './ringDefs.js';
import { ringOrder, ringState, displayState, defaultRingState, DISPLAY_DEFAULTS } from '../state.js';

const KEY = 'wheel-of-the-year:prefs:v1';

// Sliders fire on every step of a drag; coalesce those into one write.
const SAVE_DEBOUNCE_MS = 250;

// The per-ring fields that belong to the user. Everything else on a ring
// (label, unit, normalization bounds) belongs to RING_DEFS.
const RING_FIELDS = ['visible', 'color', 'thickness', 'opacity', 'smooth', 'normMode', 'collapsed'];

// Held here so a save triggered by, say, a ring toggle doesn't drop the
// location that a previous visit recorded.
let lastLocation = null;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }   // private mode, quota, or a record from an older shape
}

/**
 * Restore the ring order to `list`, tolerating a record written by a different
 * build: unknown ids are dropped, and rings the record predates are appended so
 * a new ring never goes missing from the wheel and its control panel.
 */
export function restoreOrder(list) {
  if (!Array.isArray(list)) return;
  const restored = list.filter(id => ringState[id]);
  RING_DEFS.forEach(r => { if (!restored.includes(r.id)) restored.push(r.id); });
  ringOrder.length = 0;
  ringOrder.push(...restored);
}

/**
 * Apply the saved preferences to `ringOrder` / `ringState` / `displayState`.
 * Call before the controls and legend are built.
 *
 * @returns {object|null} the location to reopen — `{ preset }` for a built-in,
 *   `{ name, lat, lon }` for a fetched city — or null if none was recorded.
 */
export function applySavedPrefs() {
  const saved = read();
  if (!saved) return null;

  restoreOrder(saved.order);

  if (saved.rings) {
    Object.entries(saved.rings).forEach(([id, fields]) => {
      if (!ringState[id] || !fields) return;
      RING_FIELDS.forEach(f => { if (fields[f] !== undefined) ringState[id][f] = fields[f]; });
    });
  }

  if (saved.display) {
    Object.entries(saved.display).forEach(([k, v]) => {
      // Only keys this build still knows about — a stale one would sit in
      // displayState forever, read by nothing.
      if (k in DISPLAY_DEFAULTS) displayState[k] = v;
    });
  }

  lastLocation = saved.location ?? null;
  return lastLocation;
}

/** Sync the display-toggle buttons in the markup to `displayState`. */
export function syncDisplayToggles() {
  document.querySelectorAll('[data-display-key]').forEach(btn => {
    btn.classList.toggle('on', !!displayState[btn.dataset.displayKey]);
  });
}

function snapshot() {
  const rings = {};
  RING_DEFS.forEach(r => {
    const s = ringState[r.id], d = defaultRingState(r), changed = {};
    RING_FIELDS.forEach(f => { if (s[f] !== undefined && s[f] !== d[f]) changed[f] = s[f]; });
    if (Object.keys(changed).length) rings[r.id] = changed;
  });

  const display = {};
  Object.entries(DISPLAY_DEFAULTS).forEach(([k, v]) => {
    if (displayState[k] !== v) display[k] = displayState[k];
  });

  const defaultOrder = RING_DEFS.map(r => r.id);
  const orderChanged = ringOrder.length !== defaultOrder.length
    || ringOrder.some((id, i) => id !== defaultOrder[i]);

  return {
    v: 1,
    ...(orderChanged ? { order: [...ringOrder] } : {}),
    ...(Object.keys(rings).length ? { rings } : {}),
    ...(Object.keys(display).length ? { display } : {}),
    ...(lastLocation ? { location: lastLocation } : {}),
  };
}

let saveTimer = null;

function write() {
  saveTimer = null;
  try { localStorage.setItem(KEY, JSON.stringify(snapshot())); } catch { /* storage unavailable */ }
}

/** Record the current UI state. Debounced; safe to call from every handler. */
export function savePrefs() {
  if (saveTimer) return;
  saveTimer = setTimeout(write, SAVE_DEBOUNCE_MS);
}

/**
 * Record the location to reopen on the next visit: `{ preset: label }` for a
 * built-in, `{ name, lat, lon }` for a geocoded city (stored resolved, so the
 * restore skips the Nominatim round-trip).
 */
export function setLastLocation(loc) {
  lastLocation = loc;
  savePrefs();
}

// A toggle flipped in the last quarter-second of a page's life still counts.
window.addEventListener('pagehide', () => { if (saveTimer) { clearTimeout(saveTimer); write(); } });
