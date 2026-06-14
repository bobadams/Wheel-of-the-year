// Wheel-of-the-Year ecology image service.
//
// A tiny zero-dependency Node service that runs on the Mac mini alongside
// Ollama (localhost:11434) and Stable Diffusion Forge (localhost:7860).
// nginx proxies `/wheel-images/` here.
//
// POST /generate  { key, facts, force }
//   - Serves a disk-cached PNG for `key` if present (unless force=true).
//   - Otherwise: asks Ollama to compose a detailed, location-specific Stable
//     Diffusion prompt from `facts`, runs Forge txt2img, caches the PNG (and the
//     prompt alongside it for debugging), and returns the PNG.
//
// Forge and Ollama are kept from co-residing in RAM (the Mac mini has 8 GB):
// the LLM is unloaded right after composing the prompt (keep_alive: 0), and
// Forge is launched on demand and shut down after an idle period.
//
// Run:  node server/image-server.mjs
// Env:  PORT (default 7871), IMAGE_CACHE_DIR, OLLAMA_URL, FORGE_URL, OLLAMA_MODEL,
//       FORGE_DIR, FORGE_LAUNCH, FORGE_BOOT_TIMEOUT, FORGE_IDLE_TIMEOUT

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const HOME        = process.env.HOME ?? '/Users/bradfordadams';
const PORT        = Number(process.env.PORT ?? 7871);
const CACHE_DIR   = process.env.IMAGE_CACHE_DIR ?? path.join(__dirname, 'image-cache');
const OLLAMA_URL  = process.env.OLLAMA_URL  ?? 'http://127.0.0.1:11434';
const FORGE_URL   = process.env.FORGE_URL   ?? 'http://127.0.0.1:7860';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2:3b';

// On-demand Forge launch + idle teardown. The Mac mini has only 8 GB of RAM,
// so Forge and Ollama must take turns rather than co-reside. Forge is left off
// when idle; the first generation after idle boots it, and it is shut down once
// no generation has run for FORGE_IDLE_TIMEOUT, handing that RAM back to Ollama
// (which the sibling astrology site needs regularly).
const FORGE_DIR          = process.env.FORGE_DIR ?? `${HOME}/stable-diffusion-webui-forge`;
const FORGE_BOOT_TIMEOUT = Number(process.env.FORGE_BOOT_TIMEOUT ?? 360000); // ms
const FORGE_IDLE_TIMEOUT = Number(process.env.FORGE_IDLE_TIMEOUT ?? 600000); // ms (10 min)

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Minimal PNG codec (8-bit, no deps). encodePNG builds the composited strip;
//    decodePNG reads Forge's PNGs back so we can blend the seasonal variants. ──
const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decode an 8-bit PNG (colorType 2 RGB or 6 RGBA, no interlace) → {w,h,data:RGBA}. */
function decodePNG(buf) {
  let p = 8, w, h, ct, idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = ct === 6 ? 4 : 3, stride = w * ch, out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4]     = cur[x * ch];
      out[(y * w + x) * 4 + 1] = cur[x * ch + 1];
      out[(y * w + x) * 4 + 2] = cur[x * ch + 2];
      out[(y * w + x) * 4 + 3] = ch === 4 ? cur[x * ch + 3] : 255;
    }
    prev = cur;
  }
  return { w, h, data: out };
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Circularly interpolate the 12 monthly bands at year-fraction `frac` (0–1). */
function sampleMonthly(monthly, frac) {
  const B = monthly.length;
  const x = frac * B;
  const i = ((Math.floor(x) % B) + B) % B;
  const j = (i + 1) % B;
  const f = x - Math.floor(x);
  const g = k => lerp(monthly[i][k] ?? 0, monthly[j][k] ?? 0, f);
  return { warm: g('warm'), veg: g('veg'), wet: g('wet'), snow: g('snow'), cold: g('cold') };
}

/** Does this location have an actual snowfall series (vs. only a cold proxy)? */
function locationHasSnow(monthly) {
  return monthly.some(b => b && b.snow != null && b.snow > 0);
}

const NEGATIVE_PROMPT = [
  'blurry, cartoon, painting, illustration, anime, deformed',
  'people, person, buildings, houses, roads, cars, urban, signage, text, watermark, frame, border',
  // The client warps this strip into a little planet, so the SOURCE must stay a
  // FLAT panorama — push curvature/sphere artifacts out of the generation.
  'fisheye, tiny planet, little planet, curved horizon, distorted horizon, sphere, globe, circular, vignette',
  'lowres, bad anatomy, worst quality, oversaturated',
].join(', ');

// The client (src/draw/centerImage.js) stereographically warps the generated
// image into a sealed "little planet". For that warp to work the SOURCE must be
// a FLAT equirectangular strip whose WIDTH carries the seasonal cycle, with
// Flat-panorama framing, prepended to every Forge prompt. The client warps the
// result into a little planet, so the SOURCE must stay a flat equirectangular
// strip (level horizon, seamless wrap). The *seasonal* content is no longer in
// this prefix — it comes from the per-variant condition phrase (composeCondition)
// and the multi-pass composite.
const SCENE_PREFIX = [
  'equirectangular 360 panorama, flat horizontal panoramic strip, perfectly level straight horizon, ultra wide aspect ratio',
  'one continuous natural landscape, seamless left-right wrap',
].join(', ');

const QUALITY = 'photorealistic, natural light, professional nature photography, National Geographic style, sharp focus, 8k';

// Fixed seed so the base scene and all seasonal variants share the SAME terrain,
// letting them composite/blend cleanly (same hill at column x, different season).
const FORGE_SEED       = Number(process.env.FORGE_SEED ?? 12345);
// How many data-placed seasonal variants to render and blend across the year.
const SEASON_VARIANTS  = Number(process.env.SEASON_VARIANTS ?? 4);
// img2img strength for the variants: high enough to swap surface features
// (green↔dead↔snow), low enough to keep the base terrain structure.
const VARIANT_DENOISE  = Number(process.env.VARIANT_DENOISE ?? 0.58);

// Dedupe concurrent requests for the same key so we never run Forge twice.
const inFlight = new Map();

function sanitizeKey(key) {
  const k = String(key || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return k || 'location';
}

/**
 * Ask the local LLM for a season-agnostic description of the location's VARIED
 * natural landscape — distinct landforms, several kinds of native vegetation,
 * and wildlife — so the base scene is interesting and place-specific rather than
 * a monotonous field. Seasonal state is added separately per variant. Returns
 * just the descriptive body (no framing/quality keywords).
 */
async function composeScene(facts) {
  const f = facts || {};
  const instruction = [
    'You write the descriptive body of a prompt for a text-to-image model (Stable Diffusion).',
    'Describe the VARIED natural landscape of one specific place: its distinctive landforms (e.g.',
    'rolling hills, rocky outcrops, a creek or pond, scattered groves, ridgelines), SEVERAL kinds of',
    'native vegetation (not just grass — name trees, shrubs, and ground cover typical of the region),',
    'and one or two representative wild animals. Make it visually varied and specific to this place.',
    'Produce ONE comma-separated fragment (max ~55 words). Do NOT mention seasons, weather, color,',
    'snow, or time of year — those are added separately. Do NOT write "tiny planet", "globe",',
    '"sphere", "fisheye", "panorama", or "curved". No people, no buildings, no text.',
    'Output ONLY the fragment, nothing else.',
    '',
    'Location facts:',
    `- Place: ${f.name ?? 'unknown'}`,
    `- Hemisphere: ${f.hemisphere ?? 'northern'}`,
    `- Dominant biome: ${f.biome ?? 'temperate landscape'}`,
    f.meanTempF != null ? `- Mean annual temperature: ${f.meanTempF}°F` : '',
    f.meanRainInPerMonth != null ? `- Mean precipitation: ${f.meanRainInPerMonth} in/month` : '',
    f.vegetationIndex != null ? `- Vegetation index (0-1): ${f.vegetationIndex}` : '',
  ].filter(Boolean).join('\n');

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // keep_alive: 0 frees the LLM's RAM before Forge loads its larger model.
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt: instruction, stream: false, keep_alive: 0, options: { temperature: 0.7 } }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const json = await res.json();
    let body = String(json.response || '').trim().replace(/^["']|["']$/g, '');
    body = body.replace(/\b(tiny planet|little planet|stereographic|fisheye|panoramas?|equirectangular|globe|sphere|curved)\b/gi, '')
               .replace(/\s*,\s*,+/g, ', ').replace(/^[,\s]+/, '').trim();
    if (body) return body;
  } catch (e) {
    console.warn('[image-server] Ollama scene failed, using fallback:', e.message);
  }
  return `${f.biome ?? 'temperate'} landscape near ${f.name ?? 'a natural region'}, rolling terrain, scattered native trees and shrubs, ground cover, native wildlife`;
}

/**
 * Turn one band's REAL conditions into feature+color words for img2img — this is
 * where a season actually changes what's on the ground, not just its tint. Driven
 * by data thresholds (vegetation, warmth, wetness, snow/cold), so a place reads
 * dead and dry when its data says so, lush when wet, snowy only when it snows.
 */
function composeCondition(c, hasSnow) {
  const snowy = hasSnow ? clamp01(c.snow) : 0;
  const parts = [];
  if (snowy > 0.45) {
    parts.push('deep fresh snow covering the ground, snow-laden bare branches, frozen, white winter landscape');
  } else {
    if (snowy > 0.12) parts.push('patchy snow on the ground, frost, bare branches');
    if (c.veg > 0.62) {
      parts.push('lush vivid green vegetation, dense fresh foliage, vibrant new growth, wildflowers in bloom, verdant and alive');
    } else if (c.veg > 0.4) {
      parts.push('green and tan mixed vegetation, healthy foliage, some flowering plants');
    } else if (c.warm > 0.5) {
      parts.push('dead dry dormant grass, parched cracked bare earth, withered brown and golden stalks, sun-scorched and lifeless, sparse dry brush');
    } else {
      parts.push('dormant muted brown vegetation, bare twigs, faded dry ground cover, leafless');
    }
    if (c.wet > 0.55 && snowy < 0.12) parts.push('damp ground, full creek');
    else if (c.wet < 0.2 && c.warm > 0.5) parts.push('dusty, drought-stricken');
  }
  return parts.join(', ');
}

/** Is Forge up and serving its API? */
async function forgeReady() {
  try {
    const r = await fetch(`${FORGE_URL}/sdapi/v1/sd-models`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

// Single in-flight boot, shared across concurrent requests.
let forgeBoot = null;

/** Launch Forge (detached) and poll until its API responds, or time out. */
async function bootForge() {
  console.log('[image-server] Forge not running — launching…');
  const cmd = process.env.FORGE_LAUNCH
    ?? `cd "${FORGE_DIR}" && bash webui.sh > "${HOME}/forge-run.log" 2>&1`;
  const child = spawn('bash', ['-lc', cmd], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}`, PYTORCH_ENABLE_MPS_FALLBACK: '1' },
  });
  child.unref();

  const deadline = Date.now() + FORGE_BOOT_TIMEOUT;
  while (Date.now() < deadline) {
    await sleep(5000);
    if (await forgeReady()) { console.log('[image-server] Forge is ready'); return; }
  }
  throw new Error(`Forge did not become ready within ${Math.round(FORGE_BOOT_TIMEOUT / 1000)}s`);
}

/** Ensure Forge is up, launching it on demand if needed. */
async function ensureForge() {
  if (await forgeReady()) return;
  if (!forgeBoot) forgeBoot = bootForge().finally(() => { forgeBoot = null; });
  await forgeBoot;
}

// ── Idle teardown ─────────────────────────────────────────────────────────────
let forgeIdleTimer = null;

/** Kill whatever process owns the Forge port, freeing its RAM for Ollama. */
function shutdownForge() {
  forgeIdleTimer = null;
  // `lsof -ti :7860 | xargs kill -9` — resolve PID(s) on the Forge port and kill.
  const port = new URL(FORGE_URL).port || '7860';
  execFile('bash', ['-lc', `lsof -ti :${port} | xargs -r kill -9`], err => {
    if (err) console.warn('[image-server] Forge shutdown failed:', err.message);
    else console.log(`[image-server] Forge idle for ${Math.round(FORGE_IDLE_TIMEOUT / 1000)}s — shut down to free RAM`);
  });
}

/** (Re)arm the idle timer; called after every generation finishes. */
function scheduleForgeShutdown() {
  if (FORGE_IDLE_TIMEOUT <= 0) return; // 0 disables auto-shutdown
  if (forgeIdleTimer) clearTimeout(forgeIdleTimer);
  forgeIdleTimer = setTimeout(shutdownForge, FORGE_IDLE_TIMEOUT);
  forgeIdleTimer.unref?.(); // don't keep the event loop alive just for this
}

/** Run Forge txt2img; returns a PNG Buffer. Shared seed keeps terrain stable. */
async function forgeTxt2img(prompt, { seed = FORGE_SEED, steps = 25 } = {}) {
  const res = await fetch(`${FORGE_URL}/sdapi/v1/txt2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      negative_prompt: NEGATIVE_PROMPT,
      seed,
      steps,
      width: 1024,   // 2:1 equirectangular strip the client warps into a planet
      height: 512,
      cfg_scale: 7,
      sampler_name: 'DPM++ 2M Karras',
      tiling: true,  // seamless horizontal wrap
    }),
  });
  if (!res.ok) throw new Error(`Forge ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (!json.images?.[0]) throw new Error('Forge returned no image');
  return Buffer.from(json.images[0], 'base64');
}

/** Run Forge img2img over a base PNG; returns a PNG Buffer. */
async function forgeImg2img(prompt, initPng, { seed = FORGE_SEED, denoise = VARIANT_DENOISE, steps = 24 } = {}) {
  const res = await fetch(`${FORGE_URL}/sdapi/v1/img2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      init_images: [initPng.toString('base64')],
      denoising_strength: denoise,
      prompt,
      negative_prompt: NEGATIVE_PROMPT,
      seed,
      steps,
      width: 1024,
      height: 512,
      cfg_scale: 7,
      sampler_name: 'DPM++ 2M Karras',
      tiling: true,
    }),
  });
  if (!res.ok) throw new Error(`Forge img2img ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (!json.images?.[0]) throw new Error('Forge returned no image');
  return Buffer.from(json.images[0], 'base64');
}

/** True when we have the 12-band monthly data needed for the seasonal composite. */
function hasMonthly(facts) {
  return Array.isArray(facts?.monthly) && facts.monthly.length === 12;
}

const smoothstep = t => t * t * (3 - 2 * t);

/**
 * Composite N seasonal variants (each a decoded full-width panorama of the SAME
 * terrain in a different seasonal state) into one strip whose WIDTH is the year.
 * Column x (year fraction x/W) is taken from variant column x, cross-faded between
 * the two variants whose phases bracket that fraction. Variant 0 sits at the
 * winter-solstice seam (x=0 and x=W), so the wrap stays seamless.
 */
function compositeSeasonalStrip(variants) {
  const N = variants.length;
  const W = variants[0].w, H = variants[0].h;
  const out = Buffer.alloc(W * H * 4);
  for (let x = 0; x < W; x++) {
    const s = (x / W) * N;          // phase position along the year
    const i = Math.floor(s) % N;
    const j = (i + 1) % N;
    const t = smoothstep(s - Math.floor(s));
    const A = variants[i].data, B = variants[j].data;
    for (let y = 0; y < H; y++) {
      const p = (y * W + x) * 4;
      out[p]     = A[p]     + (B[p]     - A[p])     * t;
      out[p + 1] = A[p + 1] + (B[p + 1] - A[p + 1]) * t;
      out[p + 2] = A[p + 2] + (B[p + 2] - A[p + 2]) * t;
      out[p + 3] = 255;
    }
  }
  return encodePNG(W, H, out);
}

/**
 * Multi-pass seasonal render: one varied base scene, then SEASON_VARIANTS img2img
 * passes that re-skin the SAME terrain into each data-placed season (features +
 * color from composeCondition), composited across the year. Returns a PNG Buffer.
 */
async function renderSeasonalComposite(scene, monthly, debug) {
  const hasSnow = locationHasSnow(monthly);
  const base = await forgeTxt2img(`${SCENE_PREFIX}, ${scene}, soft overcast daylight, ${QUALITY}`);
  if (debug) debug.base = base;

  const variants = [];
  for (let i = 0; i < SEASON_VARIANTS; i++) {
    const band = sampleMonthly(monthly, i / SEASON_VARIANTS);
    const cond = composeCondition(band, hasSnow);
    const prompt = `${SCENE_PREFIX}, ${scene}, ${cond}, ${QUALITY}`;
    const png = await forgeImg2img(prompt, base);
    variants.push(decodePNG(png));
    if (debug) (debug.variants ??= []).push({ png, prompt });
  }
  return compositeSeasonalStrip(variants);
}

async function generate(key, facts, force) {
  const pngPath    = path.join(CACHE_DIR, `${key}.png`);
  const promptPath = path.join(CACHE_DIR, `${key}.txt`);

  if (!force) {
    try { return await fs.readFile(pngPath); } catch { /* not cached */ }
  }

  // Coalesce concurrent (re)generations for the same key.
  if (inFlight.has(key)) return inFlight.get(key);

  const work = (async () => {
    const scene = await composeScene(facts);
    await ensureForge();
    await fs.mkdir(CACHE_DIR, { recursive: true });
    // Preferred path: a varied base scene re-skinned into each real season and
    // composited across the year. Fall back to a single txt2img when monthly
    // data is absent (e.g. sparse presets).
    let png, prompt;
    if (hasMonthly(facts)) {
      png = await renderSeasonalComposite(scene, facts.monthly);
      prompt = `${SCENE_PREFIX}, ${scene}, [+${SEASON_VARIANTS} data-driven seasonal variants], ${QUALITY}`;
    } else {
      prompt = `${SCENE_PREFIX}, ${scene}, ${QUALITY}`;
      png = await forgeTxt2img(prompt);
    }
    await fs.writeFile(pngPath, png);
    await fs.writeFile(promptPath, prompt);
    return png;
  })();

  inFlight.set(key, work);
  try { return await work; }
  finally {
    inFlight.delete(key);
    // Re-arm Forge's idle countdown after each generation completes.
    scheduleForgeShutdown();
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > 1e6) { reject(new Error('body too large')); req.destroy(); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Permissive CORS so local dev (VITE_IMAGE_URL) can hit this directly.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'POST' && url.pathname === '/generate') {
    try {
      const { key, facts, force } = JSON.parse(await readBody(req) || '{}');
      const safeKey = sanitizeKey(key);
      const png = await generate(safeKey, facts, !!force);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
      res.end(png);
    } catch (e) {
      console.error('[image-server] /generate failed:', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[image-server] listening on http://127.0.0.1:${PORT}  cache=${CACHE_DIR}`);
});
