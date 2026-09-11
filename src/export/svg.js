import C2S from 'canvas2svg';
import { canvas } from '../state.js';

/**
 * Shared plumbing for everything that leaves the browser as vector: the SVG
 * download and the printed poster both draw through canvas2svg, and both need
 * the same two fixes and the same self-contained fonts.
 */

/** canvas2svg v1.0.x omits several Canvas 2D methods; patch them onto the instance. */
export function patchC2S(ctx) {
  let _dash = [];
  const _dashStack = [];
  const _origStroke  = ctx.stroke.bind(ctx);
  const _origSave    = ctx.save.bind(ctx);
  const _origRestore = ctx.restore.bind(ctx);

  ctx.setLineDash = arr => { _dash = arr ? [...arr] : []; };
  ctx.getLineDash = () => [..._dash];

  // The dash lives outside canvas2svg's own style stack, so it has to ride
  // along with save/restore by hand. Without this a single dashed stroke — the
  // observed-year line, a legend swatch — leaks its pattern into every stroke
  // drawn afterwards, which is how the poster's ring profiles once printed
  // dashed while the same code on screen drew them solid.
  ctx.save = function (...args) { _dashStack.push([..._dash]); return _origSave(...args); };
  ctx.restore = function (...args) {
    const r = _origRestore(...args);
    if (_dashStack.length) _dash = _dashStack.pop();
    return r;
  };

  // Apply stroke-dasharray whenever stroke() is called so each path element
  // inherits the correct dash pattern at the moment it is stroked.
  ctx.stroke = function (...args) {
    _origStroke(...args);
    if (ctx.__currentElement) {
      const val = _dash.length ? _dash.join(',') : 'none';
      ctx.__currentElement.setAttribute('stroke-dasharray', val);
    }
  };

  // canvas2svg's __parseFont regex only allows [-,"a-z\s] in the family name,
  // so single-quoted names like 'Crimson Pro' crash it. Strip the quotes.
  let _font = ctx.font ?? '10px sans-serif';
  Object.defineProperty(ctx, 'font', {
    get() { return _font; },
    set(v) { _font = typeof v === 'string' ? v.replace(/'/g, '') : v; },
    configurable: true,
  });

  return ctx;
}

const GOOGLE_URL = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600&family=Crimson+Pro:ital,wght@0,300;0,400;1,300&display=swap';

let _fontStyleCache = null;

/**
 * Fetch the Google Fonts CSS then inline each font file as a base64 data URI so
 * the output is fully self-contained — an SVG that renders offline, and a print
 * job whose text is set in the right faces even though the print window has no
 * chance to fetch anything before the dialog opens.
 *
 * Cached: the poster and the SVG export both want it, and it is ~200 KB of
 * fetches. Falls back to an @import, which at least works online.
 */
export async function buildEmbeddedFontStyle() {
  if (_fontStyleCache) return _fontStyleCache;
  const FALLBACK = `<style><![CDATA[@import url('${GOOGLE_URL}');]]></style>`;
  try {
    const css = await fetch(GOOGLE_URL).then(r => r.text());
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)]
      .map(m => m[1].replace(/['"]/g, ''))
      .filter(u => u.startsWith('http'));

    // Fetch all font files in parallel, convert to base64 data URIs.
    const replacements = await Promise.all(urls.map(async url => {
      const buf   = await fetch(url).then(r => r.arrayBuffer());
      const bytes = new Uint8Array(buf);
      let binary  = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const b64  = btoa(binary);
      const mime = url.includes('.woff2') ? 'font/woff2' : 'font/woff';
      return { url, dataUri: `data:${mime};base64,${b64}` };
    }));

    let inlined = css;
    for (const { url, dataUri } of replacements) {
      inlined = inlined.replaceAll(url, dataUri);
    }
    _fontStyleCache = `<style>${inlined}</style>`;
    return _fontStyleCache;
  } catch {
    return FALLBACK;
  }
}

/**
 * Run `paint(ctx)` against a fresh canvas2svg context of the given size and
 * return the serialized SVG, with `fontStyle` (if supplied) spliced into defs.
 *
 * The wheel's draw modules read their target out of the shared `canvas` state,
 * so this swaps that out for the duration and restores it afterwards — including
 * `svgExport`, which tells the holiday symbols to emit drawn paths rather than
 * Unicode glyphs the viewer may not have a font for.
 */
export function renderSVG(w, h, paint, fontStyle) {
  const svgCtx = patchC2S(new C2S(w, h));
  const saved = { ctx: canvas.ctx, W: canvas.W, H: canvas.H, CX: canvas.CX, CY: canvas.CY, svgExport: canvas.svgExport };
  canvas.ctx = svgCtx;
  canvas.svgExport = true;
  try {
    paint(svgCtx);
  } finally {
    Object.assign(canvas, saved);
  }

  let svg = svgCtx.getSerializedSvg(true);
  // canvas2svg emits width/height but no viewBox, so the document cannot be
  // scaled to a container — which the print window and any downstream tool both
  // need in order to fit the sheet to the page.
  if (!/viewBox=/.test(svg)) {
    svg = svg.replace(/(<svg\b)/, `$1 viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet"`);
  }
  if (fontStyle) {
    svg = svg.includes('<defs>')
      ? svg.replace('<defs>', `<defs>${fontStyle}`)
      : svg.replace(/(<svg[^>]*>)/, `$1<defs>${fontStyle}</defs>`);
  }
  return svg;
}

/** Prompt a download of `text` as `filename`. */
export function downloadFile(text, filename, type) {
  const blob = new Blob([text], { type });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.download = filename;
  a.href = url;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A filesystem-safe stem for the current location, e.g. `wheel-Oakland`. */
export function fileStem(name) {
  return `wheel-${(name || 'location').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')}`;
}
