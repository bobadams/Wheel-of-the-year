// Wheel-of-the-Year LLM provider switch.
//
// Every LLM call the image service makes — the ecology image prompt and the two
// phenology proposal lanes — goes through here, so one env var picks the engine:
//
//   LLM_PROVIDER=anthropic   (default) → Claude, via api.anthropic.com
//   LLM_PROVIDER=ollama                → local llama on 127.0.0.1:11434
//
// The Anthropic key is the SAME one the astrology site's nginx proxy injects.
// It lives in exactly one place — the chmod-600 `anthropic-key.conf` that
// `daily-astrology.conf` includes — and is read from there (not copied into a
// plist or a second file), so rotating it stays a one-file edit. The file is
// re-read per call rather than cached, so a rotation takes effect without
// restarting this service.
//
// Env:
//   LLM_PROVIDER        anthropic | ollama            (default anthropic)
//   ANTHROPIC_API_KEY   overrides the key file if set
//   ANTHROPIC_KEY_FILE  default /opt/homebrew/etc/nginx/anthropic-key.conf
//   ANTHROPIC_MODEL     default claude-opus-5
//   ANTHROPIC_EFFORT    low | medium | high           (default low)
//   ANTHROPIC_MAX_TOKENS default 4000 (covers thinking + reply)
//   OLLAMA_URL          default http://127.0.0.1:11434
//   OLLAMA_MODEL        default llama3.2:3b
//
// Anthropic is a soft default: with no key, or on any API failure, the call
// falls through to the local llama rather than returning nothing. That is what
// keeps a dead or rotated key from emptying the phenology band. Callers pass a
// `freeRam` hook that evicts Forge before local inference (the 8 GB Mac mini
// can't hold both) — including on that fallback path, where Forge may still be
// warm because the Anthropic path had no reason to evict it.

import { promises as fs } from 'node:fs';

const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const KEY_FILE   = process.env.ANTHROPIC_KEY_FILE ?? '/opt/homebrew/etc/nginx/anthropic-key.conf';
const MODEL      = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5';
// Small structured asks — a naturalist's shortlist, a one-line scene fragment.
// `low` keeps thinking (and latency) modest; raise it if proposals get thin.
const EFFORT     = process.env.ANTHROPIC_EFFORT ?? 'low';
const MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS ?? 4000);

const OLLAMA_URL   = process.env.OLLAMA_URL   ?? 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2:3b';

const CONFIGURED = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase() === 'ollama'
  ? 'ollama' : 'anthropic';

let warnedNoKey = false;

/** The configured provider, before any missing-key fallback. */
export function llmProvider() {
  return CONFIGURED;
}

/** The Anthropic key: env first, else parsed out of nginx's include file. */
async function anthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const txt = await fs.readFile(KEY_FILE, 'utf8');
    // proxy_set_header x-api-key "sk-ant-...";
    return txt.match(/x-api-key\s+"([^"]+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Which provider this call will actually use (anthropic degrades to ollama). */
async function resolveProvider() {
  if (CONFIGURED !== 'anthropic') return 'ollama';
  if (await anthropicKey()) return 'anthropic';
  if (!warnedNoKey) {
    warnedNoKey = true;
    console.warn(`[llm] LLM_PROVIDER=anthropic but no key (${KEY_FILE}); falling back to Ollama`);
  }
  return 'ollama';
}

/** One Claude call. Returns the concatenated text blocks, or throws. */
async function anthropicText(prompt, { temperature, maxTokens }) {
  const key = await anthropicKey();
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens ?? MAX_TOKENS,
      // Sampling params are rejected on this model tier; the per-call
      // `temperature` the Ollama path uses is simply not applicable here.
      output_config: { effort: EFFORT },
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  // Safety classifiers can decline with a normal 200 — check before reading
  // content, which is empty (or partial) on a refusal.
  if (json.stop_reason === 'refusal') {
    throw new Error(`refused (${json.stop_details?.category ?? 'unspecified'})`);
  }
  // Thinking blocks ride along with empty text; keep only the real reply.
  return (json.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
}

/**
 * One Ollama call. `json` switches the model into JSON-only mode. `freeRam` is
 * awaited first: on the 8 GB Mac mini a warm Forge has to go before the llama
 * model loads.
 */
async function ollamaText(prompt, { temperature, json, ollamaUrl, ollamaModel, freeRam }) {
  await freeRam?.();
  const res = await fetch(`${ollamaUrl ?? OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // keep_alive: 0 frees the LLM's RAM immediately (the Mac mini shares 8 GB
    // with Forge / the astrology site).
    body: JSON.stringify({
      model: ollamaModel ?? OLLAMA_MODEL,
      prompt,
      stream: false,
      keep_alive: 0,
      ...(json ? { format: 'json' } : {}),
      options: { temperature: temperature ?? 0.6 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  return String((await res.json()).response || '').trim();
}

/**
 * Free-text completion. Throws only if BOTH providers fail, so callers keep
 * their own fallbacks for that case.
 * `opts`: { temperature, maxTokens, ollamaUrl, ollamaModel, freeRam }.
 */
export async function llmText(prompt, opts = {}) {
  if ((await resolveProvider()) === 'anthropic') {
    try {
      return await anthropicText(prompt, opts);
    } catch (e) {
      // A revoked key, a rate limit, an outage: run it locally rather than
      // dropping the band. Loud, because the intended engine isn't answering.
      console.warn('[llm] Anthropic call failed, falling back to Ollama:', e.message);
    }
  }
  return ollamaText(prompt, opts);
}

/**
 * JSON completion. Returns the parsed object, or null on any failure (bad
 * request, unparseable reply) — every caller already treats null as "no
 * proposals" and moves on.
 *
 * Ollama is pinned to JSON mode; Claude is asked for JSON in the prompt itself
 * (every call site already ends with "Respond with ONLY JSON"), so the reply is
 * unwrapped from a possible ``` fence before parsing.
 */
export async function llmJSON(prompt, opts = {}) {
  try {
    const raw = await llmText(prompt, { ...opts, json: true });
    return JSON.parse(unfence(raw));
  } catch (e) {
    console.warn(`[llm] ${CONFIGURED} JSON call failed:`, e.message);
    return null;
  }
}

/** Strip a ```json fence / surrounding prose, leaving the outermost JSON value. */
function unfence(s) {
  const t = String(s || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const start = t.search(/[[{]/);
  if (start < 0) return t;
  const close = t[start] === '{' ? '}' : ']';
  const end = t.lastIndexOf(close);
  return end > start ? t.slice(start, end + 1) : t;
}
