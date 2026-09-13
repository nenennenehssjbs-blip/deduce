/**
 * Railway Trial Benchmark
 * -----------------------
 * A single-file Node.js app that runs continuously and consumes a
 * controlled amount of CPU + RAM, while logging its own resource
 * usage over time. Use this to see how fast a plan's credit balance
 * drains under a known load - not random guessing.
 *
 * Auto-detects the container's total memory (os.totalmem() reflects
 * whatever plan/service you're on - free trial, Hobby, Pro, etc.) and
 * runs a CLOSED-LOOP CONTROLLER that re-measures actual usage every
 * cycle and nudges itself up or down to stay inside a target band
 * (default 85-90%). This is size-agnostic: it self-corrects to the
 * same band whether the container has 512MB or 32GB, with no manual
 * re-tuning between plans.
 *
 * Deploy this ALONE on the service/plan you want to benchmark. Read
 * the numbers it logs, then decide what your real project needs.
 *
 * ── Config (env vars, all optional) ────────────────────────────────
 * RAM_TARGET_LOW_PCT  - lower bound of the RAM band, % of total (default 85)
 * RAM_TARGET_HIGH_PCT - upper bound of the RAM band, % of total (default 90)
 * CPU_TARGET_LOW_PCT  - lower bound of the CPU band, % (default 85)
 * CPU_TARGET_HIGH_PCT - upper bound of the CPU band, % (default 90)
 * SAFETY_MARGIN_MB    - MB of headroom always kept free (default 64)
 * CONTROL_INTERVAL_MS - how often the controller re-checks and adjusts (default 5000)
 * LOG_INTERVAL_MS     - how often to print stats (default 60000 = 1 min)
 * PORT                - health check port (default 3000, Railway sets this)
 *
 * Example: RAM_TARGET_LOW_PCT=88 RAM_TARGET_HIGH_PCT=92 node index.js
 */

const http = require('http');
const os = require('os');

// ── Auto-detect the container's real resource ceiling ───────────────
// os.totalmem() reads the cgroup memory limit Railway assigns to this
// service, so it reflects whatever plan/tier the service is running
// on, and whatever size VPS it lands on - no hardcoding per plan.
const TOTAL_MEM_MB = Math.floor(os.totalmem() / 1024 / 1024);
const CPU_COUNT = os.cpus().length;

const RAM_LOW_PCT = clampPct(process.env.RAM_TARGET_LOW_PCT, 85);
const RAM_HIGH_PCT = clampPct(process.env.RAM_TARGET_HIGH_PCT, 90);
const CPU_LOW_PCT = clampPct(process.env.CPU_TARGET_LOW_PCT, 85);
const CPU_HIGH_PCT = clampPct(process.env.CPU_TARGET_HIGH_PCT, 90);
const CONTROL_INTERVAL_MS = parseInt(process.env.CONTROL_INTERVAL_MS || '5000', 10);
const LOG_INTERVAL_MS = parseInt(process.env.LOG_INTERVAL_MS || '60000', 10);
const PORT = process.env.PORT || 3000;

// Headroom that is NEVER allocated into, no matter what the band says -
// keeps Node's own overhead from tipping the container over its hard
// memory limit and getting OOM-killed mid-benchmark (a killed process
// stops logging and gives worse data, not better).
const SAFETY_MARGIN_MB = parseInt(process.env.SAFETY_MARGIN_MB || '64', 10);
const HARD_CEILING_MB = Math.max(0, TOTAL_MEM_MB - SAFETY_MARGIN_MB);

function clampPct(val, fallback) {
  const n = parseInt(val, 10);
  const v = Number.isFinite(n) ? n : fallback;
  return Math.min(100, Math.max(0, v));
}

const startTime = Date.now();
let currentCpuLoadPct = (CPU_LOW_PCT + CPU_HIGH_PCT) / 2;

// ── 1. Memory controller ─────────────────────────────────────────────
// Instead of allocating once for a fixed target, we hold memory in
// small chunks and re-check actual RSS against the band every control
// cycle - adding a chunk if we're below the band, and (if far enough
// over) letting chunks go so GC can reclaim them. This is what makes
// it size-agnostic: it converges on the 85-90% band of whatever
// TOTAL_MEM_MB turns out to be, rather than a number computed once.
const memoryBlocks = [];
const CHUNK_MB = 8;

function touchBuffer(buf) {
  for (let offset = 0; offset < buf.length; offset += 4096) {
    buf[offset] = 1;
  }
}

function memoryControlTick() {
  const rssMB = process.memoryUsage().rss / 1024 / 1024;
  const lowBoundMB = Math.min(HARD_CEILING_MB, TOTAL_MEM_MB * (RAM_LOW_PCT / 100));
  const highBoundMB = Math.min(HARD_CEILING_MB, TOTAL_MEM_MB * (RAM_HIGH_PCT / 100));

  if (rssMB < lowBoundMB) {
    const buf = Buffer.alloc(CHUNK_MB * 1024 * 1024);
    touchBuffer(buf);
    memoryBlocks.push(buf);
  } else if (rssMB > highBoundMB && memoryBlocks.length > 0) {
    // Drop a chunk and let GC reclaim it so we drift back down into band.
    memoryBlocks.pop();
  }
}

// ── 2. CPU controller ────────────────────────────────────────────────
// Busy-loop for currentCpuLoadPct% of each 100ms window, sleep the
// rest. currentCpuLoadPct is adjusted by the control loop below based
// on the actual measured load average, so it converges on the 85-90%
// band instead of just assuming a fixed busy-fraction hits that load.
// Note: this loop runs on a single core - on multi-core services it
// loads one vCPU's worth, proportional to CPU_COUNT (logged at startup).
function cpuBurnCycle() {
  const windowMs = 100;
  const busyMs = (windowMs * currentCpuLoadPct) / 100;
  const cycleStart = Date.now();
  while (Date.now() - cycleStart < busyMs) {
    Math.sqrt(Math.random() * 1e9); // meaningless work, just burns cycles
  }
  setTimeout(cpuBurnCycle, Math.max(0, windowMs - busyMs));
}

function cpuControlTick() {
  // Approximate per-core load: loadavg is system-wide, so normalize by
  // core count to get a 0-100 estimate of how loaded "our" core is.
  const approxLoadPct = (os.loadavg()[0] / CPU_COUNT) * 100;
  if (approxLoadPct < CPU_LOW_PCT) {
    currentCpuLoadPct = Math.min(100, currentCpuLoadPct + 2);
  } else if (approxLoadPct > CPU_HIGH_PCT) {
    currentCpuLoadPct = Math.max(0, currentCpuLoadPct - 2);
  }
}

// ── 3. Periodic stats logging ───────────────────────────────────────
function logStats() {
  const mem = process.memoryUsage();
  const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
  const uptimeH = (uptimeSec / 3600).toFixed(2);
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    uptime_hours: uptimeH,
    rss_mb: (mem.rss / 1024 / 1024).toFixed(1),
    rss_pct_of_total: ((mem.rss / 1024 / 1024 / TOTAL_MEM_MB) * 100).toFixed(1),
    heap_used_mb: (mem.heapUsed / 1024 / 1024).toFixed(1),
    total_system_mem_mb: TOTAL_MEM_MB,
    cpu_count: CPU_COUNT,
    ram_band_pct: `${RAM_LOW_PCT}-${RAM_HIGH_PCT}`,
    cpu_band_pct: `${CPU_LOW_PCT}-${CPU_HIGH_PCT}`,
    current_cpu_load_setting_pct: currentCpuLoadPct.toFixed(1),
    load_avg_1m: os.loadavg()[0].toFixed(2),
    free_system_mem_mb: (os.freemem() / 1024 / 1024).toFixed(1),
  }));
}

// ── 4. Health check server (keeps Railway happy, lets you check in) ─
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime_sec: Math.floor((Date.now() - startTime) / 1000) }));
    return;
  }
  if (req.url === '/stats') {
    const mem = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      uptime_hours: ((Date.now() - startTime) / 3600000).toFixed(2),
      rss_mb: (mem.rss / 1024 / 1024).toFixed(1),
      total_system_mem_mb: TOTAL_MEM_MB,
      cpu_count: CPU_COUNT,
      ram_band_pct: `${RAM_LOW_PCT}-${RAM_HIGH_PCT}`,
      cpu_band_pct: `${CPU_LOW_PCT}-${CPU_HIGH_PCT}`,
      current_cpu_load_setting_pct: currentCpuLoadPct.toFixed(1),
    }, null, 2));
    return;
  }
  res.writeHead(404);
  res.end('not found — try /health or /stats');
});

server.listen(PORT, () => {
  console.log(`[startup] detected total memory: ${TOTAL_MEM_MB}MB across ${CPU_COUNT} CPU(s)`);
  console.log(`[startup] health server on :${PORT}`);
  console.log(`[startup] RAM band: ${RAM_LOW_PCT}-${RAM_HIGH_PCT}% of detected total (hard ceiling ${HARD_CEILING_MB}MB, ${SAFETY_MARGIN_MB}MB always kept free)`);
  console.log(`[startup] CPU band: ${CPU_LOW_PCT}-${CPU_HIGH_PCT}%, self-adjusting every ${CONTROL_INTERVAL_MS}ms`);
  cpuBurnCycle();
  setInterval(memoryControlTick, CONTROL_INTERVAL_MS);
  setInterval(cpuControlTick, CONTROL_INTERVAL_MS);
  setInterval(logStats, LOG_INTERVAL_MS);
  logStats();
});
