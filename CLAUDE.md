# CLAUDE.md — Wheel of the Year

A reference for AI assistants working in this repository.

## Project Overview

**Wheel of the Year** is a browser-based climate visualization tool that renders a circular "wheel" showing annual climate patterns for any city. Rings represent temperature, rainfall, daylight, vegetation (NDVI), and wind data, drawn on an HTML5 Canvas element using a polar coordinate system anchored at the winter solstice.

## Tech Stack

- **Vite** (v5.4.0) — bundler and dev server
- **Vanilla JavaScript** — ES modules, no framework
- **HTML5 Canvas API** — all visualization rendering
- **CSS custom properties** — theming and layout
- **Google Fonts** — Cinzel (display), Crimson Pro (body)
- **External APIs** — OpenStreetMap Nominatim (geocoding), Open-Meteo (ERA5 climate), MODIS ORNL DAAC (NDVI)

No backend, no database, no runtime dependencies.

## Directory Structure

```
/
├── index.html                    # HTML entry point
├── vite.config.js                # Minimal Vite config, output → dist/
├── package.json                  # Scripts and devDependencies (vite only)
├── scripts/
│   ├── generate-preset-oakland.js  # Regenerates Oakland preset from live APIs
│   ├── seasons-report.mjs        # Seasons for reference climates vs. the committed baseline
│   └── fixtures/                 # season-climates.json (normals) + seasons-report.txt (baseline)
├── server/
│   ├── image-server.mjs          # Node service on :7871 — routes /generate, /climate
│   ├── llm.mjs                   # LLM provider switch: Anthropic (default) or Ollama
│   └── climate-cache.mjs         # Per-location store: climate normals + daily actuals
└── src/
    ├── main.js                   # App entry: drawing loop, fetch, export, events
    ├── state.js                  # Centralized mutable state
    ├── styles.css                # All styling (CSS custom properties, responsive)
    ├── data/
    │   ├── ringDefs.js           # 11 ring definitions (colors, units, scale ranges, provenance)
    │   ├── calendar.js           # The one date ↔ DOY conversion (DOY 0 = Dec 21, the winter solstice)
    │   ├── seasons.js            # Climatological seasons derived from this location's own normals
    │   ├── presets.js            # Built-in Oakland, CA preset (365-point arrays)
    │   ├── summary.js            # The year in a few figures — feeds the cartouche and the key
    │   ├── locationCache.js      # Client half of the server-side location cache
    │   └── prefs.js              # localStorage: UI preferences + last location
    ├── draw/
    │   ├── theme.js              # Ink palette, the radial register plan, tracking + halo helpers
    │   ├── canvas.js             # Math helpers: doy2angle, polar, norm, arc text
    │   ├── wheel.js              # paintWheel() — the whole drawing, screen and poster alike
    │   ├── ring.js               # Draw concentric ring arcs (one arc per day)
    │   ├── seasons.js            # The seasons band — contiguous named arcs, not a scaled ring
    │   ├── layout.js             # Compute inner radius + thickness per visible ring
    │   ├── decorations.js        # Calendar band, moon lane, solar cross, centre cartouche
    │   ├── labels.js             # Extreme markers: value, date, collision resolution
    │   └── actuals.js            # "Actuals" overlay: observed-year line + today marker
    ├── export/
    │   └── svg.js                # canvas2svg plumbing: patches, embedded fonts, renderSVG()
    ├── print/
    │   └── poster.js             # Portrait large-format sheet + the print window
    ├── fetch/
    │   ├── climate.js            # Geocode city → fetch ERA5 30-yr normals → 365-day arrays
    │   ├── ndvi.js               # Fetch MODIS 16-day NDVI composites → smooth → 365-day array
    │   ├── actuals.js            # Fetch recent real observations (trailing ~350 days, or just the days past what the cache holds)
    │   ├── humidity.js           # Fetch ERA5 hourly dew point → 365-day normals (the mugginess axis)
    │   └── image.js              # Generate AI landscape image via Forge API
    └── ui/
        ├── controls.js           # Ring control panel: toggle, color, thickness, opacity, drag-reorder
        ├── legend.js             # Legend items for visible rings
        ├── status.js             # Status messages (ok / loading / error) and spinner
        ├── tooltip.js            # Mouse-hover tooltip showing daily values per ring
        ├── ringChart.js          # Ring chart modal (click a ring) + openChartModal, the shared modal shell
        ├── seasonsChart.js       # Seasons modal: every dataset the seasons were derived from, with the season changes
        ├── eviAnalysis.js        # Vegetation analysis modal: MODIS peak/trough grids + seasonal profile
        └── yearAxis.js           # The solstice-to-solstice axis every modal chart uses
```

## Development Workflows

### Local development
```bash
npm run dev           # Vite dev server with hot reload
npm run build         # Production build → dist/
npm run preview       # Preview production build locally
npm run generate-presets  # Regenerate Oakland preset from live APIs (Node.js)
npm run seasons-report    # What a change to src/data/seasons.js moved (see "Seasons are derived")
```

### Regenerating preset data
`scripts/generate-preset-oakland.js` fetches live ERA5 and MODIS data and overwrites `src/data/presets.js`. Run only when upstream data changes are needed; the file is committed.

## Server & Deployment

### Infrastructure
- **Server:** Mac mini (`Bradfords-Mac-mini.local`). **Claude sessions normally
  run on the Mac mini itself** — check `hostname` first. If it says
  `Bradfords-Mac-mini`, run commands directly; `ssh macmini` is only an alias on
  other machines and fails to resolve here.
- **Domain:** `slamado.ng` (Cloudflare-managed)
- **Web server:** nginx on port 8080. There is **one** server block,
  `/opt/homebrew/etc/nginx/servers/slamadong.conf`, that includes per-site
  fragments from `/opt/homebrew/etc/nginx/sites/*.conf` — this app's is
  **`sites/wheel.conf`**. `nginx.conf`, `servers/` and `sites/` are symlinks into
  the **`~/Sites/infra`** repo (`git@github.com:bobadams/slamadong-infra.git`), so
  commit nginx changes there, not here. Read `~/Sites/infra/nginx/sites/README.md`
  before editing (never add a second `server { }` block), and reload with
  `~/Sites/infra/bin/reload.sh` (it runs `nginx -t` first).
- **Tunnel:** Named Cloudflare Tunnel `macmini` (UUID `218c4c03-1ae4-44d9-80d1-3ac64888e7de`), managed by launchd, runs `cloudflared tunnel run macmini`
- **Project location on server:** `~/Sites/wheel-of-the-year/`
- **Git remote:** `git@github.com:bobadams/Wheel-of-the-year.git`

### Live URLs
- `https://slamado.ng/` — **landing page**: a static index of all the sites
  hosted here (`~/Sites/infra/landing/index.html`; `~/Sites/landing` is a symlink
  to it). Previously redirected to `/astrology/`. The full list of sites is the
  set of fragments in `~/Sites/infra/nginx/sites/`.
- `https://slamado.ng/wheel/` — Wheel of the Year (this app)
- `https://slamado.ng/astrology/` — Daily Astrology (sibling app)
- `https://slamado.ng/planets.html` — Ephemeris / "The Wandering Stars" planetary
  ephemeris wheel (served from `~/Sites/wandering-stars/planets.html`)
- `https://slamado.ng/synastry.html` — Synastry Reading (served from
  `~/Sites/wandering-stars/synastry.html`)

### Vite base path
`vite.config.js` sets `base: '/wheel/'` so all assets are served from the correct subpath. Do not change this without updating the nginx config to match.

### Never let `index.html` be cached

Vite content-hashes the bundle, so **`index.html` is the only file that names the
current build**. nginx originally sent no `Cache-Control` for it, only
`Last-Modified` — which lets browsers cache it heuristically. A returning visitor
then kept loading the *previous* bundle indefinitely, with no error to notice:
that is how the location cache appeared "broken" after it shipped (an old bundle
makes no `/wheel-images/climate` call at all, so it refetched MODIS EVI from
scratch every single visit).

The nginx block now sends `Cache-Control: no-cache` for everything under
`/wheel/` and `immutable` for `/wheel/assets/` — the entry point revalidates each
load, the hashed assets are still cached hard. **`/astrology/` has the same pair
of headers**, since it is also a Vite build with hashed bundles. Two things to
remember:

- **A browser already holding a stale copy needs one hard reload** (⇧⌘R). The
  header only governs copies fetched after it was added.
- **A stale reference does not 404.** `try_files` falls back to `/wheel/index.html`,
  so a request for a deleted bundle returns HTML with a `200` under a `.js` URL.
  When debugging "the site behaves like an old version", check which bundle the
  page actually requested against `ls dist/assets/` — don't trust the status code.

### Deploying updates

> **The Mac mini is the canonical source.** All edits are made directly in
> `~/Sites/wheel-of-the-year/` on the Mac mini. Git is used as a **backup /
> history**, not as the deploy mechanism — changes are *not* edited locally and
> pushed down. Do not `git pull` into the server's working tree; that would
> overwrite the live edits. (This is deliberate for this project, not standard
> practice.)

```bash
# On the Mac mini (from another machine, wrap each line in: ssh macmini "…")
export PATH=/opt/homebrew/bin:$PATH && cd ~/Sites/wheel-of-the-year

# 1. Rebuild the front end
npm run build

# 2. If anything under server/ changed, restart the image service
launchctl kickstart -k gui/$(id -u)/com.wheel.image-server

# 3. Commit and push as a backup
git add -A && git commit -m '...' && git push
```
nginx serves the built `dist/` directory directly, so a front-end change needs no
restart. **The image service is different:** launchd keeps the Node process
running, and it keeps the old `server/*.mjs` until you restart it. Forgetting
this fails silently. For example, a new ring added to the cache lists in
`server/climate-cache.mjs` is quietly dropped from every POST until the service
restarts. After restarting, check that a new PID is listening with
`lsof -nP -iTCP:7871 -sTCP:LISTEN`.

**Merging a branch from a cloud session.** Cloud Claude sessions push
`claude/*` branches to GitHub rather than editing here. To take one:
`git fetch origin`, check that it fast-forwards
(`git merge-base --is-ancestor main origin/<branch>`),
`git merge --ff-only origin/<branch>`, then run the steps above. This is the one
case where pulling into the server's tree is safe, and only if `git status` is
clean first. A branch that fast-forwards from `main` already contains every
committed live edit, and a clean tree means there are no uncommitted ones.

> **Any other clone (e.g. a laptop checkout) is read-only / reference.** If you
> edit elsewhere, you must `git pull` *from* the server's history first and
> reconcile by hand — the server never pulls from you. Prefer editing on the
> Mac mini directly to avoid divergence.

### nginx location block (for reference)
The static-site half of `~/Sites/infra/nginx/sites/wheel.conf` (the
`/wheel-images/` half is under "Image service — deployment" below). The file in
the infra repo is authoritative; this copy is here to read, not to paste.
```nginx
location = /wheel {
    return 301 /wheel/;
}

# Content-hashed bundles — safe to cache forever, the name changes when the
# contents do. `^~` makes this win over the /wheel/ prefix below.
location ^~ /wheel/assets/ {
    alias /Users/bradfordadams/Sites/wheel-of-the-year/dist/assets/;
    add_header Cache-Control "public, max-age=31536000, immutable";
}

location /wheel/ {
    alias /Users/bradfordadams/Sites/wheel-of-the-year/dist/;
    try_files $uri $uri/ /wheel/index.html;
    add_header Cache-Control "no-cache";   # see "Never let index.html be cached"
}
```
The landing page, Wandering Stars and the other sites each have their own
fragment in the same directory.

> **Anthropic API key:** the shared `/api/anthropic/` proxy lives in
> `sites/ai-proxy.conf`, and its `x-api-key` is NOT inlined there. It lives in a
> single `chmod 600` file at `/opt/homebrew/etc/nginx/anthropic-key.conf`, pulled
> in with `include`. That file is kept **outside** the `servers/*` and `sites/*`
> globs, so nginx never loads it on its own, and outside the infra repo, so it is
> never committed. To rotate it, edit that one file and run
> `~/Sites/infra/bin/reload.sh`.

### Restarting the tunnel
If the tunnel goes down:
```bash
launchctl unload ~/Library/LaunchAgents/com.cloudflared.astrology.plist && launchctl load ~/Library/LaunchAgents/com.cloudflared.astrology.plist
```
Use `unload`/`load` — not `stop`/`start` — to ensure the plist is re-read.

Check tunnel status:
```bash
/opt/homebrew/bin/cloudflared tunnel info macmini
```

## Drawing the wheel

### One drawing, two sizes

`paintWheel()` in `src/draw/wheel.js` is the whole picture. Every module it calls
places things as a **fraction of `canvas.W`** and around `canvas.CX/CY`, so
"scaling the wheel" is nothing more than pointing those fields somewhere else:
the screen sets them to a square canvas, and `src/print/poster.js` sets them to a
square region of a 24 × 36 inch sheet before calling the same function. Nothing
in the draw code knows which it is drawing.

Two flags on `canvas` change *what* is drawn rather than how big:

| flag | set by | effect |
|---|---|---|
| `svgExport` | `renderSVG()` | holiday symbols emit drawn paths instead of Unicode glyphs, which no longer depend on the viewer's serif coverage |
| `print` | `paintPoster()` | detail that only earns its space at wall size: full month names, the complete set of centre figures |

If you add annotation that should differ between screen and paper, branch on
`canvas.print` — **never on a pixel threshold**. A `W > 900` test made an 18 × 24
poster set abbreviated month names while a 24 × 36 set full ones, which is a
difference in sheet size, not in how far away the reader is standing.

### The radial registers live in one place

`R` in `src/draw/theme.js` holds every radius the wheel uses, outward from the
centre hole to the outermost holiday label at ~0.496·W. They are in one table
because the constraint that matters is between them: the annotation bands are
packed close enough that moving one without looking at its neighbours silently
overlaps them. Nothing is drawn outside the holidays, so the table is scaled to
put them at the edge — take a band away and the rest should scale up to fill,
not leave an empty margin.

Reading outward: centre cartouche · data rings · solstice/equinox labels ·
calendar band · moon lane · holiday symbols and labels.

### Tracking has to be drawn, not spaced

Letterspaced small caps are set with `drawTracked()` (straight) or
`drawArcText(…, { tracking })` (curved), both of which place each glyph by hand.
Padding a string with spaces looks right on canvas and then collapses in the SVG
export — XML folds the run — so a letterspaced masthead prints as
`WHEELOFTHEYEAR`. There is no canvas property for tracking that survives the
export either.

### Annotation reads over the rings via a halo, not a plate

`haloText()` strokes the glyph in the paper colour before filling it. That is how
an extreme label, a season label or a holiday name stays legible where it crosses
a ring fill without a box around it. Anything drawn over the rings should use it.

## Seasons are derived, never assumed

`src/data/seasons.js` works out what seasons this location actually has, and the
`seasons` ring draws them. Nothing starts from a season vocabulary and looks for
its dates: a place may have a wet and a dry season, a fog season, four thermal
ones, or none, and the module finds the structure first and names it after.

Four stages, and **the order is the design**:

1. **Gate, in absolute units.** Which axes carry a real annual cycle — a ≥9 °F
   temperature spread, a Walsh & Lawler rainfall seasonality index ≥0.40, ≥0.08
   of EVI amplitude, and so on. This *must* run before normalization. z-scoring
   divides the amplitude out, so a rainforest varying ±1 °F produces a z-scored
   year **identical** to Chicago's, and every clustering method then returns four
   confident seasons made of noise. The gate is the only thing that lets a place
   legitimately come back with **no seasons**, which is a finding about the
   place, not a failed fetch — the legend, the panel and the poster key each say
   so in words.
2. **Segment**, by exact dynamic programming over the circular year on the
   surviving axes — one pass gives the best split for every count from one to
   five. Unlike k-means it cannot hit a local minimum or answer differently twice.
3. **The quartet**, tested on the best four-arc split before anything is counted
   or merged (see below).
4. **Count, name and merge.** `chooseCount` picks the number of seasons, each arc
   is named from its own signature, and neighbours that are one season are
   folded together.

The things in there that are load-bearing and easy to undo:

- **The gate measures the smoothed series.** A 30-year daily normal still carries
  day-to-day noise, and for cloud cover the noise alone is as wide as the
  threshold — measured raw, the gate passed exactly what it exists to reject.
  Rain's index is the exception: it works on monthly totals, which average the
  noise out already.
- **Rate of change is a feature, at reduced weight.** Spring and autumn sit at
  the same temperature; level alone cannot separate them, which is why a
  level-only clustering gives a four-season continental climate only two
  seasons. At full weight the rate term instead splits single long seasons along
  their own flanks, so it is damped (`RATE_WEIGHT`).
- **Rain and snow are square-rooted before they are z-scored.** Both sit near
  zero for months and then peak; on the raw values the peak holds nearly all the
  variance, and the segmentation spends its seasons carving up the wet season
  while lumping the rest of the year together (a second, shorter rainy season
  disappears into a "Mild season"). `means` stay in real units.
- **Neighbours that are one season are merged by refitting, not by gluing.** This
  is the counterweight to the rate features: they legitimately split spring from
  autumn, but they also split one long wet season at the point where it stops
  deepening. Adjacent arcs that share a name, or whose level signatures differ by
  less than `MERGE_DISTANCE`, send the fit down to the best split with one fewer
  season — so the boundaries stay the best ones for the count that remains. Only
  *adjacent* arcs are compared, so a year with two separate wet seasons keeps
  both even though they share a name.
- **A word comes from the absolute value; its side comes from the z-score.** A
  z-score is relative to the location's own year, so Darwin's coolest season —
  86 °F — came out "cold", which is true of the statistic and false of the place.
  But the direction must still agree: Timbuktu's coolest season averages 85 °F
  highs and was once named "hot". A season below its year's mean can only be
  cool, cold or frozen, one above it only warm or hot; dew point follows the same
  rule. Rain is the deliberate exception: a desert's wet season really is its wet
  season, and that is how people speak. `temp` is the mean daily **high**, and
  the word thresholds are set against highs.
- **An axis that just misses its gate can name a season, never define one.** At
  `NEAR_MISS` (75 %) of its threshold it joins the namer's vocabulary, so a place
  whose rain index falls just short still has its wet and dry seasons called that.
- **A shoulder is named for its direction of travel.** An arc with nothing
  remarkable in its levels, where temperature is clearly moving, is a "Warming
  season" or "Cooling season" — which keeps a mild spring and a mild autumn from
  both being "Mild season".
- **`daylight` is not a season axis.** It is astronomical, identical for every
  place at a given latitude, and including it would impose the same cycle
  everywhere — precisely the arbitrary calendar this module exists to avoid.

Winter/Spring/Summer/Autumn are used **only** when the data shows that year. On
the best four-arc split: a smoothed temperature swing ≥25 °F, every arc ≥30 days,
the coldest arc opposite the warmest with the other two less extreme than either,
and temperature among the axes separating them most. A place that does not have
the quartet is never forced into it. Two things about it are easy to undo:

- **It is tested first, on the four-arc split, whatever the count.** Tested after
  the name merge, three neighbouring "Mild season" arcs were folded into one and
  London lost its quartet before the check ever ran. Tied to `chooseCount`'s
  number, the quartet appeared and vanished with small moves of the constants.
- **Its dates come from temperature alone.** They are temperature names. Winter is
  the unbroken run of days within `QUARTET_EXTREME` (14.6 %) of the annual range
  from the coldest day, summer likewise from the warmest, and spring and autumn
  fill the gaps between. That fraction is the one at which a pure sinusoid falls
  into four 91-day quarters; an uneven curve moves the dates. Taken from the
  multi-axis segmentation instead, lagging axes (snow, green-up, dew point)
  dragged the dates weeks late and the fit's geometry made every spring and
  autumn short — Seoul's winter ran Oct 23 – Apr 1.

### Checking a change: `npm run seasons-report`

The constants in `seasons.js` are tuned, and several sit close to the point where
a season appears or vanishes, so a small move quietly changes real places. There
is no test suite; this is the check. `scripts/seasons-report.mjs` runs
`computeSeasons` over `scripts/fixtures/season-climates.json` — 30-year ERA5
normals for a spread of climates, plus records copied from the location cache —
and over the bundled presets, then compares every location with the committed
baseline `scripts/fixtures/seasons-report.txt`.

```bash
npm run seasons-report               # what changed since the baseline (exits 1 if anything did)
npm run seasons-report -- --print    # the full report
npm run seasons-report -- --update   # accept the current output as the new baseline
```

A difference is not a verdict: it is the list of places a change moved, to be read
and judged, then accepted with `--update` and committed with the change. **Expected
outcomes belong in that baseline, not in comments.** A comment asserting one goes
stale without anyone noticing — the `MIN_GAIN` comment once promised that "a
Mediterranean year resolves to three", which was true only of the bundled Oakland
preset's three axes and false of a live Oakland visit.

### The seasons modal shows the working

Clicking the seasons band, or "Show how these were found" in its panel, opens
`src/ui/seasonsChart.js`: one panel per dataset the calculation used, on a shared
solstice-to-solstice year, with a vertical line at each season change, the dates
along the top, and each season shaded and named in its stretch (a season over
the solstice is named at both ends). It plots exactly what `computeSeasons`
measured — `seasons.axes[].series`, the smoothed series each gate was tested on —
so the chart cannot disagree with the band. `seasons.datesFrom` says how the
dates were found: `'temperature'` (the quartet — the temperature panel draws the
two `QUARTET_EXTREME` thresholds the dates are read off) or `'segmentation'`.
With seasons found it shows the axes that defined them and any near-miss axis
that only named them; with none, every axis the gate looked at, each labelled
with what it measured against its threshold. A series that never changes (snow
in the tropics) is listed below the chart instead of given an empty panel.

Seasons are recomputed in `state.js` alongside `smoothedData` on every data
change (a few ms), so each stage of a load sharpens them and the band can never
disagree with the rings it came from. There is nothing to cache and no separate
refresh path — but note that `refreshSourceBadges()` is what re-renders the
seasons panel and the legend, so a new load stage must keep calling it.

## Printing a poster

`printPoster(sizeKey)` composes a **portrait, self-contained SVG** of the whole
sheet — masthead, wheel, printed key, footer — and opens it in a window whose
`@page` rule is the exact stock size, so the browser's *Save as PDF* produces a
PDF of precisely those dimensions with no further setting. `downloadPosterSVG()`
hands over the same sheet as a file for a print shop. Stocks are in
`POSTER_SIZES` (18 × 24, 24 × 36, A2, A1, A0).

Four things about it are load-bearing:

- **The paper is a `<rect>`, not a CSS background.** Chrome prints with
  "background graphics" off by default; a CSS-painted sheet would come out white.
- **The SVG is grafted on as parsed DOM, never written into the HTML string.**
  A megabyte of markup through `document.write` is parsed in chunks, and the
  break lands inside the foreign content: the sheet arrives holding its `<defs>`
  and nothing else, and prints as a blank page *of exactly the right size*. If a
  poster ever prints blank, check `document.querySelector('.sheet svg').children`
  before suspecting the drawing code.
- **The key is laid out before the wheel.** Its four columns are measured, the
  lead paragraph is wrapped, and the wheel is then given whatever height is left
  — which is why the wheel grows when rings are switched off.
- **A block is the unit of column packing.** Splitting one puts its heading in a
  different column from half its entries; only a block too tall for any column is
  broken up.

### Two canvas2svg bugs the export patches

`patchC2S()` in `src/export/svg.js` fixes both. They are easy to reintroduce:

- **`setLineDash` is not part of canvas2svg's style stack.** The patch pushes and
  pops the dash alongside `save`/`restore`. Without that, one dashed stroke — the
  observed-year line, a legend swatch — leaks its pattern into *every* stroke
  drawn afterwards. The failure is silent and print-only: the same code draws
  solid on screen.
- **canvas2svg emits `width`/`height` but no `viewBox`.** The patch adds one.
  Without it the document cannot be scaled to a container, so the print window
  crops the sheet to its top-left corner instead of fitting it to the page.

## Key Conventions

### Day-of-Year (DOY)
- **DOY 0 is the winter solstice, Dec 21** — the day at the top of the wheel. The
  year runs clockwise: Dec 31 = 10, **Jan 1 = 11**, Mar 20 = 89, Jun 21 = 182,
  Sep 22 = 275, Dec 20 = 364. It is a 365-day year; Feb 29 has no slot.
- All data arrays are length 365 and indexed this way — fetched normals, the
  bundled preset, the server's stored records, the seasons fixtures.
- **`src/data/calendar.js` is the only place a date becomes a DOY or a DOY a
  date** (`dateToDOY`, `monthDayToDOY`, `doyLabel`, `doyMonth`, `MONTH_START`,
  `monthSpans`). Never write month arithmetic anywhere else: every module used to
  carry its own copy counting from Jan 1, with the solstice put on top by rotating
  the drawing, and independent copies are how two displays drift apart silently.
- Feb 29: a normal skips it (`dateToDOY` → `null`); a single observation or event
  folds onto Mar 1 with `{ leapDay: 'mar1' }` (`observedDOY` in `fetch/actuals.js`).
- Outside conventions still count from Jan 1 — the solar declination formula and
  MODIS composite keys (`A2022145`). Convert with `doyToJan1` at that boundary only.
- `doy2angle(doy)` maps DOY to radians with the **middle** of DOY 0 at the top. A
  day's arc runs `doy2angle(d)`…`doy2angle(d + 1)`, and every whole-day marker
  (holidays, moons, extremes, today, the solstice/equinox axes) sits at `d + 0.5`.
  `angle2doy` is the inverse; `Math.floor` of it is the day under an angle.
- The solstice/equinox axes sit on their labelled dates, so they are **not** a
  perfect cross — Sep 22 → Mar 20 is 179 days, Mar 20 → Sep 22 is 186.
- Anything that scans a 365-point array for a run of equal values must scan
  **circularly**: the shortest day's plateau straddles DOY 364 → 0 (see
  `plateauMid` in `draw/labels.js`).
- **Every modal chart runs winter solstice to winter solstice**, through
  `src/ui/yearAxis.js` — the ring chart, the EVI panel's seasonal profile and the
  seasons modal. Both edges are the middle of DOY 0 (exactly the top of the
  wheel), a day's value sits at `x(doy)`, a series is closed by plotting DOY 0
  again at `x(365)` (`closeYear`), and month dividers fall half a day earlier at
  `boundaryX`. Both ends are labelled "Dec 21". A new chart must use it rather
  than mapping 0–364 across its width, which ends a day short of the solstice
  and never closes the curve.

### Canvas coordinate system
- Origin at canvas center `(cx, cy)`
- Polar coordinates via `polar(cx, cy, angle, radius)` → `{x, y}`
- Normalization: `norm(value, lo, hi)` → clamped 0–1
- Arc widths clamped to `0.02–1.0` to prevent degenerate shapes
- Use `ctx.save()` / `ctx.restore()` around every drawing operation that changes transform or style

### State management
State lives in `src/state.js` as plain mutable objects. No framework reactivity. Modules import and mutate state directly. Key state objects:
- `ringOrder` — array of ring IDs, innermost → outermost
- `ringState` — per-ring: `visible`, `color`, `thickness`, `opacity`
- `displayState` — global toggles: `moon`, `axis`, `ticks`, `actuals`
- `currentData` — 365-point arrays for the currently displayed location
- `actuals` — past ~185 days of real observations

`ringOrder` / `ringState` / `displayState` are **hydrated from localStorage at
startup** and written back on every change — see "Persisted UI preferences".
`state.js` also exports the pristine defaults (`defaultRingState()`,
`DISPLAY_DEFAULTS`) that the persistence layer diffs against.

### Ring definitions (`src/data/ringDefs.js`)
Each ring has: `id`, `label`, `unit`, `color`, `normLo`/`normHi` fallback range,
`defaultNormMode`, and `source` — the short provenance printed in the poster key.
Colors are deliberately desaturated earth pigments: a saturated screen green has
nowhere to go in print, and nine rings have to stay tellable apart on paper.

The 11 rings: `temp`, `rain`, `daylight`, `evi`, `wind`, `pm25`, `visibility`,
`snow`, `cloud`, `dewpoint`, `seasons` — everything after `wind` is hidden by
default except `seasons`.

`seasons` is the one **categorical** ring: it carries `categorical: true` and no
`normLo`/`normHi`, because it has no value per day. That flag is what every
module keyed on a numeric series checks before touching it — `drawRing` is
replaced by `drawSeasonBand`, and `computeNormBounds`, `drawMinMaxMarkers`, the
legend's range, the poster's `ringRange` and the tooltip's readout all branch on
it. Adding another categorical ring means finding those branches, not inventing
a new mechanism.

### Data fetching patterns
- All fetches use `async/await` with `try/catch`
- MODIS NDVI fetch can fail; `ndviProxyFallback()` computes a heuristic from temp/rain
- Actuals fetch is non-blocking; failures are logged to console but don't break the UI
- `setStatus()` / `setLoading()` inform the user during long fetches
- API URLs are built with template literals; no fetch library

### UI patterns
- Event delegation in `controls.js` (single listener on the panel, check `event.target`)
- Drag-to-reorder uses HTML5 drag events (`dragstart`, `dragover`, `drop`)
- Toggle states managed with CSS classes (`.on`, `.active`, `.visible`)
- Sliders (`<input type="range">`) for thickness and opacity
- `<input type="color">` for per-ring color

### CSS conventions
- CSS custom properties defined on `:root`: `--bg`, `--paper`, `--ink`, `--accent`, etc.
- Flexbox layout throughout; no CSS grid
- Responsive breakpoint at `820px` (controls panel moves below canvas on mobile)
- No CSS preprocessor; plain CSS only

## External API Notes

| API | Purpose | Key detail |
|-----|---------|-----------|
| OpenStreetMap Nominatim | Geocoding city name → lat/lon | Rate-limit: 1 req/s |
| Open-Meteo Climate | ERA5 30-year normals (1991–2020) | Daily aggregates, free |
| Open-Meteo Archive | Recent actual observations | Past ~185 days, free |
| MODIS ORNL DAAC | MOD13Q1 NDVI 16-day composites | 2019–2022 baseline, 4km × 4km sample |
| Open-Meteo Archive (hourly) | Dew point normals, 2010–2020 | Its **own request**, never folded into the main daily call — see below |

MODIS requests are batched per 16-day interval; `setNdviProgress()` updates a progress bar during fetch.

### An optional normal gets its own request

`pm25`, `visibility` and `dewpoint` are each fetched by their own module and
their own stage in `loadLocation()`, rather than being added to
`fetchClimateAPI`'s `daily=` list. That is not tidiness — Open-Meteo rejects the
**entire** request with a 400 when one aggregation name is wrong or retired, so a
variable added to the main call can take temperature, rainfall, wind, snow and
cloud down with it. As its own stage, a bad variable name costs exactly one ring.

The same reason applies to the preset generator, which now drops a series that
comes back as 365 nulls: an upstream with no data for a point answers with nulls
rather than an error, and a truthy-but-empty array used to be stored with meta
claiming real provenance. That is how the committed Oakland preset ended up
shipping a `visibility` ring of nulls labelled `ERA5 2010–2020`.

### A subset request may span at most 10 composites

Ask for an 11th and the API returns `400 exceeds maximum subset tiles support
of 10`. The cap counts **dates, not pixels** — a 25×25 grid over 10 composites
is fine, a single pixel over 11 is not — so it applies to every multi-date
request regardless of `kmAboveBelow`. `MAX_COMPOSITES` in `src/fetch/evi.js` is
that limit, and both multi-date callers chunk by it.

A full MOD13Q1 year is 23 composites, so `fetchAnnualSeries` needs three
requests. It originally asked for the year in one and took the 400 every time;
`fetchModisBatch` maps a failed request to `null`, which the caller read as "no
series", so **every location on earth silently fell back to the northern-
hemisphere peak/trough dates** (Jul 12 / Jan 1). Southern-hemisphere sites had
their two seasons exactly backwards. Nothing surfaced this but one
`MODIS batch failed 400` line on the console.

Do not change `MAX_COMPOSITES` from 10 to tune the baseline fetch: batch ids in
`eviDoneKeys` are derived from each batch's date range, so a different size
orphans the resume state in every stored location record.

### A MODIS subset is not a lat/lon raster — never treat it as one

`fetchPixelGrid` returns a window on the MODIS **sinusoidal** grid, and three
properties of it are counter-intuitive enough that all three were once wrong at
the same time. Place cells with `cellLatLon()` (in `src/fetch/evi.js`) and never
by scaling a row/column offset into degrees.

- **Row 0 is the NORTHERNMOST row**, column 0 the westernmost — ordinary raster
  order, even though the response names its origin `xllcorner`/`yllcorner`
  (lower-*left*). Verified with a subset centred on the north shore of Lake
  Okeechobee, where open water is unambiguously south: the water pixels come
  back in the last rows.
- **The grid is sheared.** Rows are true parallels, but a column holds
  sinusoidal *x* constant, and x = R·λ·cos φ — so as latitude falls, cos φ rises
  and the column drifts east. The tilt is λ·tan φ, growing with distance from
  the central meridian (λ₀ = 0): ~33° east of north over Florida, ~42° over the
  Adirondacks, ~53° over California. A subset is a parallelogram, not a
  rectangle, which is why `eviAnalysis.js` draws one quad per cell over the
  north-up satellite tiles instead of blitting an axis-aligned raster.
- **"250 m" pixels step 231.656358264 m** (`cellsize` on the response), and
  `xllcorner`/`yllcorner` are the OUTER corner of the corner pixel — hence the
  half-cell term in `cellLatLon`. Without it every computed point sits on a cell
  boundary and snaps into the neighbouring row.

`nrows`, `ncols`, `cellsize`, `xllcorner` and `yllcorner` are **top-level** on
the response, not per-band; reading them off a `subset[]` entry silently yields
`undefined`.

To check a change here, probe it: request a 1-pixel subset (`kmAboveBelow=0`) at
the lat/lon you computed and confirm the value equals the parent grid's cell.

## AI Image Generation

Landscape images are generated locally using **Stable Diffusion Forge** on the Mac mini server.

### Setup
- **Install location:** `~/stable-diffusion-webui-forge/` on the Mac mini
- **Model:** Realistic Vision V5.1 fp16 at `~/stable-diffusion-webui-forge/models/Stable-diffusion/Realistic_Vision_V5.1_fp16.safetensors`
- **Model source:** `SG161222/Realistic_Vision_V5.1_noVAE` on HuggingFace (downloaded via `huggingface_hub`)
- **Forge version:** f2.0.1v1.10.1-previous (commit `dfdcbab6`)

### Running Forge
```bash
export PATH=/opt/homebrew/bin:$PATH && nohup bash -c 'cd ~/stable-diffusion-webui-forge && bash webui.sh' > ~/forge-run.log 2>&1 &
```

Forge listens on `localhost:7860` (Mac mini only — not exposed directly to the internet).

### Key flags (`webui-user.sh`)
```bash
export COMMANDLINE_ARGS="--api --listen --port 7860 --skip-torch-cuda-test --no-half --no-half-vae --upcast-sampling --cors-allow-origins=*"
export PYTORCH_ENABLE_MPS_FALLBACK=1
python_cmd="python3.10"
```

- `--no-half --no-half-vae` — required on Apple Silicon (MPS); without these, images render as solid black
- `--upcast-sampling` — additional precision fix for MPS
- `PYTORCH_ENABLE_MPS_FALLBACK=1` — allows unsupported MPS ops to fall back to CPU

### Forge is not reached from the browser
Forge (`127.0.0.1:7860`) and Ollama (`127.0.0.1:11434`) are **localhost-only** and
are reached **server-side** by the image service — never from the browser. There
is intentionally **no public nginx proxy** to either one.

> Security note: earlier configs exposed `/forge-api/` → Forge and `/api/ollama/`
> → Ollama publicly (no auth, no rate limit), which let anyone on the internet run
> inference / image generation on the Mac mini and enumerate models. Both proxy
> blocks were **removed**. Do **not** re-add a public proxy to Forge or Ollama.
> The browser only needs `/wheel-images/` (the image service), which is itself
> now rate-limited (`limit_req zone=ai burst=5`).

### Image fetch module
`src/fetch/image.js` — exports `fetchWheelImage(data, { force })` plus the helpers
`classifyBiome`, `buildImageFacts`, `monthlyConditions`, and `locationKey`.

- Takes `currentData` (needs `temp`, `rain`, `evi`, `lat`, `name`; `snow` optional)
- `buildImageFacts` → biome + means + hemisphere + the 12-band `monthly` array
- POSTs `{ key, facts, force }` to the **image service** at `/wheel-images/generate`
  (not Forge directly) and returns a blob URL
- The service renders **img2img** at 1024×512 over a data-driven init (see
  "Center Ecology Image — tiny planet" below); the client warps it into a planet

In local dev, set `VITE_IMAGE_URL=http://127.0.0.1:7871` in `.env.local` to hit
the image service directly (Forge itself is no longer called from the browser).
See the local-dev note under "Image service — deployment" for running dev from
another machine.

### Common issues
- **Black images:** Always run with `--no-half --no-half-vae`. Restart Forge completely (kill all python3.10 processes) when changing flags — partial restarts leave old process on port 7860.
- **Port conflict on restart:** `pkill -9 -f python3.10` then wait for `lsof -i :7860` to clear before relaunching.
- **Model download:** Use `huggingface_hub.hf_hub_download()` in the Forge venv, not `curl` — HuggingFace's XetHub CDN truncates large files with plain curl.
- **CLIP install failure (`pkg_resources`):** Pre-install from local patched source at `/tmp/clip-install` (setup.py with `pkg_resources` removed) before running `webui.sh`.

## Center Ecology Image — "tiny planet"

The center of the wheel shows an AI-generated **"little planet"** (stereographic)
view of the location's ecology, masked to a circle filling the center hole and
drawn *behind* the rings, axes, labels, and decorations. Its seasonal coloring
is driven by the location's **actual** yearly climate data, not a generic
four-season template — so a place green in its wet winter and golden in its dry
summer (e.g. Oakland) renders that way.

### Pipeline
1. `src/fetch/image.js` builds a compact **facts** payload from `currentData`:
   biome via `classifyBiome`, mean temp/rain, vegetation index, hemisphere, plus
   `monthly` — `monthlyConditions()` bins the real `temp`/`rain`/`evi`/`snow`
   arrays into **12 time-bands** (anchored at DOY 0 = winter solstice, like the
   wheel), each normalized to warmth/vegetation/wetness/snow/cold. POSTs
   `{ key, facts, force }` to `/wheel-images/generate`.
2. The **image service** (`server/image-server.mjs`, Node, zero deps) serves a
   disk-cached PNG for that key, or — on a miss / `force`:
   - asks the **LLM** (Claude by default — see "Which LLM" below) for a
     season-order-agnostic ecology prompt (terrain/plants/wildlife only — it must
     **not** name or order seasons);
   - synthesizes a **data-driven init** image with `buildSeasonalInitPNG()` (a
     pure-Node PNG encoder): a flat 1024×512 equirectangular strip whose width is
     the local year and whose colors come from the 12 bands (green where veg is
     high, golden where warm+sparse, white where cold/snowy), sky over ground;
   - runs **Forge img2img** over that init (`denoising_strength` ≈ 0.7, env
     `IMG2IMG_DENOISE`; `tiling:true` for a seamless horizontal wrap) so the
     photographic landscape honors the data-driven seasonal layout;
   - caches `<key>.png` + `<key>.txt` (prompt) + `<key>.init.png` (debug init).
   Falls back to plain `txt2img` when `facts.monthly` is absent.
3. `src/draw/centerImage.js` **stereographically warps** the flat panorama into a
   sealed little planet filling the center hole: angle→year (winter solstice seam
   at top), radius→ground(centre)…horizon…sky(rim). The warp is cached and only
   rebuilt when the image or hole radius changes.

Caching is keyed by slugified location name, so each location generates once.
The control panel has an **Ecology image** toggle and a **Generate new image**
button (forces regeneration, bypassing the cache).

### Which LLM — `server/llm.mjs`

Every LLM call the service makes — the ecology image prompt — goes through
`server/llm.mjs`, so one env var picks the engine:

| `LLM_PROVIDER` | Engine | Notes |
|---|---|---|
| `anthropic` (**default**) | Claude via `api.anthropic.com` | Model `claude-opus-5` (`ANTHROPIC_MODEL`), effort `low` (`ANTHROPIC_EFFORT`), `max_tokens` 4000 (`ANTHROPIC_MAX_TOKENS`) — a small ask, so effort is kept low. Refusals (`stop_reason: "refusal"`) are treated as failures. |
| `ollama` | local `llama3.2:3b` | The previous behavior, unchanged (`OLLAMA_URL`, `OLLAMA_MODEL`, JSON mode, `keep_alive: 0`). |

**The key is the astrology site's key, read from where nginx already keeps it** —
the chmod-600 `/opt/homebrew/etc/nginx/anthropic-key.conf`, parsed out of its
`proxy_set_header x-api-key "…"` line (override the path with
`ANTHROPIC_KEY_FILE`, or the value itself with `ANTHROPIC_API_KEY`). It is
deliberately **not** copied into the launchd plist or a second file, so rotating
stays a one-file edit; the file is re-read per call, so a rotation takes effect
without restarting the service. The service calls Anthropic **directly** — it
does not go through the public `/api/anthropic/` nginx proxy, which would add a
hop and share the browser-facing `ai` rate-limit bucket.

Anthropic is a **soft** default: with no key, or on any API failure (revoked key,
rate limit, outage), the call falls through to the local llama with a warning
rather than returning nothing — that is what keeps a dead key from breaking
image generation. Watch for `[llm] Anthropic call failed` in
`~/Library/Logs/wheel-image-server.log`; it means the intended engine is not
answering and the weaker local model is doing the work.

### Image service — deployment
- **Location on server:** `~/Sites/wheel-of-the-year/server/image-server.mjs`
- **Port:** `127.0.0.1:7871` (env `PORT`); cache dir `image-cache/` (env `IMAGE_CACHE_DIR`)
- **Upstreams:** `api.anthropic.com` (or local Ollama `127.0.0.1:11434` — see
  "Which LLM" above) and Forge `127.0.0.1:7860`.
- **launchd:** `server/com.wheel.image-server.plist` → `~/Library/LaunchAgents/`
  (RunAtLoad + KeepAlive); logs to `~/Library/Logs/wheel-image-server.log`
- **nginx:** a `/wheel-images/` location proxies to `http://127.0.0.1:7871/`
  with `proxy_read_timeout 600s` (a cold Forge boot + render can take minutes).

### On-demand Forge launch
Forge is **not** kept running — the image service launches it lazily. On a cache
miss, `ensureForge()` checks `GET /sdapi/v1/sd-models`; if Forge is down it spawns
`webui.sh` (detached, logs to `~/forge-run.log`), polls until the API responds
(up to `FORGE_BOOT_TIMEOUT`, default 360s), then renders. Concurrent requests
share a single boot. Env overrides: `FORGE_DIR`, `FORGE_LAUNCH`, `FORGE_BOOT_TIMEOUT`.
The first new-city request after idle therefore waits ~1–3 min for Forge to boot
+ load the model; cache hits and subsequent generations are fast.

### Memory: Forge and Ollama take turns (8 GB Mac mini)

> Since the LLM moved to Claude by default, this whole dance only matters on the
> `LLM_PROVIDER=ollama` path (and on the Anthropic path's local fallback). When
> Claude answers, nothing loads locally and Forge is left warm — `freeRam` is
> passed *into* `llm.mjs` and fires only when a call actually reaches Ollama.

The Mac mini has only **8 GB RAM**, so Forge (~4–6 GB with `--no-half`) and Ollama
(`llama3.2:3b`, ~2.5–3 GB) must not co-reside. Ollama runs as an always-on daemon
(`brew services start ollama` → LaunchAgent `homebrew.mxcl.ollama`, RunAtLoad +
KeepAlive), which is cheap when idle because the *model* is only resident during
inference. The image service arbitrates the RAM around that:
- **LLM unloaded immediately after prompting** — every Ollama call passes
  `keep_alive: 0`, so llama frees its model RAM before Forge loads its larger one.
- **Forge evicted before any Ollama inference** — `freeRamForOllama()` kills a warm
  Forge right before the local model is used. It is handed to `llm.mjs` as the
  `freeRam` opt by image-prompt composition and fired there, immediately before an
  Ollama request — including the fallback after an Anthropic failure, where Forge
  may still be warm. It's a no-op when Forge is down.
  Forge reboots on demand for the next image.
- **Forge shut down when idle** — after `FORGE_IDLE_TIMEOUT` (default 600s / 10 min)
  with no generations, `shutdownForge()` kills the process on the Forge port
  (`lsof -ti :PORT | xargs kill -9`), returning RAM to Ollama / the astrology site.
  A burst of city-loads reuses the warm Forge; the timer re-arms after each one.
  (Both idle teardown and pre-Ollama eviction share the `killForge()` helper.)

Net: Ollama is the always-on default; Forge is a transient guest that boots on
demand, is evicted whenever the LLM needs RAM, and also evicts itself when idle.

Local dev: set `VITE_IMAGE_URL=http://127.0.0.1:7871` in `.env.local` to hit
the service directly (it sends permissive CORS headers); otherwise the
`/wheel-images` path 404s in `npm run dev` and the image simply fails gracefully.
The service binds to **`127.0.0.1` only**, so it cannot be reached over the LAN
by hostname. When running dev on another machine, forward the port first with
`ssh -N -L 7871:127.0.0.1:7871 macmini`, then use the same URL.

### nginx location block (for reference)
```nginx
# Location cache — matched ahead of /wheel-images/ so it avoids the expensive-AI
# rate limit (it is a plain disk read/write, and a page load sends several).
location /wheel-images/climate {
    proxy_pass http://127.0.0.1:7871/climate;
    proxy_http_version 1.1;
    proxy_read_timeout 60s;
    client_max_body_size 8m;
    limit_req zone=wheelcache burst=20 nodelay;
}

location /wheel-images/ {
    proxy_pass http://127.0.0.1:7871/;
    proxy_http_version 1.1;
    proxy_read_timeout 600s;
    proxy_buffering off;
    limit_req zone=ai burst=5 nodelay;
}
```
The `wheelcache` zone is declared alongside `ai` in `nginx.conf`:
`limit_req_zone $binary_remote_addr zone=wheelcache:10m rate=600r/m;`

## Location Cache — downloaded data is kept on the Mac mini

Every location the app downloads is recorded server-side, so a city is fetched
from the upstream APIs **once** rather than once per visit. Revisiting a place
paints the stored data immediately and then tops up only what is genuinely
missing.

- **Client:** `src/data/locationCache.js` (transport + merge helpers) driven by
  `loadLocation()` in `src/main.js`.
- **Server:** `server/climate-cache.mjs`, mounted on the image service at
  `GET /climate?key=…` and `POST /climate`. Records live beside the image cache
  in `image-cache/` as `<key>.climate.json` (~35 KB each), and are keyed by the
  same slugified location name both caches use
  (`locationKey`, exported from `locationCache.js`).

The server is a **dumb store** — the browser owns all fetching. A record has two
halves, and the difference between them is the whole design:

| | stored as | refresh rule |
|---|---|---|
| `normals` | 365-point arrays, one per ring | Each comes from a **fixed historical window** (ERA5 1991–2020, MODIS EVI 2013–2022, CAMS PM2.5 2014–2023, ERA5 visibility 2010–2020), so a stored one is **never** refetched. |
| `actuals` | **date-keyed** maps, `{ '2026-08-04': 72.1 }` | Topped up incrementally: the client reads the newest stored date and asks upstream only for the days after it (less a 3-day overlap, since the tail of a reanalysis archive is provisional). |
| `baseline` | date-keyed raw MODIS composites + `eviDoneKeys` | Working state for the one stage too slow to be atomic — see below. Historical dates, so **never pruned**. |

Storing actuals by calendar date rather than day-of-year is what makes the
top-up possible — DOY collapses years together and can't tell you where you left
off. `actualsForDisplay()` converts back to the `{ doy, value }` arrays the
drawing code wants, keeping the trailing 365 days with the newest observation
winning each DOY slot.

**Day numbering: records are version 2.** A stored normals array is indexed by
DOY with 0 = the winter solstice. Version 1 records counted from Jan 1; the
service migrates them as it reads them (each array rotated so Dec 21 lands at
index 0) and the next write persists version 2. Only the 365-point normals move —
actuals and baseline are date-keyed. Because the front end and the image service
are deployed separately, two guards stop the layouts mixing mid-deploy:
every response carries `doy0: 'winter-solstice'`, and the client neither uses
stored normals nor sends its own (nor the EVI baseline, which belongs to the
sample pixel recorded among them) until a response has said so; and the service
drops 365-point arrays from any POST not marked `doy0: 'winter-solstice'`, so a
page still running an old bundle cannot write Jan-1 arrays into a migrated
record. Deploy the two in either order — the worst case in between is a cache
miss, never a record that is silently eleven days out. `DOY_ZERO` is defined in
both `server/climate-cache.mjs` and `src/data/locationCache.js`; keep them equal.

**Repairing interrupted visits.** Presence is tested field by field against
`currentData`, and each stage POSTs its own patch the moment it lands, rather
than one write at the end. So a visit abandoned mid-EVI still leaves its normals
and weather actuals on the server, and the next visit fetches only the gap. This
is also why a failed EVI fetch's **proxy fallback is deliberately not recorded** —
leaving the slot empty is what makes the next visit retry MODIS.

**EVI resumes mid-stage, because one stage is too slow to be atomic.** Per-stage
patches repair a visit at stage granularity, which is enough for every stage but
one: the EVI baseline is ~30 MODIS calls over a couple of minutes, so closing the
tab at 90% used to discard all of it. It now checkpoints *within* the stage:

- `fetchModisEVI` takes `have` / `doneKeys` and fetches only the batches missing,
  reporting progress from the banked percentage rather than 0%.
- `eviProgressRecorder` (in `locationCache.js`) POSTs every `EVI_FLUSH_EVERY`
  batches, so an abandoned visit loses at most a few calls.
- The **sample pixel is recorded before the fetch**, not after. Composites are
  only comparable within one 250 m pixel, so a resumed visit must reuse the pixel
  the first one chose — recording it up front is what makes the banked composites
  attributable. It also skips the pixel search on resume.
- `eviDoneKeys` tracks batches separately from the composites themselves, because
  a batch can legitimately return **empty** (cloud, water, masked pixels). Without
  it, such a batch would look unfetched forever.
- `fetchModisBatch` returns `null` for a *failed request* and `[]` for a valid
  empty answer. Only the empty answer is banked as done — a network blip is
  retried next visit instead of being frozen into the record as a permanent gap.
- The 365-point curve is stored as a normal **only when every batch is accounted
  for**. Nothing ever refetches a normal that exists, so storing a partial curve
  would freeze an incomplete year in place.

Net: three interrupted visits now cost about as many MODIS calls as one complete
one, and a revisit makes a single call (the composite-freshness check).

Typical effect on a revisit: the 350-day weather window becomes a ~4-day
request, MODIS drops from ~22 subset calls to at most one (composites publish
every 16 days, so it is skipped entirely until the stored one is that old), and
the ERA5 / CAMS / visibility normals calls disappear altogether.

### Keying — one record per geocoded label

The key is the slugified **geocoder label**, not the user's query, so different
spellings that resolve to the same place share a record (`Boulder` and
`Boulder, CO` both → `boulder-boulder-county`). But a **zip code and its town do
not**, because Nominatim labels them differently:

| query | label | key | coords |
|---|---|---|---|
| `80301` | 80301, Boulder County | `80301-boulder-county` | 40.0476, −105.2174 |
| `Boulder` | Boulder, Boulder County | `boulder-boulder-county` | 40.0150, −105.2705 |

This is deliberate. Those two points are ~5.8 km apart: the ERA5-derived rings
are identical (both snap to grid cell `40.03515, −105.23076`, so that part *is* a
redundant download), but **MODIS EVI genuinely differs** — 250 m pixels, and the
app picks a best-contrast pixel per location. EVI is also nearly all of the cold-
load time, so merging them would save bandwidth but little else. Aliases each
keep their own record.

**Collision guard.** Because the key is only the first two comma-components of
the label, two genuinely different places can produce the same one
(`Main Street, Springfield` exists in more than one state). `loadLocation()`
therefore checks the record's stored coordinates against the point just geocoded
(`isSamePlace`, 25 km tolerance). On a mismatch it does **not** reuse or
overwrite — it re-reads under a coordinate-suffixed key
(`…-4001_-10527`, via `coordSuffix`) so both places keep working. A record with
no stored coordinates predates the check and is trusted.

Presets are the one exception: `loadLocation(..., { skipNormals: true })`, since
their normals ship in the bundle. Only their actuals come from and go to the
cache — bundled normals are never uploaded, which keeps an incomplete preset
(Oakland has no `snow`/`cloud`) from masking what a live fetch would supply.

Local dev: without `VITE_IMAGE_URL` set, every cache call fails softly and the
app refetches everything exactly as it did before the cache existed.

## Persisted UI preferences — the wheel reopens as you left it

`src/data/prefs.js` keeps every control-panel choice **and the location last
loaded** in localStorage (`wheel-of-the-year:prefs:v1`), so a return visit opens
on the same city with the same rings, colors, order, and toggles. This is
per-browser and unrelated to the server-side location cache above, which stores
*data* rather than *choices*.

- **Reading:** `applySavedPrefs()` runs in `init()` **before**
  `buildRingControls()` — the panel renders from `ringState` / `displayState`
  once and never re-reads them, so anything applied afterwards would not show up
  in the controls. It returns the saved location for `init()` to reopen.
- **Writing:** `savePrefs()` is called from each mutation handler in
  `ui/controls.js` (and `setLastLocation()` from `main.js`). It is throttled by
  `SAVE_DEBOUNCE_MS` so a slider drag writes a few times rather than per step,
  with a `pagehide` flush so a change made in the last moment still lands.

**Only *changed* values are stored.** Each ring is diffed against
`defaultRingState(r)` and the toggles against `DISPLAY_DEFAULTS` (both exported
from `state.js`). That is deliberate: a stored full snapshot would freeze today's
defaults into every existing browser, so changing a ring's default color or
`defaultVisible` in `ringDefs.js` would silently reach nobody who had ever
loaded the site. Keep the two default sources authoritative — never inline a
copy of them in `prefs.js`.

**Order restore tolerates a changed ring list.** `restoreOrder()` drops ids this
build no longer has and **appends any ring the stored order predates** —
otherwise a newly added ring would be missing from both the wheel and the
control panel for every returning visitor. `applyUrlParams()` uses the same
helper, for the same reason.

### Precedence: defaults → saved prefs → `?s=` link

A shared link wins over saved prefs, so it always shows what it encodes. It is
also **not written back**: `fetchCity({ remember: false })` on that path skips
`setLastLocation`, so opening someone else's wheel does not replace your own
default city. (The first control the visitor then touches saves the state they
are looking at, as usual — that is a real user choice.)

The saved location is stored **resolved** — `{ name, lat, lon }` for a fetched
city, `{ preset: label }` for a built-in — so restoring one skips the Nominatim
round-trip entirely and goes straight to the location cache.

## No Tests

There is no test suite. The project has no test runner, no test files, and no CI pipeline. When making changes:
- Test visually in the browser with `npm run dev`
- Verify both the Oakland preset (`loadPreset`) and a live city fetch (`fetchCity`) render correctly
- Check mobile layout at `<820px` viewport width
- After touching `src/data/seasons.js`, run `npm run seasons-report` — the one
  scripted check in the repo — and read every location it says moved
- Export the wheel SVG and open it — **the export is a second renderer**, and
  several bugs (the dash leak, the missing viewBox, collapsed letterspacing) show
  up only there, never on the canvas
- Print a poster and check it at both a small and a large stock, with rings
  toggled on and off: the key's column packing and the wheel's size both depend
  on how much there is to print

## Common Pitfalls

- **DOY vs month index**: DOY 0 is Dec 21, not Jan 1 — Jan 1 is DOY 11. Convert through `src/data/calendar.js`, never by summing month lengths in place
- **Feb 29**: All code skips leap-day; ensure any new date-math is consistent
- **MODIS latency**: Fetching NDVI for a *new* city takes 30–60 seconds due to 16-day batch requests; do not assume it's fast. A city already in the location cache skips it.
- **Actuals are date-keyed, not DOY-keyed**: the cache stores `'YYYY-MM-DD' → value`. Collapsing to DOY before storage destroys the information the incremental top-up needs. Convert to DOY only at draw time (`actualsForDisplay`).
- **Canvas size**: The canvas is resized on window resize; always re-draw after resize events
- **`ctx.save/restore`**: Forgetting these causes accumulated transform/style state bugs across draws

## File Editing Guide

| Task | Files to touch |
|------|---------------|
| Add a new data ring | `ringDefs.js`, `controls.js` (legend), `fetch/climate.js` or new fetch module, `state.js` |
| Change how seasons are found, counted or named | `src/data/seasons.js` (`SEASON_AXES` gates and vocabulary, `MIN_GAIN`, `RATE_WEIGHT`, `MERGE_DISTANCE`, `NEAR_MISS`, `QUARTET_*`, `nameFromSignature`) — then `npm run seasons-report` |
| Change how the seasons band looks | `src/draw/seasons.js` |
| Change the seasons modal | `src/ui/seasonsChart.js`; what it plots comes from `seasons.axes[].series` and `datesFrom` in `computeSeasons` |
| Add a chart modal | `openChartModal` in `src/ui/ringChart.js` for the shell, `src/ui/yearAxis.js` for the solstice-to-solstice axis |
| Add an optional normal (its own API) | new module in `src/fetch/`, a stage in `loadLocation()`, `NORMAL_SERIES`/`ACTUAL_SERIES` in **both** `locationCache.js` and `climate-cache.mjs` |
| Change color scheme | `styles.css` (custom properties) and `ringDefs.js` (default colors) |
| Add a new decoration | `draw/decorations.js`, then call it from `paintWheel()` in `draw/wheel.js` — place anything dated through `src/data/calendar.js` |
| Change how dates map onto the wheel | `src/data/calendar.js` only; if stored arrays must move, bump `VERSION` and migrate in `server/climate-cache.mjs`, and rotate `src/data/presets.js` and `scripts/fixtures/season-climates.json` |
| Move a ring or annotation band | `R` in `draw/theme.js` — check its neighbours in the same table |
| Change the ring palette or ink | `draw/ringDefs.js` (rings) and `INK` in `draw/theme.js` (everything else) |
| Change the poster layout, key, or stock sizes | `src/print/poster.js` (`paintPoster`, `keyBlocks`, `POSTER_SIZES`) |
| Change what the centre cartouche shows | `drawCenter()` in `draw/decorations.js` and `yearSummary()` in `data/summary.js` |
| Adjust normalization ranges | `ringDefs.js` (`lo`/`hi` fields) |
| Update Oakland preset data | `npm run generate-presets` |
| Add a new preset city | `src/data/presets.js` and preset button in `index.html` or `main.js` |
| Change tooltip content | `ui/tooltip.js` |
| Change image generation prompts / biome logic | `server/image-server.mjs` (`composePrompt`, `PANORAMA_PREFIX`); biome in `fetch/image.js` |
| Switch the LLM, its model, or where the key comes from | `server/llm.mjs` (env `LLM_PROVIDER`, `ANTHROPIC_*`, `OLLAMA_*`) |
| Change the data→color seasonal mapping | `fetch/image.js` (`monthlyConditions`) and `server/image-server.mjs` (`groundColor`, `buildSeasonalInitPNG`) |
| Change image size / sampler / denoise | `server/image-server.mjs` (`forgeImg2img`, `IMG2IMG_DENOISE`) |
| Change the little-planet warp | `src/draw/centerImage.js` (`buildLittlePlanet`) |
| Change what gets cached per location | `src/data/locationCache.js` (`NORMAL_SERIES`, `ACTUAL_SERIES`) **and** `server/climate-cache.mjs` (the same two lists, plus `BASELINE_SERIES` / `BASELINE_KEYLISTS`) |
| Change how often EVI progress is checkpointed | `EVI_FLUSH_EVERY` in `src/data/locationCache.js` |
| Change the cache top-up / retention windows | `src/fetch/actuals.js` (`WINDOW_DAYS`, `OVERLAP_DAYS`), `server/climate-cache.mjs` (`RETAIN_DAYS`), `locationCache.js` (`DISPLAY_DAYS`) |
| Add a stage to the location load | `loadLocation()` in `src/main.js` — paint it, then `record()` its own patch |
| Change what UI state persists across visits | `RING_FIELDS` in `src/data/prefs.js`, and the matching default in `defaultRingState()` / `DISPLAY_DEFAULTS` (`src/state.js`) |
| Add a control that must persist | call `savePrefs()` from its handler in `src/ui/controls.js` |
