import { createServer } from 'vite';
import si from 'systeminformation';
import express from 'express';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, unlinkSync, openSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const execAsync = promisify(exec);
const UPDATE_INTERVAL = 5000; // refresh cadence for sampling + SSE broadcast
const LLAMA_SERVER = 'http://127.0.0.1:8001';

// Model notes — user-editable, stored in JSON file
const NOTES_FILE = join(__dirname, 'model-notes.json');

function loadNotes() {
  try {
    if (existsSync(NOTES_FILE)) return JSON.parse(readFileSync(NOTES_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function saveNotes(notes) {
  writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2), 'utf8');
}

// ── Metrics history (7 days, append-only JSONL) ───────────────────────
// 5-second samples kept in memory for 10 minutes (raw, not persisted),
// then downsampled to 1-minute averages appended one line at a time to
// metrics-history.jsonl (~150 KB/day of writes). File is trimmed to
// AGG_MAX lines at startup and compacted periodically.
const HISTORY_FILE = join(__dirname, 'metrics-history.jsonl');
const RAW_MAX_AGE = 10 * 60 * 1000; // 10 min of 5s points
const AGG_MAX = 7 * 24 * 60;        // 7 days of 1-min points

let historyRaw = [];
let historyAgg = [];
let minuteBucket = null;
let appendedSinceCompact = 0;

function compactHistoryFile() {
  try {
    writeFileSync(HISTORY_FILE, historyAgg.map(p => JSON.stringify(p)).join('\n') + '\n');
    appendedSinceCompact = 0;
  } catch (e) {}
}

function loadHistoryFile() {
  try {
    // One-time migration from the previous whole-file JSON format
    const oldFile = join(__dirname, 'metrics-history.json');
    if (!existsSync(HISTORY_FILE) && existsSync(oldFile)) {
      const old = JSON.parse(readFileSync(oldFile, 'utf8'));
      historyAgg = Array.isArray(old.agg) ? old.agg.slice(-AGG_MAX) : [];
      if (historyAgg.length) compactHistoryFile();
      unlinkSync(oldFile);
      return;
    }
    if (!existsSync(HISTORY_FILE)) return;
    const lines = readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const cutoff = Date.now() - AGG_MAX * 60000;
    historyAgg = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(p => p && p.t >= cutoff)
      .slice(-AGG_MAX);
    if (lines.length > AGG_MAX + 1440) compactHistoryFile();
  } catch (e) {}
}

function appendAggPoint(agg) {
  try {
    appendFileSync(HISTORY_FILE, JSON.stringify(agg) + '\n');
    if (++appendedSinceCompact > 2880) compactHistoryFile(); // ~2 extra days
  } catch (e) {}
}

const HISTORY_KEYS = ['cpu', 'gpu', 'gpuTemp', 'cpuTemp', 'gpuPower', 'mem'];

function recordHistory(m) {
  const point = {
    t: m.timestamp,
    cpu: m.cpu?.usage ?? 0,
    gpu: m.gpu?.[0]?.utilizationGpu ?? 0,
    gpuTemp: m.gpu?.[0]?.temperatureGpu ?? null,
    cpuTemp: m.cpu?.temperature ?? null,
    gpuPower: m.gpu?.[0]?.powerDraw ?? null,
    mem: m.memory?.usagePercent ?? 0,
    fan: fan.actual === 'on' ? 1 : fan.actual === 'off' ? 0 : null
  };
  historyRaw.push(point);
  const cutoff = m.timestamp - RAW_MAX_AGE;
  while (historyRaw.length && historyRaw[0].t < cutoff) historyRaw.shift();

  const minute = Math.floor(m.timestamp / 60000);
  if (!minuteBucket || minuteBucket.minute !== minute) {
    if (minuteBucket && minuteBucket.n > 0) {
      const agg = { t: minuteBucket.minute * 60000 };
      for (const k of HISTORY_KEYS) {
        agg[k] = minuteBucket.sums[k].n > 0
          ? parseFloat((minuteBucket.sums[k].sum / minuteBucket.sums[k].n).toFixed(2))
          : null;
      }
      agg.fan = minuteBucket.fanSeen ? (minuteBucket.fanOn ? 1 : 0) : null;
      historyAgg.push(agg);
      if (historyAgg.length > AGG_MAX) historyAgg = historyAgg.slice(-AGG_MAX);
      appendAggPoint(agg);
    }
    minuteBucket = {
      minute,
      n: 0,
      sums: Object.fromEntries(HISTORY_KEYS.map(k => [k, { sum: 0, n: 0 }])),
      fanOn: false,
      fanSeen: false
    };
  }
  minuteBucket.n++;
  for (const k of HISTORY_KEYS) {
    if (point[k] !== null && point[k] !== undefined) {
      minuteBucket.sums[k].sum += point[k];
      minuteBucket.sums[k].n++;
    }
  }
  if (point.fan === 1) { minuteBucket.fanOn = true; minuteBucket.fanSeen = true; }
  else if (point.fan === 0) minuteBucket.fanSeen = true;
}

// ── Service availability tracking ─────────────────────────────────────
// Tracks online/offline transitions of each inference engine. Persisted
// every minute together with history.
const HEALTH_FILE = join(__dirname, 'service-health.json');

let serviceHealth = (() => {
  try {
    if (existsSync(HEALTH_FILE)) return JSON.parse(readFileSync(HEALTH_FILE, 'utf8'));
  } catch (e) {}
  return {};
})();

function updateServiceHealth(m) {
  const now = m.timestamp;
  const states = {
    llama: !!m.inference?.llama?.available,
    vllm: !!m.inference?.vllm?.available,
    ollama: !!m.inference?.ollama?.available,
    comfyui: !!m.inference?.comfyui?.running
  };
  for (const [key, online] of Object.entries(states)) {
    const h = serviceHealth[key] || (serviceHealth[key] = { online: null, since: now, downCount: 0, lastDownAt: null });
    if (h.online === null) {
      h.online = online;
      h.since = now;
    } else if (h.online !== online) {
      h.online = online;
      h.since = now;
      if (!online) {
        h.downCount++;
        h.lastDownAt = now;
      }
    }
  }
}

// ── System events: boot / unclean shutdown / GPU throttling ──────────
// A "clean shutdown" marker is written on SIGTERM/SIGINT. If the marker
// is missing at startup but a previous run existed, the last session
// ended uncleanly (crash, power loss, OOM kill).
const EVENTS_FILE = join(__dirname, 'system-events.json');
const SHUTDOWN_MARKER = join(__dirname, '.clean-shutdown');
const EVENTS_MAX = 200;

let systemEvents = (() => {
  try {
    if (existsSync(EVENTS_FILE)) return JSON.parse(readFileSync(EVENTS_FILE, 'utf8'));
  } catch (e) {}
  return [];
})();

// Events are appended to the in-memory list immediately, but the file is
// flushed at most once per 30s (plus at shutdown). This keeps a flapping GPU
// throttle state from rewriting system-events.json on every transition.
let eventsDirty = false;

function addEvent(type, detail = {}) {
  systemEvents.push({ t: Date.now(), type, ...detail });
  if (systemEvents.length > EVENTS_MAX) systemEvents = systemEvents.slice(-EVENTS_MAX);
  eventsDirty = true;
}

function flushEvents() {
  if (!eventsDirty) return;
  try {
    writeFileSync(EVENTS_FILE, JSON.stringify(systemEvents));
    eventsDirty = false;
  } catch (e) {}
}

function detectUncleanShutdown() {
  const firstRun = !existsSync(EVENTS_FILE) && historyAgg.length === 0;
  const wasClean = existsSync(SHUTDOWN_MARKER);
  if (wasClean) { try { unlinkSync(SHUTDOWN_MARKER); } catch (e) {} }
  if (!firstRun && !wasClean) {
    const lastT = historyAgg.length ? historyAgg[historyAgg.length - 1].t : null;
    addEvent('unclean_shutdown', { at: lastT });
  }
  addEvent('boot');
}

// GPU throttling episode tracking (transitions recorded as events).
// A transition is only recorded after the throttle state has been stable for
// THROTTLE_STABLE_MS, so brief on/off flapping near a temperature limit does
// not generate event spam or disk writes.
const THROTTLE_STABLE_MS = 5 * 1000;
let throttlingSince = null;
let throttleEpisode = null;
let throttleCandidate = null;

// GB10 toggles the SW Power Cap bit in bursts even at idle. Warnings are held
// briefly; informational bits are latched for 5 minutes so the card doesn't
// flash when the driver starts/stops toggling the bit.
const THROTTLE_WARNING_HOLD_MS = 10 * 1000;
const THROTTLE_INFO_HOLD_MS = 5 * 60 * 1000;
let heldThrottleWarnings = [];
let heldThrottleInfo = [];
let warningHoldUntil = 0;
let infoHoldUntil = 0;

function trackThrottling(m) {
  const gpu = m.gpu?.[0];
  const tr = gpu?.throttleReasons;
  const active = !!tr?.throttling;
  const now = m.timestamp;

  if (!throttleCandidate || throttleCandidate.active !== active) {
    throttleCandidate = {
      active,
      since: now,
      reasons: tr?.active || [],
      peakTemp: gpu?.temperatureGpu ?? null
    };
  } else if (active && gpu?.temperatureGpu != null) {
    throttleCandidate.peakTemp = Math.max(throttleCandidate.peakTemp ?? 0, gpu.temperatureGpu);
  }

  if (now - throttleCandidate.since >= THROTTLE_STABLE_MS) {
    if (throttleCandidate.active && !throttlingSince) {
      throttlingSince = throttleCandidate.since;
      throttleEpisode = { reasons: throttleCandidate.reasons, peakTemp: throttleCandidate.peakTemp };
      addEvent('throttle_start', { reasons: throttleCandidate.reasons, temp: throttleCandidate.peakTemp });
    } else if (!throttleCandidate.active && throttlingSince) {
      addEvent('throttle_end', {
        durationMs: now - throttlingSince,
        reasons: throttleEpisode?.reasons || [],
        peakTemp: throttleEpisode?.peakTemp ?? null
      });
      throttlingSince = null;
      throttleEpisode = null;
    }
    throttleCandidate = null;
  }

  if (throttlingSince && active && gpu?.temperatureGpu != null) {
    throttleEpisode.peakTemp = Math.max(throttleEpisode.peakTemp ?? 0, gpu.temperatureGpu);
  }
}

function stabilizeThrottleDisplay(m) {
  const tr = m.gpu?.[0]?.throttleReasons;
  if (!tr) return;
  const warnings = tr.warnings || [];
  const info = (tr.active || []).filter(r => !warnings.includes(r));
  const now = Date.now();
  if (warnings.length) {
    heldThrottleWarnings = warnings;
    warningHoldUntil = now + THROTTLE_WARNING_HOLD_MS;
  } else if (now > warningHoldUntil) {
    heldThrottleWarnings = [];
  }
  if (info.length) {
    heldThrottleInfo = info;
    infoHoldUntil = now + THROTTLE_INFO_HOLD_MS;
  } else if (now > infoHoldUntil) {
    heldThrottleInfo = [];
  }
  tr.warnings = heldThrottleWarnings;
  tr.info = heldThrottleInfo;
}

// ── Room fan (米家 mesh 通断器 via ha-mijia) ─────────────────────────
// The bedroom 散热风扇 is a binary wall switch, not a PWM chassis fan.
// Drive it from the same always-on tick as the rest of the dashboard:
// Observed on this Spark (7d history): idle GPU ~38°C / 9W, load ~76°C / 74W.
//   ON  if GPU>=65 / CPU>=70 / NVMe>=70 / GPU power>=28W / thermal warning
//   OFF if GPU<=52 AND CPU<=62 AND NVMe<=58 AND no thermal warning
//   hold current state in the dead band. Missing GPU temp never turns the
//   fan off (fail-safe). Confirm 3 ticks (~15s) before flipping; thermal
//   warning forces ON immediately. Min ON 5 min / min OFF 3 min so the
//   relay is not worn out. Startup reads HA and does not flip until dwell
//   elapses. Mode auto|on|off is persisted; FAN_CONTROL=0 disables.
const HA_PY = join(homedir(), '.grok/skills/ha-mijia/scripts/ha.py');
const FAN_NAME = '散热风扇';
const FAN_STATE_FILE = join(__dirname, 'fan-control.json');
const FAN_ON = { gpu: 65, cpu: 70, nvme: 70, power: 28 };
const FAN_OFF = { gpu: 52, cpu: 62, nvme: 58 };
const FAN_MIN_ON_MS = 5 * 60 * 1000;
const FAN_MIN_OFF_MS = 3 * 60 * 1000;
const FAN_CONFIRM_TICKS = 3;
const FAN_RETRY_MS = 30 * 1000;

function loadFanMode() {
  try {
    if (existsSync(FAN_STATE_FILE)) {
      const m = JSON.parse(readFileSync(FAN_STATE_FILE, 'utf8')).mode;
      if (m === 'auto' || m === 'on' || m === 'off') return m;
    }
  } catch (e) {}
  return 'auto';
}

function saveFanMode(mode) {
  try { writeFileSync(FAN_STATE_FILE, JSON.stringify({ mode, t: Date.now() })); } catch (e) {}
}

const fan = {
  enabled: process.env.FAN_CONTROL !== '0',
  mode: loadFanMode(),
  actual: null,       // 'on' | 'off' | 'unavailable' | null
  desired: null,
  lastChange: 0,
  lastError: null,
  lastCall: 0,
  pending: null,      // 'on' | 'off' while confirming
  pendingTicks: 0,
  busy: false,
  reason: 'init'
};

function parseHaSwitch(stdout) {
  const line = (stdout || '').split('\n').map(s => s.trim()).find(s => /^(on|off)\b/.test(s));
  return line ? line.split(/\s+/, 1)[0] : null;
}

function haFan(action) {
  const args = action === 'state' ? ['state', FAN_NAME] : [action, FAN_NAME];
  return new Promise((resolve, reject) => {
    execFile('python3', [HA_PY, ...args], { timeout: 12000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').trim().slice(0, 240);
        reject(new Error(msg || `ha.py ${action} failed`));
        return;
      }
      resolve(parseHaSwitch(stdout));
    });
  });
}

function fanSnapshot() {
  return {
    enabled: fan.enabled,
    mode: fan.mode,
    state: fan.actual,
    desired: fan.desired,
    reason: fan.reason,
    lastChange: fan.lastChange || null,
    lastError: fan.lastError,
    thresholds: { on: FAN_ON, off: FAN_OFF }
  };
}

function evaluateFanWant(m) {
  const gpu = m.gpu?.[0]?.temperatureGpu;
  const cpu = m.cpu?.temperature;
  const nvme = m.diskIO?.temp;
  const power = m.gpu?.[0]?.powerDraw;
  const thermal = !!(m.gpu?.[0]?.throttleReasons?.warnings?.length);
  const above = (v, lim) => v != null && v >= lim;
  const hold = fan.actual === 'on' ? 'on' : 'off';

  if (thermal || above(gpu, FAN_ON.gpu) || above(cpu, FAN_ON.cpu) || above(nvme, FAN_ON.nvme) || above(power, FAN_ON.power)) {
    const bits = [];
    if (thermal) bits.push('thermal');
    if (above(gpu, FAN_ON.gpu)) bits.push(`gpu ${gpu}°C`);
    if (above(cpu, FAN_ON.cpu)) bits.push(`cpu ${cpu}°C`);
    if (above(nvme, FAN_ON.nvme)) bits.push(`nvme ${nvme}°C`);
    if (above(power, FAN_ON.power)) bits.push(`${power}W`);
    return { want: 'on', reason: bits.join(' · '), force: thermal };
  }
  // Don't treat a missing GPU reading as "cool" — keep the last state.
  if (gpu == null) return { want: hold, reason: 'no gpu temp' };
  const cool = gpu <= FAN_OFF.gpu
    && (cpu == null || cpu <= FAN_OFF.cpu)
    && (nvme == null || nvme <= FAN_OFF.nvme)
    && !thermal;
  if (cool) {
    const bits = [`gpu ${gpu}°C`];
    if (cpu != null) bits.push(`cpu ${cpu}°C`);
    if (nvme != null) bits.push(`nvme ${nvme}°C`);
    return { want: 'off', reason: bits.join(' · ') };
  }
  return { want: hold, reason: 'hysteresis' };
}

async function applyFanAction(action, reason) {
  if (fan.busy) return;
  fan.busy = true;
  try {
    const state = await haFan(action);
    fan.actual = state || action;
    fan.desired = action;
    fan.lastChange = Date.now();
    fan.lastError = null;
    fan.reason = reason;
    fan.pending = null;
    fan.pendingTicks = 0;
    addEvent(action === 'on' ? 'fan_on' : 'fan_off', { reason, state: fan.actual });
  } catch (e) {
    fan.lastError = e.message;
    fan.lastCall = Date.now();
    addEvent('fan_error', { action, error: e.message });
  } finally {
    fan.busy = false;
  }
}

async function applyFanControl(m) {
  if (!fan.enabled) {
    fan.reason = 'disabled';
    return;
  }
  const now = Date.now();
  if (fan.lastError && now - fan.lastCall < FAN_RETRY_MS) return;

  if (fan.actual == null) {
    try {
      fan.actual = await haFan('state');
      fan.lastChange = now;
      fan.lastError = null;
      fan.reason = `ha ${fan.actual}`;
    } catch (e) {
      fan.actual = 'unavailable';
      fan.lastError = e.message;
      fan.lastCall = now;
      addEvent('fan_error', { action: 'state', error: e.message });
    }
    return;
  }
  if (fan.actual === 'unavailable') {
    fan.reason = 'unavailable';
    return;
  }

  let want, reason, force = false;
  if (fan.mode === 'on' || fan.mode === 'off') {
    want = fan.mode;
    reason = `manual ${fan.mode}`;
    force = true;
  } else {
    const ev = evaluateFanWant(m);
    want = ev.want;
    reason = ev.reason;
    force = ev.force;
  }
  fan.desired = want;
  if (want === fan.actual) {
    fan.pending = null;
    fan.pendingTicks = 0;
    if (fan.reason === 'init' || fan.reason === 'hysteresis' || fan.reason.startsWith('ha ')) fan.reason = reason;
    return;
  }

  const dwell = fan.actual === 'on' ? FAN_MIN_ON_MS : FAN_MIN_OFF_MS;
  if (!force && fan.lastChange && now - fan.lastChange < dwell) {
    fan.reason = `dwell ${Math.ceil((dwell - (now - fan.lastChange)) / 1000)}s`;
    return;
  }
  if (!force) {
    if (fan.pending !== want) {
      fan.pending = want;
      fan.pendingTicks = 1;
      fan.reason = `confirm ${want}`;
      return;
    }
    fan.pendingTicks += 1;
    if (fan.pendingTicks < FAN_CONFIRM_TICKS) {
      fan.reason = `confirm ${want} ${fan.pendingTicks}/${FAN_CONFIRM_TICKS}`;
      return;
    }
  }
  await applyFanAction(want, reason);
}

async function setFanMode(mode) {
  if (mode !== 'auto' && mode !== 'on' && mode !== 'off') {
    throw new Error('mode must be auto|on|off');
  }
  fan.mode = mode;
  saveFanMode(mode);
  fan.pending = null;
  fan.pendingTicks = 0;
  if (mode === 'on' || mode === 'off') {
    await applyFanAction(mode, `manual ${mode}`);
  }
}

let lastHealthJson = JSON.stringify(serviceHealth);

function persistState() {
  flushEvents();
  const json = JSON.stringify(serviceHealth);
  if (json === lastHealthJson) return;
  try {
    writeFileSync(HEALTH_FILE, json);
    lastHealthJson = json;
  } catch (e) {}
}

function gracefulShutdown() {
  persistState();
  try { writeFileSync(SHUTDOWN_MARKER, String(Date.now())); } catch (e) {}
  process.exit(0);
}

// Model inventory scan (du -sb over large model dirs) is far too slow to run
// inside the 1s sampling loop. Refresh it in the background and reuse the
// cached result across ticks; the UI picks new models up on the next refresh.
const MODEL_REFRESH_MS = 10 * 60 * 1000;
let modelInventory = { llama: [], vllm: [] };
let modelScanBusy = false;
let modelLastScan = 0;

async function refreshModelInventory() {
  if (modelScanBusy) return;
  modelScanBusy = true;
  try {
    modelInventory = await getAvailableModels();
    modelLastScan = Date.now();
  } catch (e) {
    console.error('Error scanning model inventory:', e.message);
  } finally {
    modelScanBusy = false;
  }
}

loadHistoryFile();
detectUncleanShutdown();
refreshModelInventory();
setInterval(flushEvents, 30 * 1000);
setInterval(persistState, 5 * 60 * 1000);
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// ── Disk I/O rates + NVMe temperature ─────────────────────────────────
// /proc/diskstats and /sys/class/hwmon are world-readable; SMART needs
// root, so temperature is used as the disk health indicator instead.
let prevDiskStats = null;
let prevDiskTime = 0;

function getDiskIO() {
  try {
    const now = Date.now();
    const lines = readFileSync('/proc/diskstats', 'utf8').trim().split('\n');
    let rSectors = 0, wSectors = 0;
    for (const line of lines) {
      const p = line.trim().split(/\s+/);
      // Whole-disk devices only (skip partitions like nvme0n1p1 / sda1)
      if (!/^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|mmcblk\d+)$/.test(p[2])) continue;
      rSectors += parseInt(p[5]);
      wSectors += parseInt(p[9]);
    }
    let readMBs = null, writeMBs = null;
    if (prevDiskStats && now > prevDiskTime) {
      const dt = (now - prevDiskTime) / 1000;
      readMBs = Math.max(0, ((rSectors - prevDiskStats.r) * 512 / (1024 ** 2)) / dt);
      writeMBs = Math.max(0, ((wSectors - prevDiskStats.w) * 512 / (1024 ** 2)) / dt);
    }
    prevDiskStats = { r: rSectors, w: wSectors };
    prevDiskTime = now;
    return {
      readMBs: readMBs !== null ? parseFloat(readMBs.toFixed(2)) : null,
      writeMBs: writeMBs !== null ? parseFloat(writeMBs.toFixed(2)) : null,
      temp: getDiskTemp()
    };
  } catch (e) {
    return { readMBs: null, writeMBs: null, temp: getDiskTemp() };
  }
}

function getDiskTemp() {
  try {
    for (const d of readdirSync('/sys/class/hwmon')) {
      if (readFileSync(`/sys/class/hwmon/${d}/name`, 'utf8').trim() === 'nvme') {
        return parseFloat((parseInt(readFileSync(`/sys/class/hwmon/${d}/temp1_input`, 'utf8').trim()) / 1000).toFixed(1));
      }
    }
  } catch (e) {}
  return null;
}

// GPU clock throttle/event reasons (bitmask from nvidia-smi)
const THROTTLE_REASONS = [
  [0x1n,   'GPU Idle', false],
  [0x2n,   'App Clocks Setting', false],
  [0x4n,   'SW Power Cap', false],  // stays set at idle on GB10 — informational
  [0x8n,   'HW Slowdown', true],
  [0x10n,  'Sync Boost', false],
  [0x20n,  'SW Thermal Slowdown', true],
  [0x40n,  'HW Thermal Slowdown', true],
  [0x80n,  'HW Power Brake', true],
  [0x100n, 'Display Clock Setting', false]
];

function parseThrottleReasons(hex) {
  try {
    const mask = BigInt(hex);
    const active = [];
    const warnings = [];
    for (const [bit, name, isWarning] of THROTTLE_REASONS) {
      if (mask & bit) {
        active.push(name);
        if (isWarning) warnings.push(name);
      }
    }
    return { raw: hex, active, warnings, throttling: warnings.length > 0 };
  } catch (e) {
    return { raw: String(hex), active: [], warnings: [], throttling: false };
  }
}

// The service applies an upper GPU clock cap at start via
// `nvidia-smi -lgc <min>,<max>` (see dgx-spark-status.service). nvidia-smi
// cannot query the applied lock, so the unit exports the range as
// GPU_CLOCK_LOCK and the dashboard surfaces the max as the displayed cap.
function clockLimitFromEnv() {
  const spec = process.env.GPU_CLOCK_LOCK || '';
  const parts = spec.split(',').map(s => parseFloat(s.trim()));
  const max = Math.max(...parts.filter(Number.isFinite));
  return Number.isFinite(max) && max > 0 ? max : null;
}

function parseModelMeta(modelId) {
  if (!modelId) return { model: null, quantFormat: null, paramSize: null };
  const quantMatch = modelId.match(/(Q\d+_K(?:_[A-Z]+)?|Q\d+_\d+|F16|F32|BF16|FP8|MXFP4)/i);
  const model = modelId
    .replace(/-\d+-of-\d+\.gguf.*$/, '')
    .replace(/\.gguf.*$/, '')
    .replace(/^.*\//, '');
  const paramMatch = model.match(/(\d+B)/i);
  return {
    model,
    quantFormat: quantMatch ? quantMatch[1] : null,
    paramSize: paramMatch ? paramMatch[1] : null
  };
}

async function getAvailableModels() {
  const models = { llama: [], vllm: [] };

  // Scan switch-model.sh for llama.cpp model definitions
  try {
    const { stdout } = await execAsync("grep -E '^MODELS\\[' /usr/local/bin/switch-model.sh 2>/dev/null");
    const ctxOut = (await execAsync("grep -E '^CTX\\[' /usr/local/bin/switch-model.sh 2>/dev/null").catch(() => ({ stdout: '' }))).stdout;
    const ctxMap = {};
    for (const line of ctxOut.trim().split('\n')) {
      const m = line.match(/^CTX\[(\w+)\]="?(\d+)"?/);
      if (m) ctxMap[m[1]] = parseInt(m[2]);
    }
    for (const line of stdout.trim().split('\n')) {
      const m = line.match(/^MODELS\[(\w+)\]="([^"]+)"/);
      if (m) {
        const key = m[1];
        const path = m[2];
        const filename = path.split('/').pop().replace(/\.gguf.*/, '').replace(/-\d+-of-\d+$/, '').replace(/^stepfun-ai_/, '');
        let sizeGB = null;
        try {
          // For multi-file models use directory, for single file use the file itself
          const target = path.includes('-00001-of-') ? path.substring(0, path.lastIndexOf('/')) : path;
          const { stdout: sizeOut } = await execAsync(`du -sb "${target}" 2>/dev/null | cut -f1`);
          const bytes = parseInt(sizeOut.trim());
          if (bytes > 1e9) sizeGB = parseFloat((bytes / (1024 ** 3)).toFixed(1));
        } catch (e) {}
        models.llama.push({ key, name: filename, path, sizeGB, ctx: ctxMap[key] || null });
      }
    }
  } catch (e) {}

  // Scan HuggingFace cache for vLLM models
  try {
    const { stdout } = await execAsync("ls -d /root/.cache/huggingface/hub/models--*/ 2>/dev/null");
    for (const dir of stdout.trim().split('\n').filter(Boolean)) {
      const dirClean = dir.replace(/\/+$/, '');
      const basename = dirClean.split('/').pop();
      const name = basename.replace(/^models--/, '').replace(/--/g, '/');
      let sizeGB = null;
      try {
        const { stdout: sizeOut } = await execAsync(`du -sb "${dir}" 2>/dev/null | cut -f1`);
        const bytes = parseInt(sizeOut.trim());
        if (bytes < 1e9) continue;
        sizeGB = parseFloat((bytes / (1024 ** 3)).toFixed(1));
      } catch (e) { continue; }
      models.vllm.push({ name, sizeGB, path: dir });
    }
  } catch (e) {}

  // Scan /opt/models/ for locally downloaded vLLM models
  try {
    const { stdout } = await execAsync("ls -d /opt/models/*/ 2>/dev/null");
    for (const dir of stdout.trim().split('\n').filter(Boolean)) {
      const dirClean = dir.replace(/\/+$/, '');
      const name = dirClean.split('/').pop();
      let sizeGB = null;
      try {
        const { stdout: sizeOut } = await execAsync(`du -sb "${dirClean}" 2>/dev/null | cut -f1`);
        const bytes = parseInt(sizeOut.trim());
        if (bytes < 1e9) continue;
        sizeGB = parseFloat((bytes / (1024 ** 3)).toFixed(1));
      } catch (e) { continue; }
      models.vllm.push({ name, sizeGB, path: dirClean });
    }
  } catch (e) {}

  return models;
}

// Get llama.cpp server info
async function getLlamaInfo() {
  try {
    const [healthRes, propsRes, slotsRes] = await Promise.allSettled([
      fetch(`${LLAMA_SERVER}/health`, { signal: AbortSignal.timeout(2000) }),
      fetch(`${LLAMA_SERVER}/props`, { signal: AbortSignal.timeout(2000) }),
      fetch(`${LLAMA_SERVER}/slots`, { signal: AbortSignal.timeout(2000) })
    ]);

    let healthy = false;
    let loading = false;
    let processRunning = false;
    let model = 'unknown';
    let ctxSize = null;
    let quantFormat = null;
    let paramSize = null;

    if (healthRes.status === 'fulfilled') {
      healthy = healthRes.value.ok;
      if (!healthy) {
        try {
          const err = await healthRes.value.json();
          const msg = err?.error?.message || '';
          if (/loading model/i.test(msg)) loading = true;
        } catch (e) {}
      }
    }

    // Try /slots first (newer llama-server), fallback to /props
    if (slotsRes.status === 'fulfilled' && slotsRes.value.ok) {
      const slots = await slotsRes.value.json();
      if (Array.isArray(slots) && slots.length > 0) {
        ctxSize = slots[0]?.n_ctx || null;
      }
    }
    if (!ctxSize && propsRes.status === 'fulfilled') {
      if (propsRes.value.ok) {
        const props = await propsRes.value.json();
        ctxSize = props?.default_generation_settings?.params?.n_ctx || null;
      } else {
        try {
          const err = await propsRes.value.json();
          const msg = err?.error?.message || '';
          if (/loading model/i.test(msg)) loading = true;
        } catch (e) {}
      }
    }

    // Get model name from /v1/models API (includes full filename with quant format)
    try {
      const modelsRes = await fetch(`${LLAMA_SERVER}/v1/models`, { signal: AbortSignal.timeout(2000) });
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        const modelId = modelsData?.data?.[0]?.id || '';
        if (modelId) {
          const parsed = parseModelMeta(modelId);
          model = parsed.model || model;
          quantFormat = parsed.quantFormat || quantFormat;
          paramSize = parsed.paramSize || paramSize;
        }
      } else {
        try {
          const err = await modelsRes.json();
          const msg = err?.error?.message || '';
          if (/loading model/i.test(msg)) loading = true;
        } catch (e) {}
      }
    } catch (e) {}

    // Fallback to running process if API isn't ready yet.
    try {
      const { stdout: psOut } = await execAsync("ps -eo args | grep -E '[/]llama-server ' | grep -v grep | head -n 1");
      const cmd = (psOut || '').trim();
      if (cmd) {
        processRunning = true;
        const modelMatch = cmd.match(/--model\s+(\S+)/);
        if (modelMatch) {
          const path = modelMatch[1];
          if (model === 'unknown') {
            const base = path.split('/').pop() || path;
            model = base.replace(/-\d+-of-\d+\.gguf.*$/, '').replace(/\.gguf.*$/, '');
          }
          if (!quantFormat || !paramSize) {
            const parsed = parseModelMeta(path);
            quantFormat = parsed.quantFormat || quantFormat;
            paramSize = parsed.paramSize || paramSize;
          }
        }
        if (!ctxSize) {
          const ctxMatch = cmd.match(/--ctx-size\s+(\d+)/);
          if (ctxMatch) ctxSize = parseInt(ctxMatch[1], 10);
        }
      }
    } catch (e) {}

    // Fallback to systemctl/ps if API didn't work
    if (model === 'unknown') {
      try {
        const { stdout } = await execAsync("systemctl show llama-server -p Description --value 2>/dev/null");
        const match = stdout.match(/\(([^)]+)\)/);
        if (match) model = match[1];
      } catch (e) {}
    }

    const status = healthy ? 'running' : (loading || processRunning ? 'loading' : 'stopped');

    return {
      engine: 'llama.cpp',
      available: status !== 'stopped',
      status,
      model,
      ctxSize,
      quantFormat,
      paramSize,
      port: 8001,
      proxyPort: 8000
    };
  } catch (error) {
    return { engine: 'llama.cpp', available: false, status: 'stopped', model: null, ctxSize: null, port: 8001, proxyPort: 8000 };
  }
}

// Get vLLM container info
async function getVllmInfo() {
  try {
    const { stdout } = await execAsync("docker ps --filter 'name=vllm' --format '{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null");
    const running = stdout.trim();
    let containers = [];
    if (running) {
      containers = running.split('\n').map(line => {
        const [name, status, ports] = line.split('|');
        return { name, status, ports };
      });
    }

    let model = null;
    let modelAlias = null;
    let modelFromPath = null;
    let loading = false;
    const modelEndpoints = [
      'http://127.0.0.1:8100/v1/models',
      'http://127.0.0.1:8102/v1/models',
      'http://127.0.0.1:8109/v1/models'
    ];
    // Probe all candidate ports in parallel: three serial 2s curls would add
    // up to 6s to every sample when vLLM is down.
    const endpointResults = await Promise.allSettled(
      modelEndpoints.map(async (endpoint) => {
        const { stdout } = await execAsync(`curl -s --max-time 2 ${endpoint} 2>/dev/null || true`);
        return stdout.trim();
      })
    );
    for (const result of endpointResults) {
      const modelsOut = result.status === 'fulfilled' ? result.value : '';
      if (!modelsOut) continue;
      if (/Loading model/i.test(modelsOut)) {
        loading = true;
        continue;
      }
      try {
        const data = JSON.parse(modelsOut);
        if (data?.data?.[0]?.id) modelAlias = data.data[0].id;
      } catch (e) {}
    }

    // Parse served alias + actual model path from docker command line.
    if (containers.length > 0) {
      try {
        const names = containers.map(c => c.name).join(' ');
        const { stdout: inspectOut } = await execAsync(
          `docker inspect ${names} --format '{{.Name}}|{{json .Config.Cmd}}' 2>/dev/null || true`
        );
        for (const line of (inspectOut || '').trim().split('\n').filter(Boolean)) {
          const parts = line.split('|');
          if (parts.length < 2) continue;
          const cmd = JSON.parse(parts[1]);
          const servedIdx = cmd.indexOf('--served-model-name');
          if (servedIdx >= 0 && cmd[servedIdx + 1]) {
            modelAlias = modelAlias || cmd[servedIdx + 1];
          }
          const serveIdx = cmd.indexOf('serve');
          if (serveIdx >= 0 && cmd[serveIdx + 1]) {
            const rawPath = cmd[serveIdx + 1];
            modelFromPath = rawPath.split('/').filter(Boolean).pop() || rawPath;
          }
          if (modelAlias || modelFromPath) {
            break;
          }
        }
      } catch (e) {}
    }

    // Prefer real model name for dashboard matching; keep alias for reference.
    model = modelFromPath || modelAlias || model;

    const status = containers.length === 0 ? 'stopped' : (model ? 'running' : (loading ? 'loading' : 'starting'));

    return {
      engine: 'vLLM',
      available: containers.length > 0,
      status,
      model,
      modelAlias,
      containers
    };
  } catch (error) {
    return { engine: 'vLLM', available: false, status: 'stopped', model: null, containers: [] };
  }
}

// Get Ollama info
async function getOllamaInfo() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { engine: 'Ollama', available: false, status: 'stopped', models: [], port: 11434 };
    const data = await res.json();
    const models = (data.models || []).map(m => {
      const sizeGB = m.size ? parseFloat((m.size / (1024 ** 3)).toFixed(1)) : null;
      // Parse quant from model details or name
      const quantFormat = m.details?.quantization_level || null;
      const paramSize = m.details?.parameter_size || null;
      return {
        name: m.name,
        sizeGB,
        quantFormat,
        paramSize,
        family: m.details?.family || null,
        modified: m.modified_at
      };
    });

    // Check if any model is currently loaded (running)
    let runningModel = null;
    try {
      const psRes = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(2000) });
      if (psRes.ok) {
        const psData = await psRes.json();
        if (psData.models && psData.models.length > 0) {
          runningModel = psData.models[0].name;
        }
      }
    } catch (e) {}

    return {
      engine: 'Ollama',
      available: true,
      status: 'running',
      models,
      runningModel,
      port: 11434
    };
  } catch (error) {
    return { engine: 'Ollama', available: false, status: 'stopped', models: [], port: 11434 };
  }
}

// Get top memory-consuming processes
async function getTopProcesses(limit = 10) {
  try {
    const { stdout } = await execAsync(
      `ps aux --sort=-%mem | head -n ${limit + 1} | tail -n ${limit}`
    );

    const processes = stdout.trim().split('\n').map(line => {
      const parts = line.trim().split(/\s+/);
      const user = parts[0];
      const pid = parseInt(parts[1]);
      const cpu = parseFloat(parts[2]);
      const mem = parseFloat(parts[3]);
      const vsz = parseInt(parts[4]);
      const rss = parseInt(parts[5]);
      const command = parts.slice(10).join(' ');

      return {
        user,
        pid,
        cpu,
        mem,
        memoryMB: (rss / 1024).toFixed(1),
        memoryGB: (rss / 1024 / 1024).toFixed(2),
        command: command.length > 80 ? command.substring(0, 77) + '...' : command
      };
    });

    return processes;
  } catch (error) {
    console.error('Error getting top processes:', error.message);
    return [];
  }
}

// Get NVIDIA GPU info using nvidia-smi
async function getNvidiaGPUInfo() {
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,utilization.memory,temperature.gpu,power.draw,power.draw.average,power.draw.instant,power.limit,clocks.current.graphics,clocks.current.sm,clocks_event_reasons.active --format=csv,noheader,nounits'
    );

    const gpus = stdout.trim().split('\n').map(line => {
      const [index, name, memTotal, memUsed, memFree, utilGpu, utilMem, temp, powerDraw, powerDrawAvg, powerDrawInstant, powerLimit, clocksGraphics, clocksSm, throttleRaw] =
        line.split(',').map(s => s.trim());

      const parseValue = (val) => {
        if (val === '[N/A]' || val === 'N/A' || val === '') return null;
        const num = parseFloat(val);
        return isNaN(num) ? null : num;
      };

      return {
        index: parseInt(index),
        model: name,
        vendor: 'NVIDIA',
        memoryTotal: parseValue(memTotal),
        memoryUsed: parseValue(memUsed),
        memoryFree: parseValue(memFree),
        memoryTotalGB: memTotal === '[N/A]' ? null : parseFloat((parseValue(memTotal) || 0).toFixed(2)),
        memoryUsedGB: memUsed === '[N/A]' ? null : parseFloat((parseValue(memUsed) || 0).toFixed(2)),
        memoryFreeGB: memFree === '[N/A]' ? null : parseFloat((parseValue(memFree) || 0).toFixed(2)),
        utilizationGpu: parseValue(utilGpu),
        utilizationMemory: parseValue(utilMem),
        temperatureGpu: parseValue(temp),
        powerDraw: parseValue(powerDraw),
        powerDrawAvg: parseValue(powerDrawAvg),
        powerDrawInstant: parseValue(powerDrawInstant),
        powerLimit: parseValue(powerLimit),
        clocksGraphics: parseValue(clocksGraphics),
        clocksSm: parseValue(clocksSm),
        clockLimitMax: clockLimitFromEnv(),
        throttleReasons: parseThrottleReasons(throttleRaw),
        unifiedMemory: memTotal === '[N/A]' // Indicate unified memory
      };
    });

    return gpus;
  } catch (error) {
    console.error('Error getting NVIDIA GPU info:', error.message);
    return [];
  }
}

// Get ComfyUI info by checking port 8188
const COMFY_DIR = process.env.COMFYUI_DIR || join(homedir(), 'workspace/ComfyUI');
const COMFY_PY = process.env.COMFYUI_PYTHON || join(COMFY_DIR, '.venv/bin/python');
const COMFY_PORT = 8188;
const COMFY_LOG = join(COMFY_DIR, 'user', 'comfyui-dashboard.log');

const comfyCtl = { action: null, error: null, since: 0, pid: null };

async function comfyListenPids() {
  try {
    const { stdout } = await execAsync('lsof -Pi :8188 -sTCP:LISTEN -t 2>/dev/null || true');
    return stdout.trim().split(/\s+/).map(n => parseInt(n, 10)).filter(n => n > 0);
  } catch (e) {
    return [];
  }
}

function withComfyControl(info) {
  const age = Date.now() - (comfyCtl.since || 0);
  let pending = comfyCtl.action;
  if (pending === 'start' && info.running) pending = null;
  if (pending === 'stop' && !info.running) pending = null;
  if (pending && age > 90 * 1000) pending = null;
  comfyCtl.action = pending;
  return { ...info, pending, error: comfyCtl.error };
}

async function getComfyUIInfo() {
  try {
    const pids = await comfyListenPids();
    const pid = pids[0];
    if (!pid) return withComfyControl({ running: false, port: COMFY_PORT });

    const { stdout: psOut } = await execAsync(
      `ps -p ${pid} -o pid,user,%cpu,%mem,rss,command --no-headers 2>/dev/null`
    );
    const parts = psOut.trim().split(/\s+/);
    const rss = parseInt(parts[4]) || 0;
    const command = parts.slice(5).join(' ') || '';

    return withComfyControl({
      running: true,
      port: COMFY_PORT,
      pid: parseInt(parts[0]) || pid,
      user: parts[1] || '',
      cpu: parseFloat(parts[2]) || 0,
      mem: parseFloat(parts[3]) || 0,
      memoryGB: (rss / 1024 / 1024).toFixed(2),
      command: command.length > 80 ? command.substring(0, 77) + '...' : command
    });
  } catch (error) {
    return withComfyControl({ running: false, port: COMFY_PORT });
  }
}

async function startComfyUI() {
  const pids = await comfyListenPids();
  if (pids.length) {
    comfyCtl.action = null;
    comfyCtl.error = null;
    return getComfyUIInfo();
  }
  if (!existsSync(COMFY_PY)) throw new Error(`ComfyUI python not found: ${COMFY_PY}`);
  if (!existsSync(join(COMFY_DIR, 'main.py'))) throw new Error(`ComfyUI main.py not found in ${COMFY_DIR}`);

  comfyCtl.action = 'start';
  comfyCtl.error = null;
  comfyCtl.since = Date.now();

  const out = openSync(COMFY_LOG, 'a');
  const child = spawn(COMFY_PY, ['-u', 'main.py', '--listen', '0.0.0.0', '--port', String(COMFY_PORT)], {
    cwd: COMFY_DIR,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, VIRTUAL_ENV: join(COMFY_DIR, '.venv') }
  });
  comfyCtl.pid = child.pid;
  child.on('error', (err) => {
    comfyCtl.error = err.message;
    comfyCtl.action = null;
  });
  child.on('exit', (code, signal) => {
    if (comfyCtl.action === 'start' && code) {
      comfyCtl.error = `ComfyUI exited ${code}${signal ? ` (${signal})` : ''}`;
      comfyCtl.action = null;
    }
  });
  child.unref();
  addEvent('comfy_start', { pid: child.pid });
  return withComfyControl({ running: false, port: COMFY_PORT, pid: child.pid });
}

async function stopComfyUI() {
  const pids = await comfyListenPids();
  const targets = new Set(pids);
  if (comfyCtl.pid) targets.add(comfyCtl.pid);
  if (!targets.size) {
    comfyCtl.action = null;
    comfyCtl.error = null;
    return withComfyControl({ running: false, port: COMFY_PORT });
  }
  comfyCtl.action = 'stop';
  comfyCtl.error = null;
  comfyCtl.since = Date.now();
  for (const pid of targets) {
    try { process.kill(pid, 'SIGTERM'); } catch (e) {}
  }
  addEvent('comfy_stop', { pids: [...targets] });
  setTimeout(() => {
    comfyListenPids().then(left => {
      for (const pid of left) {
        try { process.kill(pid, 'SIGKILL'); } catch (e) {}
      }
    }).catch(() => {});
  }, 8000);
  return withComfyControl({ running: true, port: COMFY_PORT, pid: pids[0] || null });
}

// Collect system metrics
async function getSystemMetrics() {
  try {
    const [cpu, mem, currentLoad, osInfo, gpuData, processes, llamaInfo, vllmInfo, ollamaInfo, availableModels, fsSize, time, networkStats, cpuTemp, comfyuiInfo, diskIO] = await Promise.all([
      si.cpu(),
      si.mem(),
      si.currentLoad(),
      si.osInfo(),
      getNvidiaGPUInfo(),
      getTopProcesses(10),
      getLlamaInfo(),
      getVllmInfo(),
      getOllamaInfo(),
      modelInventory,
      si.fsSize(),
      si.time(),
      si.networkStats(),
      si.cpuTemperature(),
      getComfyUIInfo(),
      Promise.resolve(getDiskIO())
    ]);

    const physical = networkStats.filter(n => n.iface !== 'lo' && !n.iface.startsWith('veth') && !n.iface.startsWith('br-'));
    const totalRx = physical.reduce((sum, n) => sum + (n.rx_sec || 0), 0);
    const totalTx = physical.reduce((sum, n) => sum + (n.tx_sec || 0), 0);
    const totalRxBytes = physical.reduce((sum, n) => sum + (n.rx_bytes || 0), 0);
    const totalTxBytes = physical.reduce((sum, n) => sum + (n.tx_bytes || 0), 0);

    const metrics = {
      timestamp: Date.now(),
      system: {
        platform: osInfo.platform,
        distro: osInfo.distro,
        hostname: osInfo.hostname,
        arch: osInfo.arch
      },
      cpu: {
        manufacturer: cpu.manufacturer,
        brand: cpu.brand,
        cores: cpu.cores,
        physicalCores: cpu.physicalCores,
        speed: cpu.speed,
        usage: parseFloat(currentLoad.currentLoad.toFixed(2)),
        temperature: cpuTemp.main !== null ? parseFloat(cpuTemp.main.toFixed(1)) : null,
        perCore: currentLoad.cpus.map(core => ({
          load: parseFloat(core.load.toFixed(2))
        }))
      },
      memory: {
        total: mem.total,
        free: mem.free,
        used: mem.used,
        active: mem.active,
        available: mem.available,
        usagePercent: parseFloat(((mem.used / mem.total) * 100).toFixed(2)),
        totalGB: parseFloat((mem.total / (1024 ** 3)).toFixed(2)),
        usedGB: parseFloat((mem.used / (1024 ** 3)).toFixed(2)),
        freeGB: parseFloat((mem.free / (1024 ** 3)).toFixed(2))
      },
      gpu: gpuData,
      processes: processes,
      inference: {
        llama: llamaInfo,
        vllm: vllmInfo,
        ollama: ollamaInfo,
        comfyui: comfyuiInfo,
        availableModels
      },
      disk: fsSize.map(disk => ({
        fs: disk.fs,
        type: disk.type,
        size: disk.size,
        used: disk.used,
        available: disk.available,
        usagePercent: parseFloat(disk.use.toFixed(2)),
        mount: disk.mount,
        sizeGB: parseFloat((disk.size / (1024 ** 3)).toFixed(2)),
        usedGB: parseFloat((disk.used / (1024 ** 3)).toFixed(2)),
        availableGB: parseFloat((disk.available / (1024 ** 3)).toFixed(2))
      })),
      diskIO,
      uptime: {
        seconds: time.uptime,
        days: Math.floor(time.uptime / 86400),
        hours: Math.floor((time.uptime % 86400) / 3600),
        minutes: Math.floor((time.uptime % 3600) / 60)
      },
      network: [{
        iface: 'all',
        rx_sec: totalRx,
        tx_sec: totalTx,
        rx_bytes: totalRxBytes,
        tx_bytes: totalTxBytes,
        rx_sec_mb: parseFloat((totalRx / (1024 ** 2)).toFixed(2)),
        tx_sec_mb: parseFloat((totalTx / (1024 ** 2)).toFixed(2))
      }, ...physical.map(net => ({
        iface: net.iface,
        rx_sec: net.rx_sec,
        tx_sec: net.tx_sec,
        rx_bytes: net.rx_bytes,
        tx_bytes: net.tx_bytes,
        rx_sec_mb: parseFloat((net.rx_sec / (1024 ** 2)).toFixed(2)),
        tx_sec_mb: parseFloat((net.tx_sec / (1024 ** 2)).toFixed(2))
      }))]
    };

    return metrics;
  } catch (error) {
    console.error('Error collecting metrics:', error);
    return null;
  }
}

// Store active SSE clients
const sseClients = new Set();

// SSE endpoint handler
function handleSSE(req, res) {
  const clientIp = req.socket.remoteAddress;
  console.log(`Client connected via SSE from ${clientIp}`);

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Send initial comment to establish connection
  res.write(':ok\n\n');

  // Send initial metrics immediately (reuse latest sample if available)
  if (latestMetrics) {
    res.write(`data: ${JSON.stringify(latestMetrics)}\n\n`);
  } else {
    // Wait for the in-flight boot sample instead of kicking off a second
    // full collection that would contend with the first one.
    (tickPromise || tick()).then(() => {
      if (latestMetrics && !res.writableEnded) {
        try {
          res.write(`data: ${JSON.stringify(latestMetrics)}\n\n`);
        } catch (error) {
          console.error('Error sending initial metrics:', error.message);
        }
      }
    }).catch(error => {
      console.error('Error getting initial metrics:', error);
    });
  }

  // Add client to set
  const client = { res, ip: clientIp };
  sseClients.add(client);

  // Handle client disconnect
  req.on('close', () => {
    sseClients.delete(client);
    console.log(`Client disconnected from ${clientIp}`);
  });

  req.on('error', (error) => {
    sseClients.delete(client);
    console.error('SSE error:', error.message);
  });
}

// Always-on sampling loop: collects metrics every second regardless of
// connected clients (needed for 24h history and service health tracking),
// and broadcasts to SSE clients when any are connected. Slow samples are
// never overlapped: a new tick is skipped while the previous one is running.
let latestMetrics = null;
let tickPromise = null;

async function tick() {
  if (tickPromise) return tickPromise;
  tickPromise = (async () => {
    try {
      if (Date.now() - modelLastScan > MODEL_REFRESH_MS) refreshModelInventory();
      const metrics = await getSystemMetrics();
      if (!metrics) return;
      updateServiceHealth(metrics);
      trackThrottling(metrics);
      stabilizeThrottleDisplay(metrics);
      await applyFanControl(metrics);
      metrics.fan = fanSnapshot();
      recordHistory(metrics);
      if (metrics.inference) metrics.inference.health = serviceHealth;
      metrics.events = systemEvents.slice(-20);
      metrics.modelNotes = loadNotes();
      latestMetrics = metrics;

      if (sseClients.size === 0) return;
      const data = `data: ${JSON.stringify(metrics)}\n\n`;

      // Send to all connected clients
      for (const client of sseClients) {
        try {
          client.res.write(data);
        } catch (error) {
          console.error(`Error sending to ${client.ip}:`, error.message);
          sseClients.delete(client);
        }
      }
    } catch (error) {
      console.error('Error in metrics tick:', error);
    }
  })();
  try {
    await tickPromise;
  } finally {
    tickPromise = null;
  }
}

// Start sampling interval
setInterval(tick, UPDATE_INTERVAL);
tick();

async function startDevServer() {
  // Create Vite dev server with middleware mode
  const vite = await createServer({
    server: {
      host: '0.0.0.0',
      port: 9000,
      strictPort: true,
      middlewareMode: true
    }
  });

  // Create Express app
  const app = express();

  // Add SSE endpoint BEFORE Vite middleware
  app.get('/api/metrics', handleSSE);

  // Metrics history window (1-min aggregates + last 10 min of 1s samples).
  // Defaults to 24h — the largest chart range the UI can select — but any
  // window up to the 7-day retention cap can be requested with ?hours=N.
  app.get('/api/history', (req, res) => {
    const hours = Math.min(7 * 24, Math.max(1, parseInt(req.query.hours, 10) || 24));
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const agg = historyAgg.filter(p => p.t >= cutoff);
    res.json({ agg, raw: historyRaw });
  });

  // Model notes API
  app.use(express.json());
  app.get('/api/notes', (req, res) => {
    res.json(loadNotes());
  });
  app.post('/api/notes', (req, res) => {
    const { modelId, note } = req.body;
    if (!modelId) return res.status(400).json({ error: 'modelId required' });
    const notes = loadNotes();
    if (note && note.trim()) {
      notes[modelId] = note.trim();
    } else {
      delete notes[modelId];
    }
    saveNotes(notes);
    res.json({ ok: true, notes });
  });

  app.get('/api/fan', (_req, res) => {
    res.json(fanSnapshot());
  });
  app.post('/api/fan', async (req, res) => {
    try {
      await setFanMode(req.body?.mode);
      res.json({ ok: true, fan: fanSnapshot() });
    } catch (e) {
      res.status(400).json({ error: e.message, fan: fanSnapshot() });
    }
  });

  app.get('/api/comfyui', async (_req, res) => {
    res.json(await getComfyUIInfo());
  });
  app.post('/api/comfyui', async (req, res) => {
    const action = req.body?.action;
    try {
      if (action === 'start') return res.json({ ok: true, comfyui: await startComfyUI() });
      if (action === 'stop') return res.json({ ok: true, comfyui: await stopComfyUI() });
      res.status(400).json({ error: 'action must be start or stop' });
    } catch (e) {
      comfyCtl.error = e.message;
      comfyCtl.action = null;
      res.status(500).json({ error: e.message, comfyui: await getComfyUIInfo() });
    }
  });

  // Use Vite middleware
  app.use(vite.middlewares);

  // Start server
  const server = app.listen(9000, '0.0.0.0', () => {
    console.log('');
    console.log('\x1b[32m%s\x1b[0m', '  ➜ DGX Spark Status Server');
    console.log('  \x1b[36m%s\x1b[0m', `Local:   http://localhost:9000/`);
    console.log('  \x1b[36m%s\x1b[0m', `Network: http://0.0.0.0:9000/`);
    console.log('  \x1b[33m%s\x1b[0m', `SSE Endpoint: http://0.0.0.0:9000/api/metrics`);
    console.log('');
  });
}

startDevServer().catch(err => {
  console.error('Failed to start dev server:', err);
  process.exit(1);
});
