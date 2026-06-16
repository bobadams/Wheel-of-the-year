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
import { handlePhenology } from './phenology.mjs';

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

const smoothstep = t => t * t * (3 - 2 * t);

const NEGATIVE_PROMPT = [
  'blurry, cartoon, painting, illustration, anime, deformed',
  'people, person, buildings, houses, roads, cars, urban, signage, text, watermark, frame, border',
  // The client warps this strip into a little planet, so the SOURCE must stay a
  // FLAT panorama — push curvature/sphere artifacts out of the generation.
  'fisheye, tiny planet, little planet, curved horizon, distorted horizon, sphere, globe, circular, vignette',
  'lowres, bad anatomy, worst quality, oversaturated',
].join(', ');

// Flat-panorama framing, prepended to every Forge prompt. The client
// (src/draw/centerImage.js) stereographically warps the result into a sealed
// "little planet", so the SOURCE must stay a FLAT equirectangular strip (level
// horizon, seamless wrap). Planet framing (low horizon, clear sky on top) is
// added by FRAMING_PROMPT + the framing init.
const SCENE_PREFIX = [
  'equirectangular 360 panorama, flat horizontal panoramic strip, perfectly level straight horizon, ultra wide aspect ratio',
  'one continuous natural landscape, seamless left-right wrap',
].join(', ');

const QUALITY = 'photorealistic, natural light, professional nature photography, National Geographic style, sharp focus, 8k';

const FORGE_SEED = Number(process.env.FORGE_SEED ?? 12345);
// img2img strength over the framing init. High enough to invent rich photographic
// ecology, low enough to keep the framing (low horizon, sky on top).
const FRAMING_DENOISE = Number(process.env.FRAMING_DENOISE ?? 0.82);
// Fraction of the panorama HEIGHT that is sky above the horizon. The warp maps the
// top rows to the planet's rim, so this sky band becomes a clean rim and the
// planet floats; the rest is ground/ecology in the inner disc. ~0.42 leaves a
// clean rim while keeping the planet body (and its ecology) large.
const SKY_FRACTION = Number(process.env.SKY_FRACTION ?? 0.42);

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
    'Describe the VARIED, distinctive natural landscape of one specific place so it is instantly',
    'recognizable and interesting — NOT a generic field. Name its characteristic landforms (e.g.',
    'rolling hills, rocky outcrops, a creek or pond, scattered groves, ridgelines, dunes, wetland),',
    'SEVERAL kinds of native vegetation (trees, shrubs, ground cover specific to the region), and',
    'one or two representative wild animals. Favor an open landscape with a wide view.',
    'Produce ONE comma-separated fragment (max ~55 words). Do NOT mention sky, horizon, framing,',
    'seasons, weather, color, snow, or time of year — those are added separately. Do NOT write',
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

// Planet-framing words: keep the horizon low with clear sky ABOVE the treetops so
// the warp's rim stays clean (floating planet) — but the ecology below is rich
// and prominent, not suppressed. The "above the treetops" phrasing keeps tall
// growth in the lower band rather than poking into the rim.
const FRAMING_PROMPT = [
  'low horizon in the lower third, clear open sky filling the area above the treetops',
  'rich detailed lush native vegetation filling the foreground and midground, abundant trees shrubs and plants, full of life and texture, varied and dense but below the open sky',
].join(', ');

/**
 * Build a flat framing init: clear sky over the top SKY_FRACTION of the height,
 * neutral ground below, soft horizon blend. img2img invents the ecology over the
 * ground while keeping the horizon low and the sky band clear — so the warped
 * planet floats and tree-tops never reach the stretched rim.
 */
function buildFramingInitPNG(W = 1024, H = 512) {
  const data = Buffer.alloc(W * H * 4);
  const horizon = Math.round(H * SKY_FRACTION);
  const skyTop = [120, 158, 205], skyHorizon = [196, 210, 224];
  const ground = [128, 122, 96];
  for (let y = 0; y < H; y++) {
    let r, g, b;
    if (y < horizon) {
      const f = y / horizon;                       // 0 top … 1 horizon
      r = lerp(skyTop[0], skyHorizon[0], f); g = lerp(skyTop[1], skyHorizon[1], f); b = lerp(skyTop[2], skyHorizon[2], f);
    } else {
      const f = (y - horizon) / (H - horizon);     // darken slightly toward foreground
      r = ground[0] * (1 - 0.25 * f); g = ground[1] * (1 - 0.25 * f); b = ground[2] * (1 - 0.25 * f);
    }
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = r | 0; data[i + 1] = g | 0; data[i + 2] = b | 0; data[i + 3] = 255;
    }
  }
  return encodePNG(W, H, data);
}

/**
 * Guarantee a clean sky rim: blend the very top of the panorama toward the scene's
 * own average sky color, fading out by the time it reaches the horizon band. Even
 * if Forge pokes a treetop into the top, this clears it so the warped rim is sky.
 */
function cleanSkyTop(img) {
  const { w, h, data } = img;
  const bandEnd = Math.round(h * SKY_FRACTION * 0.55); // fade out well above the horizon
  // Sample mean sky color from the top few rows.
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = 0; y < Math.max(1, (h * 0.04) | 0); y++) {
    for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; n++; }
  }
  sr /= n; sg /= n; sb /= n;
  for (let y = 0; y < bandEnd; y++) {
    const a = 1 - smoothstep(y / bandEnd);         // 1 at top → 0 at bandEnd
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i]     = data[i]     + (sr - data[i])     * a;
      data[i + 1] = data[i + 1] + (sg - data[i + 1]) * a;
      data[i + 2] = data[i + 2] + (sb - data[i + 2]) * a;
    }
  }
  return img;
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

/** Run Forge img2img over a base PNG; returns a PNG Buffer. */
async function forgeImg2img(prompt, initPng, { seed = FORGE_SEED, denoise = FRAMING_DENOISE, steps = 28 } = {}) {
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

/**
 * Render the planet source: img2img a rich, place-specific ecology over the
 * low-horizon framing init, then clear the top band to clean sky. The result is a
 * flat strip whose lower disc holds varied ecology and whose top maps to a clean,
 * floating rim when the client warps it. Returns a PNG Buffer.
 */
async function renderPlanetSource(scene) {
  const init = buildFramingInitPNG();
  const prompt = `${SCENE_PREFIX}, ${scene}, ${FRAMING_PROMPT}, ${QUALITY}`;
  const raw = await forgeImg2img(prompt, init, { denoise: FRAMING_DENOISE, steps: 28 });
  const decoded = cleanSkyTop(decodePNG(raw));
  return { png: encodePNG(decoded.w, decoded.h, decoded.data), prompt };
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
    const { png, prompt } = await renderPlanetSource(scene);
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

  if (req.method === 'POST' && url.pathname === '/phenology') {
    try {
      const { key, facts, force } = JSON.parse(await readBody(req) || '{}');
      // Stream newline-delimited JSON: one line per animal/plant category as it
      // becomes ready, so the client can render each the moment it lands. The
      // 'X-Accel-Buffering: no' header (and nginx's `proxy_buffering off` for
      // /wheel-images/) keeps the proxy from withholding lines until the end.
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      const emit = (category, events) => {
        res.write(JSON.stringify({ category, events }) + '\n');
      };
      await handlePhenology(sanitizeKey(key), facts, {
        force: !!force, cacheDir: CACHE_DIR, ollamaUrl: OLLAMA_URL, model: OLLAMA_MODEL,
      }, emit);
      res.end();
    } catch (e) {
      console.error('[image-server] /phenology failed:', e.message);
      // Headers may already be sent (mid-stream); end the response either way.
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(res.headersSent ? '' : JSON.stringify({ error: e.message }));
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
