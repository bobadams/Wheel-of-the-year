/**
 * Climatological seasons — derived from this location's data, not from a calendar.
 *
 * A place does not necessarily have four seasons, and the ones it has are not
 * necessarily thermal. Oakland has a wet season and a dry season; Darwin has a
 * wet and a dry with no thermal cycle at all; Singapore has arguably none. So
 * nothing here starts from a season vocabulary and looks for its dates — it
 * finds the structure in the year first and names it afterwards.
 *
 * Three stages, in this order, and the order is the whole design:
 *
 *   1. GATE, in absolute units. Which axes does this place actually cycle on?
 *      This must happen BEFORE any normalization, because z-scoring divides the
 *      amplitude out: a rainforest that varies ±1°F and ±0.01 EVI produces a
 *      z-scored year *identical* to Chicago's, and every clustering method will
 *      then hand back four confident seasons made of nothing but noise. The
 *      gate is what lets a place legitimately come back with no seasons at all.
 *
 *   2. SEGMENT the year on the surviving axes into contiguous arcs, by exact
 *      dynamic programming over a circular series. The boundaries and the
 *      *number* of seasons both fall out of the data; `chooseCount` accepts one
 *      more season only when it buys enough fit to justify itself and leaves
 *      every season long enough to be a season.
 *
 *   3. NAME each arc from its own signature. Level alone can't separate spring
 *      from autumn — they sit at the same temperature — so the namer reads the
 *      direction of travel too, which is what lets a genuinely four-season
 *      climate come back as Winter/Spring/Summer/Autumn on dates nobody typed in.
 *
 * Everything is pure: hand it a `currentData` and it returns a description. It
 * is recomputed in state.js on every data change, which is cheap enough (a few
 * ms) to need no caching and keeps it impossible for the band to disagree with
 * the rings it was derived from.
 */

import { gaussianSmooth } from '../utils/smooth.js';
import { doyLabel } from './summary.js';

const N = 365;
const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Year binned to weeks for the segmentation. The boundary of a season is not a
// day-precise thing — a 30-year normal has no such resolution — and weekly bins
// make the exact DP cheap enough to rerun on every data change.
const WEEKS = 52;

// The most seasons the wheel will ever show. Past this the band stops being
// readable, and no climate on earth needs more.
const MAX_SEASONS = 5;

// Weight on the rate-of-change features relative to the levels. See the note
// where they are built: enough to separate spring from autumn, not enough to
// start splitting one season along its own flanks.
const RATE_WEIGHT = 0.55;

// A season shorter than this is a spell of weather, not a season.
const MIN_SEASON_DAYS = 30;

// Extra fit (as a fraction of total variance) that one more season must buy
// before it is accepted. Tuned so a Mediterranean year resolves to three and a
// bimodal equatorial one to four, without either running to the cap.
const MIN_GAIN = 0.08;

const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const sd   = a => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
const zscore = a => { const m = mean(a), s = sd(a) || 1; return a.map(v => (v - m) / s); };

/** Value at quantile `q` of `a` (0–1), by nearest rank. */
function quantile(a, q) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.round(q * (s.length - 1))];
}

/** 5th-to-95th-percentile spread — an amplitude that a single outlier can't set. */
const spread = a => quantile(a, 0.95) - quantile(a, 0.05);

/**
 * Walsh & Lawler seasonality index for rainfall: the mean absolute departure of
 * the twelve monthly totals from an even twelfth, over the annual total. 0 is
 * rain spread perfectly evenly through the year, 1.0+ is essentially all of it
 * in one or two months. Used instead of a raw amplitude because what makes a
 * wet season is the *concentration* of the rain, not how many inches fall.
 */
export function rainfallSeasonality(rain) {
  const months = [];
  let i = 0;
  for (let m = 0; m < 12; m++) { months.push(rain.slice(i, i + DIM[m]).reduce((s, v) => s + v, 0)); i += DIM[m]; }
  const total = months.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return 0;
  return months.reduce((s, v) => s + Math.abs(v - total / 12), 0) / total;
}

/**
 * The axes a season may be defined along, and how much annual cycle each needs
 * before it is allowed to define one.
 *
 * Thresholds are in the series' own units and are deliberately conservative:
 * the cost of too low a threshold is inventing seasons for a place that has
 * none, which is the one failure this whole module exists to avoid. `strength`
 * measures the cycle; `words` supplies the vocabulary the namer draws on.
 */
export const SEASON_AXES = [
  {
    id: 'temp', strength: spread, min: 9, unit: '°F', order: 0,
    // Temperature words are chosen from the ABSOLUTE mean, not the z-score. A
    // z-score is relative to the location's own year, so Darwin's coolest
    // season — 86°F — comes out "cold" against its own mean, which is true of
    // the statistic and false of the place. The z-score still decides whether
    // temperature is worth mentioning at all; only the word itself is absolute.
    word: (z, v) => v < 38 ? 'frozen' : v < 52 ? 'cold' : v < 63 ? 'cool'
      : v < 74 ? null /* unremarkable — let a stronger axis carry the name */
      : v < 84 ? 'warm' : 'hot',
  },
  {
    id: 'rain', strength: rainfallSeasonality, min: 0.40, unit: 'index', order: 2,
    // Wet and dry are genuinely relative: a desert's wet season is still its wet
    // season, and that is how people talk about it.
    word: z => (z >= 0 ? 'wet' : 'dry'),
  },
  {
    id: 'evi', strength: spread, min: 0.08, unit: 'EVI', order: 6,
    word: z => (z >= 0 ? 'green' : 'bare'),
  },
  {
    id: 'dewpoint', strength: spread, min: 9, unit: '°F', order: 1,
    // 65°F dew point is the conventional line where air starts to feel muggy.
    word: (z, v) => v >= 66 ? 'muggy' : v >= 57 ? 'humid' : v <= 40 ? 'crisp' : null,
  },
  {
    id: 'snow', strength: spread, min: 1.0, unit: 'in', order: 3,
    word: (z, v) => (z >= 0 && v >= 0.5 ? 'snowy' : null),
  },
  {
    id: 'visibility', strength: spread, min: 2.0, unit: 'mi', order: 5,
    word: (z, v) => (z < 0 && v <= 6 ? 'foggy' : z > 0 && v >= 8 ? 'clear' : null),
  },
  {
    id: 'cloud', strength: spread, min: 18, unit: '%', order: 4,
    word: (z, v) => (z >= 0 && v >= 60 ? 'grey' : z < 0 && v <= 35 ? 'clear' : null),
  },
];

/** A usable 365-point series. */
const usable = a => Array.isArray(a) && a.length === N && a.filter(v => Number.isFinite(v)).length > N * 0.9;

/**
 * Which axes of `data` carry a real annual cycle. Runs on the raw series, in
 * their own units — see the note at the top about why this cannot come after
 * normalization.
 */
export function gateAxes(data) {
  return SEASON_AXES
    .filter(ax => usable(data[ax.id]))
    .map(ax => {
      const series = data[ax.id].map(v => (Number.isFinite(v) ? v : 0));
      return { ...ax, series, value: ax.strength(series) };
    })
    .map(ax => ({ ...ax, passed: ax.value >= ax.min }));
}

/** Within-segment sum of squares over bins [i, j) of every feature, from prefix sums. */
function segCost(P, Q, i, j) {
  let c = 0;
  const n = j - i;
  if (n <= 0) return 0;
  for (let d = 0; d < P.length; d++) {
    const s = P[d][j] - P[d][i], q = Q[d][j] - Q[d][i];
    c += q - s * s / n;
  }
  return c;
}

/**
 * Best split of the circular year into 1…`kMax` contiguous segments.
 *
 * Dynamic programming solves the *linear* problem exactly; the year is a circle,
 * so it is solved once per rotation and the best kept. Two things keep that from
 * being expensive enough to notice: the prefix sums are built once over the
 * doubled series rather than rebuilt per rotation, and one DP pass yields every
 * k at once (the table for k seasons is already the table for k−1 plus a row).
 * Unlike k-means this cannot land in a local minimum or answer differently on a
 * second run.
 *
 * @returns {{cost:number, bounds:number[]}[]} indexed by k; entry 0 is unused.
 */
function segmentAll(features, kMax) {
  const W = WEEKS, D = features.length;

  // Doubled, so any rotation's window [off, off+W) is a contiguous slice.
  const P = [], Q = [];
  for (let d = 0; d < D; d++) {
    const p = [0], q = [0];
    for (let i = 0; i < W * 2; i++) {
      const v = features[d][i % W];
      p.push(p[i] + v);
      q.push(q[i] + v * v);
    }
    P.push(p); Q.push(q);
  }

  const best = Array.from({ length: kMax + 1 }, () => ({ cost: Infinity, bounds: null }));

  for (let off = 0; off < W; off++) {
    // Local index u = absolute bin − off, so u runs 0…W over this rotation.
    const dp = Array.from({ length: kMax + 1 }, () => new Array(W + 1).fill(Infinity));
    const bk = Array.from({ length: kMax + 1 }, () => new Array(W + 1).fill(-1));
    dp[0][0] = 0;

    for (let s = 1; s <= kMax; s++) {
      for (let j = s; j <= W; j++) {
        let bestCost = Infinity, bestI = -1;
        for (let i = s - 1; i < j; i++) {
          const prev = dp[s - 1][i];
          if (prev === Infinity) continue;
          const c = prev + segCost(P, Q, off + i, off + j);
          if (c < bestCost) { bestCost = c; bestI = i; }
        }
        dp[s][j] = bestCost; bk[s][j] = bestI;
      }
      if (dp[s][W] < best[s].cost) {
        const cuts = [];
        let j = W;
        for (let t = s; t >= 1; t--) { cuts.unshift(bk[t][j]); j = bk[t][j]; }
        best[s] = {
          cost: dp[s][W],
          bounds: cuts.map(c => Math.round(((c + off) % W) * N / W)).sort((a, b) => a - b),
        };
      }
    }
  }
  return best;
}

/** Length in days of the segment running from `start` to `end` around the circle. */
const spanDays = (start, end) => ((end - start + N) % N) || N;

/**
 * How many seasons this year actually has.
 *
 * Accepts one more only when it buys `MIN_GAIN` of extra explained variance and
 * leaves no segment shorter than `MIN_SEASON_DAYS`. Without the length rule the
 * fit keeps improving forever by shaving slivers off the ends of real seasons.
 */
function chooseCount(features, totalVar) {
  const table = segmentAll(features, MAX_SEASONS);
  let chosen = 1, prevEV = 0, bestFit = null;
  for (let k = 2; k <= MAX_SEASONS; k++) {
    const fit = table[k];
    if (!fit?.bounds) continue;
    const ev = 1 - fit.cost / totalVar;
    const shortest = Math.min(...fit.bounds.map((s, i) => spanDays(s, fit.bounds[(i + 1) % fit.bounds.length])));
    if (ev - prevEV >= MIN_GAIN && shortest >= MIN_SEASON_DAYS) { chosen = k; bestFit = fit; }
    prevEV = ev;
  }
  return { count: chosen, fit: bestFit };
}

// Season colors, keyed by the descriptor that ends up leading the name. Drawn
// from the same desaturated earth pigments as the rings — a season band sits
// directly against them, and a saturated fill would fight the data.
const SEASON_COLORS = {
  frozen: '#8fb4c8', cold: '#6b8fa8', cool: '#7e9db0', warm: '#c4703a', hot: '#a8432f',
  wet: '#2d5f8a', dry: '#c08a3e',
  green: '#4a7c3f', bare: '#8a7048',
  snowy: '#9fc0d4', foggy: '#8c9498', clear: '#b9a97e', grey: '#8c9498',
  muggy: '#5f8f7a', humid: '#6f9a86', crisp: '#9aa8b0',
  mild: '#9a9478',
};

// Single-word names that read better as a noun than as an adjective.
const NAME_OVERRIDES = { snowy: 'Snow season', foggy: 'Fog season' };

// A second descriptor is only kept when it is nearly as strong as the first;
// otherwise "Green season" turns into the fussier "Green dry season" for a
// vegetation peak that merely happens to fall in the dry half of the year.
const SECOND_WORD_RATIO = 0.6;

const TITLE = s => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Name one season from its signature.
 *
 * Takes the one or two axes it departs from the annual mean on most strongly and
 * composes "<qualifier> <head> season". A segment that is unremarkable on every
 * axis is the shoulder of the year and is named for that rather than given a
 * spurious descriptor.
 */
function nameFromSignature(sig, means, axes) {
  const ranked = axes
    .map(ax => ({ ax, z: sig[ax.id], word: ax.word(sig[ax.id], means[ax.id]) }))
    .filter(e => Number.isFinite(e.z) && Math.abs(e.z) >= 0.45 && e.word)
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

  if (!ranked.length) return { name: 'Mild season', key: 'mild' };

  const kept = [ranked[0]];
  if (ranked[1] && Math.abs(ranked[1].z) >= SECOND_WORD_RATIO * Math.abs(ranked[0].z)) {
    kept.push(ranked[1]);
  }

  // Rank picks *which* words; SEASON_AXES.order picks the order they are said
  // in — English puts the temperature first ("cool wet season", never "wet cool
  // season"), regardless of which axis departs further from the mean.
  const phrase = [...kept].sort((a, b) => a.ax.order - b.ax.order).map(e => e.word).join(' ');
  const name = kept.length === 1 ? (NAME_OVERRIDES[phrase] ?? `${TITLE(phrase)} season`)
    : `${TITLE(phrase)} season`;
  // The color follows the strongest axis, not the first word said.
  return { name, key: ranked[0].word };
}

// The familiar quartet is used only when the data actually shows it. Deriving
// the dates is the point: a place that genuinely has Winter/Spring/Summer/Autumn
// should say so, on its own dates, while a place that does not should never be
// forced into them.
// How wide a temperature swing a year needs before the familiar quartet is even
// considered, and how close to the leading axis temperature has to be.
const QUARTET_MIN_SWING_F = 25;
const QUARTET_TEMP_SHARE  = 0.8;

/**
 * Is this a four-season thermal year? True when temperature passed the gate with
 * a wide swing, there are exactly four seasons, and temperature is among the
 * axes separating them most.
 *
 * Temperature need not *lead* outright: dew point and vegetation both track it
 * closely in a humid continental climate and either can edge it out, which does
 * not make the year any less a four-season thermal one.
 */
function isThermalQuartet(segments, axes, tempAxis) {
  if (!tempAxis || segments.length !== 4) return false;
  if (tempAxis.value < QUARTET_MIN_SWING_F) return false;
  const dominance = id => mean(segments.map(s => Math.abs(s.signature[id] ?? 0)));
  const strongest = Math.max(...axes.map(ax => dominance(ax.id)));
  return dominance('temp') >= QUARTET_TEMP_SHARE * strongest;
}

// Order the four by where each sits on the temperature cycle: the coldest is
// winter, the warmest summer, and the two between them are told apart by which
// one is warming — the only thing that separates spring from autumn, since by
// definition they share a temperature.
const QUARTET_KEYS = { Winter: 'cold', Spring: 'green', Summer: 'hot', Autumn: 'bare' };

function nameAsQuartet(segments) {
  const warmth = segments.map(s => s.signature.temp);
  const coldest = warmth.indexOf(Math.min(...warmth));
  const warmest = warmth.indexOf(Math.max(...warmth));
  return segments.map((seg, i) => {
    let name;
    if (i === coldest) name = 'Winter';
    else if (i === warmest) name = 'Summer';
    else name = (i - coldest + 4) % 4 < (i - warmest + 4) % 4 ? 'Spring' : 'Autumn';
    return { ...seg, name, color: SEASON_COLORS[QUARTET_KEYS[name]] };
  });
}

/**
 * Seasons for `data`.
 *
 * @returns {{
 *   seasons: {startDOY:number, endDOY:number, days:number, name:string,
 *             color:string, signature:Object, means:Object}[],
 *   axes: {id:string, value:number, min:number, unit:string, passed:boolean}[],
 *   basis: string[],  note: string|null,
 * }}
 *   `seasons` is empty when the location has no axis with a real annual cycle —
 *   which is a finding about the place, not a failure, and `note` says so.
 */
export function computeSeasons(data) {
  const gated = gateAxes(data);
  const axes = gated.filter(ax => ax.passed);
  const report = gated.map(({ id, value, min, unit, passed }) => ({ id, value, min, unit, passed }));

  if (!axes.length) {
    return {
      seasons: [], axes: report, basis: [],
      note: gated.length
        ? 'No axis of this location’s year varies enough to mark a season.'
        : 'Not enough data loaded yet to derive seasons.',
    };
  }

  // Smoothed, z-scored, weekly-binned — the representation the segmentation sees.
  const smooth = axes.map(ax => gaussianSmooth(ax.series, 7, 14));
  const toWeeks = a => Array.from({ length: WEEKS }, (_, w) =>
    mean(a.slice(Math.round(w * N / WEEKS), Math.round((w + 1) * N / WEEKS))));
  const levels = smooth.map(a => toWeeks(zscore(a)));
  // Rate of change, alongside level. Spring and autumn sit at the SAME
  // temperature — level alone cannot tell them apart, which is why a clustering
  // on levels gives a four-season continental climate only two seasons. The
  // direction of travel is the one thing that separates them. It is down-
  // weighted because it is a supporting signal: at full weight it starts
  // splitting the flanks of a single long season in two.
  const rate = smooth.map(a => {
    const d = a.map((_, i) => a[(i + 7) % N] - a[(i - 7 + N) % N]);
    return toWeeks(zscore(d)).map(v => v * RATE_WEIGHT);
  });
  const features = [...levels, ...rate];
  const totalVar = features.reduce((s, f) => s + f.reduce((t, v) => t + (v - mean(f)) ** 2, 0), 0);

  if (!(totalVar > 0)) {
    return { seasons: [], axes: report, basis: axes.map(a => a.id), note: 'This location’s year is flat on every axis.' };
  }

  const { count, fit } = chooseCount(features, totalVar);
  if (count < 2 || !fit) {
    return {
      seasons: [], axes: report, basis: axes.map(a => a.id),
      note: 'This location’s year runs as one continuous season.',
    };
  }

  // Per-day z-scores, so a segment's signature is measured over its real span
  // rather than over the weekly bins the boundaries were found in.
  const dailyZ = {}, dailyRaw = {};
  axes.forEach((ax, i) => { dailyZ[ax.id] = zscore(smooth[i]); dailyRaw[ax.id] = smooth[i]; });

  /** Everything that can be said about the span from `start` to `end`. */
  const describe = (start, end) => {
    const days = [];
    for (let d = start; d !== end; d = (d + 1) % N) days.push(d);
    const signature = {}, means = {};
    axes.forEach(ax => {
      signature[ax.id] = mean(days.map(d => dailyZ[ax.id][d]));
      means[ax.id]     = mean(days.map(d => dailyRaw[ax.id][d]));
    });
    const { name, key } = nameFromSignature(signature, means, axes);
    return { startDOY: start, endDOY: end, days: days.length, signature, means, name, key };
  };

  let segments = fit.bounds.map((start, i) => describe(start, fit.bounds[(i + 1) % fit.bounds.length]));

  // Two neighbours the namer cannot tell apart are one season. The rate-of-
  // change features are what make this necessary: they legitimately split
  // spring from autumn, but they also split a single long wet season at the
  // point where it stops deepening and starts easing — which is a real feature
  // of the year and not a season boundary anyone would recognise. Only
  // ADJACENT pairs merge, so a bimodal climate keeps its two separate wet
  // seasons even though they share a name.
  for (let guard = 0; guard < MAX_SEASONS && segments.length > 1; guard++) {
    const i = segments.findIndex((seg, j) => seg.name === segments[(j + 1) % segments.length].name);
    if (i < 0) break;
    const next = segments[(i + 1) % segments.length];
    const merged = describe(segments[i].startDOY, next.endDOY);
    segments = segments.filter((_, j) => j !== i && j !== (i + 1) % segments.length);
    segments.splice(i < segments.length ? i : segments.length, 0, merged);
    segments.sort((a, b) => a.startDOY - b.startDOY);
  }

  if (segments.length < 2) {
    return {
      seasons: [], axes: report, basis: axes.map(a => a.id),
      note: 'This location’s year runs as one continuous season.',
    };
  }

  const tempAxis = axes.find(ax => ax.id === 'temp');
  const seasons = isThermalQuartet(segments, axes, tempAxis)
    ? nameAsQuartet(segments)
    : segments.map(seg => ({ ...seg, color: SEASON_COLORS[seg.key] ?? SEASON_COLORS.mild }));

  return { seasons, axes: report, basis: axes.map(a => a.id), note: null };
}

/** "Nov 6 – Mar 26" for one season. */
export function seasonRangeLabel(s) {
  return `${doyLabel(s.startDOY)} – ${doyLabel((s.endDOY - 1 + N) % N)}`;
}

/** The season covering `doy`, or null. */
export function seasonAt(seasons, doy) {
  return seasons?.find(s => {
    const off = (doy - s.startDOY + N) % N;
    return off < s.days;
  }) ?? null;
}
