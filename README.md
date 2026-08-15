# DGX Spark Status Dashboard

Real-time system monitoring dashboard for NVIDIA DGX Spark (GB10) with Apple-style UI, dual themes, and comprehensive hardware metrics.

![Dashboard Screenshot](docs/dashboard-screenshot.png)

## Features

### System Monitoring
- **CPU Metrics** - Real-time CPU usage with per-core bars, brand info, frequency, and temperature
- **Memory Tracking** - Unified memory breakdown (GPU / OS / Free) with gradient progress bars
- **GPU Monitoring** - NVIDIA GPU utilization and temperature via nvidia-smi
- **System Power** - Total board power draw (CPU + GPU + memory) with 60s history curve
- **Temperature** - GPU and CPU temperature dual-line history curve
- **Disk Usage** - Partition monitoring with usage percentage and filesystem info
- **Network I/O** - Real-time throughput plus per-interface rates
- **Process Monitoring** - Top memory-consuming processes with ComfyUI highlighting
- **System Uptime** - Days, hours, and minutes since boot

### Inference Engine Integration
- **llama.cpp** - Server status monitoring (port 8001), loaded model info
- **vLLM** - Container-based model serving status, running model detection
- **Ollama** - Model management: load/unload, pull, delete models
- **ComfyUI** - Process monitoring via port 8188 detection with memory/CPU stats

### UI Features
- **Apple-style Glassmorphism** - Frosted glass cards with backdrop blur and soft shadows
- **Dual Themes** - Dark and light modes with one-click toggle; preference persisted to localStorage
- **History Persistence** - 60-second metric history saved to localStorage, survives page refresh
- **Live Updates** - Server-Sent Events (SSE) for real-time metrics streaming (1s interval)
- **Responsive Grid** - Auto-fitting card layout that adapts to screen size
- **SVG Favicon** - Gauge-style icon with gradient arc

## Prerequisites

- **Node.js** v25+ (via nvm recommended)
- **NVIDIA GPU** with nvidia-smi installed
- **Linux** - Tested on Ubuntu 24.04 (ARM64 / DGX Spark GB10)
- **Ollama** (optional) - For LLM model management features

## Quick Start

```bash
# Clone the repository
git clone https://github.com/Ajie16/dgx-spark-status.git
cd dgx-spark-status

# Install dependencies
npm install

# Start development server
npm run dev
```

Dashboard will be available at `http://localhost:9000`

### Production

```bash
npm run build
node server.js
```

### Systemd Service

```bash
sudo cp dgx-dashboard.service /etc/systemd/system/
sudo systemctl enable --now dgx-dashboard
```

## Configuration

### Update Interval
Modify `UPDATE_INTERVAL` in `dev-server.js`:
```javascript
const UPDATE_INTERVAL = 1000; // milliseconds
```

### Port
Development server runs on port 9000 by default. Change in `dev-server.js`:
```javascript
server: { host: '0.0.0.0', port: 9000 }
```

### Theme
Click the sun/moon icon in the top-right corner to toggle between dark and light themes. The preference is saved to `localStorage` under key `dgx-theme`.

### Inference Engines
Configure endpoints in `dev-server.js`:
```javascript
const OLLAMA_API = 'http://localhost:11434';
// llama.cpp: port 8001
// vLLM: auto-detected via Docker containers
// ComfyUI: auto-detected via port 8188
```

## Technology Stack

- **SvelteKit 2** - Full-stack framework with SSR
- **Svelte 5** - Reactive UI with modern runes syntax
- **Vite 7** - Fast build tool and dev server
- **Express** - SSE middleware
- **systeminformation** - Cross-platform system metrics
- **nvidia-smi** - Direct GPU querying
- **Server-Sent Events** - Real-time streaming protocol

## Project Structure

```
dgx-spark-status/
├── src/
│   ├── lib/
│   │   ├── SystemMetrics.svelte  # Main dashboard component
│   │   ├── Gauge.svelte          # Circular gauge component
│   │   └── websocket.js          # SSE client handler
│   └── routes/
│       └── api/
│           ├── metrics/+server.js  # SSE metrics endpoint
│           └── ollama/+server.js   # Ollama management API
├── static/
│   └── favicon.svg             # SVG favicon
├── dev-server.js               # Development server with SSE
├── server.js                   # Production server
├── start.sh                    # Startup script with nvm
└── package.json
```

## API Endpoints

### GET /api/metrics
Server-Sent Events stream providing real-time system metrics every second.

### POST /api/ollama
Ollama model management endpoint.

**Actions:** `pull` | `delete` | `load` | `unload`

## Credits

Originally created by [Phanes](https://github.com/Viroscope) @ [OnticEntia.ai](https://github.com/Viroscope)
Extended with inference engine integration (llama.cpp, vLLM) and UI improvements by [thx0701](https://github.com/thx0701)
Redesigned with Apple-style UI, dual themes, ComfyUI monitoring, and power/temperature curves by [Ajie16](https://github.com/Ajie16)

## License

MIT

---

# DGX Spark 系統監控面板

NVIDIA DGX Spark (GB10) 即時系統監控面板，採用 Apple 風格 UI、亮暗雙主題，提供完整的硬體監控與推論引擎管理功能。

## 功能特色

### 系統監控
- **CPU 監控** - 即時使用率、逐核心負載條、頻率與溫度
- **記憶體追蹤** - 統一記憶體細分（GPU / OS / Free）與漸層進度條
- **GPU 監控** - 透過 nvidia-smi 監控使用率與溫度
- **系統功耗** - 整板功耗（CPU + GPU + 記憶體）與 60 秒歷史曲線
- **溫度監控** - GPU / CPU 雙線溫度歷史曲線
- **磁碟使用** - 分割區使用率與檔案系統資訊
- **網路 I/O** - 即時總吞吐量與各介面速率
- **程序監控** - Top 記憶體佔用程序，ComfyUI 程序特別標記
- **系統運行時間** - 天、時、分顯示

### 推論引擎整合
- **llama.cpp** - 伺服器狀態監控（port 8001）
- **vLLM** - 容器化模型服務狀態，自動偵測執行中的模型
- **Ollama** - 模型管理：載入/卸載、下載、刪除模型
- **ComfyUI** - 透過 8188 端口偵測程序狀態，顯示記憶體與 CPU 佔用

### 介面特色
- **Apple 風格毛玻璃** - 半透明磨砂卡片、圓角與柔和陰影
- **亮暗雙主題** - 一鍵切換深色/淺色模式，偏好自動保存
- **歷史持久化** - 60 秒指標歷史存入 localStorage，重新整理不遺失
- **即時更新** - Server-Sent Events (SSE) 每秒串流更新
- **響應式排版** - 自動適應螢幕大小的卡片式排版
- **SVG 圖示** - 儀表板風格漸層圖示

## 快速開始

```bash
git clone https://github.com/Ajie16/dgx-spark-status.git
cd dgx-spark-status
npm install
npm run dev
```

開啟瀏覽器前往 `http://localhost:9000` 即可使用。

## 硬體環境

- **DGX Spark GB10** - NVIDIA Blackwell 行動版，128GB 統一記憶體，ARM64
- **作業系統** - Ubuntu 24.04
- **GPU Driver** - 580.x+

## 致謝

原始專案由 [Phanes](https://github.com/Viroscope) @ [OnticEntia.ai](https://github.com/Viroscope) 建立。
推論引擎整合（llama.cpp、vLLM）及 UI 改進由 [thx0701](https://github.com/thx0701) 擴充。
Apple 風格 UI 重新設計、雙主題、ComfyUI 監控、功耗/溫度曲線由 [Ajie16](https://github.com/Ajie16) 實現。
