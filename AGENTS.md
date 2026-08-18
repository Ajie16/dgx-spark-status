# DGX Spark Status — Agent Guide

## Project Overview

`dgx-spark-status` is a real-time system monitoring dashboard for the NVIDIA DGX Spark (GB10). It streams CPU, memory, GPU, disk, network, process, and inference-engine metrics to an Apple-style Svelte UI using Server-Sent Events (SSE). The UI supports both dark and light themes with a glassmorphism card design.

The project also tracks local inference engines:

- **llama.cpp** server on `127.0.0.1:8001` (proxied on `8000`)
- **vLLM** containers (name filter `vllm`)
- **Ollama** on `localhost:11434`

The dashboard is intended to run on the DGX Spark host itself (Ubuntu 24.04 ARM64) and binds to `0.0.0.0:9000`.

## Technology Stack

- **SvelteKit 2** with `@sveltejs/adapter-node` (SSR / production adapter)
- **Svelte 5** using runes (`$state`, reactive statements)
- **Vite 7** (build tool and dev middleware)
- **Express 5** (custom dev server and production wrapper)
- **systeminformation** (CPU/memory/disk/network/uptime metrics)
- **nvidia-smi** (GPU metrics — shell subprocess)
- **Server-Sent Events** (`EventSource` on the client; `text/event-stream` on the server)

Runtime dependencies: `express`, `systeminformation`, `ws`.
Dev dependencies: SvelteKit/Vite/Svelte toolchain.

> Note: `ws` is declared as a dependency but is not used by the current source code.

## Key Configuration Files

| File | Purpose |
|------|---------|
| `package.json` | ESM package (`"type": "module"`), scripts, dependencies, version `0.0.0`. |
| `vite.config.js` | SvelteKit Vite plugin; dev server `host: '0.0.0.0'`, `port: 9000`, `strictPort: true`; HMR overlay disabled; `optimizeDeps.exclude: ['systeminformation']`. |
| `svelte.config.js` | Uses `@sveltejs/adapter-node` and `vitePreprocess()`. |
| `jsconfig.json` | Extends `./.svelte-kit/tsconfig.json`, `checkJs: true`, `strict: false`. |
| `.gitignore` | Excludes `node_modules`, `build`, `.svelte-kit`, `.output`, `.env`, state files (`model-notes.json`, `metrics-history.json*`, `service-health.json`, `system-events.json`, `.clean-shutdown`), `.claude`, editor files. |
| `.vscode/extensions.json` | Recommends `svelte.svelte-vscode`. |

## Code Organization

```text
src/
├── routes/
│   ├── +page.svelte              # Root dashboard page — renders SystemMetrics
│   ├── +layout.svelte            # Global layout, imports app.css
│   └── api/
│       ├── metrics/+server.js    # SvelteKit SSE metrics endpoint
│       └── ollama/+server.js     # Ollama pull/delete/load/unload API
├── lib/
│   ├── SystemMetrics.svelte      # Main dashboard UI and state
│   ├── Gauge.svelte              # Circular gauge component
│   ├── websocket.js              # EventSource/SSE client manager
│   └── Counter.svelte            # Leftover Vite+Svelte demo component (unused)
├── app.html                      # SvelteKit HTML template
├── app.css                       # Global dark theme styles
├── main.js                       # Leftover Vite+Svelte boot file (unused)
├── App.svelte                    # Leftover Vite+Svelte demo app (unused)
└── hooks.server.js               # Legacy SSE metrics helper + pass-through handle

dev-server.js                     # Development server: Express + Vite middleware mode
server.js                         # Production server: Express + adapter-node build/handler.js
start.sh                          # Tmux wrapper that runs `npm run dev`
```

### Important distinctions

- **`src/routes/api/metrics/+server.js`** is the endpoint used by the **production build** (`npm run build` / `server.js`). It does **not** include Ollama data or `modelNotes`.
- **`dev-server.js`** registers its own richer `/api/metrics` endpoint that includes Ollama status and injects `modelNotes`. It also adds `/api/notes` for editing per-model notes. This is the endpoint used during `npm run dev`.
- **`src/hooks.server.js`** exports `getMetricsSSE` but is **not wired to any route**; only the `handle` hook is used, and it simply calls `resolve(event)`.
- **`index.html`, `src/main.js`, `src/App.svelte`, `src/lib/Counter.svelte`** are leftover files from the original Vite+Svelte scaffold and are **not used** by the SvelteKit application.

## Build & Run Commands

```bash
# Install dependencies
npm install

# Development server — uses dev-server.js on port 9000
npm run dev

# Production build — outputs to build/ and .svelte-kit/output/
npm run build

# Preview the production build with Vite
npm run preview

# Production server — uses server.js + build/handler.js
npm start
# or
node server.js

# Tmux convenience wrapper for development
./start.sh
```

### Environment Requirements

- Node.js v25+ is recommended in `README.md`; the build and dev server also run on Node v24.19.0 with warnings.
- Linux (tested on Ubuntu 24.04 ARM64 / DGX Spark GB10).
- NVIDIA GPU with `nvidia-smi` available on `PATH`.
- Optional services for full functionality:
  - Ollama on `localhost:11434`
  - Docker + vLLM containers named `vllm`
  - llama.cpp server on `127.0.0.1:8001` / proxy on `8000`
  - `/usr/local/bin/switch-model.sh` for llama.cpp model inventory

## Runtime Architecture

### Development (`npm run dev`)

1. `dev-server.js` creates an Express app.
2. It registers `/api/metrics` with its own SSE handler.
3. It registers `/api/notes` (GET/POST) backed by `model-notes.json` in the project root (gitignored).
4. It registers `/api/history` (GET) returning up to 24h of metrics history by default; `?hours=N` (1–168) requests a different window.
5. It mounts the Vite dev middleware (`middlewareMode: true`) so SvelteKit page routes and HMR work.
6. SvelteKit routes such as `/api/ollama` are also reachable through Vite middleware, but `/api/metrics` is intercepted first by Express.
7. An always-on sampling loop (`tick`, 5s interval) collects metrics **regardless of connected clients**: it records 7-day history (5s samples kept 10 min in memory, then 1-min aggregates appended to `metrics-history.jsonl` — append-only, ~150 KB/day of writes), tracks inference-engine availability (up/down transitions, outage counts, persisted to `service-health.json` every 5 min), and broadcasts to SSE clients when any are connected. Ticks never overlap (a new tick is skipped while the previous one runs), the expensive model-inventory scan (`du -sb` over large model dirs) is cached and refreshed in the background every 10 min instead of blocking each sample, vLLM model endpoints are probed in parallel, and the first SSE message for a client waits on the in-flight boot sample rather than triggering a duplicate collection.
8. **System events** (`system-events.json`, last 200): `boot` on every service start, `unclean_shutdown` when the clean-shutdown marker (`.clean-shutdown`, written on SIGTERM/SIGINT) is missing at startup (i.e. crash / power loss / OOM kill), `throttle_start`/`throttle_end` on GPU throttling transitions, and `fan_on`/`fan_off`/`fan_error` when the bedroom 散热风扇 is switched. Throttle transitions are only recorded after 5s of stable state (anti-flap), and the events file is flushed at most once per 30s (plus on shutdown) rather than on every event. The last 20 events are included in the SSE payload (`metrics.events`) and shown in the Events card.
8b. **Cooling fan** (米家 mesh 通断器 via `~/.grok/skills/ha-mijia/scripts/ha.py`): ON if GPU≥65°C / CPU≥70°C / NVMe≥70°C / GPU power≥28W / thermal warning; OFF if GPU≤52°C and CPU≤62°C and NVMe≤58°C. Missing GPU temp does not turn the fan off. Confirm 3 ticks (~15s) + 5 min min-on / 3 min min-off. Mode `auto|on|off` persisted in `fan-control.json` (gitignored). Disable with `FAN_CONTROL=0`. State is on the SSE payload as `metrics.fan` and stored in history (`fan` 0/1) so the temperature chart can overlay on/off bands.
9. GPU metrics include current clocks (`clocks.current.graphics` / `clocks.current.sm`), the configured boost cap (`clockLimitMax`, from the `GPU_CLOCK_LOCK` env var set by the systemd unit — nvidia-smi cannot query the applied `-lgc` lock, so the dashboard trusts the unit's value), and clock throttle/event reasons (`clocks_event_reasons.active` bitmask decoded into `gpu[].throttleReasons` with `warnings` vs `active`). `SW Power Cap` is treated as informational on GB10 (the bit flips in bursts even at idle), so only thermal slowdown / HW power brake / HW slowdown render as red `⚠` warnings; other bits render as muted text. Displayed indicators are stabilized: warnings held 10s, info bits latched 5 min, so the card doesn't flash between samples. Disk I/O rates come from `/proc/diskstats` deltas and NVMe temperature from `/sys/class/hwmon` (`metrics.diskIO`); SMART is not used because `smartctl` requires root.
10. The power/temperature charts position points by their **real timestamps** on the x-axis (5s live samples and 1-min aggregates mix without distorting the axis; null values break the line). A segmented 10m/1h/6h/24h control below the charts switches the window (defaults to 10m); the client keeps 24h of 1-min server aggregates plus 10 min of live 5s samples and re-fetches `/api/history?hours=24` every minute.

### Production (`npm run build` then `node server.js`)

1. Vite + adapter-node builds the SvelteKit app into `build/` (including `build/handler.js`).
2. `server.js` creates an Express app and mounts `handler` from `build/handler.js`.
3. The SvelteKit handler serves the UI and the endpoints defined in `src/routes/api/**/+server.js`.
4. There is **no** Express-level `/api/notes` endpoint and no custom SSE middleware in `server.js`.

## API Endpoints

| Endpoint | Dev | Prod | Description |
|----------|-----|------|-------------|
| `GET /api/metrics` | ✅ (rich, includes Ollama + notes) | ✅ (basic, no Ollama/notes) | SSE stream of system metrics (5s interval) |
| `POST /api/ollama` | ✅ | ✅ | `action`: `pull`, `delete`, `load`, `unload`; `model`: model name |
| `GET/POST /api/notes` | ✅ | ❌ | Per-model notes stored in `model-notes.json` (project root) |
| `GET /api/history` | ✅ | ❌ | Metrics history: `{ agg, raw }` — 1-min aggregates for `?hours=N` (default 24, max 168) + 5s samples (last 10 min) |
| `GET/POST /api/fan` | ✅ | ❌ | Room fan: GET status; POST `{ "mode": "auto"|"on"|"off" }` |
| `GET/POST /api/comfyui` | ✅ | ❌ | ComfyUI process: GET status; POST `{ "action": "start"|"stop" }` launches `~/workspace/ComfyUI/.venv/bin/python main.py --listen 0.0.0.0` |

## Code Style & Conventions

- ESM throughout (`"type": "module"`); no CommonJS.
- Svelte 5 runes syntax in new components (e.g., `$state` in `SystemMetrics.svelte`, `Counter.svelte`).
- Legacy Svelte 4 `$:` reactive statements still appear in `Gauge.svelte`.
- Server-side code is plain JS; `jsconfig.json` enables `checkJs` but not strict mode.
- Shell commands are invoked with `child_process.exec` and string interpolation; no prepared-statement-style escaping.
- Color palette: Apple-inspired system colors — green (`#30d158`), blue (`#0a84ff`), orange (`#ff9f0a`), purple (`#bf5af2`), cyan (`#64d2ff`), red (`#ff453a`), yellow (`#ffd60a`). Dark theme uses `#000` background with `rgba(255,255,255,0.06)` cards; light theme uses `#f5f5f7` background with `rgba(255,255,255,0.72)` cards.

## Testing

There are **no automated tests** in this repository. There is no `test` script in `package.json` and no test framework dependency.

Manual verification:

```bash
# Dev server SSE
npm run dev
curl -N http://localhost:9000/api/metrics

# Ollama endpoint
curl -X POST http://localhost:9000/api/ollama \
  -H 'Content-Type: application/json' \
  -d '{"action":"load","model":"llama3.2"}'

# Production build/start
npm run build
node server.js
```

## Deployment

The repository ships a systemd unit named `dgx-spark-status.service` that runs `node dev-server.js` (port 9000) as user `xujie`. It is deliberately **not** named `dgx-dashboard.service`: that unit name is already taken on DGX Spark hosts by NVIDIA's preinstalled "DGX Dashboard Service" (port 11000). `start.sh` (tmux + `npm run dev`) remains an equivalent launcher. Only one instance may run at a time — dev-server binds port 9000 with `strictPort: true`, so a second instance crash-loops.

Typical deployment steps:

```bash
npm ci
npm run build
node server.js
```

For a persistent service, install the bundled unit:

```bash
sudo cp dgx-spark-status.service /etc/systemd/system/dgx-spark-status.service
sudo systemctl daemon-reload
sudo systemctl enable --now dgx-spark-status
```

## Security Considerations

- **No authentication/authorization** — the dashboard and all API endpoints are publicly reachable on `0.0.0.0:9000` once started.
- **Shell injection surface** — server code constructs shell commands with unsanitized paths and model names:
  - `ollama pull ${model}` / `ollama rm ${model}` in `/api/ollama`
  - `du -sb "${target}"` and `ls -d` commands driven by filesystem scans
  - `docker inspect ${names}` built from container names
  Avoid exposing the service to untrusted networks.
- **No HTTPS/TLS** in the provided server scripts.
- **CORS wildcard** — the SSE endpoint sets `Access-Control-Allow-Origin: *`.
- **State files in project root** — `dev-server.js` reads/writes `model-notes.json`, `metrics-history.jsonl`, `service-health.json`, `system-events.json`, and `.clean-shutdown` next to itself (all gitignored). They contain system metrics, event history, and service uptime data; review before sharing the directory.
- **Input validation is minimal** — the Ollama endpoint checks only the `action` value; the `model` value is passed through to shell or HTTP bodies with limited sanitization.

## Known Issues & Gotchas

1. **Production `/api/metrics` is incomplete vs. dev**
   The SvelteKit route `src/routes/api/metrics/+server.js` does not collect Ollama data, `modelNotes`, `diskIO`, throttle reasons, or service health, and there is no production `/api/history`. The UI (`SystemMetrics.svelte`) reads all of these, so those features silently fail in production.

2. **Production SSE crash on client disconnect**
   When a client disconnects from the production `/api/metrics` stream, the interval continues to call `controller.enqueue()` on a closed `ReadableStream` controller, causing `TypeError [ERR_INVALID_STATE]: Invalid state: Controller is already closed` and crashing `server.js`.

3. **`/api/notes` is dev-only**
   Only `dev-server.js` implements this endpoint. The production server (`server.js`) has no equivalent route, so model note persistence does not work after `npm run build`.

4. **Unused Vite+Svelte scaffolding**
   `index.html`, `src/main.js`, `src/App.svelte`, and `src/lib/Counter.svelte` can be removed without affecting the SvelteKit app.

5. **Unused `src/hooks.server.js` SSE helper**
   The `getMetricsSSE` function in `src/hooks.server.js` is not imported by any route. The active metrics endpoint is in `src/routes/api/metrics/+server.js` (production) or `dev-server.js` (development).

6. **Svelte a11y warnings**
   `SystemMetrics.svelte` uses clickable `<div>` elements for note editing, which triggers Svelte accessibility warnings during build. These are warnings, not errors.

7. **`ws` dependency unused**
   `ws` is listed in `package.json` dependencies but is not imported anywhere.

## Verification Notes

- `npm install` completed successfully.
- `npm run build` completed successfully on Node v24.19.0, producing `build/handler.js` and `.svelte-kit/output/`.
- `npm run dev` served the dashboard and streamed metrics correctly.
- `node server.js` started and served `/api/metrics`, but crashed when the SSE client disconnected (see known issue #2).
- UI redesigned with Apple-style glassmorphism cards, larger typography, per-core CPU bars, and ComfyUI process highlighting. Theme toggle persists preference to `localStorage` under key `dgx-theme`.
- Aug 2026 visual refresh: deep-space design tokens live in `app.css` (dark `#07080d` / light `#f4f5f8`, layered shadows, 8pt-inspired spacing), while `SystemMetrics.svelte` carries component-level overrides (glass cards with hover lift, staggered entrance animation, skeleton shimmer loading, refined segmented range control). The older component CSS remains as a fallback layer below the overrides.
- CPU temperature is collected via `systeminformation.cpuTemperature()` and displayed alongside core/thread counts. GPU temperature and power draw are shown on the GPU card.
- Favicon is an SVG gauge icon at `static/favicon.svg`, referenced in `src/app.html`.
