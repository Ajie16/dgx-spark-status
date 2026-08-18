<script>
  import { onMount, onDestroy } from 'svelte';
  import { subscribe, getCurrentMetrics, isWebSocketConnected } from './websocket.js';
  import Gauge from './Gauge.svelte';

  let metrics = $state(null);
  let connected = $state(false);
  let unsubscribe = null;

  // Theme
  let theme = $state('dark');

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('dgx-theme', theme);
  }

  let comfyBusy = $state(false);

  async function controlComfy(action) {
    if (comfyBusy) return;
    comfyBusy = true;
    try {
      const res = await fetch('/api/comfyui', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const data = await res.json();
      if (data.comfyui && metrics?.inference) {
        metrics.inference.comfyui = { ...metrics.inference.comfyui, ...data.comfyui };
      }
    } catch (e) {
    } finally {
      comfyBusy = false;
    }
  }

  async function setFanMode(mode) {
    try {
      const res = await fetch('/api/fan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
      const data = await res.json();
      if (data.fan && metrics) metrics.fan = data.fan;
    } catch (e) {}
  }

  onMount(() => {
    const saved = localStorage.getItem('dgx-theme');
    if (saved === 'light' || saved === 'dark') {
      theme = saved;
      document.documentElement.setAttribute('data-theme', theme);
    } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      theme = 'light';
      document.documentElement.setAttribute('data-theme', 'light');
    }
  });

  // 60-point 5s sparklines for the metric cards
  const HISTORY_LEN = 60;
  // Time-based chart series. chartAgg holds 1-min averages from the server;
  // chartLive holds 5s samples received since this page connected. Points are
  // positioned on the x-axis by their real timestamp, so both precisions mix
  // without distorting the time axis.
  const CHART_AGG_MAX = 24 * 60;                 // 24h of 1-min points
  const CHART_LIVE_MAX_AGE = 10 * 60 * 1000;     // keep live 5s points 10 min
  const CHART_RANGES = [
    { value: 1 / 6, label: '10m' },
    { value: 1, label: '1h' },
    { value: 6, label: '6h' },
    { value: 24, label: '24h' }
  ];
  const CHART_HEADROOM = 1.12;                   // leave room so peaks aren't clipped
  let cpuHistory = $state(Array(HISTORY_LEN).fill(0));
  let gpuHistory = $state(Array(HISTORY_LEN).fill(0));
  let netRxHistory = $state(Array(HISTORY_LEN).fill(0));
  let netTxHistory = $state(Array(HISTORY_LEN).fill(0));
  let chartAgg = $state([]);     // {t, gpuPower, gpuTemp, cpuTemp}
  let chartLive = $state([]);    // {t, gpuPower, gpuTemp, cpuTemp}
  let chartRangeH = $state(1 / 6); // chart window in hours (default 10 min)
  let historyRefreshTimer = null;

  function pushHistory(arr, val, max = HISTORY_LEN) {
    const next = arr.length >= max ? arr.slice(arr.length - max + 1) : arr.slice();
    next.push(val);
    return next;
  }

  function padTo(arr, len) {
    return [...Array(Math.max(0, len - arr.length)).fill(0), ...arr.slice(-len)];
  }

  function toChartPoint(p) {
    return {
      t: typeof p.t === 'number' ? p.t : null,
      gpuPower: p.gpuPower ?? null,
      gpuTemp: p.gpuTemp ?? null,
      cpuTemp: p.cpuTemp ?? null,
      fan: p.fan === 1 || p.fan === 'on' ? 1 : p.fan === 0 || p.fan === 'off' ? 0 : null
    };
  }

  // Seed charts from server-side history (survives refresh and server restart)
  async function loadServerHistory() {
    try {
      const res = await fetch('/api/history?hours=24');
      if (!res.ok) return;
      const data = await res.json();
      chartAgg = (data.agg || [])
        .map(toChartPoint)
        .filter(p => p.t !== null)
        .slice(-CHART_AGG_MAX);
      const live = (data.raw || []).map(toChartPoint).filter(p => p.t !== null);
      if (live.length > 0) chartLive = live;
      const raw = (data.raw || []).slice(-HISTORY_LEN);
      if (raw.length > 0) {
        cpuHistory = padTo(raw.map(p => p.cpu ?? 0), HISTORY_LEN);
        gpuHistory = padTo(raw.map(p => p.gpu ?? 0), HISTORY_LEN);
      }
    } catch (e) {
      console.error('Failed to load server history:', e);
    }
  }

  // Live 5s samples, deduplicated by timestamp and trimmed to 10 minutes.
  function pushLivePoint(p) {
    if (p.t == null) return;
    let next = chartLive.filter(q => q.t !== p.t);
    next.push(p);
    const cutoff = p.t - CHART_LIVE_MAX_AGE;
    while (next.length && next[0].t < cutoff) next.shift();
    chartLive = next;
  }

  // Merge server 1-min points with live 1s points for the selected window,
  // sorted by timestamp. Live samples win on exact timestamp collisions.
  function visibleChartPoints() {
    const cutoff = Date.now() - chartRangeH * 60 * 60 * 1000;
    const map = new Map();
    for (const p of chartAgg) if (p.t >= cutoff) map.set(p.t, p);
    for (const p of chartLive) if (p.t >= cutoff) map.set(p.t, p);
    return [...map.values()].sort((a, b) => a.t - b.t);
  }

  const chartView = $derived.by(() => visibleChartPoints());

  // X is mapped from the real timestamp: window start → 0, now → width.
  // Null values break the line instead of being drawn as zero.
  function timeChartPath(points, w, h, key, opts = {}) {
    const now = opts.now ?? Date.now();
    const tStart = now - chartRangeH * 60 * 60 * 1000;
    const span = Math.max(1, now - tStart);
    const vals = points
      .map(p => p[key])
      .filter(v => typeof v === 'number' && Number.isFinite(v));
    if (vals.length === 0) return '';
    const max = (opts.max ?? Math.max(...vals, 1)) * CHART_HEADROOM;
    const x = t => ((t - tStart) / span) * w;
    let d = '';
    let pen = false;
    for (const p of points) {
      const v = p[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${(h - (v / max) * h).toFixed(1)} `;
      pen = true;
    }
    return d.trim();
  }

  function timeChartArea(points, w, h, key, opts = {}) {
    const line = timeChartPath(points, w, h, key, opts);
    if (!line) return '';
    const now = opts.now ?? Date.now();
    const tStart = now - chartRangeH * 60 * 60 * 1000;
    const span = Math.max(1, now - tStart);
    const x = t => ((t - tStart) / span) * w;
    const valid = points.filter(p => typeof p[key] === 'number' && Number.isFinite(p[key]));
    const first = valid[0];
    const last = valid[valid.length - 1];
    return `${line} L${x(last.t).toFixed(1)},${h} L${x(first.t).toFixed(1)},${h} Z`;
  }

  function chartMaxTemp(points) {
    const vals = points
      .flatMap(p => [p.gpuTemp, p.cpuTemp])
      .filter(v => typeof v === 'number' && Number.isFinite(v));
    return Math.max(...vals, 1);
  }

  function chartSeriesMax(points, key) {
    const vals = points
      .map(p => p[key])
      .filter(v => typeof v === 'number' && Number.isFinite(v));
    if (!vals.length) return null;
    return Math.max(...vals, 1);
  }

  function axisValue(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    return v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  }

  function peakOf(points, key) {
    let best = null;
    for (const p of points) {
      const v = p[key];
      if (typeof v === 'number' && Number.isFinite(v) && (!best || v > best.v)) {
        best = { t: p.t, v };
      }
    }
    return best;
  }

  function chartPointXY(t, v, w, h, max, now = Date.now()) {
    const tStart = now - chartRangeH * 60 * 60 * 1000;
    const span = Math.max(1, now - tStart);
    return {
      x: ((t - tStart) / span) * w,
      y: h - (v / max) * h
    };
  }

  function formatTick(t, withDate) {
    const opts = withDate
      ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' };
    return new Date(t).toLocaleString([], opts);
  }

  function rangeLabel(h) {
    return h < 1 ? `${Math.round(h * 60)}m` : `${Math.round(h)}h`;
  }

  // Merge consecutive fan on/off samples into chart-space bands.
  // Falls back to fan_on / fan_off events when history predates the fan field.
  function fanBands(points, w = 400, now = Date.now()) {
    const tStart = now - chartRangeH * 60 * 60 * 1000;
    const span = Math.max(1, now - tStart);
    const samples = [];
    for (const p of points) {
      if (p.t == null || p.t < tStart) continue;
      if (p.fan === 1 || p.fan === 0) samples.push({ t: p.t, state: p.fan === 1 ? 'on' : 'off' });
    }
    if (samples.length === 0 && metrics?.events) {
      const evs = [...metrics.events]
        .filter(e => e.type === 'fan_on' || e.type === 'fan_off')
        .sort((a, b) => a.t - b.t);
      for (const ev of evs) {
        samples.push({ t: ev.t, state: ev.type === 'fan_on' ? 'on' : 'off' });
      }
    }
    const live = metrics?.fan?.state;
    if (live === 'on' || live === 'off') {
      if (!samples.length || samples[samples.length - 1].t < now) {
        samples.push({ t: now, state: live });
      } else {
        samples[samples.length - 1].state = live;
      }
    }
    if (!samples.length) return [];
    const segs = [];
    let cur = { state: samples[0].state, t0: Math.max(samples[0].t, tStart) };
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].state !== cur.state) {
        segs.push({ ...cur, t1: samples[i].t });
        cur = { state: samples[i].state, t0: samples[i].t };
      }
    }
    segs.push({ ...cur, t1: now });
    return segs.map(s => {
      const x0 = ((s.t0 - tStart) / span) * w;
      const x1 = ((s.t1 - tStart) / span) * w;
      return { state: s.state, x: x0, w: Math.max(0.4, x1 - x0) };
    }).filter(s => s.w > 0 && s.x < w);
  }

  function thresholdY(temp, scale, h = 120) {
    if (temp == null || scale == null || scale <= 0) return null;
    const y = h - (temp / scale) * h;
    return y >= 0 && y <= h ? y : null;
  }

  onMount(() => {
    loadServerHistory();
    historyRefreshTimer = setInterval(loadServerHistory, 60 * 1000);
    unsubscribe = subscribe((message) => {
      if (message.type === 'connected') {
        connected = true;
      } else if (message.type === 'disconnected') {
        connected = false;
      } else if (message.type === 'metrics') {
        metrics = message.data;
        cpuHistory = pushHistory(cpuHistory, message.data.cpu?.usage || 0);
        gpuHistory = pushHistory(gpuHistory, message.data.gpu?.[0]?.utilizationGpu || 0);
        const net = message.data.network?.find(n => n.iface === 'all') || message.data.network?.[0];
        netRxHistory = pushHistory(netRxHistory, net?.rx_sec_mb || 0);
        netTxHistory = pushHistory(netTxHistory, net?.tx_sec_mb || 0);
        pushLivePoint({
          t: message.data.timestamp,
          gpuPower: message.data.gpu?.[0]?.powerDraw ?? null,
          gpuTemp: message.data.gpu?.[0]?.temperatureGpu ?? null,
          cpuTemp: message.data.cpu?.temperature ?? null,
          fan: message.data.fan?.state === 'on' ? 1 : message.data.fan?.state === 'off' ? 0 : null
        });
      }
    });
    metrics = getCurrentMetrics();
    connected = isWebSocketConnected();
  });

  onDestroy(() => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (historyRefreshTimer) { clearInterval(historyRefreshTimer); historyRefreshTimer = null; }
  });

  // Notes
  let editingNote = $state(null);
  let noteInput = $state('');

  function startEditNote(modelId, currentNote) {
    editingNote = modelId;
    noteInput = currentNote || '';
  }

  async function saveNote(modelId) {
    await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, note: noteInput })
    });
    editingNote = null;
  }

  function cancelEdit() { editingNote = null; }

  function getNote(modelId) {
    return metrics?.modelNotes?.[modelId] || '';
  }

  // Sparkline path generator
  function sparklinePath(data, w, h) {
    if (!data || data.length < 2) return '';
    const max = Math.max(...data, 1);
    const step = w / (data.length - 1);
    return data.map((v, i) => {
      const x = i * step;
      const y = h - (v / max) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }

  function sparklineArea(data, w, h) {
    const path = sparklinePath(data, w, h);
    if (!path) return '';
    return path + ` L${w},${h} L0,${h} Z`;
  }

  function formatBytes(bytes) {
    return (bytes / (1024 ** 3)).toFixed(2);
  }

  function formatClock(mhz) {
    if (mhz == null || !Number.isFinite(mhz)) return '';
    return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${mhz.toFixed(0)} MHz`;
  }

  function formatUptime(uptime) {
    if (!uptime) return '';
    const parts = [];
    if (uptime.days) parts.push(`${uptime.days}d`);
    if (uptime.hours) parts.push(`${uptime.hours}h`);
    parts.push(`${uptime.minutes}m`);
    return parts.join(' ');
  }

  function formatDuration(ms) {
    if (ms == null || ms < 0) return '';
    const m = Math.floor(ms / 60000);
    if (m < 1) return '<1m';
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d) return `${d}d ${h % 24}h`;
    if (h) return `${h}h ${m % 60}m`;
    return `${m}m`;
  }

  // One-line availability summary for an inference engine
  function healthText(h, now) {
    if (!h) return '';
    const dur = formatDuration(Math.max(0, now - h.since));
    let s = h.online ? `Up ${dur}` : `Down ${dur}`;
    if (h.downCount > 0) {
      s += ` · ${h.downCount} outage${h.downCount > 1 ? 's' : ''}`;
      if (h.lastDownAt) {
        s += ` (last ${new Date(h.lastDownAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})`;
      }
    }
    return s;
  }

  // Human-readable text for a system event
  function eventText(ev) {
    switch (ev.type) {
      case 'boot':
        return 'Dashboard service started';
      case 'unclean_shutdown':
        return ev.at
          ? `Possible crash / power loss — last data ${new Date(ev.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
          : 'Possible crash / power loss before this boot';
      case 'throttle_start':
        return `GPU throttling started — ${(ev.reasons || []).join(', ') || 'unknown'}${ev.temp != null ? ` (GPU ${ev.temp}°C)` : ''}`;
      case 'throttle_end':
        return `GPU throttling ended after ${formatDuration(ev.durationMs)}${ev.peakTemp != null ? ` (peak ${ev.peakTemp}°C)` : ''}`;
      case 'fan_on':
        return `Cooling fan on${ev.reason ? ` — ${ev.reason}` : ''}`;
      case 'fan_off':
        return `Cooling fan off${ev.reason ? ` — ${ev.reason}` : ''}`;
      case 'fan_error':
        return `Cooling fan error${ev.error ? ` — ${ev.error}` : ''}`;
      case 'comfy_start':
        return `ComfyUI starting${ev.pid ? ` (pid ${ev.pid})` : ''}`;
      case 'comfy_stop':
        return `ComfyUI stop requested`;
      default:
        return ev.type;
    }
  }
</script>

<div class="dashboard">
  <div class="header">
    <div class="header-left">
      <div class="header-title">
        <h1>DGX Spark</h1>
        <div class="system-meta">
          <span class="hostname">{metrics?.system?.hostname || 'Loading...'}</span>
          {#if metrics?.system}
            <span class="meta-divider">·</span>
            <span class="meta-item">{metrics.system.distro}</span>
            <span class="meta-divider">·</span>
            <span class="meta-item">{metrics.system.arch}</span>
          {/if}
        </div>
      </div>
    </div>
    <div class="header-right">
      <button class="theme-toggle" onclick={toggleTheme} title="Toggle theme">
        {#if theme === 'dark'}☀️{:else}🌙{/if}
      </button>
      {#if metrics?.uptime}
        <div class="uptime-pill">
          <span class="uptime-label">Uptime</span>
          <span class="uptime-value">{formatUptime(metrics.uptime)}</span>
        </div>
      {/if}
      <div class="status-pill {connected ? 'connected' : 'disconnected'}">
        <span class="status-dot"></span>
        {connected ? 'Live' : 'Disconnected'}
      </div>
    </div>
  </div>

  {#if metrics}
    <!-- Row 1: Core Metrics -->
    <div class="stats-grid">
      <!-- CPU -->
      <div class="card stat-card">
        <div class="stat-header">
          <h2>CPU</h2>
          <div class="stat-badge">{metrics.cpu.usage.toFixed(0)}%</div>
        </div>
        <div class="stat-body">
          <div class="gauge-wrap">
            <Gauge value={metrics.cpu.usage.toFixed(0)} max={100} color="#30d158" label="%" size={72} thickness={6} />
          </div>
          <div class="stat-details">
            <div class="stat-main">{metrics.cpu.brand || metrics.cpu.manufacturer || 'Unknown CPU'}</div>
            <div class="stat-sub">
              {metrics.cpu.physicalCores}C / {metrics.cpu.cores}T · {metrics.cpu.speed}GHz
              {#if metrics.cpu.temperature !== null} · {metrics.cpu.temperature}°C{/if}
            </div>
            <div class="per-core-grid">
              {#each metrics.cpu.perCore.slice(0, 20) as core, i}
                <div class="core-bar-wrap" title="Core {i}: {core.load}%">
                  <div class="core-bar" style="height: {Math.max(core.load, 2)}%"></div>
                </div>
              {/each}
            </div>
          </div>
        </div>
        <div class="sparkline-container">
          <svg viewBox="0 0 120 32" preserveAspectRatio="none" class="sparkline">
            <path d={sparklineArea(cpuHistory, 120, 32)} fill="rgba(48, 209, 88, 0.12)" />
            <path d={sparklinePath(cpuHistory, 120, 32)} fill="none" stroke="#30d158" stroke-width="1.5" />
          </svg>
        </div>
      </div>

      <!-- GPU -->
      {#if metrics.gpu && metrics.gpu.length > 0}
        {@const gpu = metrics.gpu[0]}
        <div class="card stat-card">
          <div class="stat-header">
            <h2>GPU</h2>
            <div class="stat-badge">{gpu.utilizationGpu ?? 0}%</div>
          </div>
          <div class="stat-body">
            <div class="gauge-wrap">
              <Gauge value={gpu.utilizationGpu ?? 0} max={100} color="#ff9f0a" label="%" size={72} thickness={6} />
            </div>
            <div class="stat-details">
              <div class="stat-main">{gpu.model}</div>
              <div class="stat-sub">
                {#if gpu.temperatureGpu !== null}{gpu.temperatureGpu}°C{/if}
                {#if gpu.clocksGraphics !== null || gpu.clocksSm !== null}
                  {#if gpu.temperatureGpu !== null} · {/if}
                  {formatClock(gpu.clocksGraphics ?? gpu.clocksSm)}
                {/if}
                {#if gpu.clockLimitMax !== null}
                  {#if gpu.temperatureGpu !== null || gpu.clocksGraphics !== null || gpu.clocksSm !== null} · {/if}
                  cap {formatClock(gpu.clockLimitMax)}
                {/if}
              </div>
              {#if !gpu.unifiedMemory && gpu.memoryTotalGB !== null}
                <div class="stat-sub mono">
                  VRAM {gpu.memoryUsedGB} / {gpu.memoryTotalGB} GB
                </div>
              {:else}
                <div class="stat-sub">Unified Memory Architecture</div>
              {/if}
              {#if gpu.throttleReasons?.warnings?.length}
                <div class="stat-sub throttle-warning">⚠ {gpu.throttleReasons.warnings.join(' · ')}</div>
              {/if}
              {#if gpu.throttleReasons?.info?.length}
                <div class="stat-sub throttle-info">{gpu.throttleReasons.info.join(' · ')}</div>
              {/if}
              {#if metrics.fan}
                <div class="fan-row">
                  <span class="fan-label">Fan {metrics.fan.state ?? '…'}{metrics.fan.reason && metrics.fan.reason !== 'hysteresis' ? ` · ${metrics.fan.reason}` : ''}</span>
                  <div class="fan-modes">
                    {#each ['auto', 'on', 'off'] as mode}
                      <button
                        type="button"
                        class="fan-mode {metrics.fan.mode === mode ? 'active' : ''}"
                        onclick={() => setFanMode(mode)}
                      >{mode}</button>
                    {/each}
                  </div>
                </div>
              {/if}
            </div>
          </div>
          <div class="sparkline-container">
            <svg viewBox="0 0 120 32" preserveAspectRatio="none" class="sparkline">
              <path d={sparklineArea(gpuHistory, 120, 32)} fill="rgba(255, 159, 10, 0.12)" />
              <path d={sparklinePath(gpuHistory, 120, 32)} fill="none" stroke="#ff9f0a" stroke-width="1.5" />
            </svg>
          </div>
        </div>
      {/if}

      <!-- Unified Memory -->
      {#if metrics.memory}
        {@const totalUsedGB = (metrics.memory.total - metrics.memory.available) / (1024 ** 3)}
        {@const processRssGB = metrics.processes?.reduce((s, p) => s + parseFloat(p.memoryGB), 0) || 0}
        {@const gpuMemGB = Math.max(0, totalUsedGB - processRssGB)}
        {@const gpuPct = (gpuMemGB / metrics.memory.totalGB) * 100}
        {@const osPct = (processRssGB / metrics.memory.totalGB) * 100}
        <div class="card stat-card">
          <div class="stat-header">
            <h2>Memory</h2>
            <div class="stat-badge">{metrics.memory.usagePercent.toFixed(0)}%</div>
          </div>
          <div class="stat-body">
            <div class="mem-total">{totalUsedGB.toFixed(1)} <span class="mem-unit">/ {metrics.memory.totalGB} GB</span></div>
            <div class="mem-bar-container">
              <div class="mem-bar">
                <div class="mem-bar-gpu" style="width: {gpuPct}%"></div>
                <div class="mem-bar-os" style="width: {osPct}%"></div>
              </div>
            </div>
            <div class="mem-legend">
              <span><span class="mem-dot gpu"></span>GPU {gpuMemGB.toFixed(1)}G</span>
              <span><span class="mem-dot os"></span>OS {processRssGB.toFixed(1)}G</span>
              <span><span class="mem-dot free"></span>Free {formatBytes(metrics.memory.available)}G</span>
            </div>
          </div>
        </div>
      {/if}

      <!-- Disk -->
      {#if metrics.disk && metrics.disk.length > 0}
        {@const disk = metrics.disk.find(d => d.mount === '/') || metrics.disk[0]}
        <div class="card stat-card">
          <div class="stat-header">
            <h2>Disk</h2>
            <div class="stat-badge">{disk.usagePercent}%</div>
          </div>
          <div class="stat-body">
            <div class="mem-total">{disk.usedGB} <span class="mem-unit">/ {disk.sizeGB} GB</span></div>
            <div class="mem-bar-container">
              <div class="mem-bar">
                <div class="mem-bar-disk" style="width: {disk.usagePercent}%"></div>
              </div>
            </div>
            <div class="mem-legend">
              <span><span class="mem-dot disk"></span>Used {disk.usagePercent}%</span>
              <span><span class="mem-dot free"></span>Free {disk.availableGB} GB</span>
            </div>
            <div class="stat-sub mono">{disk.fs} · {disk.type} · {disk.mount}</div>
            {#if metrics.diskIO}
              <div class="disk-io-row">
                <span class="disk-io-item">
                  <span class="disk-io-label">Read</span>
                  <span class="disk-io-value read">{metrics.diskIO.readMBs?.toFixed(1) ?? '—'}</span>
                  <span class="disk-io-unit">MB/s</span>
                </span>
                <span class="disk-io-item">
                  <span class="disk-io-label">Write</span>
                  <span class="disk-io-value write">{metrics.diskIO.writeMBs?.toFixed(1) ?? '—'}</span>
                  <span class="disk-io-unit">MB/s</span>
                </span>
                {#if metrics.diskIO.temp !== null && metrics.diskIO.temp !== undefined}
                  <span class="disk-io-item">
                    <span class="disk-io-label">NVMe</span>
                    <span class="disk-io-value temp">{metrics.diskIO.temp}°C</span>
                  </span>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <!-- Network -->
      {#if metrics.network && metrics.network.length > 0}
        {@const net = metrics.network.find(n => n.iface === 'all') || metrics.network[0]}
        {@const ifaces = metrics.network.filter(n => n.iface !== 'all')}
        <div class="card stat-card">
          <div class="stat-header">
            <h2>Network</h2>
            <div class="stat-badge">{ifaces.length} iface</div>
          </div>
          <div class="stat-body">
            <div class="net-speeds">
              <div class="net-speed">
                <span class="net-label">↓ RX</span>
                <span class="net-value rx">{net.rx_sec_mb.toFixed(2)}</span>
                <span class="net-unit">MB/s</span>
              </div>
              <div class="net-speed">
                <span class="net-label">↑ TX</span>
                <span class="net-value tx">{net.tx_sec_mb.toFixed(2)}</span>
                <span class="net-unit">MB/s</span>
              </div>
            </div>
            <div class="iface-list">
              {#each ifaces.slice(0, 3) as iface}
                <div class="iface-row">
                  <span class="iface-name">{iface.iface}</span>
                  <span class="iface-stats">↓{iface.rx_sec_mb.toFixed(1)} ↑{iface.tx_sec_mb.toFixed(1)}</span>
                </div>
              {/each}
            </div>
          </div>
          <div class="sparkline-container">
            <svg viewBox="0 0 120 32" preserveAspectRatio="none" class="sparkline">
              <path d={sparklineArea(netRxHistory, 120, 32)} fill="rgba(100, 210, 255, 0.08)" />
              <path d={sparklinePath(netRxHistory, 120, 32)} fill="none" stroke="#64d2ff" stroke-width="1.5" />
              <path d={sparklinePath(netTxHistory, 120, 32)} fill="none" stroke="#30d158" stroke-width="1" opacity="0.7" />
            </svg>
          </div>
        </div>
      {/if}
    </div>

    <!-- Row 2: Power & Temperature Charts -->
    {#if metrics.gpu && metrics.gpu.length > 0}
      {@const gpu = metrics.gpu[0]}
      {@const tempMax = chartMaxTemp(chartView)}
      {@const powerMax = chartSeriesMax(chartView, 'gpuPower')}
      {@const powerPeak = peakOf(chartView, 'gpuPower')}
      {@const gpuPeak = peakOf(chartView, 'gpuTemp')}
      {@const cpuPeak = peakOf(chartView, 'cpuTemp')}
      {@const powerScale = powerMax !== null ? powerMax * CHART_HEADROOM : null}
      {@const tempScale = tempMax * CHART_HEADROOM}
      {@const bands = fanBands(chartView)}
      {@const yOn = thresholdY(metrics.fan?.thresholds?.on?.gpu ?? 65, tempScale)}
      {@const yOff = thresholdY(metrics.fan?.thresholds?.off?.gpu ?? 52, tempScale)}
      <div class="charts-grid">
        <!-- Power Chart -->
        <div class="card chart-card">
          <div class="section-header">
            <h2>System Power</h2>
            <div class="chart-value">
              {#if gpu.powerDraw !== null}
                <span class="chart-current">{gpu.powerDraw.toFixed(1)}</span>
                <span class="chart-unit">W</span>
              {/if}
              {#if gpu.powerLimit !== null}
                <span class="chart-limit">/ {gpu.powerLimit}W</span>
              {/if}
            </div>
          </div>
          <div class="chart-plot">
            <div class="chart-y-axis" aria-hidden="true">
              <span>{axisValue(powerScale)}</span>
              <span>{axisValue(powerScale !== null ? powerScale * 0.75 : null)}</span>
              <span>{axisValue(powerScale !== null ? powerScale * 0.5 : null)}</span>
              <span>{axisValue(powerScale !== null ? powerScale * 0.25 : null)}</span>
              <span>0</span>
            </div>
            <div class="chart-container">
              <svg viewBox="0 0 400 120" preserveAspectRatio="none" class="chart-svg">
                <!-- Grid lines -->
                <line x1="0" y1="30" x2="400" y2="30" stroke="var(--border-subtle)" stroke-width="0.5" stroke-dasharray="4" />
                <line x1="0" y1="60" x2="400" y2="60" stroke="var(--border-subtle)" stroke-width="0.5" stroke-dasharray="4" />
                <line x1="0" y1="90" x2="400" y2="90" stroke="var(--border-subtle)" stroke-width="0.5" stroke-dasharray="4" />
                <!-- Baseline -->
                <line x1="0" y1="120" x2="400" y2="120" stroke="var(--border-color)" stroke-width="1" />
                <!-- Area -->
                <path d={timeChartArea(chartView, 400, 120, 'gpuPower')} fill="rgba(255, 159, 10, 0.08)" />
                <!-- Line -->
                <path d={timeChartPath(chartView, 400, 120, 'gpuPower')} fill="none" stroke="#ff9f0a" stroke-width="2" />
                {#if powerPeak}
                  {@const pp = chartPointXY(powerPeak.t, powerPeak.v, 400, 120, powerScale)}
                  <line x1={pp.x.toFixed(1)} y1={pp.y.toFixed(1)} x2={pp.x.toFixed(1)} y2="120" stroke="#ff9f0a" stroke-width="1" stroke-dasharray="3 4" opacity="0.3" />
                  <circle cx={pp.x.toFixed(1)} cy={pp.y.toFixed(1)} r="7" fill="rgba(255, 159, 10, 0.18)" />
                  <circle cx={pp.x.toFixed(1)} cy={pp.y.toFixed(1)} r="3.6" fill="#ff9f0a" stroke="var(--bg-primary)" stroke-width="1.5" />
                {/if}
              </svg>
            </div>
          </div>
          <div class="chart-ticks">
            <span>{formatTick(Date.now() - chartRangeH * 3600 * 1000, chartRangeH >= 24)}</span>
            <span>{formatTick(Date.now(), false)}</span>
          </div>
          <div class="chart-labels">
            <span><span class="legend-dot power-dot"></span>Peak {powerPeak ? `${axisValue(powerPeak.v)}W` : '—'}</span>
            <span>Avg {gpu.powerDrawAvg !== null ? `${gpu.powerDrawAvg.toFixed(1)}W` : '—'}</span>
            <span>{gpu.powerLimit !== null ? `${gpu.powerLimit}W` : 'Max'}</span>
          </div>
        </div>

        <!-- Temperature Chart -->
        <div class="card chart-card">
          <div class="section-header">
            <h2>Temperature</h2>
            <div class="chart-value">
              {#if gpu.temperatureGpu !== null}
                <span class="chart-current gpu-temp">{gpu.temperatureGpu}°C</span>
              {/if}
              {#if metrics.cpu.temperature !== null}
                <span class="chart-current cpu-temp">{metrics.cpu.temperature}°C</span>
              {/if}
            </div>
          </div>
          <div class="chart-plot">
            <div class="chart-y-axis" aria-hidden="true">
              <span>{axisValue(tempScale)}</span>
              <span>{axisValue(tempScale * 0.75)}</span>
              <span>{axisValue(tempScale * 0.5)}</span>
              <span>{axisValue(tempScale * 0.25)}</span>
              <span>0</span>
            </div>
            <div class="chart-container">
              <svg viewBox="0 0 400 120" preserveAspectRatio="none" class="chart-svg">
                <!-- Fan on/off wash (behind the temperature series) -->
                {#each bands as b}
                  <rect
                    x={b.x.toFixed(2)}
                    y="0"
                    width={b.w.toFixed(2)}
                    height="120"
                    class={b.state === 'on' ? 'fan-band-on' : 'fan-band-off'}
                  />
                {/each}
                <!-- Grid lines -->
                <line x1="0" y1="30" x2="400" y2="30" stroke="var(--border-subtle)" stroke-width="0.5" stroke-dasharray="4" />
                <line x1="0" y1="60" x2="400" y2="60" stroke="var(--border-subtle)" stroke-width="0.5" stroke-dasharray="4" />
                <line x1="0" y1="90" x2="400" y2="90" stroke="var(--border-subtle)" stroke-width="0.5" stroke-dasharray="4" />
                <!-- Fan switch thresholds -->
                {#if yOn != null}
                  <line x1="0" y1={yOn.toFixed(1)} x2="400" y2={yOn.toFixed(1)} class="fan-threshold-on" />
                {/if}
                {#if yOff != null}
                  <line x1="0" y1={yOff.toFixed(1)} x2="400" y2={yOff.toFixed(1)} class="fan-threshold-off" />
                {/if}
                <!-- Baseline -->
                <line x1="0" y1="120" x2="400" y2="120" stroke="var(--border-color)" stroke-width="1" />
                <!-- GPU temp area -->
                <path d={timeChartArea(chartView, 400, 120, 'gpuTemp', { max: tempMax })} fill="rgba(255, 159, 10, 0.06)" />
                <!-- GPU temp line -->
                <path d={timeChartPath(chartView, 400, 120, 'gpuTemp', { max: tempMax })} fill="none" stroke="#ff9f0a" stroke-width="2" />
                <!-- CPU temp line -->
                <path d={timeChartPath(chartView, 400, 120, 'cpuTemp', { max: tempMax })} fill="none" stroke="#0a84ff" stroke-width="1.5" opacity="0.8" />
                {#if gpuPeak}
                  {@const gp = chartPointXY(gpuPeak.t, gpuPeak.v, 400, 120, tempScale)}
                  <line x1={gp.x.toFixed(1)} y1={gp.y.toFixed(1)} x2={gp.x.toFixed(1)} y2="120" stroke="#ff9f0a" stroke-width="1" stroke-dasharray="3 4" opacity="0.3" />
                  <circle cx={gp.x.toFixed(1)} cy={gp.y.toFixed(1)} r="7" fill="rgba(255, 159, 10, 0.18)" />
                  <circle cx={gp.x.toFixed(1)} cy={gp.y.toFixed(1)} r="3.6" fill="#ff9f0a" stroke="var(--bg-primary)" stroke-width="1.5" />
                {/if}
                {#if cpuPeak}
                  {@const cp = chartPointXY(cpuPeak.t, cpuPeak.v, 400, 120, tempScale)}
                  <line x1={cp.x.toFixed(1)} y1={cp.y.toFixed(1)} x2={cp.x.toFixed(1)} y2="120" stroke="#0a84ff" stroke-width="1" stroke-dasharray="3 4" opacity="0.3" />
                  <circle cx={cp.x.toFixed(1)} cy={cp.y.toFixed(1)} r="7" fill="rgba(10, 132, 255, 0.18)" />
                  <circle cx={cp.x.toFixed(1)} cy={cp.y.toFixed(1)} r="3.6" fill="#0a84ff" stroke="var(--bg-primary)" stroke-width="1.5" />
                {/if}
                <!-- Fan state strip along the baseline -->
                {#each bands as b}
                  <rect
                    x={b.x.toFixed(2)}
                    y="113"
                    width={b.w.toFixed(2)}
                    height="7"
                    rx="0.5"
                    class={b.state === 'on' ? 'fan-strip-on' : 'fan-strip-off'}
                  />
                {/each}
              </svg>
            </div>
          </div>
          <div class="chart-ticks">
            <span>{formatTick(Date.now() - chartRangeH * 3600 * 1000, chartRangeH >= 24)}</span>
            <span>{formatTick(Date.now(), false)}</span>
          </div>
          <div class="chart-labels">
            <span><span class="legend-dot gpu-temp-dot"></span>GPU peak {gpuPeak ? `${axisValue(gpuPeak.v)}°C` : '—'}</span>
            <span><span class="legend-dot cpu-temp-dot"></span>CPU peak {cpuPeak ? `${axisValue(cpuPeak.v)}°C` : '—'}</span>
            <span><span class="legend-dot fan-on-dot"></span>Fan on</span>
            <span><span class="legend-dot fan-off-dot"></span>Fan off</span>
          </div>
        </div>
      </div>
      <div class="chart-controls">
        <div class="range-toggle" role="group" aria-label="Chart time range">
          {#each CHART_RANGES as r}
            <button
              class="range-btn {chartRangeH === r.value ? 'active' : ''}"
              aria-pressed={chartRangeH === r.value}
              onclick={() => (chartRangeH = r.value)}
            >{r.label}</button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Row 3: System Events (boot / crash / throttling) -->
    {#if metrics.events && metrics.events.length > 0}
      <div class="card events-card">
        <div class="section-header">
          <h2>Events</h2>
          <span class="section-sub">boot · crash · throttling · fan</span>
        </div>
        <div class="events-list">
          {#each [...metrics.events].reverse().slice(0, 8) as ev}
            <div class="event-row">
              <span class="event-dot {ev.type}"></span>
              <span class="event-time">{new Date(ev.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <span class="event-text">{eventText(ev)}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Row 4: Processes -->
    {#if metrics.processes && metrics.processes.length > 0}
      <div class="card processes-card">
        <div class="section-header">
          <h2>Top Processes</h2>
          <span class="section-sub">by memory usage</span>
        </div>
        <div class="processes-table">
          <div class="processes-head">
            <span>Process</span>
            <span>User</span>
            <span class="num">Memory</span>
            <span class="num">CPU</span>
          </div>
          {#each metrics.processes.slice(0, 8) as process}
            {@const isComfyUI = process.command.toLowerCase().includes('comfyui')}
            <div class="process-row {isComfyUI ? 'comfyui-row' : ''}">
              <div class="process-name" title="{process.command}">
                {process.command.split(' ')[0].split('/').pop()}
                {#if isComfyUI}<span class="comfyui-badge">ComfyUI</span>{/if}
              </div>
              <div class="process-user">{process.user}</div>
              <div class="process-mem num">{process.memoryGB} GB</div>
              <div class="process-cpu num">{process.cpu}%</div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Row 3: Inference Engines -->
    {#if metrics.inference}
      <div class="models-grid">
        <!-- llama.cpp -->
        <div class="card models-card">
          <div class="section-header">
            <h2>llama.cpp</h2>
            {#if metrics.inference.llama.status === 'running'}
              <span class="engine-pill running">:{metrics.inference.llama.proxyPort}</span>
            {:else if metrics.inference.llama.status === 'loading'}
              <span class="engine-pill loading">Loading</span>
            {:else}
              <span class="engine-pill stopped">Stopped</span>
            {/if}
          </div>
          {#if metrics.inference.health?.llama}
            <div class="engine-health {metrics.inference.health.llama.online ? 'online' : 'offline'}">
              {healthText(metrics.inference.health.llama, metrics.timestamp)}
            </div>
          {/if}
          <div class="models-list">
            {#if metrics.inference.availableModels?.llama}
              {#each metrics.inference.availableModels.llama as model}
                {@const isRunning = metrics.inference.llama.status !== 'stopped' && (metrics.inference.llama.model === model.key || (metrics.inference.llama.model && model.name && metrics.inference.llama.model.includes(model.name.split('-00')[0])))}
                {@const noteId = `llama:${model.key}`}
                <div class="model-item {isRunning ? 'loaded' : ''}">
                  <div class="model-header-row">
                    <div class="model-name">{model.name || model.key}</div>
                    {#if isRunning}
                      <span class="running-badge">{metrics.inference.llama.status === 'loading' ? 'LOADING' : 'RUNNING'}</span>
                    {/if}
                  </div>
                  <div class="model-info">
                    {#if model.sizeGB}<span class="model-size">{model.sizeGB} GB</span>{/if}
                    {#if isRunning && metrics.inference.llama.quantFormat}<span class="model-quant">{metrics.inference.llama.quantFormat}</span>{/if}
                    {#if isRunning && metrics.inference.llama.paramSize}<span class="model-params">{metrics.inference.llama.paramSize}</span>{/if}
                    {#if model.ctx}<span class="model-params">ctx {(model.ctx / 1024).toFixed(0)}K</span>{/if}
                    {#if isRunning && metrics.inference.llama.ctxSize}<span class="model-params active-ctx">active {(metrics.inference.llama.ctxSize / 1024).toFixed(0)}K</span>{/if}
                  </div>
                  {#if editingNote === noteId}
                    <div class="note-edit">
                      <textarea bind:value={noteInput} placeholder="Add note..." rows="2" onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNote(noteId); } if (e.key === 'Escape') cancelEdit(); }}></textarea>
                      <div class="note-actions">
                        <button class="note-btn save" onclick={() => saveNote(noteId)}>Save</button>
                        <button class="note-btn cancel" onclick={cancelEdit}>Cancel</button>
                      </div>
                    </div>
                  {:else}
                    <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                      {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
                      <span class="note-edit-icon" title="Edit note">✏️</span>
                    </div>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>
        </div>

        <!-- vLLM -->
        <div class="card models-card">
          <div class="section-header">
            <h2>vLLM</h2>
            {#if metrics.inference.vllm.status === 'running'}
              <span class="engine-pill running">Running</span>
            {:else if metrics.inference.vllm.status === 'loading' || metrics.inference.vllm.status === 'starting'}
              <span class="engine-pill loading">{metrics.inference.vllm.status}</span>
            {:else}
              <span class="engine-pill stopped">Stopped</span>
            {/if}
          </div>
          {#if metrics.inference.health?.vllm}
            <div class="engine-health {metrics.inference.health.vllm.online ? 'online' : 'offline'}">
              {healthText(metrics.inference.health.vllm, metrics.timestamp)}
            </div>
          {/if}
          <div class="models-list">
            {#if metrics.inference.availableModels?.vllm && metrics.inference.availableModels.vllm.length > 0}
              {#each metrics.inference.availableModels.vllm as model}
                {@const isRunning = metrics.inference.vllm.status !== 'stopped' && metrics.inference.vllm.model && model.name.includes(metrics.inference.vllm.model)}
                {@const noteId = `vllm:${model.name}`}
                <div class="model-item {isRunning ? 'loaded' : ''}">
                  <div class="model-header-row">
                    <div class="model-name">{model.name.split('/').pop()}</div>
                    {#if isRunning}
                      <span class="running-badge">{metrics.inference.vllm.status === 'running' ? 'RUNNING' : 'LOADING'}</span>
                    {/if}
                  </div>
                  <div class="model-info">
                    <span class="model-size">{model.sizeGB} GB</span>
                    <span class="model-params">{model.name.split('/')[0]}</span>
                  </div>
                  {#if editingNote === noteId}
                    <div class="note-edit">
                      <textarea bind:value={noteInput} placeholder="Add note..." rows="2" onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNote(noteId); } if (e.key === 'Escape') cancelEdit(); }}></textarea>
                      <div class="note-actions">
                        <button class="note-btn save" onclick={() => saveNote(noteId)}>Save</button>
                        <button class="note-btn cancel" onclick={cancelEdit}>Cancel</button>
                      </div>
                    </div>
                  {:else}
                    <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                      {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
                      <span class="note-edit-icon" title="Edit note">✏️</span>
                    </div>
                  {/if}
                </div>
              {/each}
            {:else}
              <div class="model-empty">No models downloaded</div>
            {/if}
          </div>
        </div>

        <!-- Ollama -->
        {#if metrics.inference.ollama}
          <div class="card models-card">
            <div class="section-header">
              <h2>Ollama</h2>
              {#if metrics.inference.ollama.available}
                <span class="engine-pill running">:{metrics.inference.ollama.port}</span>
              {:else}
                <span class="engine-pill stopped">Stopped</span>
              {/if}
            </div>
            {#if metrics.inference.health?.ollama}
              <div class="engine-health {metrics.inference.health.ollama.online ? 'online' : 'offline'}">
                {healthText(metrics.inference.health.ollama, metrics.timestamp)}
              </div>
            {/if}
            <div class="models-list">
              {#if metrics.inference.ollama.models && metrics.inference.ollama.models.length > 0}
                {#each metrics.inference.ollama.models as model}
                  {@const isRunning = metrics.inference.ollama.runningModel === model.name}
                  {@const noteId = `ollama:${model.name}`}
                  <div class="model-item {isRunning ? 'loaded' : ''}">
                    <div class="model-header-row">
                      <div class="model-name">{model.name}</div>
                      {#if isRunning}<span class="running-badge">LOADED</span>{/if}
                    </div>
                    <div class="model-info">
                      {#if model.sizeGB}<span class="model-size">{model.sizeGB} GB</span>{/if}
                      {#if model.quantFormat}<span class="model-quant">{model.quantFormat}</span>{/if}
                      {#if model.paramSize}<span class="model-params">{model.paramSize}</span>{/if}
                      {#if model.family}<span class="model-params">{model.family}</span>{/if}
                    </div>
                    {#if editingNote === noteId}
                      <div class="note-edit">
                        <textarea bind:value={noteInput} placeholder="Add note..." rows="2" onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNote(noteId); } if (e.key === 'Escape') cancelEdit(); }}></textarea>
                        <div class="note-actions">
                          <button class="note-btn save" onclick={() => saveNote(noteId)}>Save</button>
                          <button class="note-btn cancel" onclick={cancelEdit}>Cancel</button>
                        </div>
                      </div>
                    {:else}
                      <div class="note-display" onclick={() => startEditNote(noteId, getNote(noteId))}>
                        {#if getNote(noteId)}<span class="note-text">{getNote(noteId)}</span>{/if}
                        <span class="note-edit-icon" title="Edit note">✏️</span>
                      </div>
                    {/if}
                  </div>
                {/each}
              {:else}
                <div class="model-empty">No models</div>
              {/if}
            </div>
          </div>
        {/if}

        <!-- ComfyUI -->
        <div class="card models-card">
          <div class="section-header">
            <h2>ComfyUI</h2>
            <div class="engine-actions">
              {#if metrics.inference.comfyui?.pending === 'start'}
                <span class="engine-pill loading">Starting</span>
              {:else if metrics.inference.comfyui?.pending === 'stop'}
                <span class="engine-pill loading">Stopping</span>
              {:else if metrics.inference.comfyui?.running}
                <span class="engine-pill running">:{metrics.inference.comfyui.port}</span>
              {:else}
                <span class="engine-pill stopped">Stopped</span>
              {/if}
              {#if metrics.inference.comfyui?.running || metrics.inference.comfyui?.pending === 'stop'}
                <button
                  type="button"
                  class="engine-btn stop"
                  disabled={comfyBusy || metrics.inference.comfyui?.pending === 'stop'}
                  onclick={() => controlComfy('stop')}
                >Stop</button>
              {:else}
                <button
                  type="button"
                  class="engine-btn start"
                  disabled={comfyBusy || metrics.inference.comfyui?.pending === 'start'}
                  onclick={() => controlComfy('start')}
                >Start</button>
              {/if}
            </div>
          </div>
          {#if metrics.inference.health?.comfyui}
            <div class="engine-health {metrics.inference.health.comfyui.online ? 'online' : 'offline'}">
              {healthText(metrics.inference.health.comfyui, metrics.timestamp)}
            </div>
          {/if}
          <div class="models-list">
            {#if metrics.inference.comfyui?.running}
              <div class="model-item loaded">
                <div class="model-header-row">
                  <div class="model-name" title="{metrics.inference.comfyui.command}">{metrics.inference.comfyui.command.split(' ')[0].split('/').pop()}</div>
                  <span class="running-badge">RUNNING</span>
                </div>
                <div class="model-info">
                  <span class="model-size">{metrics.inference.comfyui.memoryGB} GB</span>
                  <span class="model-params">CPU {metrics.inference.comfyui.cpu}%</span>
                  <span class="model-params">PID {metrics.inference.comfyui.pid}</span>
                </div>
              </div>
            {:else if metrics.inference.comfyui?.pending === 'start'}
              <div class="model-empty">Starting on :{metrics.inference.comfyui.port}…</div>
            {:else}
              <div class="model-empty">Not running</div>
            {/if}
            {#if metrics.inference.comfyui?.error}
              <div class="model-empty comfy-error">{metrics.inference.comfyui.error}</div>
            {/if}
          </div>
        </div>
      </div>
    {/if}

    <div class="footer">
      Last updated {new Date(metrics.timestamp).toLocaleTimeString()}
    </div>
  {:else}
    <div class="loading-state">
      <div class="skeleton-grid" aria-hidden="true">
        <div class="skeleton-card"></div>
        <div class="skeleton-card"></div>
        <div class="skeleton-card"></div>
        <div class="skeleton-card"></div>
      </div>
      <div class="loading-status">
        <div class="loading-spinner"></div>
        <div class="loading-text">Loading system metrics…</div>
      </div>
    </div>
  {/if}
</div>

<style>
  .dashboard {
    min-height: 100vh;
    padding: 1.5rem 2rem 2rem;
    max-width: 1600px;
    margin: 0 auto;
  }

  /* Header */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    margin-bottom: 1.5rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border-color);
  }

  .header-title h1 {
    margin: 0;
    font-size: 2.4rem;
    font-weight: 700;
    letter-spacing: -0.03em;
    color: var(--text-primary);
    line-height: 1.1;
  }

  .system-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.35rem;
    font-size: 0.95rem;
    color: var(--text-secondary);
  }

  .hostname {
    color: var(--text-primary);
    font-weight: 500;
  }

  .meta-divider {
    color: var(--text-tertiary);
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .theme-toggle {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    border: 1px solid var(--border-color);
    background: var(--bg-card);
    color: var(--text-primary);
    font-size: 1rem;
    cursor: pointer;
    transition: all var(--transition-fast);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
  }

  .theme-toggle:hover {
    background: var(--bg-card-hover);
    border-color: var(--border-color-hover);
    transform: scale(1.05);
  }

  .uptime-pill {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.75rem;
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 999px;
    font-size: 0.9rem;
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
  }

  .uptime-label {
    color: var(--text-secondary);
  }

  .uptime-value {
    color: var(--text-primary);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .status-pill {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.75rem;
    border-radius: 999px;
    font-size: 0.9rem;
    font-weight: 600;
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid transparent;
  }

  .status-pill.connected {
    background: rgba(48, 209, 88, 0.12);
    color: #30d158;
    border-color: rgba(48, 209, 88, 0.25);
  }

  .status-pill.disconnected {
    background: rgba(255, 69, 58, 0.12);
    color: #ff453a;
    border-color: rgba(255, 69, 58, 0.25);
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }

  /* Cards */
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 1rem;
    transition: all var(--transition-normal);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    box-shadow: var(--shadow-sm);
  }

  .card:hover {
    background: var(--bg-card-hover);
    border-color: var(--border-color-hover);
    box-shadow: var(--shadow-md);
  }

  /* Stats Grid */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .stat-card {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .stat-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }

  .stat-header h2 {
    margin: 0;
    font-size: 0.85rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }

  .stat-badge {
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
    background: var(--bg-subtle);
    padding: 0.15rem 0.5rem;
    border-radius: 6px;
  }

  .stat-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .stat-body .gauge-wrap {
    display: flex;
    justify-content: center;
    margin: 0.25rem 0;
  }

  .stat-details {
    text-align: center;
  }

  .stat-main {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .stat-sub {
    font-size: 0.85rem;
    color: var(--text-secondary);
    margin-top: 0.15rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .stat-sub.mono {
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 0.8rem;
  }

  /* Per-core mini bars */
  .per-core-grid {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 2px;
    height: 24px;
    margin-top: 0.5rem;
    padding: 0 0.25rem;
  }

  .core-bar-wrap {
    flex: 1;
    max-width: 12px;
    height: 100%;
    background: var(--bg-subtle);
    border-radius: 2px;
    overflow: hidden;
    display: flex;
    align-items: flex-end;
  }

  .core-bar {
    width: 100%;
    background: #30d158;
    border-radius: 2px;
    transition: height 0.4s ease;
  }

  /* Sparkline */
  .sparkline-container {
    width: 100%;
    height: 32px;
    margin-top: 0.5rem;
  }

  .sparkline {
    width: 100%;
    height: 100%;
  }

  /* Memory / Disk */
  .mem-total {
    font-size: 1.6rem;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: -0.02em;
    text-align: center;
  }

  .mem-unit {
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .mem-bar-container {
    width: 100%;
  }

  .mem-bar {
    width: 100%;
    height: 8px;
    background: var(--bg-subtle);
    border-radius: 999px;
    overflow: hidden;
    display: flex;
  }

  .mem-bar-gpu {
    height: 100%;
    background: linear-gradient(90deg, #ff9f0a, #ffb340);
    transition: width 0.5s ease;
  }

  .mem-bar-os {
    height: 100%;
    background: linear-gradient(90deg, #0a84ff, #409cff);
    transition: width 0.5s ease;
  }

  .mem-bar-disk {
    height: 100%;
    background: linear-gradient(90deg, #bf5af2, #d17aff);
    transition: width 0.5s ease;
  }

  .mem-legend {
    display: flex;
    justify-content: center;
    gap: 0.75rem;
    font-size: 0.8rem;
    color: var(--text-secondary);
    flex-wrap: wrap;
  }

  .mem-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    display: inline-block;
    vertical-align: middle;
    margin-right: 3px;
  }

  .mem-dot.gpu { background: #ff9f0a; }
  .mem-dot.os { background: #0a84ff; }
  .mem-dot.disk { background: #bf5af2; }
  .mem-dot.free { background: var(--bg-subtle-hover); border: 1px solid var(--border-color-hover); }

  /* Network */
  .net-speeds {
    display: flex;
    justify-content: space-around;
    gap: 0.5rem;
  }

  .net-speed {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.1rem;
  }

  .net-label {
    font-size: 0.75rem;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .net-value {
    font-size: 1.4rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
  }

  .net-value.rx { color: #64d2ff; }
  .net-value.tx { color: #30d158; }

  .net-unit {
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .iface-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border-subtle);
  }

  .iface-row {
    display: flex;
    justify-content: space-between;
    font-size: 0.8rem;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
  }

  .iface-name {
    color: var(--text-secondary);
  }

  .iface-stats {
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }

  /* Section headers */
  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }

  .section-header h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .section-sub {
    font-size: 0.85rem;
    color: var(--text-tertiary);
  }

  /* Processes */
  .processes-card {
    margin-bottom: 1rem;
  }

  .processes-table {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .processes-head,
  .process-row {
    display: grid;
    grid-template-columns: 2fr 1fr 0.8fr 0.6fr;
    gap: 0.75rem;
    align-items: center;
    padding: 0.4rem 0.5rem;
    border-radius: var(--radius-sm);
  }

  .processes-head {
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .process-row {
    font-size: 0.9rem;
    transition: background var(--transition-fast);
  }

  .process-row:hover {
    background: var(--bg-subtle);
  }

  .process-row.comfyui-row {
    background: rgba(48, 209, 88, 0.06);
    border-left: 2px solid #30d158;
    margin-left: -0.5rem;
    padding-left: calc(0.5rem - 2px);
  }

  .process-row.comfyui-row:hover {
    background: rgba(48, 209, 88, 0.1);
  }

  .comfyui-badge {
    font-size: 0.65rem;
    font-weight: 700;
    color: #30d158;
    background: rgba(48, 209, 88, 0.15);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    margin-left: 0.4rem;
    vertical-align: middle;
    letter-spacing: 0.02em;
  }

  .process-name {
    color: var(--text-primary);
    font-weight: 500;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .process-user {
    color: var(--text-secondary);
    font-size: 0.85rem;
  }

  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .process-mem {
    color: #30d158;
    font-weight: 600;
  }

  .process-cpu {
    color: #ff9f0a;
  }

  /* Models */
  .models-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .models-card {
    min-height: 0;
    max-height: 480px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .models-card .models-list {
    overflow-y: auto;
    flex: 1;
    padding-right: 0.25rem;
  }

  .models-card .models-list::-webkit-scrollbar {
    width: 4px;
  }

  .models-card .models-list::-webkit-scrollbar-track {
    background: transparent;
  }

  .models-card .models-list::-webkit-scrollbar-thumb {
    background: var(--border-subtle);
    border-radius: 2px;
  }

  .engine-pill {
    font-size: 0.8rem;
    font-weight: 600;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }

  .engine-pill.running {
    background: rgba(48, 209, 88, 0.12);
    color: #30d158;
    border: 1px solid rgba(48, 209, 88, 0.2);
  }

  .engine-pill.loading {
    background: rgba(255, 214, 10, 0.12);
    color: #ffd60a;
    border: 1px solid rgba(255, 214, 10, 0.2);
  }

  .engine-pill.stopped {
    background: rgba(255, 69, 58, 0.12);
    color: #ff453a;
    border: 1px solid rgba(255, 69, 58, 0.2);
  }

  .engine-actions {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }

  .engine-btn {
    appearance: none;
    border: 1px solid var(--border-subtle);
    background: var(--bg-subtle);
    color: var(--text-secondary);
    font: inherit;
    font-size: 0.75rem;
    font-weight: 650;
    letter-spacing: 0.03em;
    padding: 0.22rem 0.65rem;
    border-radius: 999px;
    cursor: pointer;
  }

  .engine-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .engine-btn.start {
    color: #30d158;
    border-color: rgba(48, 209, 88, 0.28);
    background: rgba(48, 209, 88, 0.1);
  }

  .engine-btn.stop {
    color: #ff453a;
    border-color: rgba(255, 69, 58, 0.28);
    background: rgba(255, 69, 58, 0.1);
  }

  .comfy-error {
    color: #ff453a !important;
  }

  /* Engine availability line */
  .engine-health {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
    margin: -0.35rem 0 0.6rem;
    font-variant-numeric: tabular-nums;
  }

  .engine-health::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .engine-health.online {
    color: var(--text-secondary);
  }

  .engine-health.online::before {
    background: #30d158;
  }

  .engine-health.offline {
    color: #ff453a;
    font-weight: 600;
  }

  .engine-health.offline::before {
    background: #ff453a;
  }

  /* Disk I/O mini stats */
  .disk-io-row {
    display: flex;
    justify-content: space-around;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border-subtle);
  }

  .disk-io-item {
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
  }

  .disk-io-label {
    font-size: 0.7rem;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .disk-io-value {
    font-size: 1rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .disk-io-value.read { color: #64d2ff; }
  .disk-io-value.write { color: #30d158; }
  .disk-io-value.temp { color: #bf5af2; }

  .disk-io-unit {
    font-size: 0.7rem;
    color: var(--text-secondary);
  }

  /* GPU throttle warning */
  .throttle-warning {
    color: #ff453a !important;
    font-weight: 600;
  }

  /* Benign clock/power states (e.g. SW Power Cap on GB10) */
  .throttle-info {
    color: var(--text-secondary);
  }

  .fan-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem 0.65rem;
    margin-top: 0.35rem;
  }

  .fan-label {
    color: var(--text-secondary);
    font-size: 0.78rem;
  }

  .fan-modes {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border-radius: 8px;
    background: var(--bg-subtle);
    border: 1px solid var(--border-subtle);
  }

  .fan-mode {
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--text-tertiary);
    font: inherit;
    font-size: 0.7rem;
    font-weight: 650;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 0.18rem 0.45rem;
    border-radius: 6px;
    cursor: pointer;
  }

  .fan-mode.active {
    background: rgba(100, 210, 255, 0.16);
    color: #64d2ff;
  }

  .models-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
  }

  .model-item {
    padding: 0.6rem 0.75rem;
    background: var(--bg-subtle);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
    transition: all var(--transition-fast);
  }

  .model-item:hover {
    background: var(--bg-subtle-hover);
  }

  .model-item.loaded {
    background: rgba(48, 209, 88, 0.08);
    border-color: rgba(48, 209, 88, 0.3);
    box-shadow: 0 0 20px rgba(48, 209, 88, 0.1);
  }

  .model-header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }

  .model-name {
    color: var(--text-primary);
    font-weight: 600;
    font-size: 0.95rem;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .running-badge {
    font-size: 0.7rem;
    font-weight: 700;
    color: #30d158;
    background: rgba(48, 209, 88, 0.15);
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }

  .model-info {
    display: flex;
    gap: 0.5rem;
    font-size: 0.85rem;
    flex-wrap: wrap;
    margin-top: 0.35rem;
  }

  .model-size {
    color: #30d158;
    font-weight: 600;
  }

  .model-quant {
    color: #ffd60a;
    font-weight: 600;
    background: rgba(255, 214, 10, 0.12);
    padding: 0.05rem 0.4rem;
    border-radius: 4px;
    font-size: 0.8em;
  }

  .model-params {
    color: var(--text-secondary);
  }

  .model-params.active-ctx {
    color: #30d158;
    font-weight: 600;
  }

  .model-empty {
    color: var(--text-tertiary);
    font-size: 0.9rem;
    padding: 1rem 0;
    text-align: center;
  }

  /* Notes */
  .note-display {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.4rem;
    cursor: pointer;
    min-height: 1.2rem;
  }

  .note-display:hover .note-edit-icon {
    opacity: 1;
  }

  .note-text {
    color: var(--text-secondary);
    font-size: 0.85em;
    line-height: 1.4;
    white-space: pre-wrap;
  }

  .note-edit-icon {
    opacity: 0.25;
    font-size: 0.8em;
    transition: opacity var(--transition-fast);
    flex-shrink: 0;
  }

  .note-edit {
    margin-top: 0.4rem;
  }

  .note-edit textarea {
    width: 100%;
    background: var(--bg-subtle);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    border-radius: var(--radius-sm);
    padding: 0.5rem;
    font-size: 0.9em;
    font-family: inherit;
    resize: vertical;
    transition: border-color var(--transition-fast);
  }

  .note-edit textarea:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  .note-actions {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.4rem;
  }

  .note-btn {
    padding: 0.25rem 0.75rem;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85em;
    font-weight: 600;
    transition: all var(--transition-fast);
  }

  .note-btn.save {
    background: var(--accent-blue);
    color: #fff;
  }

  .note-btn.save:hover {
    background: #409cff;
  }

  .note-btn.cancel {
    background: var(--bg-subtle);
    color: var(--text-secondary);
  }

  .note-btn.cancel:hover {
    background: var(--bg-subtle-hover);
  }

  /* Charts */
  .charts-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .chart-card {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .chart-value {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  .chart-current {
    font-size: 1.2rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
  }

  .chart-current.gpu-temp { color: #ff9f0a; }
  .chart-current.cpu-temp { color: #0a84ff; }

  .chart-unit {
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .chart-limit {
    font-size: 0.85rem;
    color: var(--text-tertiary);
  }

  .chart-container {
    width: 100%;
    height: 120px;
    margin-top: 0.5rem;
  }

  .chart-svg {
    width: 100%;
    height: 100%;
  }

  .chart-labels {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 0.5rem;
    font-size: 0.75rem;
    color: var(--text-tertiary);
  }

  .chart-ticks {
    display: flex;
    justify-content: space-between;
    margin-top: 0.2rem;
    font-size: 0.7rem;
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
  }

  .chart-controls {
    display: flex;
    justify-content: center;
    margin-bottom: 1rem;
  }

  .range-toggle {
    display: inline-flex;
    padding: 3px;
    border-radius: 999px;
    background: var(--bg-subtle);
    border: 1px solid var(--border-subtle);
  }

  .range-btn {
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.8rem;
    font-weight: 600;
    padding: 0.35rem 1.1rem;
    border-radius: 999px;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .range-btn:hover {
    color: var(--text-primary);
  }

  .range-btn.active {
    background: var(--accent-blue);
    color: #fff;
  }

  .legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    vertical-align: middle;
    margin-right: 4px;
  }

  .legend-dot.gpu-temp-dot { background: #ff9f0a; }
  .legend-dot.cpu-temp-dot { background: #0a84ff; }
  .legend-dot.fan-on-dot { background: #64d2ff; }
  .legend-dot.fan-off-dot { background: #636366; }

  .fan-band-on { fill: rgba(100, 210, 255, 0.16); }
  .fan-band-off { fill: rgba(99, 99, 102, 0.06); }
  .fan-strip-on { fill: #64d2ff; }
  .fan-strip-off { fill: #636366; }
  .fan-threshold-on {
    stroke: #64d2ff;
    stroke-width: 0.8;
    stroke-dasharray: 5 4;
    opacity: 0.55;
  }
  .fan-threshold-off {
    stroke: #8e8e93;
    stroke-width: 0.8;
    stroke-dasharray: 4 5;
    opacity: 0.4;
  }

  :global([data-theme='light']) .fan-band-on { fill: rgba(0, 122, 255, 0.12); }
  :global([data-theme='light']) .fan-band-off { fill: rgba(60, 60, 67, 0.05); }
  :global([data-theme='light']) .fan-strip-on { fill: #007aff; }
  :global([data-theme='light']) .legend-dot.fan-on-dot { background: #007aff; }

  /* Events */
  .events-card {
    margin-bottom: 1rem;
  }

  .events-list {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    max-height: 180px;
    overflow-y: auto;
  }

  .event-row {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    font-size: 0.85rem;
    padding: 0.3rem 0.5rem;
    border-radius: var(--radius-sm);
  }

  .event-row:hover {
    background: var(--bg-subtle);
  }

  .event-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    align-self: center;
  }

  .event-dot.boot { background: #0a84ff; }
  .event-dot.unclean_shutdown { background: #ff453a; }
  .event-dot.throttle_start { background: #ff9f0a; }
  .event-dot.throttle_end { background: #30d158; }
  .event-dot.fan_on { background: #64d2ff; }
  .event-dot.fan_off { background: #8e8e93; }
  .event-dot.fan_error { background: #ff453a; }
  .event-dot.comfy_start { background: #30d158; }
  .event-dot.comfy_stop { background: #ff9f0a; }

  .event-time {
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
    min-width: 7.5rem;
  }

  .event-text {
    color: var(--text-secondary);
  }

  /* Footer */
  .footer {
    text-align: center;
    color: var(--text-tertiary);
    font-size: 0.85rem;
    margin-top: 1rem;
    padding: 0.5rem 0;
  }

  /* Loading */
  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 50vh;
    gap: 1rem;
  }

  .loading-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--bg-subtle);
    border-top-color: var(--accent-blue);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .loading-text {
    color: var(--text-secondary);
    font-size: 1rem;
  }

  /* Responsive */
  @media (max-width: 1400px) {
    .stats-grid {
      grid-template-columns: repeat(3, 1fr);
    }
  }

  @media (max-width: 1024px) {
    .stats-grid {
      grid-template-columns: repeat(2, 1fr);
    }
    .models-grid {
      grid-template-columns: 1fr;
    }
    .processes-head,
    .process-row {
      grid-template-columns: 2fr 1fr 1fr 1fr;
    }
  }

  @media (max-width: 640px) {
    .dashboard {
      padding: 1rem;
    }
    .header {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.75rem;
    }
    .header-right {
      width: 100%;
      justify-content: space-between;
    }
    .stats-grid {
      grid-template-columns: 1fr;
    }
    .processes-head,
    .process-row {
      grid-template-columns: 1.5fr 0.8fr 0.8fr 0.6fr;
      font-size: 0.85rem;
    }
  }

  /* ── 2026 visual refresh: deep-space glass, refined type, micro-motion ── */

  .dashboard {
    max-width: 1680px;
    padding: clamp(1.25rem, 3vw, 2.5rem);
  }

  .dashboard > * {
    animation: fade-rise 0.5s var(--ease-spring) both;
  }

  .dashboard > *:nth-child(2) { animation-delay: 0.05s; }
  .dashboard > *:nth-child(3) { animation-delay: 0.1s; }
  .dashboard > *:nth-child(4) { animation-delay: 0.15s; }
  .dashboard > *:nth-child(5) { animation-delay: 0.2s; }
  .dashboard > *:nth-child(6) { animation-delay: 0.25s; }
  .dashboard > *:nth-child(7) { animation-delay: 0.3s; }
  .dashboard > *:nth-child(8) { animation-delay: 0.35s; }

  .header {
    align-items: center;
    margin-bottom: 1.75rem;
    padding-bottom: 1.25rem;
  }

  .header-title {
    display: flex;
    align-items: center;
    gap: 0.85rem;
  }

  .header-title::before {
    content: '';
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
    background: conic-gradient(from 180deg, #0a84ff, #bf5af2, #ff9f0a, #0a84ff);
    box-shadow: 0 0 18px rgba(10, 132, 255, 0.65);
  }

  .header-title h1 {
    font-size: clamp(1.7rem, 3vw, 2.2rem);
    letter-spacing: -0.035em;
    line-height: 1.05;
  }

  .system-meta {
    gap: 0.55rem;
    margin-top: 0.3rem;
    font-size: 0.9rem;
  }

  .hostname {
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  .theme-toggle {
    width: 38px;
    height: 38px;
    border-radius: 12px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
  }

  .theme-toggle:hover {
    transform: scale(1.06) rotate(8deg);
  }

  .uptime-pill,
  .status-pill {
    padding: 0.42rem 0.9rem;
    font-size: 0.85rem;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }

  .status-dot {
    width: 7px;
    height: 7px;
    animation: pulse-dot 2.2s ease-out infinite;
  }

  .status-pill.disconnected .status-dot {
    animation: none;
  }

  @keyframes pulse-dot {
    0% { box-shadow: 0 0 0 0 rgba(48, 209, 88, 0.45); }
    70% { box-shadow: 0 0 0 6px rgba(48, 209, 88, 0); }
    100% { box-shadow: 0 0 0 0 rgba(48, 209, 88, 0); }
  }

  .card {
    position: relative;
    padding: 1.25rem;
    border-radius: var(--radius-md);
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    backdrop-filter: blur(28px) saturate(170%);
    -webkit-backdrop-filter: blur(28px) saturate(170%);
    box-shadow: var(--shadow-sm), inset 0 1px 0 rgba(255, 255, 255, 0.045);
    transition: transform var(--transition-normal), background var(--transition-normal),
      border-color var(--transition-normal), box-shadow var(--transition-normal);
    overflow: hidden;
  }

  .card::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: radial-gradient(120% 65% at 50% 0%, rgba(255, 255, 255, 0.05), transparent 55%);
    pointer-events: none;
  }

  .card:hover {
    background: var(--bg-card-hover);
    border-color: var(--border-color-hover);
    transform: translateY(-2px);
    box-shadow: var(--shadow-md), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  }

  .stats-grid,
  .charts-grid,
  .models-grid {
    gap: 1.1rem;
    margin-bottom: 1.1rem;
  }

  .processes-card,
  .events-card {
    margin-bottom: 1.1rem;
  }

  .stat-header h2 {
    font-size: 0.76rem;
    font-weight: 650;
    letter-spacing: 0.1em;
    color: var(--text-tertiary);
  }

  .stat-badge {
    background: var(--bg-subtle);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-pill);
    padding: 0.18rem 0.62rem;
    font-size: 0.82rem;
    font-weight: 650;
  }

  .stat-main {
    font-size: 1.02rem;
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  .gauge-wrap svg {
    filter: drop-shadow(0 0 10px rgba(255, 255, 255, 0.08));
  }

  .core-bar-wrap {
    border-radius: 3px;
  }

  .core-bar {
    border-radius: 3px;
    background: linear-gradient(180deg, #3ce061, #28b04c);
  }

  .mem-total {
    font-size: 1.75rem;
    letter-spacing: -0.03em;
  }

  .mem-bar {
    height: 10px;
  }

  .mem-bar-gpu { background: linear-gradient(90deg, #ff9f0a, #ffc260); }
  .mem-bar-os { background: linear-gradient(90deg, #0a84ff, #55aaff); }
  .mem-bar-disk { background: linear-gradient(90deg, #bf5af2, #df9fff); }

  .chart-container {
    height: 138px;
  }

  .chart-current {
    font-size: 1.35rem;
    letter-spacing: -0.025em;
  }

  .chart-labels {
    font-size: 0.78rem;
    color: var(--text-secondary);
  }

  .chart-ticks {
    font-size: 0.72rem;
  }

  .chart-plot {
    position: relative;
    padding-left: 42px;
    margin-top: 0.5rem;
  }

  .chart-plot .chart-container {
    margin-top: 0;
  }

  .chart-y-axis {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 42px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: flex-end;
    padding-right: 8px;
    font-size: 0.66rem;
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    pointer-events: none;
    user-select: none;
  }

  .chart-controls {
    margin: 0.15rem 0 1.1rem;
  }

  .range-toggle {
    padding: 4px;
    box-shadow: var(--shadow-sm);
    backdrop-filter: blur(20px) saturate(160%);
    -webkit-backdrop-filter: blur(20px) saturate(160%);
  }

  .range-btn {
    padding: 0.4rem 1.15rem;
    font-size: 0.78rem;
    letter-spacing: 0.02em;
  }

  .range-btn:hover {
    background: var(--bg-subtle-hover);
  }

  .range-btn.active {
    background: linear-gradient(180deg, #2997ff, #0a84ff);
    box-shadow: 0 2px 10px rgba(10, 132, 255, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.25);
  }

  .engine-pill {
    font-size: 0.78rem;
    font-weight: 650;
    padding: 0.24rem 0.65rem;
  }

  .running-badge,
  .comfyui-badge {
    border-radius: var(--radius-pill);
    padding: 0.16rem 0.55rem;
  }

  .processes-head {
    font-size: 0.72rem;
    letter-spacing: 0.08em;
  }

  .process-row.comfyui-row {
    background: rgba(48, 209, 88, 0.055);
    border-left: 2px solid #32d74b;
  }

  .model-item {
    border-radius: 12px;
    padding: 0.7rem 0.8rem;
    transition: transform var(--transition-fast), background var(--transition-fast), border-color var(--transition-fast);
  }

  .model-item:hover {
    transform: translateY(-1px);
  }

  .model-name {
    font-weight: 620;
  }

  .event-dot {
    width: 8px;
    height: 8px;
  }

  .event-dot.boot { box-shadow: 0 0 8px rgba(10, 132, 255, 0.5); }
  .event-dot.unclean_shutdown { box-shadow: 0 0 8px rgba(255, 69, 58, 0.5); }
  .event-dot.throttle_start { box-shadow: 0 0 8px rgba(255, 159, 10, 0.5); }
  .event-dot.throttle_end { box-shadow: 0 0 8px rgba(48, 209, 88, 0.5); }
  .event-dot.fan_on { box-shadow: 0 0 8px rgba(100, 210, 255, 0.45); }
  .event-dot.fan_error { box-shadow: 0 0 8px rgba(255, 69, 58, 0.5); }
  .event-dot.comfy_start { box-shadow: 0 0 8px rgba(48, 209, 88, 0.5); }
  .event-dot.comfy_stop { box-shadow: 0 0 8px rgba(255, 159, 10, 0.5); }

  .footer {
    font-size: 0.8rem;
    letter-spacing: 0.01em;
  }

  /* Loading skeleton */
  .loading-state {
    min-height: 60vh;
    gap: 1.6rem;
  }

  .skeleton-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(180px, 1fr));
    gap: 1.1rem;
    width: min(100%, 1680px);
    padding: 0 clamp(1.25rem, 3vw, 2.5rem);
  }

  .skeleton-card {
    height: 190px;
    border-radius: var(--radius-md);
    background: linear-gradient(100deg, var(--bg-subtle) 40%, var(--bg-subtle-hover) 50%, var(--bg-subtle) 60%);
    background-size: 200% 100%;
    animation: shimmer 1.6s linear infinite;
  }

  @keyframes shimmer {
    to { background-position: -200% 0; }
  }

  .loading-status {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .loading-spinner {
    width: 26px;
    height: 26px;
    border-width: 2.5px;
  }

  .loading-text {
    font-size: 0.95rem;
    letter-spacing: 0.01em;
  }

  @media (max-width: 1024px) {
    .skeleton-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  @media (max-width: 640px) {
    .skeleton-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
