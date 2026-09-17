/**
 * Climatological seasons — derived from this location's data, not from a calendar.
 *
 * A place does not necessarily have four seasons, and the ones it has are not
 * necessarily thermal. Oakland has a wet season and a dry season; Darwin has a
 * wet and a dry with no thermal cycle at all; Singapore has arguably none. So
 * nothing here starts from a season vocabulary and looks for its dates — it
 * finds the structure in the year first and names it afterwards.
 *
 * Four stages, in this order, and the order is the whole design:
 *
 *   1. GATE, in absolute units. Which axes does this place actually cycle on?
 *      This must happen BEFORE any normalization, because z-scoring divides the
 *      amplitude out: a rainforest that varies ±1°F and ±0.01 EVI produces a
 *      z-scored year *identical* to Chicago's, and every clustering method will
 *      then hand back four confident seasons made of nothing but noise. The
 *      gate is what lets a place legitimately come back with no seasons at all.
 *
 *   2. SEGMENT the year on the surviving axes into contiguous arcs, by exact
 *      dynamic programming over a circular series. One pass yields the best
 *      split for every count from one to MAX_SEASONS.
 *
 *   3. THE QUARTET, tested on the best four-arc split before anything is merged
 *      or counted. A year whose structure is a wide thermal cycle is given
 *      Winter/Spring/Summer/Autumn — on dates read off its own temperature
 *      curve, because those are temperature names.
 *
 *   4. Otherwise COUNT the seasons (`chooseCount`), NAME each arc from its own
 *      signature, and fold together neighbours that turn out to be one season
 *      by stepping down to the best split with one fewer.
 *
 * Everything is pure: hand it a `currentData` and it returns a description. It
 * is recomputed in state.js on every data change, which is cheap enough (a few
 * ms) to need no caching and keeps it impossible for the band to disagree with
 * the rings it was derived from.
 *
 * The constants below are tuned, and several sit close to the point where a
 * season appears or vanishes. `npm run seasons-report` runs this module over a
 * fixed set of reference climates and lists every place a change moved.
 */

import { gaussianSmooth } from '../utils/smooth.js';
import { N, DIM, MONTH_START, doyLabel } from './calendar.js';

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
// before it is accepted. Too low and long seasons split in half; too high and
// short but genuinely distinct seasons are refused, since the fit a season buys
// grows with its length. A plain sinusoid gains about 0.10 from its fourth arc,
// so this sits close to where counts flip — check the report after moving it.
const MIN_GAIN = 0.08;

// Rain and snow are square-rooted before they are z-scored. Both are heavily
// skewed — months near zero, then a peak — and on the raw values the peak holds
// nearly all the variance, so the segmentation spends its seasons carving up the
// wet season and lumps the rest of the year together. The square root is the
// usual variance-stabilising transform for amounts like these. Only the
// segmentation and the z-scores see it; `means` stay in real units.
const SQRT_AXES = new Set(['rain', 'snow']);

// An axis that misses its gate but reaches this fraction of the threshold may
// help NAME a season another axis found. It never helps define one — that would
// lower the gate by the back door.
const NEAR_MISS = 0.75;

// Neighbouring arcs whose level signatures are closer than this (RMS of the
// z-score difference over the gated axes) are one season that only the rate
// features split.
const MERGE_DISTANCE = 0.35;

// How fast temperature must be moving (as a rate z-score) for a shoulder with
// nothing remarkable in its levels to be named for its direction of travel.
const SHOULDER_TREND = 0.5;

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
  // Calendar months, so December is summed across the top of the wheel.
  const months = MONTH_START.map((start, m) =>
    Array.from({ length: DIM[m] }, (_, d) => rain[(start + d) % N]).reduce((s, v) => s + v, 0));
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
 *
 * Every word must agree in direction with the season's departure from its own
 * year. The word itself may be chosen from the absolute value, but a season
 * below the year's mean is never named for being high, nor one above it for
 * being low.
 */
export const SEASON_AXES = [
  {
    id: 'temp', strength: spread, min: 9, unit: '°F', order: 0,
    // `temp` is the mean daily HIGH. The word is chosen from the ABSOLUTE mean,
    // not the z-score: a z-score is relative to the location's own year, so
    // Darwin's coolest season — 86°F — is "cold" against its own mean, which is
    // true of the statistic and false of the place. The z-score still picks the
    // SIDE. Timbuktu's coolest season averages 85°F highs, and without that it
    // would be named "hot" for being hot in absolute terms while being the
    // relief from the real hot season on either side of it.
    word: (z, v) => z < 0
      ? (v < 38 ? 'frozen' : v < 52 ? 'cold' : v < 63 ? 'cool' : null)
      : (v >= 84 ? 'hot' : v >= 74 ? 'warm' : null /* unremarkable — let a stronger axis carry the name */),
  },
  {
    id: 'rain', strength: rainfallSeasonality, min: 0.40, unit: 'index', order: 2,
    // The index works on monthly totals, which already average out day-to-day
    // noise, so it alone is measured on the raw series.
    gateRaw: true,
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
    word: (z, v) => z > 0
      ? (v >= 66 ? 'muggy' : v >= 57 ? 'humid' : null)
      : (v <= 40 ? 'crisp' : null),
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
 * Which axes of `data` carry a real annual cycle. Runs on the series in their
 * own units — see the note at the top about why this cannot come after
 * normalization.
 *
 * The spread is measured on the SMOOTHED series. A 30-year daily normal still
 * carries day-to-day noise, and for cloud cover that noise alone is as wide as
 * the threshold: Christchurch's raw cloud spread is 18%, its smoothed annual
 * cycle under 8%. Measured raw, the gate passed exactly the noise it exists to
 * reject.
 *
 * `nearMiss` marks an axis that failed but came within NEAR_MISS of passing.
 */
export function gateAxes(data) {
  return SEASON_AXES
    .filter(ax => usable(data[ax.id]))
    .map(ax => {
      const series = data[ax.id].map(v => (Number.isFinite(v) ? v : 0));
      const smooth = gaussianSmooth(series, 7, 14);
      const value = ax.strength(ax.gateRaw ? series : smooth);
      return {
        ...ax, series, smooth, value,
        passed: value >= ax.min,
        nearMiss: value < ax.min && value >= NEAR_MISS * ax.min,
      };
    });
}

/**
 * The per-day series an axis contributes: its `level` (z-scored, square-rooted
 * first for SQRT_AXES), its `rate` (the z-scored 14-day change in that level),
 * and `raw` — the smoothed series in its own units, for the means.
 */
function profile(ax) {
  const shaped = SQRT_AXES.has(ax.id) ? ax.smooth.map(v => Math.sqrt(Math.max(0, v))) : ax.smooth;
  const level = zscore(shaped);
  const rate = zscore(level.map((_, i) => level[(i + 7) % N] - level[(i - 7 + N) % N]));
  return { level, rate, raw: ax.smooth };
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

/** Length in days of the shortest arc a set of boundaries makes. */
const shortestArc = bounds => Math.min(...bounds.map((s, i) => spanDays(s, bounds[(i + 1) % bounds.length])));

/**
 * How many seasons this year actually has, from the table `segmentAll` built.
 *
 * Accepts one more only when it buys `MIN_GAIN` of extra explained variance over
 * one fewer and leaves no segment shorter than `MIN_SEASON_DAYS`. Without the
 * length rule the fit keeps improving forever by shaving slivers off the ends of
 * real seasons.
 */
function chooseCount(table, totalVar) {
  let chosen = 1, prevEV = 0;
  for (let k = 2; k <= MAX_SEASONS; k++) {
    const fit = table[k];
    if (!fit?.bounds) continue;
    const ev = 1 - fit.cost / totalVar;
    if (ev - prevEV >= MIN_GAIN && shortestArc(fit.bounds) >= MIN_SEASON_DAYS) chosen = k;
    prevEV = ev;
  }
  return chosen;
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
  mild: '#9a9478', warming: '#4a7c3f', cooling: '#8a7048',
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
 * axis is the shoulder of the year: it is named for its direction of travel when
 * temperature is clearly moving — which keeps a mild spring and a mild autumn
 * from both being "Mild season" — and simply "Mild season" when it is not.
 */
function nameFromSignature(sig, means, trend, axes) {
  const ranked = axes
    .map(ax => ({ ax, z: sig[ax.id], word: ax.word(sig[ax.id], means[ax.id]) }))
    .filter(e => Number.isFinite(e.z) && Math.abs(e.z) >= 0.45 && e.word)
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

  if (!ranked.length) {
    const t = trend.temp;
    if (Number.isFinite(t) && Math.abs(t) >= SHOULDER_TREND) {
      return t > 0 ? { name: 'Warming season', key: 'warming' } : { name: 'Cooling season', key: 'cooling' };
    }
    return { name: 'Mild season', key: 'mild' };
  }

  const kept = [ranked[0]];
  if (ranked[1] && Math.abs(ranked[1].z) >= SECOND_WORD_RATIO * Math.abs(ranked[0].z)) {
    kept.push(ranked[1]);
  }

  // Rank picks *which* words; SEASON_AXES.order picks the order they are said
  // in — English puts the temperature first ("cool wet season", never "wet cool
  // season"), regardless of which axis departs further from the mean. Two axes
  // can offer the same word (cloud and visibility both say "clear"), and it is
  // said once.
  const words = [...new Set([...kept].sort((a, b) => a.ax.order - b.ax.order).map(e => e.word))];
  const phrase = words.join(' ');
  const name = words.length === 1 ? (NAME_OVERRIDES[phrase] ?? `${TITLE(phrase)} season`)
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

// How close to its coldest (warmest) point a day must be to belong to winter
// (summer), as a fraction of the annual range. (1 − cos 45°)/2 is the value at
// which a pure sinusoid divides into four equal quarters; a real curve that
// lingers near its trough — a long continental winter — gets a longer winter
// from the same rule.
export const QUARTET_EXTREME = (1 - Math.SQRT1_2) / 2;

const QUARTET_KEYS = { Winter: 'cold', Spring: 'green', Summer: 'hot', Autumn: 'bare' };

/**
 * Is this a four-season thermal year? Tested on the best four-arc split, before
 * anything is merged and whatever count `chooseCount` would pick: the quartet
 * is a reading of the thermal cycle, and should not appear or vanish with a
 * threshold on the count, nor be merged away before it is looked for.
 *
 * True when temperature passed the gate with a wide swing; the four arcs are
 * each long enough to be seasons; they run in thermal order — coldest opposite
 * warmest, and the two between them less extreme than either; and temperature
 * is among the axes separating them most.
 *
 * Temperature need not *lead* outright: dew point and vegetation both track it
 * closely in a humid continental climate and either can edge it out, which does
 * not make the year any less a four-season thermal one.
 */
function isThermalQuartet(arcs, axes, tempAxis) {
  if (!tempAxis || tempAxis.value < QUARTET_MIN_SWING_F || arcs.length !== 4) return false;
  if (Math.min(...arcs.map(a => a.days)) < MIN_SEASON_DAYS) return false;

  const t = arcs.map(a => a.signature.temp);
  const coldest = t.indexOf(Math.min(...t)), warmest = t.indexOf(Math.max(...t));
  if ((coldest - warmest + 4) % 4 !== 2) return false;
  const extreme = Math.min(-t[coldest], t[warmest]);
  if (t.some((v, i) => i !== coldest && i !== warmest && Math.abs(v) >= extreme)) return false;

  const dominance = id => mean(arcs.map(a => Math.abs(a.signature[id] ?? 0)));
  const strongest = Math.max(...axes.map(ax => dominance(ax.id)));
  return dominance('temp') >= QUARTET_TEMP_SHARE * strongest;
}

/**
 * Winter, Spring, Summer and Autumn as [start, end) day ranges, read off the
 * smoothed temperature curve `T` alone.
 *
 * They are temperature names, so they take temperature dates. Taken from the
 * multi-axis segmentation instead, lagging axes — snow cover, green-up, dew
 * point — drag them weeks late, and the fit's own geometry makes the shoulders
 * short: at this RATE_WEIGHT a pure sinusoid splits into seasons of roughly
 * 113 and 70 days rather than into quarters.
 */
function quartetRanges(T) {
  const lo = Math.min(...T), hi = Math.max(...T);
  const band = QUARTET_EXTREME * (hi - lo);
  // The unbroken run of days around `seed` for which `inside` holds, as [start, end).
  const around = (seed, inside) => {
    let s = seed, e = seed;
    while (inside((s - 1 + N) % N) && (s - 1 + N) % N !== seed) s = (s - 1 + N) % N;
    while (inside((e + 1) % N) && (e + 1) % N !== seed) e = (e + 1) % N;
    return [s, (e + 1) % N];
  };
  const [winterStart, winterEnd] = around(T.indexOf(lo), d => T[d] <= lo + band);
  const [summerStart, summerEnd] = around(T.indexOf(hi), d => T[d] >= hi - band);
  return {
    Winter: [winterStart, winterEnd], Spring: [winterEnd, summerStart],
    Summer: [summerStart, summerEnd], Autumn: [summerEnd, winterStart],
  };
}

/**
 * Seasons for `data`.
 *
 * @returns {{
 *   seasons: {startDOY:number, endDOY:number, days:number, name:string, key:string,
 *             color:string, signature:Object, means:Object, trend:Object}[],
 *   axes: {id:string, value:number, min:number, unit:string, passed:boolean,
 *          nearMiss:boolean, series:number[]}[],
 *   basis: string[],  note: string|null,
 *   datesFrom: 'temperature'|'segmentation'|null,
 * }}
 *   `seasons` is empty when the location has no axis with a real annual cycle —
 *   which is a finding about the place, not a failure, and `note` says so.
 *   Each entry in `axes` carries the smoothed series its gate was measured on,
 *   so the seasons modal can show exactly what the calculation saw. `datesFrom`
 *   says whether the boundaries were read off temperature (the quartet) or
 *   found by segmenting every gated axis together.
 */
export function computeSeasons(data) {
  const gated = gateAxes(data);
  const axes = gated.filter(ax => ax.passed);
  const report = gated.map(({ id, value, min, unit, passed, nearMiss, smooth }) =>
    ({ id, value, min, unit, passed, nearMiss, series: smooth }));
  const basis = axes.map(ax => ax.id);
  const none = note => ({ seasons: [], axes: report, basis, note, datesFrom: null });

  if (!axes.length) {
    return none(gated.length
      ? 'No axis of this location’s year varies enough to mark a season.'
      : 'Not enough data loaded yet to derive seasons.');
  }

  // Axes that just missed the gate get a profile too: they can help name a
  // season, never define one.
  const nameAxes = [...axes, ...gated.filter(ax => ax.nearMiss)];
  const profiles = Object.fromEntries(nameAxes.map(ax => [ax.id, profile(ax)]));

  // What the segmentation sees: each gated axis's level and rate, binned to weeks.
  const toWeeks = a => Array.from({ length: WEEKS }, (_, w) =>
    mean(a.slice(Math.round(w * N / WEEKS), Math.round((w + 1) * N / WEEKS))));
  // Rate of change, alongside level. Spring and autumn sit at the SAME
  // temperature — level alone cannot tell them apart, which is why a clustering
  // on levels gives a four-season continental climate only two seasons. The
  // direction of travel is the one thing that separates them. It is down-
  // weighted because it is a supporting signal: at full weight it starts
  // splitting the flanks of a single long season in two.
  const features = [
    ...axes.map(ax => toWeeks(profiles[ax.id].level)),
    ...axes.map(ax => toWeeks(profiles[ax.id].rate).map(v => v * RATE_WEIGHT)),
  ];
  const totalVar = features.reduce((s, f) => s + f.reduce((t, v) => t + (v - mean(f)) ** 2, 0), 0);

  if (!(totalVar > 0)) return none('This location’s year is flat on every axis.');

  const table = segmentAll(features, MAX_SEASONS);

  /**
   * Everything that can be said about the span from `start` to `end`, measured
   * per day rather than over the weekly bins the boundaries were found in.
   */
  const describe = (start, end) => {
    const days = [];
    for (let d = start; d !== end; d = (d + 1) % N) days.push(d);
    const signature = {}, means = {}, trend = {};
    nameAxes.forEach(ax => {
      const p = profiles[ax.id];
      signature[ax.id] = mean(days.map(d => p.level[d]));
      means[ax.id]     = mean(days.map(d => p.raw[d]));
      trend[ax.id]     = mean(days.map(d => p.rate[d]));
    });
    return { startDOY: start, endDOY: end, days: days.length, signature, means, trend,
             ...nameFromSignature(signature, means, trend, nameAxes) };
  };
  const arcsOf = fit => fit.bounds.map((start, i) => describe(start, fit.bounds[(i + 1) % fit.bounds.length]));

  const tempAxis = axes.find(ax => ax.id === 'temp');
  if (table[4]?.bounds && isThermalQuartet(arcsOf(table[4]), axes, tempAxis)) {
    const ranges = quartetRanges(profiles.temp.raw);
    if (Object.values(ranges).every(([start, end]) => start !== end)) {
      const seasons = Object.entries(ranges)
        .map(([name, [start, end]]) => ({
          ...describe(start, end), name, key: QUARTET_KEYS[name], color: SEASON_COLORS[QUARTET_KEYS[name]],
        }))
        .sort((a, b) => a.startDOY - b.startDOY);
      return { seasons, axes: report, basis, note: null, datesFrom: 'temperature' };
    }
  }

  let k = chooseCount(table, totalVar);
  if (k < 2) return none('This location’s year runs as one continuous season.');

  // Two neighbours that are the same season — the namer cannot tell them apart,
  // or their levels barely differ — are folded together. The rate-of-change
  // features are what make this necessary: they legitimately split spring from
  // autumn, but they also split a single long wet season at the point where it
  // stops deepening and starts easing, which is a real feature of the year and
  // not a season boundary anyone would recognise.
  //
  // The fold steps down to the best split with one fewer season rather than
  // gluing the two arcs end to end, so every boundary stays the best one for the
  // count that remains; a step that would leave a sliver shorter than
  // MIN_SEASON_DAYS keeps stepping. Only ADJACENT arcs are compared, so a year
  // with two separate wet seasons keeps both even though they share a name.
  const distance = (a, b) => Math.sqrt(mean(axes.map(ax => (a.signature[ax.id] - b.signature[ax.id]) ** 2)));
  let arcs = arcsOf(table[k]);
  while (k > 2) {
    const next = j => arcs[(j + 1) % arcs.length];
    if (!arcs.some((a, j) => a.name === next(j).name || distance(a, next(j)) < MERGE_DISTANCE)) break;
    do { k--; } while (k > 2 && shortestArc(table[k].bounds) < MIN_SEASON_DAYS);
    arcs = arcsOf(table[k]);
  }
  if (k === 2 && (arcs[0].name === arcs[1].name || shortestArc(table[2].bounds) < MIN_SEASON_DAYS)) {
    return none('This location’s year runs as one continuous season.');
  }

  const seasons = arcs.map(a => ({ ...a, color: SEASON_COLORS[a.key] ?? SEASON_COLORS.mild }));
  return { seasons, axes: report, basis, note: null, datesFrom: 'segmentation' };
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
