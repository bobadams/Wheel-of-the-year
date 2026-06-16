// Wheel-of-the-Year phenology service.
//
// Produces the "Wildlife & blooms" band: the characteristic seasonal ecological
// events for a location (flower blooms, migrations, arrivals, breeding), each
// with a date window. Imported by server/image-server.mjs and exposed at
// POST /wheel-images/phenology.
//
// Pipeline (Design B — see plan):
//   1. Ask the local LLM (Ollama) to PROPOSE 6-10 characteristic events for the
//      location, each with a taxon to search and a fallback month range.
//   2. ANCHOR each event's timing against iNaturalist observation histograms,
//      geofiltered to the location. Blooms use the flowering phenology
//      annotation; presence-based events use the raw histogram. Where iNaturalist
//      coverage is good, the data sets the dates (source:'inat', verified). Where
//      it is thin (unresolved taxon / too few records), fall back to the LLM's
//      proposed range (source:'llm', verified:false → shown with a '*').
//   3. RECONCILE labels: feed each data-anchored event's observed peak back to the
//      LLM so it can confirm the proposed label or relabel it to the activity
//      actually happening then (e.g. elephant-seal "calving" → "juvenile haul-out"
//      when observations peak in April, not the Dec-Feb calving the LLM guessed).
//
// Results are disk-cached per location key, so each location generates once.
//
// Zero dependencies; uses global fetch (Node 18+).

import { promises as fs } from 'node:fs';
import path from 'node:path';

const INAT = 'https://api.inaturalist.org/v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 0-indexed DOY (Jan 1 = 0) of the first day of each month, non-leap year — the
// same calendar-DOY convention the holidays band uses (Feb 29 excluded).
const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const MONTH_NAME  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const VALID_TYPES = ['bloom', 'migration', 'arrival', 'emergence', 'breeding', 'other'];

/** Trim a label to <= max chars on a word boundary (no mid-word cuts). */
function trimLabel(s, max = 32) {
  s = String(s || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
}

// Coalesce concurrent (re)generations for the same key.
const inFlight = new Map();

// ── LLM helper ────────────────────────────────────────────────────────────────

/** Call Ollama with JSON-mode output; returns the parsed object or null. */
async function ollamaJSON(prompt, { ollamaUrl, model, temperature = 0.6 }) {
  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // keep_alive: 0 frees the LLM's RAM immediately (the Mac mini shares 8 GB
      // with Forge / the astrology site).
      body: JSON.stringify({ model, prompt, stream: false, format: 'json', keep_alive: 0, options: { temperature } }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const json = await res.json();
    return JSON.parse(String(json.response || '').trim());
  } catch (e) {
    console.warn('[phenology] Ollama call failed:', e.message);
    return null;
  }
}

// ── Step 1: propose ─────────────────────────────────────────────────────────

async function proposeEvents(facts, llm) {
  const f = facts || {};
  const coastal = f.coastal ? 'yes (near the coast)' : 'unknown';
  const prompt = [
    'You are a field naturalist. List the 6 to 10 MOST CHARACTERISTIC, iconic',
    'seasonal wildlife and plant events for the ecosystem around one specific',
    'location — the events that define the living year there: major flower blooms,',
    'bird and insect migrations and arrivals, animal breeding or birthing, insect',
    'emergences. Prefer locally famous, recognizable, place-defining events. Avoid',
    'generic ones that occur everywhere.',
    '',
    'For each event provide:',
    '- common_name: short event name, e.g. "California poppy bloom"',
    '- taxon: the species or genus to search, common or scientific name, e.g.',
    '  "Eschscholzia californica" or "Monarch"',
    '- event_type: one of bloom, migration, arrival, emergence, breeding, other',
    '- expected_months: [startMonth, endMonth], integers 1-12, when you expect it',
    '',
    'Location:',
    `- Place: ${f.name ?? 'unknown'}`,
    `- Latitude: ${f.lat ?? '?'}, Longitude: ${f.lon ?? '?'}`,
    `- Hemisphere: ${f.hemisphere ?? 'northern'}`,
    `- Dominant biome: ${f.biome ?? 'temperate landscape'}`,
    `- Coastal: ${coastal}`,
    '',
    'Respond with ONLY JSON of the form {"events": [ ... ]}.',
  ].join('\n');

  for (let attempt = 0; attempt < 2; attempt++) {
    const obj = await ollamaJSON(prompt, llm);
    const list = obj && Array.isArray(obj.events) ? obj.events : Array.isArray(obj) ? obj : null;
    if (list) {
      return list
        .map(e => ({
          common_name: String(e.common_name || e.name || '').trim().slice(0, 60),
          taxon: String(e.taxon || e.species || e.common_name || '').trim().slice(0, 80),
          event_type: VALID_TYPES.includes(e.event_type) ? e.event_type : 'other',
          expected_months: normMonths(e.expected_months),
        }))
        .filter(e => e.common_name && e.taxon)
        .slice(0, 10);
    }
  }
  return [];
}

/** Coerce a proposed month range into a clean [start,end] of 1-12 ints, or null. */
function normMonths(m) {
  if (!Array.isArray(m) || m.length < 2) return null;
  let a = Math.round(Number(m[0])), b = Math.round(Number(m[1]));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  a = ((a - 1 + 12) % 12) + 1; b = ((b - 1 + 12) % 12) + 1;
  return [a, b];
}

// ── Step 2: anchor against iNaturalist ────────────────────────────────────────

/** Resolve a taxon name to an iNaturalist taxon id, or null. */
async function resolveTaxon(taxon) {
  try {
    const res = await fetch(`${INAT}/taxa?q=${encodeURIComponent(taxon)}&per_page=1`,
      { headers: { 'User-Agent': 'wheel-of-the-year/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const json = await res.json();
    return json.results?.[0]?.id ?? null;
  } catch { return null; }
}

/** Fetch a 53-bin week-of-year histogram (counts), geofiltered, or null. */
async function fetchHistogram(taxonId, lat, lon, { flowering = false } = {}) {
  let u = `${INAT}/observations/histogram?taxon_id=${taxonId}`
        + `&lat=${lat}&lng=${lon}&radius=150&date_field=observed&interval=week_of_year`;
  if (flowering) u += '&term_id=12&term_value_id=13'; // Plant Phenology = Flowering
  try {
    const res = await fetch(u, { headers: { 'User-Agent': 'wheel-of-the-year/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const json = await res.json();
    const wk = json.results?.week_of_year;
    if (!wk) return null;
    // weeks are keyed "1".."53"; build a dense 53-length array.
    const arr = new Array(53).fill(0);
    for (const [k, v] of Object.entries(wk)) {
      const i = Number(k) - 1;
      if (i >= 0 && i < 53) arr[i] = v;
    }
    return arr;
  } catch { return null; }
}

const sum = a => a.reduce((s, v) => s + v, 0);

/** Circular 3-tap smoothing of the weekly counts. */
function smoothCircular(a) {
  const n = a.length;
  return a.map((_, i) => (a[(i - 1 + n) % n] + 2 * a[i] + a[(i + 1) % n]) / 4);
}

/**
 * Find the peak week and the contiguous span around it where counts stay at or
 * above half the peak (wrapping around the year). Returns 1-based week indices
 * plus `widthWeeks` — a year-round/uniform distribution (a resident species with
 * no real season) expands to a very wide window, which the caller rejects as
 * "no clear seasonal signal" rather than reporting a meaningless peak.
 */
function peakWindow(counts) {
  const s = smoothCircular(counts);
  const n = s.length;
  let peak = 0;
  for (let i = 1; i < n; i++) if (s[i] > s[peak]) peak = i;
  const thresh = s[peak] * 0.5;
  let lo = peak, hi = peak;
  for (let step = 1; step < n; step++) { const j = (peak - step + n) % n; if (s[j] >= thresh) lo = j; else break; }
  for (let step = 1; step < n; step++) { const j = (peak + step) % n; if (s[j] >= thresh) hi = j; else break; }
  const widthWeeks = ((hi - lo + n) % n) + 1;
  return { startWeek: lo + 1, peakWeek: peak + 1, endWeek: hi + 1, widthWeeks };
}

// Above this window width (in weeks, of 53) the distribution is too flat to call
// a season — the species is observed roughly year-round, so we don't trust the
// data peak and fall back to the LLM's proposed range instead.
const MAX_SEASON_WEEKS = 28;

const weekToDOY  = w => (((w - 1) * 7) % 365 + 365) % 365;
const monthToDOY = m => MONTH_START[((m - 1) % 12 + 12) % 12];
const doyToMonth = d => { let m = 0; for (let i = 0; i < 12; i++) if (d >= MONTH_START[i]) m = i; return m; }; // 0-based

/** Mid-DOY of a window [start,end] on the 365-day circle. */
function midDOY(start, end) {
  let span = (end - start + 365) % 365;
  return (start + span / 2) % 365;
}

/** Build the DOY window for an LLM fallback month range. */
function monthRangeWindow([m1, m2]) {
  const startDOY = monthToDOY(m1);
  const endMonth0 = (m2 - 1) % 12;
  const endDOY = endMonth0 === 11 ? 364 : MONTH_START[endMonth0 + 1] - 1;
  return { startDOY, endDOY, peakDOY: midDOY(startDOY, endDOY) };
}

/**
 * Anchor one proposed event. Returns an event record with timing from
 * iNaturalist (source:'inat') when coverage is good, else from the LLM's
 * proposed range (source:'llm', verified:false). Returns null only when neither
 * source yields a usable window.
 */
async function anchorEvent(ev, lat, lon) {
  const fallback = () => {
    if (!ev.expected_months) return null;
    const w = monthRangeWindow(ev.expected_months);
    return {
      label: ev.common_name, taxon_id: null, event_type: ev.event_type,
      source: 'llm', verified: false, obs_total: 0,
      ...w, common_name: ev.common_name, expected_months: ev.expected_months,
    };
  };

  const taxonId = await resolveTaxon(ev.taxon);
  if (!taxonId) return fallback();

  let counts = await fetchHistogram(taxonId, lat, lon, { flowering: ev.event_type === 'bloom' });
  // Flowering annotation can be sparse even where raw obs are plentiful — retry raw.
  if (ev.event_type === 'bloom' && (!counts || sum(counts) < 30)) {
    counts = await fetchHistogram(taxonId, lat, lon);
  }
  const total = counts ? sum(counts) : 0;
  if (total < 50) { const fb = fallback(); if (fb) fb.taxon_id = taxonId; return fb; }

  const { startWeek, peakWeek, endWeek, widthWeeks } = peakWindow(counts);
  // Year-round resident with no real season → don't fake a peak; use LLM range.
  if (widthWeeks > MAX_SEASON_WEEKS) { const fb = fallback(); if (fb) fb.taxon_id = taxonId; return fb; }
  const startDOY = weekToDOY(startWeek), peakDOY = weekToDOY(peakWeek), endDOY = weekToDOY(endWeek);
  return {
    label: ev.common_name, taxon_id: taxonId, event_type: ev.event_type,
    source: 'inat', verified: true, obs_total: total,
    startDOY, peakDOY, endDOY, common_name: ev.common_name, expected_months: ev.expected_months,
    observed_peak_month: doyToMonth(peakDOY) + 1,
  };
}

// ── Step 3: reconcile labels for data-anchored events ────────────────────────

async function reconcileLabels(inatEvents, llm) {
  if (!inatEvents.length) return;
  const monthRange = ev => {
    const a = MONTH_NAME[doyToMonth(ev.startDOY)], b = MONTH_NAME[doyToMonth(ev.endDOY)];
    return a === b ? a : `${a}–${b}`;
  };
  const items = inatEvents.map((ev, i) => ({
    i,
    proposed: ev.common_name,
    taxon: ev.event_type,
    expected: ev.expected_months ? `${MONTH_NAME[ev.expected_months[0] - 1]}–${MONTH_NAME[ev.expected_months[1] - 1]}` : 'unknown',
    observed_peak: MONTH_NAME[(ev.observed_peak_month - 1)],
    observed_span: monthRange(ev),
  }));
  const prompt = [
    'For each wildlife/plant event below, you are given the originally proposed',
    'event label, its type, the months it was EXPECTED, and the months when the',
    'species is ACTUALLY most observed near this location (from citizen-science data).',
    '',
    'If the observed timing roughly matches what was expected, keep a clean, short',
    'label for the event. But if the data peaks in a clearly DIFFERENT season than',
    'expected, the proposed event is probably not what the data shows — RELABEL it',
    'to the activity that species is most likely doing at the OBSERVED time of year',
    'at this place (e.g. juvenile haul-out, post-breeding dispersal, peak sightings,',
    'fall foliage) rather than keeping the wrong event.',
    '',
    'Events:',
    JSON.stringify(items),
    '',
    'Respond with ONLY JSON: {"labels":[{"i":0,"label":"...","confirmed":true}, ...]}',
    'Each label is a natural, human-readable event name written with COMPLETE words',
    'only — for example "California poppy bloom", "Monarch butterfly migration",',
    '"Western fence lizard emergence". Never abbreviate, clip, shorten, or cut off a',
    'word; spell every word in full. There is no character limit. Provide one entry',
    'per event, with the same i values.',
  ].join('\n');

  const obj = await ollamaJSON(prompt, { ...llm, temperature: 0.2 });
  const labels = obj && Array.isArray(obj.labels) ? obj.labels : null;
  if (!labels) return; // keep proposed labels on failure
  for (const l of labels) {
    const ev = inatEvents[l.i];
    if (ev && typeof l.label === 'string' && l.label.trim()) {
      ev.label = l.label.trim();
      ev.confirmed = l.confirmed !== false;
    }
  }
}

// ── Orchestration + cache ─────────────────────────────────────────────────────

async function build(key, facts, force, opts) {
  const { cacheDir } = opts;
  const jsonPath  = path.join(cacheDir, `${key}.phenology.json`);
  const debugPath = path.join(cacheDir, `${key}.phenology.debug.json`);

  if (!force) {
    try { return JSON.parse(await fs.readFile(jsonPath, 'utf8')); } catch { /* miss */ }
  }
  if (inFlight.has(key)) return inFlight.get(key);

  const work = (async () => {
    const llm = { ollamaUrl: opts.ollamaUrl, model: opts.model };
    const lat = facts?.lat ?? 0, lon = facts?.lon ?? 0;

    const proposed = await proposeEvents(facts, llm);
    const anchored = [];
    for (const ev of proposed) {
      const a = await anchorEvent(ev, lat, lon);
      if (a) anchored.push(a);
      await sleep(700); // be polite to iNaturalist (~60 req/min)
    }

    await reconcileLabels(anchored.filter(e => e.source === 'inat'), llm);

    const events = anchored.map(e => ({
      label: trimLabel(e.label),
      startDOY: Math.round(e.startDOY),
      peakDOY: Math.round(e.peakDOY),
      endDOY: Math.round(e.endDOY),
      event_type: e.event_type,
      source: e.source,
      verified: e.verified,
      obs_total: e.obs_total,
      taxon_id: e.taxon_id,
    }));
    const result = { key, generated_at: new Date().toISOString(), events };

    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(jsonPath, JSON.stringify(result, null, 2));
    await fs.writeFile(debugPath, JSON.stringify({ facts, proposed, anchored }, null, 2));
    return result;
  })();

  inFlight.set(key, work);
  try { return await work; }
  finally { inFlight.delete(key); }
}

/**
 * Handle a /phenology request. `opts`: { force, cacheDir, ollamaUrl, model }.
 * Never throws on upstream failure — returns { events: [] } so the band degrades
 * gracefully like the other optional fetches.
 */
export async function handlePhenology(key, facts, opts) {
  try {
    return await build(key, facts, !!opts.force, opts);
  } catch (e) {
    console.error('[phenology] build failed:', e.message);
    return { key, generated_at: new Date().toISOString(), events: [] };
  }
}
