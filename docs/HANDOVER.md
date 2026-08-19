# DGX Spark Status — 交接文档

日期：2026-08-16

本批次围绕四件事收尾：确认数据保留策略、图表时间轴与范围切换改造、启动加载优化、交接文档。前三件已在代码中落地，全部为工作区未提交改动（与上一批次的历史记录/健康跟踪/事件功能同属一个 diff，建议一起评审后提交）。

## 1. 数据保留策略（已确认满足，未改逻辑）

结论：现有实现已经满足「7 天封顶、空间有界、不会无限增长」的要求，本次只做了文档化，没有改保留逻辑。

| 项目 | 说明 |
|------|------|
| 采样 | 每 5 秒采样一次；5 秒精度样本只留在内存，保留最近 10 分钟（约 120 点） |
| 落盘 | 每满一分钟，把该分钟的均值**追加一行**到 `metrics-history.jsonl`（append-only，约 150 KB/天） |
| 文件封顶 | 7 天 × 1440 行/天 = 10080 行；每行约 120 字节，**空间上限 ≈ 1.2 MB** |
| 内存封顶 | `historyAgg` 最多 10080 条；`historyRaw` 最多约 600 条 |
| 删除时机 1 | 启动时：按 `now - 7天` 的 cutoff 过滤超龄行，再 `slice(-10080)` 兜底 |
| 删除时机 2 | 运行中：每追加约 2880 行（约 2 天新数据）把内存数组**压缩重写**一次文件，同时裁掉超龄行 |
| 迁移 | 首次检测到旧格式 `metrics-history.json` 且 jsonl 不存在时，自动迁移为 jsonl 并删除旧文件（一次性） |

相关代码：`dev-server.js` 顶部 `HISTORY_FILE / RAW_MAX_AGE / AGG_MAX / loadHistoryFile / appendAggPoint / compactHistoryFile / recordHistory`。

注意：迁移会把 `metrics-history.json` 删除。当前仓库根目录下这份旧格式文件是最后一次启动前的真实数据，服务重启后会自动转换，不需要手动处理。

### GPU 主频与频率上限

GPU 卡片显示当前图形时钟（`clocks.current.graphics`，缺失时回退 `clocks.current.sm`）和频率上限（`cap`）。上限数据来自 systemd 单元里的 `GPU_CLOCK_LOCK` 环境变量（默认 `0,2200`）：`ExecStartPre` 用 `nvidia-smi -lgc ${GPU_CLOCK_LOCK}` 在每次服务启动（含开机）时以 root 应用锁频，面板读取同一变量显示。注意 nvidia-smi 无法回读已应用的 `-lgc` 锁定值，所以面板显示的是单元里配置的值，不是从驱动查询得到的。

节流原因位掩码分两级展示：`SW Power Cap` 在 GB10 上会成段地每秒翻转（驱动在空闲时的伪信号），归入灰字信息行；红色 `⚠` 只留给 HW/SW Thermal Slowdown、HW Power Brake、HW Slowdown 这些真正的降频警告。为防止翻转导致界面闪烁，服务端做了保持：警告位保持 10 秒，信息位锁存 5 分钟（连续缺席才隐藏）。"Unified Memory Architecture" 是 GB10 统一内存的正常标签，不是错误。

### 写盘频率清单

所有文件**没有任何每秒级写盘**，只有以下定时/事件触发写入：

| 文件 | 触发时机 | 频率与体积 |
|------|----------|------------|
| `metrics-history.jsonl` | 每满一分钟追加一行 | 1 行/分钟，约 150 KB/天；每约 2 天全量压缩重写一次（≤1.2 MB） |
| `service-health.json` | 引擎上下线状态变化时 | 仅在内容变化时写；另有 5 分钟检查周期，未变化不写盘 |
| `system-events.json` | boot / crash / GPU 节流起止 | 事件入内存即时，文件最多每 30 秒落一次盘 + 退出时落盘；节流翻转需连续 5 秒稳定才记事件（防抖动） |
| `model-notes.json` | 用户编辑备注 | 仅 POST `/api/notes` 时 |
| `.clean-shutdown` | SIGTERM/SIGINT | 仅退出时一次 |

常态下每天写入量约 250 KB；唯一曾经可能高频写的场景（GPU 节流在温度阈值附近每秒抖动、每次都重写事件文件）已通过 5 秒稳定窗口 + 30 秒落盘防抖消除。

### 多节点监督

每台 DGX Spark 各自部署并运行自己的面板（互不依赖）。选一台做主节点，在其 systemd 单元里配置 `Environment=PEER_NODES=spark-2=http://<peer-ip>:9000`（`name=url` 逗号分隔，或 JSON 数组）。主节点每 5 秒拉一次对端的 `GET /api/snapshot`（2.5 秒超时），把合并后的 `metrics.nodes`（本机 + 对端的在线状态、最后指标）放进自己的 SSE。`/api/snapshot` 会剥掉 `nodes` 字段，避免“对端的对端”嵌套膨胀。前端在有多节点时于页面顶部渲染节点状态条（在线圆点 + CPU/GPU/温度/功耗/风扇摘要），点击节点胶囊直接把面板切换为对端数据。

第二台部署：克隆/同步仓库 → `npm install` → `sudo cp dgx-spark-status.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now dgx-spark-status`，并确保 9000 端口在节点间可达（防火墙放行）。

当前集群实际配置（2026-08-19）：主节点配置 `PEER_NODES=spark-2=http://<peer-ip>:9000`；对端通过 drop-in `node2.conf` 配置反向监督 `PEER_NODES=spark-1=http://<primary-ip>:9000`，并设置 `FAN_CONTROL=0`（对端没有米家脚本）。两端都注册了 systemd 单元（开机自启 + `-lgc 0,2200` 锁频）。

第三台设备（如笔记本）通常路由不到集群内网 IP。因此前端不做跳转：**点击节点胶囊直接把整个面板切换为对端数据**（同源，页面不离开主节点），对端历史由主节点经 `GET /api/history?node=<name>` 服务端代理返回；远程视图会隐藏风扇/ComfyUI/笔记等本机专属操作。另外主节点还为每个对端保留反向代理端口（9101、9102…，`startPeerProxy`），供需要直接打开对端面板的场景使用。

## 2. 图表：真实时间戳 x 轴 + 1h/6h/24h 切换

改动集中在 `src/lib/SystemMetrics.svelte`：

- 用时间点数组替换原来按数组下标均匀排布的折线数据：
  - `chartAgg`：服务端 1 分钟均值（保留 24h，1440 点）
  - `chartLive`：本页连接后收到的 5 秒样本（保留 10 分钟）
  - 渲染前合并去重，`chartView` 按时间戳排序（`$derived`）
- x 坐标按真实时间映射：`窗口起点 → 0`，`当前时刻 → 宽度`。因此 5 秒精度和 1 分钟精度的数据混在一起时，时间轴不会因为点数不同而变形。
- 空值（`null`）会把折线断开，而不是画成 0（比如 GPU 掉线、重启期间）。
- 图表下方新增分段控件 **10m / 1h / 6h / 24h**（`chartRangeH`，**默认 10m**），两张图共用同一窗口；每张图下方有起止时间刻度，图例显示当前窗口。
- 温度图里 GPU/CPU 两条线共享同一个 y 轴刻度；功率图独立刻度。
- 页面每 60 秒重新拉一次 `/api/history?hours=24`，补齐新完成的分桶，同时保留本地 5 秒实时点。

核心函数：`timeChartPath / timeChartArea / visibleChartPoints / pushLivePoint`。

## 3. 启动加载慢的优化（"Loading system metrics..." 久等问题）

根因定位在 `dev-server.js` 的采样热路径，而不是前端本身：

1. 每次 tick 都同步执行 `getAvailableModels()`，对每个模型目录串行 `du -sb`；大目录单次可达数秒到几十秒。
2. vLLM 模型探测对 3 个端口**串行** curl，每个超时 2 秒，vLLM 未运行时一次 tick 至少 +6 秒。
3. 1 秒定时器没有并发保护，慢 tick 会重叠堆积，进一步放大延迟和负载（现改为 5 秒一次采样，并加了防堆积）。
4. 服务刚启动、首个样本尚未完成时接入的客户端，会再触发一次完整采集，和启动采样互相抢资源。

对应措施：

- **模型清单后台缓存**：`refreshModelInventory()` 每 10 分钟后台刷新一次，tick 只读缓存，启动时预热。
- **vLLM 三端口并行探测**：`Promise.allSettled`，最坏从 6 秒降到约 2 秒。
- **tick 防堆积**：`tickPromise` 复用，上一轮没跑完就跳过新一轮。
- **首个 SSE 消息复用进行中的启动采样**：客户端不再触发重复采集，启动采样一完成立即下发。
- `/api/history` 支持 `?hours=N`（默认 24，上限 168），前端只拉 24h 而不是全部 7 天，减少启动时的传输与解析量。

预期效果：引擎全部在线时首条消息亚秒级；引擎全挂的最坏情况也从 6–12 秒以上降到约 2 秒；长时间运行不再有 tick 堆积。

## 4. 部署与验证

历史部署是 tmux（`start.sh` → `npm run dev`），本批次同时注册了 systemd 单元。**unit 名必须是 `dgx-spark-status`**：DGX Spark 宿主机上 `dgx-dashboard.service` 这个名字已被 NVIDIA 预装的另一个服务（11000 端口）占用。两种方式都跑 `node dev-server.js`，绑定 0.0.0.0:9000：

```bash
# 先停掉占用 9000 的旧实例（tmux 或旧服务），再启用新 unit，顺序不能反
tmux kill-session -t dgx-spark-status
sudo cp dgx-spark-status.service /etc/systemd/system/dgx-spark-status.service
sudo systemctl daemon-reload
sudo systemctl enable --now dgx-spark-status

sudo systemctl restart dgx-spark-status                  # 以后加载新代码用这条
curl -N http://localhost:9000/api/metrics                 # SSE 首条消息应秒回
curl 'http://localhost:9000/api/history?hours=24' | head -c 200
npm run build                                            # 构建通过
```

验证要点：

- 页面底部出现 1h/6h/24h 切换，切换后折线窗口、时间刻度、图例同步变化。
- 服务器刚重启后立刻打开页面，"Loading system metrics..." 应在约 2 秒内消失。
- `metrics-history.jsonl` 每分钟多一行；`metrics-history.json` 在首次启动后消失（已被迁移）。

本次在 agent 沙箱里完成了 `node --check`、`npm run build`（通过）、75 秒进程级运行（历史写入、事件写入、优雅退出标记均正常）；沙箱禁用了 socket，HTTP 端到端需要在宿主机上按上面命令实测。

## 5. 遗留事项与注意事项

**只跑一个实例**：`dev-server.js` 用 `strictPort: true` 绑 9000，两个实例并存时后启动的会崩溃循环，且新旧格式会互写 `metrics-history.json` / `metrics-history.jsonl`。切换 tmux → systemd 前务必先 `tmux kill-session -t dgx-spark-status`。新代码只写 jsonl，启动时会一次性迁移旧 json 并删除它。

**生产模式差异（已知，未修）**：`src/routes/api/metrics/+server.js`（`npm run build` + `node server.js` 时生效）没有 Ollama/notes/diskIO/节流/健康数据，也没有 `/api/history`，且客户端断开时 SSE 会崩（`controller.enqueue` 到已关闭流）。图表和启动优化依赖 dev-server，**当前部署请继续用 dev-server.js（systemd 现状）**；若要切生产模式需要先补齐这些问题。

**安全**：9000 端口无鉴权、无 TLS、CORS 全开，模型名/路径有 shell 拼接注入面，只适合可信内网。

**状态文件**（均在项目根目录，已 gitignore）：`metrics-history.jsonl`、`service-health.json`、`system-events.json`、`model-notes.json`、`.clean-shutdown`。清理或备份前先停服务。

**未清理的脚手架**：`index.html`、`src/main.js`、`src/App.svelte`、`src/lib/Counter.svelte`、未使用的 `ws` 依赖，可后续移除。

**构建告警**：`SystemMetrics.svelte` 有可点击 `<div>` 的 Svelte a11y 警告（warning，不阻塞构建）。

## 6. 关键改动文件

| 文件 | 改动 |
|------|------|
| `dev-server.js` | tick 防堆积与复用、模型清单后台缓存、vLLM 并行探测、`/api/history?hours=N` |
| `src/lib/SystemMetrics.svelte` | 时间戳 x 轴图表、1h/6h/24h 控件、历史拉取与合并、修复上一批遗留的未声明变量 bug |
| `AGENTS.md` | 同步上述行为描述 |
| `docs/HANDOVER.md` | 本文档 |
