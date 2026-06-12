import { canvas, centerImage, displayState } from '../state.js';

// Cache of the last little-planet warp. Rebuilding the per-pixel warp every
// draw (hover, resize, etc.) would be wasteful, so we keep the warped canvas
// and only recompute when the source image or the hole radius changes.
let warpCache = null; // { src, R, canvas }

/**
 * Warp a flat equirectangular panorama into a sealed "little planet".
 *
 * The image service generates a FLAT 2:1 strip whose WIDTH sweeps the four
 * seasons (winter on both ends so the wrap is seamless) and whose HEIGHT runs
 * ground (bottom) → sky (top). This is the inverse stereographic / "polar
 * coordinates" map that turns that strip into a globe:
 *   - angle around the planet  (θ) ← horizontal position in the strip → seasons
 *     become angular wedges; winter's seam is placed at the top of the wheel.
 *   - distance from centre      (r) ← vertical position: centre = ground at the
 *     nadir, an inner ring = horizon, the rim and corners = sky.
 *
 * @param {HTMLImageElement} src  loaded panorama (same-origin blob → readable)
 * @param {number} R              hole radius in canvas pixels
 * @returns {HTMLCanvasElement}   a 2R×2R canvas with the planet (corners clear)
 */
function buildLittlePlanet(src, R) {
  const size = Math.max(2, Math.round(R * 2));
  const sw = src.naturalWidth  || src.width;
  const sh = src.naturalHeight || src.height;

  // Read the panorama's pixels once via an offscreen canvas.
  const sc = document.createElement('canvas');
  sc.width = sw; sc.height = sh;
  const sctx = sc.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(src, 0, 0);
  const sdata = sctx.getImageData(0, 0, sw, sh).data;

  const out = document.createElement('canvas');
  out.width = size; out.height = size;
  const octx = out.getContext('2d');
  const odata = octx.createImageData(size, size);
  const od = odata.data;

  const c = size / 2;          // centre of the output square
  const Rpx = size / 2;        // planet radius in output pixels
  const TWO_PI = Math.PI * 2;
  // Rotate so the winter seam (strip edge, u≈0) sits at the top of the wheel,
  // matching DOY 0 = winter solstice at the top of the rings.
  const ROT = Math.PI / 2;

  for (let py = 0; py < size; py++) {
    const dy = py - c;
    for (let px = 0; px < size; px++) {
      const dx = px - c;
      const r = Math.hypot(dx, dy);
      const oi = (py * size + px) * 4;
      if (r > Rpx) { od[oi + 3] = 0; continue; } // outside the disc → transparent

      // θ → column (azimuth, wraps); r → row (centre=ground, rim=sky).
      let u = (Math.atan2(dy, dx) + ROT) / TWO_PI;
      u -= Math.floor(u);                          // wrap into [0,1)
      const v = r / Rpx;                           // 0 centre … 1 rim

      const sx = Math.min(sw - 1, (u * sw) | 0);
      const sy = Math.min(sh - 1, ((1 - v) * (sh - 1)) | 0);
      const si = (sy * sw + sx) * 4;

      od[oi]     = sdata[si];
      od[oi + 1] = sdata[si + 1];
      od[oi + 2] = sdata[si + 2];
      od[oi + 3] = 255;
    }
  }

  octx.putImageData(odata, 0, 0);
  return out;
}

/** Get the warped planet for `img` at radius `R`, rebuilding only when stale. */
function littlePlanetFor(img, R) {
  const rKey = Math.round(R);
  if (warpCache && warpCache.src === img && warpCache.R === rKey) return warpCache.canvas;
  const canvasEl = buildLittlePlanet(img, R);
  warpCache = { src: img, R: rKey, canvas: canvasEl };
  return canvasEl;
}

/**
 * Draw the ecology image as a "little planet" filling the wheel's center hole.
 *
 * Called early in the draw loop (right after the background fill) so it sits
 * behind the rings, axes, labels and all other decorations. The rings only
 * paint their outer band, so the image remains visible in the hole.
 *
 * @param {object} layouts  output of computeRingLayouts(); used to find the
 *                          inner radius of the innermost visible ring (the hole)
 */
export function drawCenterImage(layouts) {
  const img = centerImage;
  if (!img || !displayState.centerImage) return;
  // canvas2svg doesn't support clipping/drawImage reliably — skip in SVG export.
  if (canvas.svgExport) return;

  const { ctx, W, CX, CY } = canvas;

  // Hole radius = inner edge of the innermost visible ring. Fall back to a
  // sensible default when no rings are visible.
  const innerFracs = Object.values(layouts).map(l => l.innerFrac);
  const holeFrac = innerFracs.length ? Math.min(...innerFracs) : 0.34;
  const R = holeFrac * W;
  if (R <= 0) return;
  if (!(img.naturalWidth || img.width)) return;

  const planet = littlePlanetFor(img, R);

  ctx.save();
  // Circular mask (also hides any sub-pixel rounding at the disc edge).
  ctx.beginPath();
  ctx.arc(CX, CY, R, 0, Math.PI * 2);
  ctx.clip();

  // The warped canvas is exactly the 2R×2R bounding square of the hole.
  ctx.drawImage(planet, CX - planet.width / 2, CY - planet.height / 2);

  // Soft inner vignette so ring labels/text stay legible over the image.
  const grad = ctx.createRadialGradient(CX, CY, R * 0.55, CX, CY, R);
  grad.addColorStop(0, 'rgba(250,247,242,0)');
  grad.addColorStop(1, 'rgba(250,247,242,0.55)');
  ctx.fillStyle = grad;
  ctx.fillRect(CX - R, CY - R, 2 * R, 2 * R);
  ctx.restore();

  // Thin rim to seat the image in the design.
  ctx.save();
  ctx.beginPath();
  ctx.arc(CX, CY, R, 0, Math.PI * 2);
  ctx.strokeStyle = '#b0a090';
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.4;
  ctx.stroke();
  ctx.restore();
}
