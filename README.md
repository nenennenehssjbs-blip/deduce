# Railway Trial Benchmark

A single-file Node.js app that runs continuously, consumes a **known,
controlled** amount of CPU and RAM, and logs its own resource usage
over time — so you can see exactly how fast a plan's credit balance
drains under a given load, instead of guessing.

It **auto-detects** the container's total memory at startup and runs
a closed-loop controller that keeps re-measuring actual usage and
nudging itself to stay inside an 85–90% band — so it converges on
that band no matter what size VPS/plan it lands on, with no manual
re-tuning needed.

## Why "controlled" instead of "max everything"

Credits are usually billed by **resource-hours** (RAM-hours +
CPU-hours), not by "did it survive." Pegging everything to 100%
immediately just gets the process OOM-killed or throttled fast and
tells you very little. Running a **known** load (e.g. 85% of
detected RAM, 85% CPU) for a measured number of hours tells you the
actual $/hour burn rate at that load — which you can then scale to
guess what your real project will cost.

## Deploy to Railway

1. Push this folder to a new GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo** → pick it.
3. Railway auto-detects Node via `package.json` and runs `npm start`.
4. Set env vars in Railway's dashboard (Variables tab) if you want
   non-default load levels — see below.
5. Once deployed, hit `https://<your-app>.up.railway.app/stats` any
   time to see live numbers, or check the **Deploy Logs** tab for the
   periodic JSON log lines.

## Config (all optional, set as env vars in Railway)

| Variable                | Default | Meaning                                                      |
|---------------------------|---------|-----------------------------------------------------------------|
| `RAM_TARGET_LOW_PCT`      | 85      | Lower bound of the RAM band, % of detected total memory         |
| `RAM_TARGET_HIGH_PCT`     | 90      | Upper bound of the RAM band, % of detected total memory         |
| `CPU_TARGET_LOW_PCT`      | 85      | Lower bound of the CPU band, %                                  |
| `CPU_TARGET_HIGH_PCT`     | 90      | Upper bound of the CPU band, %                                  |
| `SAFETY_MARGIN_MB`        | 64      | MB always kept free, regardless of the band                     |
| `CONTROL_INTERVAL_MS`     | 5000    | How often the controller re-checks and self-adjusts (ms)        |
| `LOG_INTERVAL_MS`         | 60000   | How often to log stats (ms)                                     |

Railway sets `PORT` itself — don't override it.

At startup the script reads the container's total memory via
`os.totalmem()` (this reflects the actual limit for whatever
plan/tier and VPS size the service lands on). From there it's a
closed loop, not a one-time calculation: every `CONTROL_INTERVAL_MS`
it measures actual RSS and load average, and adds/releases memory or
raises/lowers the CPU busy-fraction to converge on the 85–90% band —
so the same defaults land in that band whether the container has
512MB or 32GB. A `SAFETY_MARGIN_MB` floor is never crossed, so Node's
own overhead can't push it past the hard limit and get OOM-killed.

Note: the CPU burn loop runs on a single core. On multi-core services
it loads one vCPU's worth rather than all of them — the startup log
prints the detected core count (`cpu_count`) so you can see how many
are available.

## Reading the results

Every log line looks like:

```json
{"ts":"...","uptime_hours":"1.50","rss_mb":"6960.3","rss_pct_of_total":"85.0","heap_used_mb":"...","total_system_mem_mb":8192,"cpu_count":8,"ram_band_pct":"85-90","cpu_band_pct":"85-90","current_cpu_load_setting_pct":"87.0","load_avg_1m":"6.98","free_system_mem_mb":"..."}
```

Watch Railway's own **Usage** tab (shows $ consumed) alongside these
logs. After a few hours you'll have enough data points to calculate:

```
$ consumed / uptime_hours = $/hour at this RAM+CPU load
```

Then: `credit_balance / ($/hour) = hours you can run`, and you can
adjust `RAM_TARGET_PCT` / `CPU_LOAD_PCT` to match what your real
project will actually need, and re-derive the number for that.

## When you're done benchmarking

Delete this service (or set the four `*_TARGET_*_PCT` vars to `0`)
before deploying your real projects — this is a synthetic load, not
something you want running alongside actual work.
