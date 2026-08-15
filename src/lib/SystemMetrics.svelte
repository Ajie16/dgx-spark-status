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

  // History for sparklines (last 60 data points = 60 seconds)
  const HISTORY_LEN = 60;
  let cpuHistory = $state(Array(HISTORY_LEN).fill(0));
  let gpuHistory = $state(Array(HISTORY_LEN).fill(0));
  let netRxHistory = $state(Array(HISTORY_LEN).fill(0));
  let netTxHistory = $state(Array(HISTORY_LEN).fill(0));

  function pushHistory(arr, val) {
    return [...arr.slice(1), val];
  }

  onMount(() => {
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
      }
    });
    metrics = getCurrentMetrics();
    connected = isWebSocketConnected();
  });

  onDestroy(() => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
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
    if (!data || data.length === 0) return '';
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

  function formatUptime(uptime) {
    if (!uptime) return '';
    const parts = [];
    if (uptime.days) parts.push(`${uptime.days}d`);
    if (uptime.hours) parts.push(`${uptime.hours}h`);
    parts.push(`${uptime.minutes}m`);
    return parts.join(' ');
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
                {#if gpu.powerDraw !== null} · {gpu.powerDraw}W{/if}
                {#if gpu.powerLimit !== null} / {gpu.powerLimit}W{/if}
              </div>
              {#if !gpu.unifiedMemory && gpu.memoryTotalGB !== null}
                <div class="stat-sub mono">
                  VRAM {gpu.memoryUsedGB} / {gpu.memoryTotalGB} GB
                </div>
              {:else}
                <div class="stat-sub">Unified Memory Architecture</div>
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

    <!-- Row 2: Processes -->
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
      {@const comfyuiProcesses = metrics.processes?.filter(p => p.command.toLowerCase().includes('comfyui')) || []}
      {@const comfyuiRunning = comfyuiProcesses.length > 0}
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
            {#if comfyuiRunning}
              <span class="engine-pill running">Running</span>
            {:else}
              <span class="engine-pill stopped">Stopped</span>
            {/if}
          </div>
          <div class="models-list">
            {#if comfyuiRunning}
              {#each comfyuiProcesses as process}
                <div class="model-item loaded">
                  <div class="model-header-row">
                    <div class="model-name" title="{process.command}">{process.command.split(' ')[0].split('/').pop()}</div>
                    <span class="running-badge">RUNNING</span>
                  </div>
                  <div class="model-info">
                    <span class="model-size">{process.memoryGB} GB</span>
                    <span class="model-params">CPU {process.cpu}%</span>
                    <span class="model-params">PID {process.pid}</span>
                  </div>
                </div>
              {/each}
            {:else}
              <div class="model-empty">Not running</div>
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
      <div class="loading-spinner"></div>
      <div class="loading-text">Loading system metrics...</div>
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
</style>
