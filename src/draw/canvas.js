// Shared canvas math helpers — no DOM or state imports needed
export const SOLSTICE_OFFSET = -Math.PI / 2 - (354 / 365) * Math.PI * 2;

export function doy2angle(d) {
  return (d / 365) * Math.PI * 2 + SOLSTICE_OFFSET;
}

export function polar(cx, cy, a, r) {
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
}

export function norm(v, lo, hi) {
  return Math.max(.02, Math.min(1, (v - lo) / (hi - lo)));
}
