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

const NEGATIVE_PROMPT = [
  'blurry, cartoon, painting, illustration, anime, deformed',
  'people, person, buildings, houses, roads, cars, urban, signage, text, watermark, frame, border',
  'flat horizon, straight horizon, cropped sphere, square crop, multiple planets',
  'lowres, bad anatomy, worst quality, oversaturated',
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
  const instruction = [
    'You write prompts for a text-to-image model (Stable Diffusion).',
    'Produce ONE vivid, comma-separated prompt (max ~70 words) for a "tiny planet" image: a',
    'stereographic 360-degree spherical panorama where the landscape is wrapped into a small',
    'curved globe centered in frame, with the sky and clouds radiating outward around it.',
    'The little planet must capture the natural ecology of a specific place and show its FOUR',
    'SEASONS blending around the sphere — e.g. snowy winter, spring blossoms, lush green summer,',
    'and golden autumn foliage flowing into one another. Include characteristic terrain, native',
    'vegetation, and one or two representative wild animals of that region. No people, no buildings,',
    'no text. End with quality keywords. Output ONLY the prompt text, nothing else.',
    '',
    'Always begin the prompt with: "tiny planet, little planet, stereographic 360 panorama".',
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
    let text = String(json.response || '').trim().replace(/^["']|["']$/g, '');
    // Guarantee the tiny-planet framing even if the LLM drops it.
    if (text && !/tiny planet|little planet/i.test(text)) {
      text = `tiny planet, little planet, stereographic 360 panorama, ${text}`;
    }
    if (text) return `${text}, photorealistic, natural light, professional nature photography, National Geographic style, sharp focus, 8k`;
  } catch (e) {
    console.warn('[image-server] Ollama prompt failed, using fallback:', e.message);
  }
  // Fallback prompt if the LLM is unavailable.
  return [
    'tiny planet, little planet, stereographic 360 panorama',
    `${f.biome ?? 'temperate'} landscape near ${f.name ?? 'a natural region'}`,
    'four seasons blending around the sphere — snowy winter, spring blossoms, green summer, golden autumn',
    'native wildlife, native vegetation, curved horizon, sky and clouds radiating outward, golden hour',
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
      width: 768,
      height: 768,
      cfg_scale: 7,
      sampler_name: 'DPM++ 2M Karras',
    }),
  });
  if (!res.ok) throw new Error(`Forge ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (!json.images?.[0]) throw new Error('Forge returned no image');
  return Buffer.from(json.images[0], 'base64');
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
    const png = await forgeTxt2img(prompt);
    await fs.mkdir(CACHE_DIR, { recursive: true });
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
