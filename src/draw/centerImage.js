import { canvas, centerImage, displayState } from '../state.js';

/**
 * Draw the ecology image masked to a circle filling the wheel's center hole.
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

  ctx.save();
  // Circular mask
  ctx.beginPath();
  ctx.arc(CX, CY, R, 0, Math.PI * 2);
  ctx.clip();

  // Cover-fit the image into the 2R × 2R square so it fills the circle with no
  // letterboxing, cropping the longer dimension.
  const iw = img.naturalWidth  || img.width;
  const ih = img.naturalHeight || img.height;
  if (iw && ih) {
    const scale = Math.max((2 * R) / iw, (2 * R) / ih);
    const dw = iw * scale, dh = ih * scale;
    ctx.drawImage(img, CX - dw / 2, CY - dh / 2, dw, dh);
  }

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
