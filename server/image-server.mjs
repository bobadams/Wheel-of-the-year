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

// Lower = the img2img output follows the synthetic seasonal init more faithfully
// (crisper local seasonal layout, less invented detail); higher = prettier but
// drifts from the data-driven colors. ~0.7 keeps the layout while letting Forge
// paint real landscape texture.
const IMG2IMG_DENOISE = Number(process.env.IMG2IMG_DENOISE ?? 0.7);

// ── Minimal PNG encoder (RGBA, filter 0) — zero deps. Used to synthesize the
//    data-driven seasonal init image that img2img paints over. ──────────────
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

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const mixRGB = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

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

/** Ground color for one band from its real conditions (green↔brown↔gold↔snow). */
function groundColor(c) {
  const brown = [150, 120, 80], green = [70, 130, 55], gold = [200, 170, 70], white = [235, 238, 245];
  let col = mixRGB(brown, green, c.veg);              // greenness from vegetation index
  const dryness = clamp01((1 - c.veg) * c.warm);      // warm + sparse veg → golden dry hills
  col = mixRGB(col, gold, dryness * 0.6);
  const snowy = clamp01(Math.max(c.snow, c.cold));    // snow series, or cold when none
  col = mixRGB(col, white, snowy * 0.85);
  return col;
}

/**
 * Synthesize the equirectangular init image whose WIDTH is the local year
 * (winter solstice at both edges) colored by real monthly conditions, and whose
 * HEIGHT runs sky (top) → ground (bottom). Forge img2img paints photographic
 * landscape over it; the client then warps it into the little planet.
 */
function buildSeasonalInitPNG(monthly, W = 1024, H = 512) {
  const data = Buffer.alloc(W * H * 4);
  const horizon = Math.round(H * 0.42);
  for (let x = 0; x < W; x++) {
    const c = sampleMonthly(monthly, x / W);
    const g = groundColor(c);
    const snowy = clamp01(Math.max(c.snow, c.cold));
    const sky = [lerp(120, 205, snowy), lerp(160, 212, snowy), lerp(210, 224, snowy)]; // paler when cold
    for (let y = 0; y < H; y++) {
      let col;
      if (y < horizon) {
        const f = y / horizon;                          // lighter toward the horizon
        col = [lerp(sky[0] * 0.9, sky[0], f), lerp(sky[1] * 0.9, sky[1], f), sky[2]];
      } else {
        const f = (y - horizon) / (H - horizon);        // darker toward the foreground
        col = [g[0] * (1 - 0.3 * f), g[1] * (1 - 0.3 * f), g[2] * (1 - 0.3 * f)];
      }
      const i = (y * W + x) * 4;
      data[i] = col[0] | 0; data[i + 1] = col[1] | 0; data[i + 2] = col[2] | 0; data[i + 3] = 255;
    }
  }
  return encodePNG(W, H, data);
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
// winter on BOTH ends so the wrap seam (left edge meets right edge) is invisible.
// This prefix is prepended to every prompt; the LLM only writes the ecology body.
// The seasonal *layout* now comes from the data-driven init image (img2img),
// not from words — so the prompt must NOT impose a generic winter→summer order.
// It only asks for a flat panorama that honors the colors already present.
const PANORAMA_PREFIX = [
  'equirectangular 360 panorama, flat horizontal panoramic strip, perfectly level straight horizon, ultra wide aspect ratio',
  'one continuous natural landscape whose vegetation, dryness, greenery and snow vary smoothly from left to right exactly as in the underlying composition',
  'keep the existing color and seasonal layout, the far-left and far-right edges match for a seamless wrap',
].join(', ');

// Dedupe concurrent requests for the same key so we never run Forge twice.
const inFlight = new Map();

function sanitizeKey(key) {
  const k = String(key || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return k || 'location';
}

/** Ask the local LLM to compose a Stable Diffusion prompt from location facts. */
async function composePrompt(facts) {
  const f = facts || {};
  // The server prepends a fixed panorama/seasonal-layout prefix (PANORAMA_PREFIX);
  // the LLM only writes the ecology BODY so it can concentrate on place-specific
  // terrain, vegetation and wildlife without having to reproduce the framing.
  const instruction = [
    'You write the descriptive body of a prompt for a text-to-image model (Stable Diffusion).',
    'The image is a FLAT horizontal panorama of ONE place across its year. The seasonal layout,',
    'colors and flat framing are supplied separately by an underlying image — describe only the',
    'natural ecology (terrain, native plants, wildlife) that fills the scene.',
    'Produce ONE vivid, comma-separated fragment (max ~50 words) naming the characteristic terrain,',
    'native vegetation, and one or two representative wild animals of this specific region.',
    'Do NOT impose a generic season order and do NOT name seasons — this place may green up or dry',
    'out at unusual times, and that is already set by the underlying colors. Do NOT write the words',
    '"tiny planet", "globe", "sphere", "fisheye", "panorama", or "curved". No people, no buildings,',
    'no text. Output ONLY the fragment, nothing else.',
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
      // keep_alive: 0 unloads the LLM from RAM immediately after it answers, so
      // its memory is freed before Forge loads its (much larger) model. On 8 GB
      // the two cannot co-reside without thrashing.
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt: instruction, stream: false, keep_alive: 0, options: { temperature: 0.7 } }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const json = await res.json();
    let body = String(json.response || '').trim().replace(/^["']|["']$/g, '');
    // Strip any framing words the LLM slipped in so they don't fight the flat
    // panorama we need as the warp source.
    body = body.replace(/\b(tiny planet|little planet|stereographic|fisheye|panoramas?|equirectangular|globe|sphere|curved)\b/gi, '')
               .replace(/\s*,\s*,+/g, ', ').replace(/^[,\s]+/, '').trim();
    if (body) return `${PANORAMA_PREFIX}, ${body}, photorealistic, natural light, professional nature photography, National Geographic style, sharp focus, 8k`;
  } catch (e) {
    console.warn('[image-server] Ollama prompt failed, using fallback:', e.message);
  }
  // Fallback prompt if the LLM is unavailable.
  return [
    PANORAMA_PREFIX,
    `${f.biome ?? 'temperate'} landscape near ${f.name ?? 'a natural region'}`,
    'native vegetation bare and snowy in winter, flowering in spring, lush green in summer, gold in autumn',
    'native wildlife, golden hour',
    'photorealistic, professional nature photography, National Geographic style, sharp focus, 8k',
  ].join(', ');
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

/** Run Forge txt2img; returns a PNG Buffer. */
async function forgeTxt2img(prompt) {
  const res = await fetch(`${FORGE_URL}/sdapi/v1/txt2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      negative_prompt: NEGATIVE_PROMPT,
      steps: 25,
      // 2:1 equirectangular strip — the client warps it into a little planet,
      // and its width carries the seasonal cycle.
      width: 1024,
      height: 512,
      cfg_scale: 7,
      sampler_name: 'DPM++ 2M Karras',
      tiling: true, // seamless horizontal wrap (see forgeImg2img)
    }),
  });
  if (!res.ok) throw new Error(`Forge ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (!json.images?.[0]) throw new Error('Forge returned no image');
  return Buffer.from(json.images[0], 'base64');
}

/** Run Forge img2img over the data-driven seasonal init; returns a PNG Buffer. */
async function forgeImg2img(prompt, initPng) {
  const res = await fetch(`${FORGE_URL}/sdapi/v1/img2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      init_images: [initPng.toString('base64')],
      denoising_strength: IMG2IMG_DENOISE,
      prompt,
      negative_prompt: NEGATIVE_PROMPT,
      steps: 28,
      width: 1024,
      height: 512,
      cfg_scale: 7,
      sampler_name: 'DPM++ 2M Karras',
      // Seamless horizontal wrap so the warp's left/right edges meet without a
      // radial seam. Vertical tiling is harmless here — top(sky)/bottom(ground)
      // map to the planet's rim and centre and never touch.
      tiling: true,
    }),
  });
  if (!res.ok) throw new Error(`Forge img2img ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (!json.images?.[0]) throw new Error('Forge returned no image');
  return Buffer.from(json.images[0], 'base64');
}

/** True when we have the 12-band monthly data needed for the data-driven init. */
function hasMonthly(facts) {
  return Array.isArray(facts?.monthly) && facts.monthly.length === 12;
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
    const prompt = await composePrompt(facts);
    await ensureForge();
    // Preferred path: paint photographic landscape over the data-driven seasonal
    // init so the local seasonal layout tracks real temp/rain/vegetation. Fall
    // back to plain txt2img when monthly data is absent (e.g. sparse presets).
    let png;
    if (hasMonthly(facts)) {
      const init = buildSeasonalInitPNG(facts.monthly);
      png = await forgeImg2img(prompt, init);
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(path.join(CACHE_DIR, `${key}.init.png`), init); // keep for debugging
    } else {
      png = await forgeTxt2img(prompt);
      await fs.mkdir(CACHE_DIR, { recursive: true });
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
