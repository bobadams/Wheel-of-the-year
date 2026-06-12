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
// Run:  node server/image-server.mjs
// Env:  PORT (default 7871), IMAGE_CACHE_DIR, OLLAMA_URL, FORGE_URL, OLLAMA_MODEL

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const HOME        = process.env.HOME ?? '/Users/bradfordadams';
const PORT        = Number(process.env.PORT ?? 7871);
const CACHE_DIR   = process.env.IMAGE_CACHE_DIR ?? path.join(__dirname, 'image-cache');
const OLLAMA_URL  = process.env.OLLAMA_URL  ?? 'http://127.0.0.1:11434';
const FORGE_URL   = process.env.FORGE_URL   ?? 'http://127.0.0.1:7860';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2:3b';

// On-demand Forge launch. Forge is left off when idle; the first generation
// after idle boots it and waits for the model to load.
const FORGE_DIR          = process.env.FORGE_DIR ?? `${HOME}/stable-diffusion-webui-forge`;
const FORGE_BOOT_TIMEOUT = Number(process.env.FORGE_BOOT_TIMEOUT ?? 360000); // ms

const sleep = ms => new Promise(r => setTimeout(r, ms));

const NEGATIVE_PROMPT = [
  'blurry, cartoon, painting, illustration, anime, deformed',
  'people, person, buildings, houses, roads, cars, urban, signage, text, watermark, frame, border',
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
    'Produce ONE vivid, comma-separated prompt (max ~70 words) for a single photorealistic',
    'landscape photograph that captures the natural ecology of a specific place and how it looks',
    'across the seasons of its year. Show characteristic terrain, native vegetation, and at least',
    'one or two representative wild animals of that region. No people, no buildings, no text.',
    'End with photography quality keywords. Output ONLY the prompt text, nothing else.',
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
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt: instruction, stream: false, options: { temperature: 0.7 } }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const json = await res.json();
    const text = String(json.response || '').trim().replace(/^["']|["']$/g, '');
    if (text) return `${text}, photorealistic, natural light, professional nature photography, National Geographic style, sharp focus, 8k`;
  } catch (e) {
    console.warn('[image-server] Ollama prompt failed, using fallback:', e.message);
  }
  // Fallback prompt if the LLM is unavailable.
  return [
    `${f.biome ?? 'temperate'} landscape near ${f.name ?? 'a natural region'}`,
    'native wildlife, seasonal vegetation, dramatic sky, golden hour',
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
  finally { inFlight.delete(key); }
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
