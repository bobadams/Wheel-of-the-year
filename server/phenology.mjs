// Wheel-of-the-Year phenology service.
//
// Produces the "Wildlife & blooms" band: the characteristic seasonal ecological
// events for a location (flower blooms, migrations, arrivals, breeding), each
// with a date window. Imported by server/image-server.mjs and exposed at
// POST /wheel-images/phenology.
//
// Design principle: never let the LLM (or any single source) assert a bare fact.
// Every event decomposes into three independently-checkable claims — does the
// species occur here? is the event type real for it? when does it happen? —
// each verified against the source that is actually good at it, and the event is
// given a CONFIDENCE TIER rather than a binary keep/drop.
//
// Pipeline (per category — mammals, fish, birds, insects, plants — handled
// separately and streamed to the client as each finishes):
//
//   STEP 1  PROPOSE, data-first. Two lanes:
//     (a) Retrieval lane — iNaturalist /observations/species_counts returns the
//         species ACTUALLY most-observed near the location for the category. The
//         LLM only LABELS this real menu ("which of these has a notable seasonal
//         event, and roughly when?") so it cannot invent a species.
//     (b) Famous-events lane — the LLM additionally proposes locally-iconic events
//         that may be under-photographed (offshore whale passages, salmon runs).
//         These are the events iNat can't surface on its own; they must clear a
//         non-iNat occurrence + behaviour check before they survive (Step 3).
//
//   STEP 2  TIME against iNaturalist, corrected. Presence histograms are geofiltered
//     and use phenology/life-stage annotations where they encode the event
//     (flowering, larva/juvenile). Two refinements over raw presence:
//       - OBSERVER-BIAS NORMALISATION — divide the taxon's weekly counts by the
//         whole iconic group's weekly counts, converting "when were people out
//         with cameras" into "when was THIS species disproportionately seen".
//       - ONSET vs PEAK — arrival/migration timing uses the rising edge (when the
//         species shows up), not the observation peak (mid-season presence).
//
//   STEP 3  CORROBORATE + tier. An event that iNat confirms locally (enough nearby
//     records + a clear season) is VERIFIED (solid). One it can't confirm is only
//     kept as CORROBORATED (dashed, '*') when it clears a real occurrence gate
//     (GBIF regional presence / iNat local records / eBird) AND has independent
//     support for the behaviour (a Wikipedia trait match) or data-backed timing.
//     Anything that fails the occurrence gate or has no support is REJECTED — this
//     is what keeps the band grounded rather than imaginary.
//
//   STEP 4  CROSS-CHECK. GBIF month facets (a second, larger occurrence dataset,
//     and for birds largely eBird-sourced) sanity-check the iNat window: when they
//     disagree by more than ~2 months a verified event is downgraded to dashed.
//     For birds, an optional eBird nearby-observations call (env EBIRD_API_KEY)
//     strengthens the occurrence gate.
//
// Results are disk-cached per location key, so each location generates once.
//
// Zero dependencies; uses global fetch (Node 18+).

import { promises as fs } from 'node:fs';
import path from 'node:path';

const INAT = 'https://api.inaturalist.org/v1';
const GBIF = 'https://api.gbif.org/v1';
const WIKI = 'https://en.wikipedia.org/api/rest_v1/page/summary';
const UA   = 'wheel-of-the-year/1.0';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const VALID_TYPES = ['bloom', 'migration', 'arrival', 'emergence', 'breeding', 'other'];

// Animal/plant categories, each queried separately and confirmed against its
// iNaturalist iconic taxon so a proposed name can't drift into the wrong kingdom
// (a plant name resolving to an animal, etc.). Array order = the order categories
// are computed and streamed to the client.
const CATEGORIES = [
  { id: 'mammals', label: 'mammals', noun: 'animal', iconic: 'Mammalia' },
  { id: 'fish',    label: 'fish',    noun: 'animal', iconic: 'Actinopterygii' },
  { id: 'birds',   label: 'birds',   noun: 'animal', iconic: 'Aves' },
  { id: 'insects', label: 'insects', noun: 'animal', iconic: 'Insecta' },
  { id: 'plants',  label: 'plants',  noun: 'plant',  iconic: 'Plantae' },
];

// Minimum nearby iNaturalist records for a VERIFIED (data-timed) event.
const MIN_OBS = 50;
// Minimum iNat local records for the weaker occurrence gate used by the dashed
// (corroborated) lane — enough to say "the species is really seen here".
const MIN_LOCAL = 5;
// Minimum GBIF nearby records for the corroborated lane's occurrence gate.
const MIN_REGIONAL = 20;
// Above this window width (in weeks, of 53) the distribution is too flat to call
// a season — the species is observed roughly year-round, so we don't trust the
// data peak and won't mark the event verified.
const MAX_SEASON_WEEKS = 28;

// iNat controlled term "Plant Phenology" (12) → Flowering (13); "Life Stage" (1)
// → Larva (6, insect emergence) / Juvenile (8, recent breeding). The life-stage
// value ids are best-effort: if an annotated histogram comes back too sparse we
// fall back to the raw histogram, so a stale id degrades rather than breaks.
const LIFE_STAGE_TERM = 1;
const LIFESTAGE = { emergence: 6, breeding: 8 };

const EBIRD_KEY = process.env.EBIRD_API_KEY || '';

// Cumulative days before each month in a 365-day (non-leap) year. iNat week
// histograms are calendar-based (week 1 ≈ Jan 1), and the existing wheel maps
// DOY 0 to the top; month DOYs use the same calendar basis for consistency.
const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const monthMidDOY = m => (MONTH_START[(m - 1 + 12) % 12] + 15) % 365;
function doyToMonth(doy) {
  let m = 0;
  for (let i = 11; i >= 0; i--) { if (doy >= MONTH_START[i]) { m = i; break; } }
  return m + 1;
}
const monthDist = (a, b) => { const d = Math.abs(a - b) % 12; return d > 6 ? 12 - d : d; };
const weekToDOY = w => (((w - 1) * 7) % 365 + 365) % 365;
const sum = a => a.reduce((s, v) => s + v, 0);

/** Trim a label to <= max chars on a word boundary (no mid-word cuts). */
function trimLabel(s, max = 32) {
  s = String(s || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
}

/** Coerce a proposed month range into a clean [start,end] of 1-12 ints, or null. */
function normMonths(m) {
  if (!Array.isArray(m) || m.length < 2) return null;
  let a = Math.round(Number(m[0])), b = Math.round(Number(m[1]));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  a = ((a - 1 + 12) % 12) + 1; b = ((b - 1 + 12) % 12) + 1;
  return [a, b];
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

// ── Step 1a: retrieve real local species ──────────────────────────────────────

/**
 * The species actually most-observed near the location for a category, from iNat
 * /observations/species_counts. This is the anti-hallucination backbone: the LLM
 * labels events over THIS real menu, so it cannot invent a species that isn't
 * present. Returns [{ id, name, common, count }], most-observed first.
 */
async function fetchSpeciesCounts(lat, lon, iconic) {
  try {
    const u = `${INAT}/observations/species_counts?iconic_taxa=${iconic}`
            + `&lat=${lat}&lng=${lon}&radius=200&quality_grade=research&per_page=30`;
    const res = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.results || [])
      .map(r => ({
        id: r.taxon?.id,
        name: r.taxon?.name || '',
        common: r.taxon?.preferred_common_name || r.taxon?.name || '',
        count: r.count || 0,
      }))
      .filter(t => t.id && t.name);
  } catch { return []; }
}

/**
 * STEP 1a — label the real-species menu. The LLM picks which retrieved species
 * have a notable seasonal event; it returns the list index (`ref`) so we bind the
 * event back to the exact real taxon id, never a name the LLM might mangle.
 */
async function proposeFromRealSpecies(cat, facts, species, llm) {
  if (!species.length) return [];
  const menu = species.slice(0, 20)
    .map((s, i) => `${i + 1}. ${s.common} (${s.name})`).join('\n');
  const f = facts || {};
  const examples = cat.id === 'plants'
    ? 'a major bloom, leaf-out, fall color, or fruiting'
    : 'a migration, arrival, breeding/birthing, emergence, or spawning run';
  const prompt = [
    `You are a field naturalist near ${f.name ?? 'a location'} (lat ${f.lat ?? '?'},`,
    `lon ${f.lon ?? '?'}, ${f.hemisphere ?? 'northern'} hemisphere, biome`,
    `${f.biome ?? 'temperate'}). Below is a numbered list of ${cat.label} that are`,
    'REALLY observed there. Pick up to THREE that have a CHARACTERISTIC, recognizable',
    `seasonal event (${examples}). Only pick species with a genuinely notable event;`,
    'if fewer than three do, pick fewer. Do not invent species not on the list.',
    '',
    'Species actually seen here:',
    menu,
    '',
    'For each pick provide:',
    '- ref: the number of the species from the list above',
    '- common_name: a short event name, e.g. "Chinook salmon run"',
    '- event_type: one of bloom, migration, arrival, emergence, breeding, other',
    '- expected_months: [startMonth, endMonth], integers 1-12, when you expect it',
    '',
    'Respond with ONLY JSON of the form {"events": [ ... ]}.',
  ].join('\n');

  const obj = await ollamaJSON(prompt, llm);
  const list = obj && Array.isArray(obj.events) ? obj.events : Array.isArray(obj) ? obj : [];
  const out = [];
  for (const e of list) {
    const ref = Math.round(Number(e.ref));
    const sp = Number.isFinite(ref) && species[ref - 1] ? species[ref - 1] : null;
    if (!sp) continue; // couldn't bind to a real species → drop
    out.push({
      common_name: String(e.common_name || e.name || sp.common).trim().slice(0, 60),
      taxon: sp.name,
      taxon_id: sp.id,
      local_count: sp.count,
      event_type: VALID_TYPES.includes(e.event_type) ? e.event_type : 'other',
      expected_months: normMonths(e.expected_months),
      lane: 'data',
    });
    if (out.length >= 3) break;
  }
  return out;
}

// ── Step 1b: famous / under-photographed events ───────────────────────────────

/**
 * STEP 1b — the LLM's unique lane: locally-iconic events that iNat may not surface
 * because the animal is hard to photograph (offshore whales, spawning runs). These
 * are proposed freely but MUST pass the non-iNat occurrence + behaviour checks in
 * anchorEvent before they survive — the LLM is not trusted on its own here.
 */
async function proposeFamousEvents(cat, facts, llm) {
  const f = facts || {};
  const coastal = f.coastal ? 'yes (near the coast)' : 'unknown';
  const examples = cat.id === 'plants'
    ? 'major flower blooms, leaf-out, fall color, fruiting'
    : 'migrations, arrivals, breeding or birthing, emergences, spawning runs';
  const prompt = [
    `You are a field naturalist. List up to TWO of the MOST CHARACTERISTIC, iconic`,
    `seasonal ${cat.label} events for the ecosystem around one specific location —`,
    `the ${cat.label} events that define the living year there (${examples}),`,
    'especially locally-famous ones a visitor would travel to see even if they are',
    'hard to photograph (e.g. offshore passages, night emergences, spawning runs).',
    'List only real, well-known events; if fewer than two apply here, list fewer.',
    '',
    'For each event provide:',
    '- common_name: short event name, e.g. "Gray whale migration"',
    `- taxon: the ${cat.noun} species or genus, common or scientific name`,
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

  const obj = await ollamaJSON(prompt, llm);
  const list = obj && Array.isArray(obj.events) ? obj.events : Array.isArray(obj) ? obj : [];
  return list
    .map(e => ({
      common_name: String(e.common_name || e.name || '').trim().slice(0, 60),
      taxon: String(e.taxon || e.species || e.common_name || '').trim().slice(0, 80),
      taxon_id: null,
      event_type: VALID_TYPES.includes(e.event_type) ? e.event_type : 'other',
      expected_months: normMonths(e.expected_months),
      lane: 'famous',
    }))
    .filter(e => e.common_name && e.taxon)
    .slice(0, 2);
}

/** Merge the two proposal lanes, preferring the data lane, deduped by taxon. */
function mergeProposals(dataProps, famousProps) {
  const seen = new Set();
  const merged = [];
  for (const e of [...dataProps, ...famousProps]) {
    const key = e.taxon_id != null ? `id:${e.taxon_id}` : `n:${e.taxon.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  return merged.slice(0, 5); // bound the per-category iNat/GBIF call budget
}

// ── Step 2: time against iNaturalist (corrected) ──────────────────────────────

/**
 * Resolve a taxon name to an iNaturalist taxon id, constrained to `iconic` so a
 * name can't resolve into the wrong category. The /taxa autocomplete ignores its
 * own iconic filter, so we check each candidate's iconic_taxon_name ourselves.
 */
async function resolveTaxon(taxon, iconic) {
  try {
    const res = await fetch(`${INAT}/taxa?q=${encodeURIComponent(taxon)}&per_page=5`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const json = await res.json();
    const results = json.results || [];
    const match = iconic ? results.find(r => r.iconic_taxon_name === iconic) : results[0];
    return match?.id ?? null;
  } catch { return null; }
}

/** Fetch a 53-bin week-of-year histogram (counts), geofiltered, or null. */
async function fetchHistogram(taxonId, lat, lon, { flowering = false, lifeStage = null } = {}) {
  let u = `${INAT}/observations/histogram?taxon_id=${taxonId}`
        + `&lat=${lat}&lng=${lon}&radius=150&date_field=observed&interval=week_of_year`;
  if (flowering) u += '&term_id=12&term_value_id=13';          // Plant Phenology = Flowering
  else if (lifeStage) u += `&term_id=${LIFE_STAGE_TERM}&term_value_id=${lifeStage}`;
  try {
    const res = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const json = await res.json();
    const wk = json.results?.week_of_year;
    if (!wk) return null;
    const arr = new Array(53).fill(0);
    for (const [k, v] of Object.entries(wk)) {
      const i = Number(k) - 1;
      if (i >= 0 && i < 53) arr[i] = v;
    }
    return arr;
  } catch { return null; }
}

/** All observations of an iconic group near the location — the bias denominator. */
async function fetchBaseline(iconic, lat, lon) {
  let u = `${INAT}/observations/histogram?iconic_taxa=${iconic}`
        + `&lat=${lat}&lng=${lon}&radius=150&date_field=observed&interval=week_of_year`;
  try {
    const res = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const json = await res.json();
    const wk = json.results?.week_of_year;
    if (!wk) return null;
    const arr = new Array(53).fill(0);
    for (const [k, v] of Object.entries(wk)) { const i = Number(k) - 1; if (i >= 0 && i < 53) arr[i] = v; }
    return arr;
  } catch { return null; }
}

/**
 * Reweight weekly counts by how under-observed each week was overall, turning raw
 * presence ("when people were out with cameras") into relative activity ("when
 * THIS species was disproportionately seen"). No-op when the baseline is too thin
 * to trust; the reweight factor is smoothed and capped so low-baseline weeks don't
 * blow up.
 */
function biasCorrect(counts, baseline) {
  if (!baseline || sum(baseline) < 100) return counts.slice();
  const bmean = sum(baseline) / baseline.length;
  const eps = bmean * 0.25 + 1;
  return counts.map((c, i) => c * Math.min(bmean / (baseline[i] + eps), 4));
}

/** Circular 3-tap smoothing. */
function smoothCircular(a) {
  const n = a.length;
  return a.map((_, i) => (a[(i - 1 + n) % n] + 2 * a[i] + a[(i + 1) % n]) / 4);
}

/**
 * Find the peak bin and the contiguous span around it where the smoothed signal
 * stays at or above half the peak (wrapping the year). Works for any circular
 * array (53 weeks or 12 months). Returns 0-based bin indices plus `width`.
 */
function circularPeakWindow(arr) {
  const s = smoothCircular(arr);
  const n = s.length;
  let peak = 0;
  for (let i = 1; i < n; i++) if (s[i] > s[peak]) peak = i;
  const thresh = s[peak] * 0.5;
  let lo = peak, hi = peak;
  for (let step = 1; step < n; step++) { const j = (peak - step + n) % n; if (s[j] >= thresh) lo = j; else break; }
  for (let step = 1; step < n; step++) { const j = (peak + step) % n; if (s[j] >= thresh) hi = j; else break; }
  return { start: lo, peak, end: hi, width: ((hi - lo + n) % n) + 1 };
}

/**
 * Turn a weekly signal into a DOY window. Arrival/migration events report the
 * RISING EDGE (start→peak, labelled at onset) — that's when the species shows up.
 * Everything else reports the season around the peak (labelled at peak).
 */
function windowFromWeeks(counts, type) {
  const w = circularPeakWindow(counts);
  const onset = type === 'arrival' || type === 'migration';
  const startW = w.start + 1, peakW = w.peak + 1, endW = w.end + 1;
  if (onset) {
    const end = startW === peakW ? endW : peakW;
    return { startDOY: weekToDOY(startW), peakDOY: weekToDOY(startW), endDOY: weekToDOY(end), widthWeeks: w.width };
  }
  return { startDOY: weekToDOY(startW), peakDOY: weekToDOY(peakW), endDOY: weekToDOY(endW), widthWeeks: w.width };
}

/** Turn a 12-bin month signal into a DOY window (same onset logic as weeks). */
function windowFromMonths(months, type) {
  const w = circularPeakWindow(months);
  const onset = type === 'arrival' || type === 'migration';
  const startM = w.start + 1, peakM = w.peak + 1, endM = w.end + 1;
  if (onset) {
    const end = startM === peakM ? endM : peakM;
    return { startDOY: monthMidDOY(startM), peakDOY: monthMidDOY(startM), endDOY: monthMidDOY(end) };
  }
  return { startDOY: monthMidDOY(startM), peakDOY: monthMidDOY(peakM), endDOY: monthMidDOY(endM) };
}

/** Turn an LLM [startMonth, endMonth] guess into a DOY window (last resort). */
function windowFromMonthRange(months, type) {
  if (!months) return null;
  const [a, b] = months;
  const onset = type === 'arrival' || type === 'migration';
  const mid = a === b ? a : (a + Math.round((((b - a + 12) % 12)) / 2) - 1 + 12) % 12 + 1;
  return { startDOY: monthMidDOY(a), peakDOY: monthMidDOY(onset ? a : mid), endDOY: monthMidDOY(b) };
}

/**
 * Pick the histogram that best encodes the event: flowering annotation for blooms,
 * life-stage annotation for emergence/breeding, raw presence otherwise. Annotated
 * histograms fall back to raw when too sparse, so a stale annotation id can't blank
 * out an event that has plenty of raw records.
 */
async function fetchTimedHistogram(taxonId, lat, lon, type) {
  const annotated = type === 'bloom' ? { flowering: true }
    : LIFESTAGE[type] ? { lifeStage: LIFESTAGE[type] } : null;
  if (annotated) {
    let c = await fetchHistogram(taxonId, lat, lon, annotated);
    if (!c || sum(c) < 30) { await sleep(250); c = await fetchHistogram(taxonId, lat, lon); }
    return c;
  }
  return fetchHistogram(taxonId, lat, lon);
}

// ── Step 3: corroborate against Wikipedia ─────────────────────────────────────

// Keyword signatures per event type. A match in the species' encyclopedia summary
// corroborates that the claimed behaviour is real for the taxon; 'other' always
// passes (nothing specific to disconfirm).
const BEHAVIOR_RE = {
  migration: /migrat|passage|overwinter|winters? in|summers? in/,
  arrival:   /migrat|visitor|winters? in|summers? in|arriv|overwinter/,
  breeding:  /breed|nest|spawn|calv|mating|\bmate\b|\brut\b|lek|brood|nursery|pups?\b/,
  emergence: /larva|emerg|metamorph|hatch|brood|instar|nymph|pupa/,
  bloom:     /flower|bloom|blossom|inflorescen/,
  other:     /./,
};

/** Wikipedia summary extract for a name, lowercased, or '' on any miss. */
async function fetchWikiExtract(name) {
  try {
    const res = await fetch(`${WIKI}/${encodeURIComponent(String(name).replace(/ /g, '_'))}`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return '';
    const json = await res.json();
    return String(json.extract || '').toLowerCase();
  } catch { return ''; }
}

/** true / false if the extract does / doesn't support the behaviour; null if unknown. */
function corroborateBehavior(text, type) {
  if (!text) return null;
  return (BEHAVIOR_RE[type] || BEHAVIOR_RE.other).test(text);
}

// ── Step 4: cross-check against GBIF (+ optional eBird for birds) ──────────────

/** GBIF taxon key for a scientific/common name, or null. */
async function gbifKey(name) {
  try {
    const res = await fetch(`${GBIF}/species/match?name=${encodeURIComponent(name)}`,
      { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const json = await res.json();
    return json.usageKey ?? null;
  } catch { return null; }
}

/**
 * GBIF month histogram + total records within `radiusKm` of the location. A
 * second, larger occurrence dataset (for birds, largely eBird-sourced) used both
 * as the corroborated lane's occurrence gate and to sanity-check the iNat month.
 */
async function gbifMonths(key, lat, lon, radiusKm = 200) {
  try {
    const u = `${GBIF}/occurrence/search?taxonKey=${key}`
            + `&geoDistance=${lat},${lon},${radiusKm}km&hasCoordinate=true`
            + `&facet=month&facetLimit=12&limit=0`;
    const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const json = await res.json();
    const months = new Array(12).fill(0);
    const f = (json.facets || []).find(x => x.field === 'MONTH');
    if (f) for (const c of f.counts) { const m = Number(c.name); if (m >= 1 && m <= 12) months[m - 1] = c.count; }
    return { total: json.count ?? sum(months), months };
  } catch { return null; }
}

/** Resolve a name to GBIF month data, or null. */
async function fetchGbif(name, lat, lon) {
  const key = await gbifKey(name);
  if (!key) return null;
  await sleep(200);
  return gbifMonths(key, lat, lon);
}

/** Set of bird names observed near the point in the last 30 days (eBird), or null. */
async function fetchEbirdNearby(lat, lon) {
  if (!EBIRD_KEY) return null;
  try {
    const u = `https://api.ebird.org/v2/data/obs/geo/recent`
            + `?lat=${lat.toFixed(2)}&lng=${lon.toFixed(2)}&dist=50&back=30&maxResults=200`;
    const res = await fetch(u, { headers: { 'X-eBirdApiToken': EBIRD_KEY }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const json = await res.json();
    const set = new Set();
    for (const o of json) { if (o.comName) set.add(o.comName.toLowerCase()); if (o.sciName) set.add(o.sciName.toLowerCase()); }
    return set;
  } catch { return null; }
}

/** Does an eBird nearby-name set support this event's taxon? */
function ebirdSupports(set, ev) {
  if (!set) return false;
  const a = (ev.taxon || '').toLowerCase(), b = (ev.common_name || '').toLowerCase();
  for (const name of set) {
    if (!name) continue;
    if (a.includes(name) || name.includes(a) || b.includes(name)) return true;
  }
  return false;
}

// ── Anchor one event → a confidence-tiered record (or null) ───────────────────

/**
 * Verify one proposed event down its three claims and return a tiered record, or
 * null (rejected). `ctx` caches the per-category baseline histogram and eBird set.
 *   - VERIFIED (verified:true, solid): iNat has enough nearby records AND a clear,
 *     bias-corrected season; that observed window sets the dates. GBIF disagreement
 *     by >2 months downgrades it to dashed.
 *   - CORROBORATED (verified:false, dashed '*'): iNat can't confirm locally, but the
 *     species really occurs here (GBIF/iNat/eBird) AND the behaviour is supported
 *     (Wikipedia) or the timing is data-backed (GBIF); dates from GBIF or the LLM.
 *   - REJECTED (null): fails the occurrence gate or has no independent support.
 */
async function anchorEvent(ev, lat, lon, cat, ctx) {
  // Claim 1 — species identity. Data-lane events already carry a real taxon id;
  // famous-lane names are resolved (and iconic-constrained) here.
  let taxonId = ev.taxon_id ?? null;
  if (!taxonId) { taxonId = await resolveTaxon(ev.taxon, cat.iconic); await sleep(300); }

  // Claim 3 (attempt A) — local iNat timing.
  let inatLocalTotal = 0;
  let verifiedWindow = null;
  if (taxonId) {
    const counts = await fetchTimedHistogram(taxonId, lat, lon, ev.event_type);
    await sleep(300);
    inatLocalTotal = counts ? sum(counts) : 0;
    if (inatLocalTotal >= MIN_OBS) {
      if (!ctx.baseline) { ctx.baseline = await fetchBaseline(cat.iconic, lat, lon); await sleep(300); }
      const corrected = biasCorrect(counts, ctx.baseline);
      const w = windowFromWeeks(corrected, ev.event_type);
      if (w.widthWeeks <= MAX_SEASON_WEEKS) verifiedWindow = w; // clear season
    }
  }

  // GBIF cross-check / occurrence data (shared by both tiers).
  const gbif = await fetchGbif(ev.taxon, lat, lon);
  await sleep(200);
  const gbifTiming = gbif && gbif.total >= 30;

  if (verifiedWindow) {
    let verified = true, confidence = 'verified', source = 'inat';
    if (gbifTiming) {
      const inatMonth = doyToMonth(verifiedWindow.peakDOY);
      const gbifPeak = circularPeakWindow(gbif.months).peak + 1;
      if (monthDist(inatMonth, gbifPeak) > 2) { verified = false; confidence = 'corroborated'; } // sources disagree
    }
    return record(ev, cat, taxonId, verifiedWindow, {
      verified, confidence, source, obs_total: inatLocalTotal,
    });
  }

  // Claim 1 (gate) — does it really occur here? Reject pure hallucinations.
  const occurrenceOK = (gbif && gbif.total >= MIN_REGIONAL)
    || inatLocalTotal >= MIN_LOCAL
    || (cat.id === 'birds' && ebirdSupports(ctx.ebird, ev));
  if (!occurrenceOK) return null;

  // Claim 2 — is the behaviour real for this taxon? Needs independent support:
  // an encyclopedia trait match, or a data-backed GBIF season. LLM-only claims die.
  const behaviorOK = corroborateBehavior(await fetchWikiExtract(ev.taxon), ev.event_type);
  await sleep(200);
  if (!(behaviorOK === true || gbifTiming)) return null;

  // Claim 3 (attempt B) — timing from GBIF where we have it, else the LLM guess.
  const window = gbifTiming
    ? windowFromMonths(gbif.months, ev.event_type)
    : windowFromMonthRange(ev.expected_months, ev.event_type);
  if (!window) return null;

  return record(ev, cat, taxonId, window, {
    verified: false,
    confidence: 'corroborated',
    source: gbifTiming ? 'gbif' : 'llm',
    obs_total: gbif?.total ?? MIN_LOCAL,
  });
}

/** Assemble the internal event record from a proposal + window + tier metadata. */
function record(ev, cat, taxonId, window, meta) {
  return {
    label: ev.common_name,
    startDOY: Math.round(window.startDOY),
    peakDOY: Math.round(window.peakDOY),
    endDOY: Math.round(window.endDOY),
    event_type: ev.event_type,
    category: cat.id,
    taxon_id: taxonId,
    ...meta,
  };
}

// ── Orchestration + cache ─────────────────────────────────────────────────────

const tierRank = e => (e.confidence === 'verified' ? 2 : 1);

/** Propose (both lanes) → anchor → tier one category, returning its kept events. */
async function buildCategory(cat, facts, lat, lon, llm) {
  const real = await fetchSpeciesCounts(lat, lon, cat.iconic);
  await sleep(400);
  const dataProps = await proposeFromRealSpecies(cat, facts, real, llm);
  const famousProps = await proposeFamousEvents(cat, facts, llm);
  const proposed = mergeProposals(dataProps, famousProps);

  // Per-category caches: baseline histogram (fetched lazily) + eBird nearby set.
  const ctx = { baseline: null, ebird: cat.id === 'birds' ? await fetchEbirdNearby(lat, lon) : null };

  const anchored = [];
  // Drop events that resolve to a taxon already kept this category (the LLM often
  // proposes two events for one species), keeping the first.
  const seenTaxa = new Set();
  for (const ev of proposed) {
    const a = await anchorEvent(ev, lat, lon, cat, ctx);
    const key = a ? (a.taxon_id ?? a.label?.toLowerCase()) : null;
    if (a && key && !seenTaxa.has(key)) { seenTaxa.add(key); anchored.push(a); }
    await sleep(700); // be polite to iNaturalist (~60 req/min)
  }

  // Keep the strongest three: verified before corroborated, then best-supported.
  anchored.sort((x, y) => (tierRank(y) - tierRank(x)) || ((y.obs_total || 0) - (x.obs_total || 0)));
  const events = anchored.slice(0, 3).map(e => ({
    label: trimLabel(e.label),
    startDOY: e.startDOY,
    peakDOY: e.peakDOY,
    endDOY: e.endDOY,
    event_type: e.event_type,
    category: e.category,
    source: e.source,
    verified: e.verified,
    confidence: e.confidence,
    obs_total: e.obs_total,
    taxon_id: e.taxon_id,
  }));
  return { events, proposed, anchored };
}

/** Group already-built events by category and replay them through `emit`. */
function streamByCategory(events, emit) {
  if (!emit) return;
  for (const cat of CATEGORIES) {
    emit(cat.id, (events || []).filter(e => e.category === cat.id));
  }
}

async function build(key, facts, force, opts, emit) {
  const { cacheDir } = opts;
  const jsonPath  = path.join(cacheDir, `${key}.phenology.json`);
  const debugPath = path.join(cacheDir, `${key}.phenology.debug.json`);

  if (!force) {
    try {
      const cached = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
      streamByCategory(cached.events, emit); // replay the cache, category by category
      return cached;
    } catch { /* miss */ }
  }

  // Coalesce concurrent (re)generations: a second caller can't share the first's
  // progressive stream, so it awaits the full result and emits it all at once.
  if (inFlight.has(key)) {
    const result = await inFlight.get(key);
    streamByCategory(result.events, emit);
    return result;
  }

  const work = (async () => {
    // 8 GB Mac mini: free the image generator's RAM before we hit Ollama. Only on
    // this real-generation path — cache hits above replay without touching the LLM.
    await opts.freeRam?.();
    const llm = { ollamaUrl: opts.ollamaUrl, model: opts.model };
    const lat = facts?.lat ?? 0, lon = facts?.lon ?? 0;

    const events = [];
    const debug = { facts, categories: {} };
    // Compute one category at a time and emit each the moment it is ready.
    for (const cat of CATEGORIES) {
      const built = await buildCategory(cat, facts, lat, lon, llm);
      events.push(...built.events);
      debug.categories[cat.id] = { proposed: built.proposed, anchored: built.anchored };
      if (emit) emit(cat.id, built.events);
    }

    const result = { key, generated_at: new Date().toISOString(), events };

    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(jsonPath, JSON.stringify(result, null, 2));
    await fs.writeFile(debugPath, JSON.stringify(debug, null, 2));
    return result;
  })();

  inFlight.set(key, work);
  try { return await work; }
  finally { inFlight.delete(key); }
}

/**
 * Handle a /phenology request. `opts`: { force, cacheDir, ollamaUrl, model,
 * freeRam? } — `freeRam` is an optional async hook the caller uses to evict the
 * image generator's RAM before the (Ollama-heavy) build runs; it fires only on a
 * real generation, never on a cache replay.
 * `emit(category, events)` is called once per category as it becomes ready (and
 * is replayed from cache on a hit) so the caller can stream results to the
 * client. Never throws on upstream failure — returns { events: [] } so the band
 * degrades gracefully like the other optional fetches.
 */
export async function handlePhenology(key, facts, opts, emit) {
  try {
    return await build(key, facts, !!opts.force, opts, emit);
  } catch (e) {
    console.error('[phenology] build failed:', e.message);
    return { key, generated_at: new Date().toISOString(), events: [] };
  }
}
