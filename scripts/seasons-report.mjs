#!/usr/bin/env node
/**
 * The seasons every reference climate comes out with, and what a change moved.
 *
 * src/data/seasons.js is steered by a handful of tuned constants, and several
 * sit close to the point where a season appears or vanishes, so a small move
 * quietly changes real places. There is no test suite; this is the check. It
 * runs computeSeasons over a fixed set of 30-year normals and compares the
 * result, location by location, with the committed baseline.
 *
 *   npm run seasons-report               what changed since the baseline
 *   npm run seasons-report -- --print    the full report
 *   npm run seasons-report -- --update   accept the current output as the baseline
 *
 * A difference is not a verdict. It is the list of places a change moved, to be
 * read and judged — and, if it is right, accepted with --update. The script
 * exits 1 while a difference stands, so it can gate a commit.
 *
 * Fixtures (scripts/fixtures/season-climates.json) are ERA5 1991–2020 daily
 * normals from the Open-Meteo archive, aggregated and rounded as the app stores
 * them, plus records copied from the server's location cache, which also carry
 * MODIS EVI. Their dew point comes from the archive's daily aggregate rather
 * than the app's hourly 2010–2020 fetch. The bundled presets are read straight
 * from src/data/presets.js, so they are checked as shipped.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeSeasons, seasonRangeLabel } from '../src/data/seasons.js';
import { PRESETS } from '../src/data/presets.js';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const FIXTURES = here('./fixtures/season-climates.json');
const BASELINE = here('./fixtures/seasons-report.txt');

const FORMAT = {
  '°F': v => `${v.toFixed(1)}°F`, index: v => v.toFixed(2), EVI: v => v.toFixed(2),
  in: v => `${v.toFixed(1)} in`, mi: v => `${v.toFixed(1)} mi`, '%': v => `${v.toFixed(0)}%`,
};

/** One location's entry: its gate readings, then its seasons or the note. */
function block(name, data) {
  const s = computeSeasons(data);
  const gate = s.axes.map(a => `${a.id} ${(FORMAT[a.unit] ?? String)(a.value)} ${a.passed ? '✓' : '✗'}`).join(' · ');
  const lines = [name, `  gate: ${gate}`];
  if (!s.seasons.length) lines.push(`  — ${s.note}`);
  for (const sn of s.seasons) {
    lines.push(`  ${sn.name.padEnd(24)} ${seasonRangeLabel(sn).padEnd(16)} ${String(sn.days).padStart(3)} days`);
  }
  return lines.join('\n');
}

const locations = [
  ...PRESETS.map(p => [`${p.label} (preset)`, p.data]),
  ...JSON.parse(fs.readFileSync(FIXTURES, 'utf8')).map(f => [f.name, f]),
];
const report = locations.map(([name, data]) => block(name, data)).join('\n\n') + '\n';

const args = new Set(process.argv.slice(2));
if (args.has('--print')) process.stdout.write(report);

if (args.has('--update') || !fs.existsSync(BASELINE)) {
  fs.writeFileSync(BASELINE, report);
  console.log(`Baseline written: ${locations.length} locations → ${BASELINE}`);
  process.exit(0);
}

// Compare by location, so one moved season reads as one changed place rather
// than as a shifted wall of text.
const blocks = text => new Map(text.trim().split('\n\n').map(b => [b.split('\n')[0], b]));
const before = blocks(fs.readFileSync(BASELINE, 'utf8')), after = blocks(report);
const changed = [];
for (const name of new Set([...before.keys(), ...after.keys()])) {
  const a = before.get(name)?.split('\n') ?? [], b = after.get(name)?.split('\n') ?? [];
  if (a.join('\n') === b.join('\n')) continue;
  const gone = a.slice(1).filter(l => !b.includes(l)), added = b.slice(1).filter(l => !a.includes(l));
  changed.push([
    !a.length ? `${name}  (new)` : !b.length ? `${name}  (removed)` : name,
    ...gone.map(l => `- ${l.trimStart()}`), ...added.map(l => `+ ${l.trimStart()}`),
  ].join('\n'));
}

if (!changed.length) {
  console.log(`No change: all ${after.size} locations match the baseline.`);
  process.exit(0);
}
console.log(`${changed.length} of ${after.size} locations changed since the baseline:\n`);
console.log(changed.join('\n\n'));
console.log('\nIf these are right, accept them with: npm run seasons-report -- --update');
process.exit(1);
