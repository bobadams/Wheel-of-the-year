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
//       - PEAK-CENTRED — the window is centred on the observation peak, i.e. when
//         the species is most PRESENT/noticeable, not a technical onset. If a
//         migrant "arrives" in May but is mostly seen in July, we report July —
//         the experience a visitor actually has (accuracy over specificity).
//
//   STEP 3  CORROBORATE + tier. Every taxon must first resolve within the category's
//     iconic class (species_counts is already class-filtered; famous-lane names go
//     through iNat's iconic filter and are DROPPED if they don't match — this keeps
//     whales out of "fish", reptiles out of "birds"). An event iNat confirms locally
//     (enough nearby records + a clear season) is VERIFIED (solid). One it can't is
//     kept as CORROBORATED (dashed, '*') ONLY when it really occurs here (iNat local
//     records / eBird), its behaviour is corroborated by Wikipedia, and a NARROW
//     window can be formed from the sparse iNat histogram or the LLM's month hint.
//     Anything else is REJECTED — precision over recall.
//
//     Labels are composed from the resolved species' common name + a COLLOQUIAL
//     event noun ("California Poppy bloom"), never the LLM's free-text label — the
//     model tends to emit bare words ("Emergence", "None notable") that this makes
//     impossible. A specific animal verb (migration/breeding/emergence) is used
//     only when Wikipedia corroborates that behaviour for the taxon; otherwise (and
//     for a bird that merely "arrives", or a plant that isn't blooming) we ZOOM OUT
//     to the general "<species> season" a person would say — accurate, not clinical.
//
//   STEP 4  OCCURRENCE (birds). An optional eBird nearby-observations call (env
//     EBIRD_API_KEY) strengthens the birds occurrence gate. NOTE: GBIF was evaluated
//     as a timing source and REMOVED — its month facets carry the same observer bias
//     as iNat but without annotation filtering or bias normalisation, and high-rank
//     matches contaminated the output with year-round "seasons". iNat sets timing;
//     GBIF is no longer consulted.
//
// Results are disk-cached per location key, so each location generates once.
//
// Zero dependencies; uses global fetch (Node 18+).

import { promises as fs } from 'node:fs';
import path from 'node:path';

const INAT = 'https://api.inaturalist.org/v1';
const WIKI = 'https://en.wikipedia.org/w/api.php';
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
// Minimum iNat local records before we trust the (sparse) histogram to place a
// corroborated event's window; below this we fall back to the LLM's month hint.
const MIN_CORR_OBS = 15;
// Above this window width (in weeks, of 53) the distribution is too flat to call
// a season — the species is observed roughly year-round, so we don't trust the
// data peak and won't mark the event verified.
const MAX_SEASON_WEEKS = 28;
// Hard cap on any event's total window, in days. A corroborated event whose window
// (iNat-sparse or LLM-month) exceeds this is not a season and is dropped.
const MAX_WINDOW_DAYS = 150;

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
const weekToDOY = w => (((w - 1) * 7) % 365 + 365) % 365;
const doySpan = (a, b) => (b - a + 365) % 365; // forward circular distance, days
const sum = a => a.reduce((s, v) => s + v, 0);

// Colloquial event noun for the label. Specific animal verbs survive only when the
// behaviour is corroborated for the taxon; otherwise — and for 'arrival'/'other',
// and non-bloom plants — we ZOOM OUT to the general "season" a person would use.
// Labels are always "<species common name> <noun>", centred on peak observation.
const SPECIFIC_NOUN = { migration: 'migration', breeding: 'breeding', emergence: 'emergence' };
function eventNoun(category, type, behaviorOK) {
  if (category === 'plants') return type === 'bloom' ? 'bloom' : 'season';
  if (SPECIFIC_NOUN[type]) return behaviorOK === true ? SPECIFIC_NOUN[type] : 'season';
  return 'season'; // 'arrival' / 'other' → general presence
}
function composeLabel(commonName, noun, max = 32) {
  const name = String(commonName || '').trim();
  if (!name) return '';
  if (!noun) return trimLabel(name, max);
  const full = `${name} ${noun}`;
  if (full.length <= max) return full;
  // Too long for the arc: keep the whole event noun, abbreviate the SPECIES name
  // with an ellipsis (dropping the verb would make it read like a bare label).
  const room = Math.max(3, max - noun.length - 2); // name + "… " + noun
  const short = name.slice(0, room).replace(/[\s,–-]+$/, '');
  return `${short}… ${noun}`;
}

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

  // The 3B model sometimes returns no valid refs on the first try; retry once at a
  // lower temperature before giving up, so sparse-region coverage comes from real
  // local species rather than falling through to the (weaker) famous lane.
  for (let attempt = 0; attempt < 2; attempt++) {
    const obj = await ollamaJSON(prompt, { ...llm, temperature: attempt === 0 ? 0.4 : 0.2 });
    const list = obj && Array.isArray(obj.events) ? obj.events : Array.isArray(obj) ? obj : [];
    const out = [];
    for (const e of list) {
      const ref = Math.round(Number(e.ref));
      const sp = Number.isFinite(ref) && species[ref - 1] ? species[ref - 1] : null;
      if (!sp) continue; // couldn't bind to a real species → drop
      out.push({
        taxon: sp.name,
        taxon_id: sp.id,
        species_common: sp.common,       // the label is built from this, not the LLM
        local_count: sp.count,
        event_type: VALID_TYPES.includes(e.event_type) ? e.event_type : 'other',
        expected_months: normMonths(e.expected_months),
        lane: 'data',
      });
      if (out.length >= 3) break;
    }
    if (out.length) return out;
  }
  return [];
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
      common_name: String(e.common_name || e.name || '').trim().slice(0, 60), // for the filter/debug only
      taxon: String(e.taxon || e.species || e.common_name || '').trim().slice(0, 80),
      taxon_id: null,
      species_common: null,            // resolved (and class-checked) in anchorEvent
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
  return merged.slice(0, 5); // bound the per-category iNat/Wikipedia call budget
}

// ── Step 2: time against iNaturalist (corrected) ──────────────────────────────

/**
 * Resolve a taxon name to an iNaturalist { id, common, scientific }, constrained to
 * `iconic` (right class) AND to SPECIES rank or below (rank_level <= 10) so a name
 * can't resolve to a whole family — e.g. "hawks" → Accipitridae with 100k+ records
 * and no real season. Returns null (event dropped) when no such match exists. The
 * /taxa autocomplete ignores its own iconic filter, so we check candidates ourselves.
 */
async function resolveTaxon(taxon, iconic) {
  try {
    const res = await fetch(`${INAT}/taxa?q=${encodeURIComponent(taxon)}&per_page=5`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const json = await res.json();
    const results = json.results || [];
    const match = results.find(r =>
      (!iconic || r.iconic_taxon_name === iconic) && r.rank_level && r.rank_level <= 10);
    if (!match) return null;
    return {
      id: match.id,
      common: match.preferred_common_name || match.name || taxon,
      scientific: match.name || taxon,   // used for the (disambiguated) Wikipedia lookup
    };
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
 * Turn a weekly signal into a DOY window, centred on the observation PEAK (when the
 * species is most present/noticeable). The arc spans the half-max season; the label
 * sits at the peak — the experience a visitor has, not a technical onset.
 */
function windowFromWeeks(counts) {
  const w = circularPeakWindow(counts);
  return {
    startDOY: weekToDOY(w.start + 1),
    peakDOY:  weekToDOY(w.peak + 1),
    endDOY:   weekToDOY(w.end + 1),
    widthWeeks: w.width,
  };
}

/** Turn an LLM [startMonth, endMonth] guess into a DOY window (last resort). */
function windowFromMonthRange(months) {
  if (!months) return null;
  const [a, b] = months;
  const mid = a === b ? a : (a + Math.round(((b - a + 12) % 12) / 2) - 1 + 12) % 12 + 1;
  return { startDOY: monthMidDOY(a), peakDOY: monthMidDOY(mid), endDOY: monthMidDOY(b) };
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

/**
 * Wikipedia LEAD-SECTION plaintext for a name (redirects followed so a scientific
 * name lands on the species article), lowercased, or '' on any miss. The lead
 * section — not the REST one-sentence summary — is what reliably describes what a
 * species DOES (migration, breeding), so the behaviour check can corroborate it.
 */
async function fetchWikiExtract(name) {
  try {
    const u = `${WIKI}?action=query&format=json&prop=extracts&exintro=1&explaintext=1`
            + `&redirects=1&titles=${encodeURIComponent(String(name).replace(/ /g, '_'))}`;
    const res = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return '';
    const json = await res.json();
    const first = Object.values(json?.query?.pages || {})[0];
    return String(first?.extract || '').toLowerCase();
  } catch { return ''; }
}

/** true / false if the extract does / doesn't support the behaviour; null if unknown. */
function corroborateBehavior(text, type) {
  if (!text) return null;
  return (BEHAVIOR_RE[type] || BEHAVIOR_RE.other).test(text);
}

// ── Step 4: occurrence booster (eBird, birds only) ────────────────────────────
// GBIF was removed as a timing source — its month facets carry the same observer
// bias as iNat without annotation filtering or bias normalisation, and high-rank
// matches produced year-round "seasons" (see the header note). iNat sets timing.

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
 * Verify one proposed event and return a confidence-tiered record, or null
 * (rejected). `ctx` caches the per-category baseline histogram and eBird set.
 *   - IDENTITY gate: the taxon must resolve within the category's iconic class
 *     (data-lane species already are; famous-lane names are resolved here and
 *     dropped if they don't match). The resolved common name builds the label.
 *   - VERIFIED (solid): iNat has >= MIN_OBS nearby records AND a clear, bias-
 *     corrected season; that observed window sets the dates.
 *   - CORROBORATED (dashed '*'): iNat can't pin a season locally, but the species
 *     really occurs here (iNat/eBird), Wikipedia corroborates the behaviour, and a
 *     window narrower than MAX_WINDOW_DAYS forms from the sparse iNat histogram or
 *     the LLM month hint. GBIF is never consulted for timing.
 *   - REJECTED (null): wrong class, doesn't occur here, uncorroborated behaviour,
 *     or no narrow window.
 */
async function anchorEvent(ev, lat, lon, cat, ctx) {
  // Claim 1 — identity, class-constrained. Reject anything that doesn't resolve to
  // the category's iconic class (this is what stops whales landing under "fish").
  let taxonId = ev.taxon_id ?? null;
  let commonName = ev.species_common || '';
  let sciName = ev.taxon;                  // data lane: scientific name from species_counts
  if (!taxonId) {
    const r = await resolveTaxon(ev.taxon, cat.iconic);
    await sleep(300);
    if (!r) return null;                  // no same-class match → reject
    taxonId = r.id; commonName = r.common; sciName = r.scientific;
  }
  if (!commonName) commonName = ev.taxon; // last-ditch label source

  // Claim 3 (attempt A) — local iNat timing.
  const counts = await fetchTimedHistogram(taxonId, lat, lon, ev.event_type);
  await sleep(300);
  const inatLocalTotal = counts ? sum(counts) : 0;

  if (inatLocalTotal >= MIN_OBS) {
    if (!ctx.baseline) { ctx.baseline = await fetchBaseline(cat.iconic, lat, lon); await sleep(300); }
    const w = windowFromWeeks(biasCorrect(counts, ctx.baseline));
    if (w.widthWeeks <= MAX_SEASON_WEEKS) {  // a clear season → VERIFIED
      // Keep the LLM's specific verb only if Wikipedia backs it for this taxon;
      // otherwise zoom out to the colloquial "season" (accuracy over specificity).
      const noun = await eventNounFor(cat, ev, sciName);
      return record(ev, cat, taxonId, commonName, noun, w,
        { verified: true, confidence: 'verified', source: 'inat', obs_total: inatLocalTotal });
    }
    // else: observed ~year-round → no real season; fall through (usually dropped)
  }

  // CORROBORATED path — real, class-correct species that iNat can't clearly time.
  const occurs = inatLocalTotal >= MIN_LOCAL || (cat.id === 'birds' && ebirdSupports(ctx.ebird, ev));
  if (!occurs) return null;                          // doesn't really occur here

  const behaviorOK = corroborateBehavior(await fetchWikiExtract(sciName), ev.event_type);
  await sleep(200);
  if (behaviorOK !== true) return null;              // require positive support

  // Timing WITHOUT GBIF: prefer the sparse iNat histogram when narrow enough, else
  // the LLM's month hint. Reject anything wider than a season.
  let window = null, source = 'llm';
  if (inatLocalTotal >= MIN_CORR_OBS) {
    const w = windowFromWeeks(counts);
    if (w.widthWeeks <= MAX_SEASON_WEEKS) { window = w; source = 'inat'; }
  }
  if (!window) window = windowFromMonthRange(ev.expected_months);
  if (!window || doySpan(window.startDOY, window.endDOY) > MAX_WINDOW_DAYS) return null;

  const noun = eventNoun(cat.id, ev.event_type, behaviorOK); // behaviour already checked above
  return record(ev, cat, taxonId, commonName, noun, window,
    { verified: false, confidence: 'corroborated', source, obs_total: inatLocalTotal || MIN_LOCAL });
}

/**
 * Resolve the colloquial event noun for the VERIFIED lane. Only pays for a
 * Wikipedia lookup when the LLM proposed a specific animal verb that could be
 * wrong; plants and generic ('arrival'/'other') types never need one.
 */
async function eventNounFor(cat, ev, sciName) {
  if (cat.id === 'plants' || !SPECIFIC_NOUN[ev.event_type]) {
    return eventNoun(cat.id, ev.event_type, null);
  }
  const ok = corroborateBehavior(await fetchWikiExtract(sciName), ev.event_type);
  await sleep(200);
  return eventNoun(cat.id, ev.event_type, ok);
}

/** Assemble the internal event record; the label is composed from the species. */
function record(ev, cat, taxonId, commonName, noun, window, meta) {
  return {
    label: composeLabel(commonName, noun),
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
async function buildCategory(cat, facts, lat, lon, llm, seenTaxa) {
  const real = await fetchSpeciesCounts(lat, lon, cat.iconic);
  await sleep(400);
  const dataProps = await proposeFromRealSpecies(cat, facts, real, llm);
  const famousProps = await proposeFamousEvents(cat, facts, llm);
  const proposed = mergeProposals(dataProps, famousProps);

  // Per-category caches: baseline histogram (fetched lazily) + eBird nearby set.
  const ctx = { baseline: null, ebird: cat.id === 'birds' ? await fetchEbirdNearby(lat, lon) : null };

  const anchored = [];
  // `seenTaxa` is shared across ALL categories for this location, so a charismatic
  // species (e.g. a whale) anchored under its correct class can't reappear in
  // another category, and the LLM proposing one species twice is collapsed.
  for (const ev of proposed) {
    const a = await anchorEvent(ev, lat, lon, cat, ctx);
    if (a && a.taxon_id && !seenTaxa.has(a.taxon_id)) { seenTaxa.add(a.taxon_id); anchored.push(a); }
    await sleep(700); // be polite to iNaturalist (~60 req/min)
  }

  // Keep the strongest three: verified before corroborated, then best-supported.
  anchored.sort((x, y) => (tierRank(y) - tierRank(x)) || ((y.obs_total || 0) - (x.obs_total || 0)));
  const events = anchored.slice(0, 3).map(e => ({
    label: e.label, // already length-bounded by composeLabel, with the noun kept
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
    const seenTaxa = new Set(); // shared across categories → no cross-category dupes
    // Compute one category at a time and emit each the moment it is ready.
    for (const cat of CATEGORIES) {
      const built = await buildCategory(cat, facts, lat, lon, llm, seenTaxa);
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
