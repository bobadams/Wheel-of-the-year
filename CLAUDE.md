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
    │   ├── actuals.js            # Fetch past ~185 days of real observations
    │   └── image.js              # Generate AI landscape image via Forge API
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

## Server & Deployment

### Infrastructure
- **Server:** Mac mini, accessed via `ssh macmini`
- **Domain:** `slamad.ong` (Cloudflare-managed)
- **Web server:** nginx on port 8080 (`/opt/homebrew/etc/nginx/servers/daily-astrology.conf`)
- **Tunnel:** Named Cloudflare Tunnel `macmini` (UUID `218c4c03-1ae4-44d9-80d1-3ac64888e7de`), managed by launchd, runs `cloudflared tunnel run macmini`
- **Project location on server:** `~/Sites/wheel-of-the-year/`
- **Git remote:** `git@github.com:bobadams/wheel-of-the-year.git`

### Live URLs
- `https://slamad.ong/wheel/` — Wheel of the Year (this app)
- `https://slamad.ong/astrology/` — Daily Astrology (sibling app)
- `https://slamad.ong` — redirects to `/astrology/`

### Vite base path
`vite.config.js` sets `base: '/wheel/'` so all assets are served from the correct subpath. Do not change this without updating the nginx config to match.

### Deploying updates
```bash
# 1. Push changes to GitHub locally
git push

# 2. Pull and rebuild on the Mac mini
ssh macmini "export PATH=/opt/homebrew/bin:\$PATH && cd ~/Sites/wheel-of-the-year && git pull && npm run build"
```
nginx serves the built `dist/` directory directly — no process restart needed after a rebuild.

### nginx location block (for reference)
```nginx
location /wheel/ {
    alias /Users/bradfordadams/Sites/wheel-of-the-year/dist/;
    try_files $uri $uri/ /wheel/index.html;
}
```

### Restarting the tunnel
If the tunnel goes down:
```bash
ssh macmini "launchctl unload ~/Library/LaunchAgents/com.cloudflared.astrology.plist && launchctl load ~/Library/LaunchAgents/com.cloudflared.astrology.plist"
```
Use `unload`/`load` — not `stop`/`start` — to ensure the plist is re-read.

Check tunnel status:
```bash
ssh macmini "export PATH=/opt/homebrew/bin:\$PATH && cloudflared tunnel info macmini"
```

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

## AI Image Generation

Landscape images are generated locally using **Stable Diffusion Forge** on the Mac mini server.

### Setup
- **Install location:** `~/stable-diffusion-webui-forge/` on the Mac mini
- **Model:** Realistic Vision V5.1 fp16 at `~/stable-diffusion-webui-forge/models/Stable-diffusion/Realistic_Vision_V5.1_fp16.safetensors`
- **Model source:** `SG161222/Realistic_Vision_V5.1_noVAE` on HuggingFace (downloaded via `huggingface_hub`)
- **Forge version:** f2.0.1v1.10.1-previous (commit `dfdcbab6`)

### Running Forge
```bash
ssh macmini "export PATH=/opt/homebrew/bin:\$PATH && nohup bash -c 'cd ~/stable-diffusion-webui-forge && bash webui.sh' > ~/forge-run.log 2>&1 &"
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

### nginx proxy
`/forge-api/` on the server proxies to `http://localhost:7860/`. This is how the deployed web app at `slamad.ong/wheel/` reaches Forge:

```nginx
location /forge-api/ {
    proxy_pass http://127.0.0.1:7860/;
    proxy_http_version 1.1;
    proxy_set_header Host localhost;
    proxy_read_timeout 300s;
    proxy_buffering off;
}
```

### Image fetch module
`src/fetch/image.js` — exports `fetchWheelImage(data, { force })` plus the helpers
`classifyBiome`, `buildImageFacts`, `monthlyConditions`, and `locationKey`.

- Takes `currentData` (needs `temp`, `rain`, `evi`, `lat`, `name`; `snow` optional)
- `buildImageFacts` → biome + means + hemisphere + the 12-band `monthly` array
- POSTs `{ key, facts, force }` to the **image service** at `/wheel-images/generate`
  (not Forge directly) and returns a blob URL
- The service renders **img2img** at 1024×512 over a data-driven init (see
  "Center Ecology Image — tiny planet" below); the client warps it into a planet

In local dev, set `VITE_IMAGE_URL=http://macmini.local:7871` in `.env.local` to hit
the image service directly (Forge itself is no longer called from the browser).

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
   - asks **Ollama** (`llama3.2:3b`) for a season-order-agnostic ecology prompt
     (terrain/plants/wildlife only — it must **not** name or order seasons);
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

### Image service — deployment
- **Location on server:** `~/Sites/wheel-of-the-year/server/image-server.mjs`
- **Port:** `127.0.0.1:7871` (env `PORT`); cache dir `image-cache/` (env `IMAGE_CACHE_DIR`)
- **Upstreams:** Ollama `127.0.0.1:11434`, Forge `127.0.0.1:7860` (both local)
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
The Mac mini has only **8 GB RAM**, so Forge (~4–6 GB with `--no-half`) and Ollama
(`llama3.2:3b`, ~2.5–3 GB) must not co-reside. The image service enforces this:
- **LLM unloaded immediately after prompting** — the Ollama call passes
  `keep_alive: 0`, so llama frees its RAM before Forge loads its larger model.
- **Forge shut down when idle** — after `FORGE_IDLE_TIMEOUT` (default 600s / 10 min)
  with no generations, `shutdownForge()` kills the process on the Forge port
  (`lsof -ti :PORT | xargs kill -9`), returning RAM to Ollama / the astrology site.
  A burst of city-loads reuses the warm Forge; the timer re-arms after each one.

Net: Ollama is the always-available default; Forge is a transient guest that
boots on demand, frees Ollama's RAM while rendering, and evicts itself when done.

Local dev: set `VITE_IMAGE_URL=http://macmini.local:7871` in `.env.local` to hit
the service directly (it sends permissive CORS headers); otherwise the
`/wheel-images` path 404s in `npm run dev` and the image simply fails gracefully.

### nginx location block (for reference)
```nginx
location /wheel-images/ {
    proxy_pass http://127.0.0.1:7871/;
    proxy_http_version 1.1;
    proxy_read_timeout 300s;
    proxy_buffering off;
}
```

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
| Change image generation prompts / biome logic | `server/image-server.mjs` (`composePrompt`, `PANORAMA_PREFIX`); biome in `fetch/image.js` |
| Change the data→color seasonal mapping | `fetch/image.js` (`monthlyConditions`) and `server/image-server.mjs` (`groundColor`, `buildSeasonalInitPNG`) |
| Change image size / sampler / denoise | `server/image-server.mjs` (`forgeImg2img`, `IMG2IMG_DENOISE`) |
| Change the little-planet warp | `src/draw/centerImage.js` (`buildLittlePlanet`) |
