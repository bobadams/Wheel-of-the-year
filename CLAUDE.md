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
│   └── generate-preset-oakland.js  # Regenerates Oakland preset from live APIs
└── src/
    ├── main.js                   # App entry: drawing loop, fetch, export, events
    ├── state.js                  # Centralized mutable state
    ├── styles.css                # All styling (CSS custom properties, responsive)
    ├── data/
    │   ├── ringDefs.js           # 5 ring definitions (type, color, range, labels)
    │   └── presets.js            # Built-in Oakland, CA preset (365-point arrays)
    ├── draw/
    │   ├── canvas.js             # Math helpers: doy2angle, polar, norm
    │   ├── ring.js               # Draw concentric ring arcs (one arc per day)
    │   ├── layout.js             # Compute inner radius + thickness per visible ring
    │   ├── decorations.js        # Moon phases, solstice/equinox axes, ticks, center text
    │   ├── labels.js             # Min/max markers and value labels
    │   └── actuals.js            # "Actuals" overlay: smoothed line + today dot
    ├── fetch/
    │   ├── climate.js            # Geocode city → fetch ERA5 30-yr normals → 365-day arrays
    │   ├── ndvi.js               # Fetch MODIS 16-day NDVI composites → smooth → 365-day array
    │   └── actuals.js            # Fetch past ~185 days of real observations
    └── ui/
        ├── controls.js           # Ring control panel: toggle, color, thickness, opacity, drag-reorder
        ├── legend.js             # Legend items for visible rings
        ├── status.js             # Status messages (ok / loading / error) and spinner
        └── tooltip.js            # Mouse-hover tooltip showing daily values per ring
```

## Development Workflows

### Local development
```bash
npm run dev           # Vite dev server with hot reload
npm run build         # Production build → dist/
npm run preview       # Preview production build locally
npm run generate-presets  # Regenerate Oakland preset from live APIs (Node.js)
```

### Regenerating preset data
`scripts/generate-preset-oakland.js` fetches live ERA5 and MODIS data and overwrites `src/data/presets.js`. Run only when upstream data changes are needed; the file is committed.

## Key Conventions

### Day-of-Year (DOY)
- DOY is **0-indexed, 0–364** (365-day year, Feb 29 excluded)
- All data arrays are length 365
- `doy2angle(doy)` maps DOY to radians, with DOY 0 at the **winter solstice** (top of wheel)

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

### Ring definitions (`src/data/ringDefs.js`)
Each ring has: `id`, `label`, `key` (property name in data), `unit`, `color`, `lo`/`hi` normalization range, `minWord`/`maxWord` label text.

The 5 rings: `temperature`, `rainfall`, `daylight`, `ndvi`, `wind`.

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

MODIS requests are batched per 16-day interval; `setNdviProgress()` updates a progress bar during fetch.

## No Tests

There is no test suite. The project has no test runner, no test files, and no CI pipeline. When making changes:
- Test visually in the browser with `npm run dev`
- Verify both the Oakland preset (`loadPreset`) and a live city fetch (`fetchCity`) render correctly
- Check mobile layout at `<820px` viewport width
- Export PNG (`exportPNG`) and verify the output

## Common Pitfalls

- **DOY vs month index**: DOY is 0-indexed and 0 = winter solstice day; don't confuse with calendar month arrays
- **Feb 29**: All code skips leap-day; ensure any new date-math is consistent
- **MODIS latency**: Fetching NDVI for a new city takes 30–60 seconds due to 16-day batch requests; do not assume it's fast
- **Canvas size**: The canvas is resized on window resize; always re-draw after resize events
- **`ctx.save/restore`**: Forgetting these causes accumulated transform/style state bugs across draws

## File Editing Guide

| Task | Files to touch |
|------|---------------|
| Add a new data ring | `ringDefs.js`, `controls.js` (legend), `fetch/climate.js` or new fetch module, `state.js` |
| Change color scheme | `styles.css` (custom properties) and `ringDefs.js` (default colors) |
| Add a new decoration | `draw/decorations.js` and call it in `main.js` draw loop |
| Adjust normalization ranges | `ringDefs.js` (`lo`/`hi` fields) |
| Update Oakland preset data | `npm run generate-presets` |
| Add a new preset city | `src/data/presets.js` and preset button in `index.html` or `main.js` |
| Change tooltip content | `ui/tooltip.js` |
