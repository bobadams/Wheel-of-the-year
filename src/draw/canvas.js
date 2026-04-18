// Shared canvas math helpers — no DOM or state imports needed
//
// The wheel places midday of the winter solstice (Dec 20, d=353.5) at the top
// of the canvas (angle -π/2). Every feature that converts between day-of-year
// and canvas angle MUST go through doy2angle / angle2doy so they stay aligned.
// Individual days of year are 0-indexed (d=0 is Jan 1); use d + 0.5 when you
// want the *center* of a day's arc (e.g. a marker placed on that day), and a
// bare integer d for *boundaries* between days (e.g. month tick marks).
export const WINTER_SOLSTICE_DOY = 353.5; // midday Dec 20
export const SOLSTICE_OFFSET = -Math.PI / 2 - (WINTER_SOLSTICE_DOY / 365) * Math.PI * 2;

export function doy2angle(d) {
  return (d / 365) * Math.PI * 2 + SOLSTICE_OFFSET;
}

// Inverse of doy2angle: maps a canvas angle (e.g. from atan2) to a 0-indexed
// day of year. Normalizes the result into [0, 365).
export function angle2doy(angle) {
  let frac = (angle - SOLSTICE_OFFSET) / (Math.PI * 2);
  frac = ((frac % 1) + 1) % 1;
  return frac * 365;
}

export function polar(cx, cy, a, r) {
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
}

export function norm(v, lo, hi) {
  return Math.max(.02, Math.min(1, (v - lo) / (hi - lo)));
}
