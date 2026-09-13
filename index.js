/**
 * Railway Trial Benchmark
 * -----------------------
 * A single-file Node.js app that runs continuously and consumes a
 * configurable amount of CPU + RAM, while logging its own resource
 * usage over time. Use this to see how fast a trial's credit balance
 * drains under a known, controlled load - not random guessing.
 *
 * Deploy this ALONE on the VPS/trial you want to benchmark. Read the
 * numbers it logs, then decide what your real project needs.
 *
 * ── Config (env vars, all optional) ────────────────────────────────
 * RAM_TARGET_MB   - how much memory to hold onto, in MB (default 256)
 * CPU_LOAD_PCT    - 0-100, how hard to spin the CPU (default 30)
 * LOG_INTERVAL_MS - how often to print stats (default 60000 = 1 min)
 * PORT            - health check port (default 3000, Railway sets this)
 *
 * Example: RAM_TARGET_MB=512 CPU_LOAD_PCT=50 node index.js
 */

const http = require('http');
const os = require('os');

// Defaults tuned for Railway's free trial tier: 1 vCPU / 0.5GB RAM per
// service. RAM target is kept a bit under the 512MB hard limit (rather
// than exactly at it) so the process doesn't get OOM-killed the moment
// Node's own overhead is added on top - a killed process stops logging
// and gives you worse data, not better.
const RAM_TARGET_MB = parseInt(process.env.RAM_TARGET_MB || '420', 10);
const CPU_LOAD_PCT = Math.min(100, Math.max(0, parseInt(process.env.CPU_LOAD_PCT || '95', 10)));
const LOG_INTERVAL_MS = parseInt(process.env.LOG_INTERVAL_MS || '60000', 10);
const PORT = process.env.PORT || 3000;

const startTime = Date.now();

// ── 1. Hold a chunk of memory ───────────────────────────────────────
// We allocate an array of buffers and touch every page so the OS
// actually commits real memory (not just reserves virtual address
// space), which is what shows up in Railway's metrics.
const memoryBlocks = [];
function allocateMemory(targetMB) {
  const chunkSizeMB = 8;
  const chunks = Math.ceil(targetMB / chunkSizeMB);
  for (let i = 0; i < chunks; i++) {
    const buf = Buffer.alloc(chunkSizeMB * 1024 * 1024);
    // touch every page (4KB) so it's actually resident, not lazily mapped
    for (let offset = 0; offset < buf.length; offset += 4096) {
      buf[offset] = 1;
    }
    memoryBlocks.push(buf);
  }
  console.log(`[mem] allocated ~${chunks * chunkSizeMB}MB across ${chunks} blocks`);
}

// ── 2. Burn a controllable amount of CPU ────────────────────────────
// Busy-loop for CPU_LOAD_PCT% of each 100ms window, sleep the rest.
// This gives a roughly steady, predictable load instead of pegging
// the CPU at 100% (which would just get throttled/OOM-killed faster
// without telling you anything useful).
function cpuBurnCycle() {
  const windowMs = 100;
  const busyMs = (windowMs * CPU_LOAD_PCT) / 100;
  const cycleStart = Date.now();
  while (Date.now() - cycleStart < busyMs) {
    Math.sqrt(Math.random() * 1e9); // meaningless work, just burns cycles
  }
  setTimeout(cpuBurnCycle, windowMs - busyMs);
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
    heap_used_mb: (mem.heapUsed / 1024 / 1024).toFixed(1),
    target_ram_mb: RAM_TARGET_MB,
    cpu_load_target_pct: CPU_LOAD_PCT,
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
      target_ram_mb: RAM_TARGET_MB,
      cpu_load_target_pct: CPU_LOAD_PCT,
    }, null, 2));
    return;
  }
  res.writeHead(404);
  res.end('not found — try /health or /stats');
});

server.listen(PORT, () => {
  console.log(`[startup] health server on :${PORT}`);
  console.log(`[startup] target RAM: ${RAM_TARGET_MB}MB, target CPU load: ${CPU_LOAD_PCT}%`);
  allocateMemory(RAM_TARGET_MB);
  cpuBurnCycle();
  setInterval(logStats, LOG_INTERVAL_MS);
  logStats();
});
